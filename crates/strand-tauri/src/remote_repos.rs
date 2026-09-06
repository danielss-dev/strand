//! Optional SSH transport. No local repository command acquires these locks.
use crate::{
    ai::bin,
    commands::{CmdError, CmdResult},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use strand_ops::{
    protocol::*, remote::RemoteIdentity, Envelope, OpError, ReadOp, ReadRequest, Result,
};
use tauri::{Emitter, State};

const TIMEOUT: Duration = Duration::from_secs(30);
type Pending = Mutex<HashMap<u64, mpsc::SyncSender<Result<Value>>>>;
type Events = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

#[derive(Clone, Serialize)]
pub struct Health {
    pub host: String,
    pub state: String,
    pub error: Option<String>,
}

struct Process {
    child: Child,
    stopped: bool,
    #[cfg(windows)]
    job: bin::WindowsJob,
}
// The Windows job is uniquely owned, only accessed while holding the process
// mutex, and Win32 process/job operations are not thread-affine.
#[cfg(windows)]
unsafe impl Send for Process {}
impl Process {
    fn kill(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        #[cfg(windows)]
        bin::kill_process_tree(&mut self.child, &self.job);
        #[cfg(unix)]
        bin::kill_process_tree(&mut self.child);
        let _ = self.child.wait();
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.kill();
    }
}

struct Session {
    host: String,
    process: Mutex<Process>,
    outgoing: mpsc::SyncSender<Vec<u8>>,
    // Allocate IDs and enqueue under the same lock: parallel callers cannot
    // put request 2 on the wire before request 1.
    next: Mutex<u64>,
    pending: Pending,
    alive: AtomicBool,
    stderr: Mutex<Vec<u8>>,
    events: Events,
}
impl Session {
    fn spawn(mut command: Command, host: String, events: Events) -> Result<Arc<Self>> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| OpError::new("connection", format!("Could not start system SSH: {e}")))?;
        #[cfg(windows)]
        let job = match bin::WindowsJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpError::new("connection", error));
            }
        };
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
        let session = Arc::new(Self {
            host,
            process: Mutex::new(Process {
                child,
                stopped: false,
                #[cfg(windows)]
                job,
            }),
            outgoing: tx,
            next: Mutex::new(0),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            stderr: Mutex::new(Vec::new()),
            events,
        });
        let weak = Arc::downgrade(&session);
        std::thread::spawn(move || {
            for bytes in rx {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    if let Some(session) = weak.upgrade() {
                        session.fail("connection", "SSH input closed.");
                    }
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&session);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            let mut total = 0;
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let Some(session) = weak.upgrade() else {
                    break;
                };
                total += n;
                let mut text = session.stderr.lock().unwrap();
                let keep = n.min(16_384usize.saturating_sub(text.len()));
                text.extend_from_slice(&buffer[..keep]);
                drop(text);
                if total > 65_536 {
                    session.fail("protocol", "SSH diagnostics exceeded 64 KiB.");
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&session);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let bytes = strand_ops::read_frame(&mut reader);
                let Some(session) = weak.upgrade() else {
                    break;
                };
                let bytes = match bytes {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => {
                        session.fail("connection", "SSH connection closed. Authenticate with ssh HOST in a terminal and verify ~/.strand/bin/strand is installed.");
                        break;
                    }
                    Err(error) => {
                        session.fail("protocol", &format!("Invalid SSH frame: {error}"));
                        break;
                    }
                };
                let frame = serde_json::from_slice::<Frame>(&bytes);
                match frame {
                    Ok(Frame::Response(response))
                        if response.jsonrpc == "2.0"
                            && response.result.is_some() != response.error.is_some() =>
                    {
                        let pending = session.pending.lock().unwrap().remove(&response.id);
                        if let Some(pending) = pending {
                            let _ = pending.send(match response.error {
                                Some(error) => Err(error.data),
                                None => Ok(response.result.unwrap()),
                            });
                        } else {
                            session.fail("protocol", "SSH response has an unknown request id.");
                            break;
                        }
                    }
                    Ok(Frame::Notification(event))
                        if event.jsonrpc == "2.0"
                            && event.method == "changed"
                            && event.params.repository.len() <= 4096 =>
                    {
                        (session.events)(&session.host, "changed", Some(&event.params.repository));
                    }
                    _ => {
                        session.fail("protocol", "Malformed SSH response; connection closed.");
                        break;
                    }
                }
            }
        });
        Ok(session)
    }

    fn fail(&self, code: &str, message: &str) {
        if !self.alive.swap(false, Ordering::SeqCst) {
            return;
        }
        self.process.lock().unwrap().kill();
        let diagnostic = String::from_utf8_lossy(&self.stderr.lock().unwrap())
            .trim()
            .to_owned();
        let message = if diagnostic.is_empty() {
            message.to_owned()
        } else {
            format!("{message}\n{diagnostic}")
        };
        for (_, pending) in self.pending.lock().unwrap().drain() {
            let _ = pending.send(Err(OpError::new(code, &message)));
        }
        (self.events)(&self.host, "disconnected", Some(&message));
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(OpError::new("connection", "SSH is disconnected."));
        }
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut next = self.next.lock().unwrap();
            let mut pending = self.pending.lock().unwrap();
            // Pair registration with fail()'s pending drain. EOF can race the
            // initial alive check; never leave a new waiter behind that drain.
            if !self.alive.load(Ordering::SeqCst) {
                return Err(OpError::new("connection", "SSH is disconnected."));
            }
            if pending.len() >= 16 {
                return Err(OpError::new(
                    "busy",
                    "SSH connection already has sixteen pending requests.",
                ));
            }
            *next += 1;
            let bytes = strand_ops::encode(&Request::new(*next, method, params))?;
            pending.insert(*next, tx);
            if self.outgoing.try_send(bytes).is_err() {
                pending.remove(&*next);
                return Err(OpError::new("busy", "SSH output queue is full."));
            }
        }
        let start = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                self.fail(
                    "cancelled",
                    "SSH connection cancelled; all reads on this host stopped.",
                );
                return Err(OpError::new("cancelled", "Read cancelled."));
            }
            if start.elapsed() >= timeout {
                self.fail(
                    "timeout",
                    "SSH request timed out; the connection was stopped.",
                );
                return Err(OpError::new("timeout", "SSH request timed out."));
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(value) => return value,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(OpError::new("connection", "SSH request closed."))
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
}

