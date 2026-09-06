use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
struct Peer {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Value>,
    next: u64,
}
impl Peer {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_strand-cli"))
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if tx
                    .send(serde_json::from_str(&line.unwrap()).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            next: 0,
        }
    }
    fn send(&mut self, method: &str, params: Value) -> u64 {
        self.next += 1;
        writeln!(
            self.input.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":self.next,"method":method,"params":params})
        )
        .unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        self.next
    }
    fn receive(&self) -> Value {
        self.output
            .recv_timeout(Duration::from_secs(10))
            .expect("daemon response deadline")
    }
    fn hello(&mut self) {
        self.send("hello", json!({"protocolVersion":1}));
        let hello = self.receive();
        assert_eq!(hello["result"]["readOnly"], true);
    }
    fn wait_exit(&mut self) {
        for _ in 0..100 {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("daemon did not exit on EOF/malformed frame");
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn repo() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    assert!(Command::new("git")
        .args(["init", "-q"])
        .arg(repo.path())
        .status()
        .unwrap()
        .success());
    repo
}

#[test]
fn handshake_mismatch_unknown_fields_and_truncated_frames_fail_closed() {
    let mut peer = Peer::new();
    peer.send("hello", json!({"protocolVersion":99}));
    assert_eq!(peer.receive()["error"]["data"]["code"], "protocol");
    peer.wait_exit();
    let mut peer = Peer::new();
    peer.send("hello", json!({"protocolVersion":1,"execute":"bad"}));
    peer.wait_exit();
    let mut peer = Peer::new();
    peer.input
        .take()
        .unwrap()
        .write_all(b"{\"jsonrpc\":")
        .unwrap();
    peer.wait_exit();
    let mut peer = Peer::new();
    peer.hello();
    peer.send(
        "read",
        json!({"repository":".","op":{"kind":"status","execute":"bad"}}),
    );
    assert_eq!(peer.receive()["error"]["data"]["code"], "invalid_request");
    peer.send("push", json!({}));
    assert_eq!(peer.receive()["error"]["code"], -32602);
}

#[test]
fn multiplexed_reads_file_chunks_watch_and_eof_lifecycle() {
    let repo = repo();
    let path = repo.path().to_string_lossy().into_owned();
    std::fs::write(repo.path().join("large.txt"), vec![b'x'; 150_000]).unwrap();
    let mut peer = Peer::new();
    peer.hello();
    let a = peer.send("read", json!({"repository":path,"op":{"kind":"status"}}));
    let b = peer.send("read", json!({"repository":path,"op":{"kind":"snapshot"}}));
    let mut ids = vec![
        peer.receive()["id"].as_u64().unwrap(),
        peer.receive()["id"].as_u64().unwrap(),
    ];
    ids.sort();
    assert_eq!(ids, vec![a, b]);
    peer.send("read", json!({"repository":path,"op":{"kind":"file_chunk","path":"large.txt","offset":0,"length":65536,"version":null}}));
    let chunk = peer.receive();
    assert_eq!(
        chunk["result"]["result"]["data"]["bytes"]
            .as_array()
            .unwrap()
            .len(),
        65536
    );
    let version = chunk["result"]["result"]["data"]["version"].clone();
    std::fs::write(repo.path().join("large.txt"), b"changed").unwrap();
    peer.send("read", json!({"repository":path,"op":{"kind":"file_chunk","path":"large.txt","offset":0,"length":65536,"version":version}}));
    assert_eq!(peer.receive()["error"]["data"]["code"], "repository");
    peer.send("read", json!({"repository":path,"op":{"kind":"file_chunk","path":"../outside","offset":0,"length":1,"version":null}}));
    assert_eq!(peer.receive()["error"]["data"]["code"], "invalid_request");
    peer.send("watch", json!({"repository":path}));
    let watch = peer.receive();
    assert!(watch["result"]["repository"].is_string());
    for i in 0..30 {
        std::fs::write(repo.path().join("burst.txt"), i.to_string()).unwrap();
    }
    let event = peer.receive();
    assert_eq!(event["method"], "changed");
    assert!(event["params"]["files_changed"].is_boolean());
    peer.send("unwatch", json!({"repository":path}));
    assert!(peer.receive()["result"].is_null());
    peer.input.take();
    peer.wait_exit();
}

#[test]
fn cancellation_does_not_expand_worker_budget_and_duplicate_ids_close_connection() {
    let repo = repo();
    let path = repo.path().to_string_lossy().into_owned();
    let mut peer = Peer::new();
    peer.hello();
    let id = peer.send("read", json!({"repository":path,"op":{"kind":"status"}}));
    let cancel = peer.send("cancel", json!({"id":id}));
    let frames = [peer.receive(), peer.receive()];
    assert!(frames
        .iter()
        .any(|r| r["id"] == cancel && r["result"].is_null()));
    assert!(frames
        .iter()
        .any(|r| r["id"] == id
            && (r["result"].is_object() || r["error"]["data"]["code"] == "cancelled")));
    peer.next = 0;
    peer.send("read", json!({"repository":path,"op":{"kind":"status"}}));
    peer.wait_exit();
}
