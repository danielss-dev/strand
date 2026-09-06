//! Bounded pipe capture for user-triggered Git commands. Drain both pipes to
//! EOF even after the limit, retaining the start and final diagnostics.

use std::io::Read;
use std::process::{Command, Output, Stdio};

const HALF_LIMIT: usize = 8 * 1024;

fn drain(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let mut total = 0;
    let mut buffer = [0; 8192];
    loop {
        let n = pipe.read(&mut buffer)?;
        if n == 0 { break; }
        total += n;
        let split = n.min(HALF_LIMIT - head.len());
        head.extend_from_slice(&buffer[..split]);
        tail.extend_from_slice(&buffer[split..n]);
        if tail.len() > HALF_LIMIT {
            tail.drain(..tail.len() - HALF_LIMIT);
        }
    }
    if total > HALF_LIMIT * 2 {
        head.extend_from_slice(b"\n[output truncated; final diagnostics follow]\n");
    }
    head.extend(tail);
    Ok(head)
}

pub(crate) fn capture(command: &mut Command) -> crate::Result<Output> {
    let mut child = command.stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let reader = std::thread::spawn(move || drain(stdout));
    let stderr = drain(stderr);
    let status = child.wait()?;
    let stdout = reader.join().map_err(|_| crate::Error::Other("Git output reader failed".into()))??;
    Ok(Output { status, stdout, stderr: stderr? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_start_and_end_without_unbounded_allocation() {
        let mut bytes = b"start\n".to_vec();
        bytes.extend(vec![b'x'; 1024 * 1024]);
        bytes.extend_from_slice(b"\nfinal error");
        let output = drain(bytes.as_slice()).unwrap();
        assert!(output.len() < 17 * 1024);
        assert!(output.starts_with(b"start\n"));
        assert!(output.ends_with(b"\nfinal error"));
        assert!(String::from_utf8(output).unwrap().contains("output truncated"));
    }
}