#[derive(Default)]
struct Host {
    session: Mutex<Option<Arc<Session>>>,
}
#[derive(Default)]
pub struct RemoteRepos {
    hosts: Mutex<HashMap<String, Arc<Host>>>,
    operations: Mutex<HashMap<String, (String, Arc<AtomicBool>)>>,
}

fn ssh_command(host: &str) -> Result<Command> {
    let program = bin::resolve_cli("ssh", None).ok_or_else(|| {
        OpError::new(
            "connection",
            "Install system OpenSSH and authenticate in your terminal first.",
        )
    })?;
    let mut command = bin::base_command(&program, true);
    // Fixed remote command only. Repository paths travel as JSON over stdin.
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
        "--",
        host,
        "exec \"$HOME/.strand/bin/strand\" --stdio",
    ]);
    Ok(command)
}

impl RemoteRepos {
    fn host(&self, host: &str) -> Result<Arc<Host>> {
        let mut hosts = self.hosts.lock().unwrap();
        if !hosts.contains_key(host) && hosts.len() >= 16 {
            return Err(OpError::new(
                "busy",
                "Disconnect an SSH host before opening another (limit 16).",
            ));
        }
        Ok(hosts.entry(host.into()).or_default().clone())
    }
    fn connect(
        &self,
        identity: &RemoteIdentity,
        events: Events,
        cancel: &AtomicBool,
    ) -> Result<Arc<Session>> {
        let host = self.host(&identity.host)?;
        // Per-host only; no local command waits here. Manual cancellation uses
        // operation flags and never needs this handshake lock.
        let mut slot = host.session.lock().unwrap();
        if let Some(session) = slot.as_ref().filter(|s| s.alive.load(Ordering::SeqCst)) {
            return Ok(session.clone());
        }
        (events)(&identity.host, "connecting", None);
        let session = Session::spawn(
            ssh_command(&identity.host)?,
            identity.host.clone(),
            events.clone(),
        )?;
        let hello = session.request(
            "hello",
            json!(HelloRequest {
                protocol_version: strand_ops::PROTOCOL_VERSION
            }),
            Duration::from_secs(15),
            cancel,
        )?;
        let hello: Hello =
            serde_json::from_value(hello).map_err(|e| OpError::new("protocol", e.to_string()))?;
        if hello.protocol_version != strand_ops::PROTOCOL_VERSION
            || hello.schema_version != strand_ops::SCHEMA_VERSION
            || !hello.read_only
            || !hello.watch
            || !hello.file_chunks
            || hello.max_frame_bytes != strand_ops::MAX_FRAME_BYTES
        {
            session.fail(
                "protocol",
                "Incompatible remote companion; install the matching protocol version.",
            );
            return Err(OpError::new("protocol", "Incompatible remote companion."));
        }
        *slot = Some(session.clone());
        (events)(&identity.host, "connected", None);
        Ok(session)
    }

