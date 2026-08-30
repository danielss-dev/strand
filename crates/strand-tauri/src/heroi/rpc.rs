use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ai::bin::base_command;

#[cfg(windows)]
use crate::ai::bin::{kill_process_tree, WindowsJob};

#[cfg(unix)]
use crate::ai::bin::kill_process_tree;

/// Newline-delimited JSON-RPC over a child process's stdio.
///
/// Codex app-server omits the `jsonrpc` field. Cursor ACP uses JSON-RPC 2.0
/// plus an empty `headers` array, matching T3 Code's probes.
pub struct NdjsonRpc {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    next_id: i64,
    kind: RpcKind,
    deadline: Instant,
    #[cfg(windows)]
    job: WindowsJob,
}

#[derive(Clone, Copy)]
pub enum RpcKind {
    Codex,
    Acp,
}

impl NdjsonRpc {
    pub fn spawn(
        program: &Path,
        args: &[&str],
        cwd: &Path,
        timeout: Duration,
        kind: RpcKind,
    ) -> Result<Self, String> {
        let mut cmd = base_command(program, true);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd
            .spawn()
            .map_err(|error| format!("Could not start `{}`: {error}", program.display()))?;
        #[cfg(windows)]
        let job = match WindowsJob::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Could not open stdin for `{}`", program.display()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Could not open stdout for `{}`", program.display()))?;

        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            lines,
            next_id: 1,
            kind,
            deadline: Instant::now() + timeout,
            #[cfg(windows)]
            job,
        })
    }

    pub fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut message = match self.kind {
            RpcKind::Codex => json!({ "method": method }),
            RpcKind::Acp => json!({ "jsonrpc": "2.0", "method": method }),
        };
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message)
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let message = match self.kind {
            RpcKind::Codex => json!({ "id": id, "method": method, "params": params }),
            RpcKind::Acp => json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
                "headers": []
            }),
        };
        self.write_message(&message)?;
        self.read_result(id)
    }

    fn write_message(&mut self, message: &Value) -> Result<(), String> {
        let encoded = serde_json::to_string(message).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(encoded.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Could not write to the agent: {error}"))
    }

    fn read_result(&mut self, id: i64) -> Result<Value, String> {
        loop {
            if Instant::now() >= self.deadline {
                return Err("The agent timed out while listing models.".into());
            }
            match self.lines.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(method) = value.get("method").and_then(Value::as_str) {
                        if value.get("id").is_some() {
                            self.reply_inbound(&value, method)?;
                        }
                        continue;
                    }
                    if json_id(&value) != Some(id) {
                        continue;
                    }
                    if let Some(error) = value.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("request failed");
                        return Err(message.into());
                    }
                    return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if self.child.try_wait().ok().flatten().is_some() {
                        return Err("The agent exited before listing models.".into());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("The agent closed its output before listing models.".into());
                }
            }
        }
    }

    fn reply_inbound(&mut self, request: &Value, _method: &str) -> Result<(), String> {
        let Some(id) = request.get("id").cloned() else {
            return Ok(());
        };
        let reply = match self.kind {
            RpcKind::Codex => json!({ "id": id, "result": {} }),
            RpcKind::Acp => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        };
        self.write_message(&reply)
    }
}

impl Drop for NdjsonRpc {
    fn drop(&mut self) {
        #[cfg(unix)]
        kill_process_tree(&mut self.child);
        #[cfg(windows)]
        kill_process_tree(&mut self.child, &self.job);
        let _ = self.child.wait();
    }
}

fn json_id(value: &Value) -> Option<i64> {
    value.get("id").and_then(|id| {
        id.as_i64()
            .or_else(|| id.as_u64().and_then(|n| i64::try_from(n).ok()))
            .or_else(|| id.as_str()?.parse().ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_numeric_and_string_ids() {
        assert_eq!(json_id(&json!({"id": 3})), Some(3));
        assert_eq!(json_id(&json!({"id": "3"})), Some(3));
    }
}
