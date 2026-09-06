//! Stdio only, four concurrent reads, sixteen watchers, bounded output queue.
//! EOF terminates the process, including any in-flight read worker threads.
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufReader, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use strand_ops::{protocol::*, OpError, ReadRequest, Result};

type Jobs = Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>;
struct Watch {
    _handle: strand_core::watch::RepoWatcher,
    dirty: Arc<AtomicBool>,
    files: Arc<AtomicBool>,
}

fn params<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|error| OpError::new("invalid_request", error.to_string()))
}
fn send(tx: &mpsc::SyncSender<Vec<u8>>, response: Response) -> bool {
    let bytes = strand_ops::encode(&response)
        .unwrap_or_else(|error| strand_ops::encode(&Response::error(response.id, error)).unwrap());
    tx.send(bytes).is_ok()
}

pub fn serve() -> Result<()> {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(8);
    let writer = std::thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        for bytes in rx {
            if stdout
                .write_all(&bytes)
                .and_then(|_| stdout.flush())
                .is_err()
            {
                std::process::exit(0);
            }
        }
    });
    let jobs: Jobs = Arc::new(Mutex::new(HashMap::new()));
    let watches = Arc::new(Mutex::new(HashMap::<String, Watch>::new()));
    let stopped = Arc::new(AtomicBool::new(false));
    let watch_map = watches.clone();
    let watch_tx = tx.clone();
    let stop = stopped.clone();
    let notifier = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(200));
            let map = watch_map.lock().unwrap();
            for (path, watch) in map.iter() {
                if !watch.dirty.swap(false, Ordering::Relaxed) {
                    continue;
                }
                let files_changed = watch.files.swap(false, Ordering::Relaxed);
                let frame = Notification {
                    jsonrpc: "2.0".into(),
                    method: "changed".into(),
                    params: Changed {
                        repository: path.clone(),
                        files_changed,
                    },
                };
                if watch_tx
                    .try_send(strand_ops::encode(&frame).unwrap())
                    .is_err()
                {
                    watch.dirty.store(true, Ordering::Relaxed);
                    if files_changed {
                        watch.files.store(true, Ordering::Relaxed);
                    }
                }
            }
        }
    });
    let mut reader = BufReader::new(io::stdin());
    let mut greeted = false;
    // Require strictly increasing request IDs, bounding replay tracking.
    let mut last_id = None;
    let result = (|| {
        while let Some(bytes) = strand_ops::read_frame(&mut reader)
            .map_err(|e| OpError::new("protocol", e.to_string()))?
        {
            let request: Request = serde_json::from_slice(&bytes)
                .map_err(|e| OpError::new("protocol", e.to_string()))?;
            if request.jsonrpc != "2.0" || last_id.is_some_and(|id| request.id <= id) {
                return Err(OpError::new(
                    "protocol",
                    "Invalid JSON-RPC version or non-increasing request id.",
                ));
            }
            last_id = Some(request.id);
            let id = request.id;
            if !greeted {
                let hello = params::<HelloRequest>(request.params)?;
                if request.method != "hello"
                    || hello.protocol_version != strand_ops::PROTOCOL_VERSION
                {
                    send(&tx, Response::error(id, OpError::new("protocol", "Protocol mismatch; install a compatible Strand companion on the host.")));
                    return Ok(());
                }
                greeted = true;
                send(&tx, Response::result(id, json!(Hello::default())));
                continue;
            }
            let outcome: Result<Value> = match request.method.as_str() {
                "read" => {
                    let read: ReadRequest = match params(request.params) {
                        Ok(read) => read,
                        Err(error) => {
                            send(&tx, Response::error(id, error));
                            continue;
                        }
                    };
                    let mut active = jobs.lock().unwrap();
                    if active.len() >= 4 {
                        Err(OpError::new(
                            "busy",
                            "At most four reads may run concurrently.",
                        ))
                    } else {
                        let cancelled = Arc::new(AtomicBool::new(false));
                        active.insert(id, cancelled.clone());
                        let jobs = jobs.clone();
                        let tx = tx.clone();
                        std::thread::spawn(move || {
                            let result = strand_ops::execute(&read)
                                .and_then(|result| strand_ops::encode(&result))
                                .and_then(|bytes| {
                                    serde_json::from_slice::<Value>(&bytes)
                                        .map_err(|e| OpError::new("protocol", e.to_string()))
                                });
                            let mut active = jobs.lock().unwrap();
                            if active.remove(&id).is_some() {
                                let response = if cancelled.load(Ordering::Relaxed) {
                                    Response::error(
                                        id,
                                        OpError::new("cancelled", "Read cancelled."),
                                    )
                                } else {
                                    match result {
                                        Ok(result) => Response::result(id, json!(result)),
                                        Err(error) => Response::error(id, error),
                                    }
                                };
                                drop(active);
                                send(&tx, response);
                            }
                        });
                        continue;
                    }
                }
                "cancel" => {
                    match params::<CancelRequest>(request.params) {
                        Ok(cancel) => {
                            // Mark, but retain the slot until the native read returns:
                            // cancellation cannot be abused to create unbounded workers.
                            if let Some(flag) = jobs.lock().unwrap().get(&cancel.id) {
                                flag.store(true, Ordering::Relaxed);
                            }
                            Ok(Value::Null)
                        }
                        Err(error) => Err(error),
                    }
                }
                "watch" | "unwatch" => {
                    let repository = params::<RepositoryRequest>(request.params);
                    repository.and_then(|repository| {
                        let repo = strand_core::Repo::discover(&repository.repository)?;
                        let path = repo
                            .path()
                            .canonicalize()
                            .map_err(|e| OpError::new("repository", e.to_string()))?
                            .to_string_lossy()
                            .into_owned();
                        let mut map = watches.lock().unwrap();
                        if request.method == "unwatch" {
                            map.remove(&path);
                            return Ok(Value::Null);
                        }
                        if !map.contains_key(&path) {
                            if map.len() >= 16 {
                                return Err(OpError::new(
                                    "busy",
                                    "At most sixteen repository watches per connection.",
                                ));
                            }
                            let dirty = Arc::new(AtomicBool::new(false));
                            let files = Arc::new(AtomicBool::new(false));
                            let d = dirty.clone();
                            let f = files.clone();
                            let watcher = strand_core::watch::watch(
                                repo.path(),
                                repo.git_dir(),
                                Duration::from_millis(400),
                                move |changed| {
                                    if changed {
                                        f.store(true, Ordering::Relaxed);
                                    }
                                    d.store(true, Ordering::Relaxed);
                                },
                            )?;
                            map.insert(
                                path.clone(),
                                Watch {
                                    _handle: watcher,
                                    dirty,
                                    files,
                                },
                            );
                        }
                        Ok(json!({ "repository": path }))
                    })
                }
                _ => Err(OpError::new(
                    "invalid_request",
                    "Unknown method; the remote engine is read-only.",
                )),
            };
            if !send(
                &tx,
                match outcome {
                    Ok(value) => Response::result(id, value),
                    Err(error) => Response::error(id, error),
                },
            ) {
                break;
            }
        }
        Ok(())
    })();
    stopped.store(true, Ordering::Relaxed);
    watches.lock().unwrap().clear();
    let _ = notifier.join();
    // Do not join in-flight native reads after EOF; returning from main ends
    // them. For an idle orderly shutdown, drain the writer before exiting.
    if jobs.lock().unwrap().is_empty() {
        drop(tx);
        let _ = writer.join();
    }
    result
}