    fn read(
        &self,
        identity: &RemoteIdentity,
        op: ReadOp,
        events: Events,
        cancel: &AtomicBool,
    ) -> Result<Envelope> {
        // Only reads retry, at 250ms then 1s. A final failure remains visible;
        // no offline queue, background spin, or replay of writes exists.
        for attempt in 0..3 {
            if cancel.load(Ordering::SeqCst) {
                return Err(OpError::new("cancelled", "Read cancelled."));
            }
            let result = self
                .connect(identity, events.clone(), cancel)
                .and_then(|session| {
                    let value = session.request(
                        "read",
                        json!(ReadRequest {
                            repository: identity.path.clone(),
                            op: op.clone()
                        }),
                        if matches!(op, ReadOp::Diff { .. } | ReadOp::Review { .. }) {
                            Duration::from_secs(60)
                        } else {
                            TIMEOUT
                        },
                        cancel,
                    )?;
                    let result = serde_json::from_value::<Envelope>(value)
                        .map_err(|e| OpError::new("protocol", e.to_string()));
                    match result {
                        Ok(result)
                            if result.schema_version == strand_ops::SCHEMA_VERSION
                                && result.repository.starts_with('/')
                                && result.repository.len() <= 4096
                                && op.accepts(&result.result) =>
                        {
                            Ok(result)
                        }
                        _ => {
                            session.fail("protocol", "Malformed or incompatible remote result.");
                            Err(OpError::new(
                                "protocol",
                                "Malformed or incompatible remote result.",
                            ))
                        }
                    }
                });
            match result {
                Ok(result) => return Ok(result),
                Err(error) if attempt < 2 && error.code == "connection" => {
                    (events)(&identity.host, "reconnecting", Some(&error.message));
                    let until = Instant::now() + Duration::from_millis(250 * 4u64.pow(attempt));
                    while Instant::now() < until {
                        if cancel.load(Ordering::SeqCst) {
                            return Err(OpError::new("cancelled", "Read cancelled."));
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }

    pub fn stop_all(&self) {
        for (_, cancel) in self.operations.lock().unwrap().values() {
            cancel.store(true, Ordering::SeqCst);
        }
        for host in self.hosts.lock().unwrap().values() {
            if let Some(session) = host.session.lock().unwrap().as_ref() {
                session.fail("cancelled", "SSH disconnected.");
            }
        }
    }
}

fn events(app: tauri::AppHandle) -> Events {
    Arc::new(move |host, state, detail| {
        if state == "changed" {
            let _ = app.emit(
                "ssh://changed",
                json!({ "host": host, "repository": detail }),
            );
        } else {
            let _ = app.emit(
                "ssh://health",
                Health {
                    host: host.into(),
                    state: state.into(),
                    error: detail.map(str::to_string),
                },
            );
        }
    })
}
fn cmd_error(error: OpError) -> CmdError {
    CmdError {
        message: format!("{}: {}", error.code, error.message),
    }
}

#[tauri::command(async)]
pub async fn remote_repo_read(
    address: String,
    op: ReadOp,
    request_id: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<RemoteRepos>>,
) -> CmdResult<Envelope> {
    let identity = RemoteIdentity::parse(&address).map_err(cmd_error)?;
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(cmd_error(OpError::new(
            "invalid_request",
            "Invalid request id.",
        )));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut ops = state.operations.lock().unwrap();
        if ops.len() >= 32 || ops.contains_key(&request_id) {
            return Err(cmd_error(OpError::new(
                "busy",
                "Duplicate request or too many SSH operations.",
            )));
        }
        ops.insert(request_id.clone(), (identity.host.clone(), cancel.clone()));
    }
    let manager = state.inner().clone();
    let result =
        tokio::task::spawn_blocking(move || manager.read(&identity, op, events(app), &cancel))
            .await;
    state.operations.lock().unwrap().remove(&request_id);
    result
        .map_err(|e| CmdError {
            message: e.to_string(),
        })?
        .map_err(cmd_error)
}

#[tauri::command(async)]
pub fn remote_repo_cancel(request_id: String, state: State<'_, Arc<RemoteRepos>>) {
    if let Some((_, cancel)) = state.operations.lock().unwrap().get(&request_id) {
        cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command(async)]
pub async fn remote_repo_watch(
    address: String,
    enabled: bool,
    state: State<'_, Arc<RemoteRepos>>,
) -> CmdResult<()> {
    let identity = RemoteIdentity::parse(&address).map_err(cmd_error)?;
    let manager = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let cancel = AtomicBool::new(false);
        let host = manager.host(&identity.host)?;
        let session = host.session.lock().unwrap().clone();
        // Unwatch/close never connects to an unavailable host.
        let session =
            if let Some(session) = session.filter(|session| session.alive.load(Ordering::SeqCst)) {
                session
            } else if enabled {
                return Err(OpError::new(
                    "connection",
                    "Read the repository before starting its watch.",
                ));
            } else {
                return Ok(());
            };
        session
            .request(
                if enabled { "watch" } else { "unwatch" },
                json!(RepositoryRequest {
                    repository: identity.path
                }),
                TIMEOUT,
                &cancel,
            )
            .map(|_| ())
    })
    .await
    .map_err(|e| CmdError {
        message: e.to_string(),
    })?
    .map_err(cmd_error)
}

#[tauri::command(async)]
pub async fn remote_repo_disconnect(
    address: String,
    state: State<'_, Arc<RemoteRepos>>,
) -> CmdResult<()> {
    let identity = RemoteIdentity::parse(&address).map_err(cmd_error)?;
    for (host, cancel) in state.operations.lock().unwrap().values() {
        if *host == identity.host {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    let host = state.hosts.lock().unwrap().remove(&identity.host);
    if let Some(host) = host {
        tokio::task::spawn_blocking(move || {
            if let Some(session) = host.session.lock().unwrap().take() {
                session.fail("cancelled", "SSH disconnected by user.");
            }
        })
        .await
        .map_err(|e| CmdError {
            message: e.to_string(),
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn peer(mode: &str) -> Arc<Session> {
        static PEER: OnceLock<(tempfile::TempDir, std::path::PathBuf)> = OnceLock::new();
        let (_, program) = PEER.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("peer.rs");
            let program = dir
                .path()
                .join(format!("peer{}", std::env::consts::EXE_SUFFIX));
            std::fs::write(&source, include_str!("../tests/fixtures/ssh_peer.rs")).unwrap();
            assert!(Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&program)
                .status()
                .unwrap()
                .success());
            (dir, program)
        });
        let mut command = bin::base_command(program, true);
        command.arg(mode);
        Session::spawn(command, "fixture".into(), Arc::new(|_, _, _| {})).unwrap()
    }

    #[test]
    fn concurrent_ids_and_null_results_keep_the_session_alive() {
        let session = peer("null");
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let session = session.clone();
                std::thread::spawn(move || {
                    session.request(
                        "unwatch",
                        json!({}),
                        Duration::from_secs(5),
                        &AtomicBool::new(false),
                    )
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().unwrap(), Value::Null);
        }
        assert_eq!(*session.next.lock().unwrap(), 12);
        assert!(session.alive.load(Ordering::SeqCst));
        assert!(session.pending.lock().unwrap().is_empty());
        let weak = Arc::downgrade(&session);
        drop(session);
        // Reader/writer threads must not retain the child through an Arc cycle.
        for _ in 0..100 {
            if weak.upgrade().is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("transport retained the session after its owner dropped");
    }

    #[test]
    fn malformed_oversized_unknown_and_truncated_frames_stop_the_peer() {
        for mode in [
            "malformed",
            "unknown",
            "truncated",
            "oversized",
            "stderr",
            "eof",
        ] {
            let session = peer(mode);
            let error = session
                .request(
                    "read",
                    json!({}),
                    Duration::from_secs(5),
                    &AtomicBool::new(false),
                )
                .unwrap_err();
            assert_eq!(
                error.code,
                if mode == "eof" {
                    "connection"
                } else {
                    "protocol"
                },
                "{mode}: {error:?}"
            );
            assert!(!session.alive.load(Ordering::SeqCst));
            assert!(session
                .process
                .lock()
                .unwrap()
                .child
                .try_wait()
                .unwrap()
                .is_some());
            assert!(session.pending.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn timeout_and_cancel_kill_hung_peers_and_drain_pending_requests() {
        let session = peer("hang");
        let start = Instant::now();
        assert_eq!(
            session
                .request(
                    "read",
                    json!({}),
                    Duration::from_millis(100),
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .code,
            "timeout"
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        assert!(session
            .process
            .lock()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_some());

        let session = peer("hang");
        let cancel = Arc::new(AtomicBool::new(false));
        let reads: Vec<_> = (0..2)
            .map(|_| {
                let session = session.clone();
                let cancel = cancel.clone();
                std::thread::spawn(move || {
                    session.request("read", json!({}), Duration::from_secs(5), &cancel)
                })
            })
            .collect();
        for _ in 0..100 {
            if session.pending.lock().unwrap().len() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(session.pending.lock().unwrap().len(), 2);
        cancel.store(true, Ordering::SeqCst);
        for read in reads {
            assert_eq!(read.join().unwrap().unwrap_err().code, "cancelled");
        }
        assert!(session.pending.lock().unwrap().is_empty());
        assert!(session
            .process
            .lock()
            .unwrap()
            .child
            .try_wait()
            .unwrap()
            .is_some());
    }

    #[test]
    fn eof_during_registration_never_leaves_a_waiter_after_the_drain() {
        let session = peer("hang");
        let pending = session.pending.lock().unwrap();
        let read = {
            let session = session.clone();
            std::thread::spawn(move || {
                session.request(
                    "read",
                    json!({}),
                    Duration::from_secs(5),
                    &AtomicBool::new(false),
                )
            })
        };
        // Wait until registration owns the ID lock and is blocked on pending.
        let deadline = Instant::now() + Duration::from_secs(3);
        while session.next.try_lock().is_ok() {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        let failure = {
            let session = session.clone();
            std::thread::spawn(move || session.fail("connection", "fixture EOF"))
        };
        while session.alive.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        drop(pending);
        assert_eq!(read.join().unwrap().unwrap_err().code, "connection");
        failure.join().unwrap();
        assert!(session.pending.lock().unwrap().is_empty());
    }
}
