use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const MAX_STDOUT_BYTES: usize = 1_048_576;
const MAX_STDERR_BYTES: usize = 262_144;

/// Ceiling for quick CLI calls (auth status, logout). Node-based CLIs can
/// take seconds to cold-start, but they must never hang the UI forever.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(30);
/// Ceiling for a full model round-trip when suggesting a commit message.
pub const SUGGEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Resolve the Codex CLI binary: user override, then `codex` on PATH.
pub fn resolve_codex(override_path: Option<&str>) -> Option<PathBuf> {
    resolve_cli("codex", override_path)
}

/// Resolve the Claude Code CLI binary: user override, then `claude` on PATH.
pub fn resolve_claude(override_path: Option<&str>) -> Option<PathBuf> {
    resolve_cli("claude", override_path)
}

pub(crate) fn resolve_cli(default_name: &str, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        let path = PathBuf::from(p);
        if path.is_file() {
            return std::fs::canonicalize(path).ok();
        }
        return None;
    }
    which_on_path(default_name)
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    find_in_dirs(name, &dirs)
}

/// `which` over candidate dirs. On Windows only `.exe`/`.cmd`/`.bat` count:
/// an extensionless file on PATH there is a POSIX-shell shim (npm writes one
/// next to every `.cmd`) that `CreateProcess` cannot run — resolving one made
/// Strand report a CLI as installed while every spawn failed (DAN-11).
fn find_in_dirs(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in dirs {
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let candidate = dir.join(format!("{name}.{ext}"));
            if candidate.is_file() {
                return std::fs::canonicalize(candidate).ok();
            }
        }
        #[cfg(not(windows))]
        {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return std::fs::canonicalize(candidate).ok();
            }
        }
    }
    None
}

/// Base command for a resolved CLI. On Windows this routes `.cmd`/`.bat`
/// shims through `cmd /C` (`CreateProcess` cannot execute batch files
/// directly) and hides the child console — the release build is a
/// GUI-subsystem process, so a default spawn flashes a visible console
/// window per call (same rationale as `strand_core::git_command`).
pub(crate) fn base_command(program: &Path, hide_console: bool) -> Command {
    #[cfg(windows)]
    {
        let is_batch = program
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        let mut cmd = if is_batch {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(program);
            c
        } else {
            Command::new(program)
        };
        if hide_console {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }
    #[cfg(not(windows))]
    {
        let _ = hide_console;
        Command::new(program)
    }
}

/// Run a CLI and capture stdout + stderr. Returns Err with stderr on
/// non-zero exit.
///
/// `stdin_data` is piped to the child — prompts travel via stdin, which
/// avoids the Windows 32K command-line ceiling and `cmd /C` re-parsing of
/// multi-line arguments. Without it stdin is null so a CLI that stops to
/// ask a question fails fast instead of waiting forever on an invisible
/// prompt; `timeout` backstops anything that still stalls.
pub fn run_capture(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    stdin_data: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = base_command(program, true);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(if stdin_data.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_error(program, &e.to_string()))?;

    // Feed stdin and drain both output pipes on threads: a full pipe buffer
    // (or a child that never reads stdin) must not deadlock the wait loop.
    let stdin_pipe = child.stdin.take();
    if let (Some(mut pipe), Some(data)) = (stdin_pipe, stdin_data.map(String::from)) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(data.as_bytes());
        });
    }
    let stdout_thread = child
        .stdout
        .take()
        .map(|pipe| drain_pipe(pipe, MAX_STDOUT_BYTES));
    let stderr_thread = child
        .stderr
        .take()
        .map(|pipe| drain_pipe(pipe, MAX_STDERR_BYTES));

    let Some(status) = wait_with_timeout(&mut child, timeout) else {
        let _ = child.kill();
        let _ = child.wait();
        let _ = join_pipe(stdout_thread);
        let _ = join_pipe(stderr_thread);
        return Err(format!(
            "`{}` timed out after {}s",
            program.display(),
            timeout.as_secs()
        ));
    };

    let stdout = join_pipe(stdout_thread);
    let stderr = join_pipe(stderr_thread);
    if stdout.exceeded {
        return Err(format!(
            "`{}` produced more than 1 MB on stdout",
            program.display()
        ));
    }
    if stderr.exceeded {
        return Err(format!(
            "`{}` produced more than 256 KB on stderr",
            program.display()
        ));
    }
    let stdout = stdout.text;
    let stderr = stderr.text;
    if status.success() {
        Ok(stdout)
    } else {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("`{}` exited with status {status}", program.display())
        } else {
            detail
        })
    }
}

struct CapturedOutput {
    text: String,
    exceeded: bool,
}

fn drain_pipe<R: Read + Send + 'static>(
    mut pipe: R,
    max_bytes: usize,
) -> std::thread::JoinHandle<CapturedOutput> {
    std::thread::spawn(move || {
        let mut retained = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut exceeded = false;
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let remaining = max_bytes.saturating_sub(retained.len());
                    retained.extend_from_slice(&chunk[..read.min(remaining)]);
                    exceeded |= read > remaining;
                }
            }
        }
        CapturedOutput {
            text: String::from_utf8_lossy(&retained).trim().to_string(),
            exceeded,
        }
    })
}

fn join_pipe(handle: Option<std::thread::JoinHandle<CapturedOutput>>) -> CapturedOutput {
    handle
        .and_then(|h| h.join().ok())
        .unwrap_or(CapturedOutput {
            text: String::new(),
            exceeded: false,
        })
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() >= deadline => return None,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// Spawn a CLI detached (login flows that open a browser). Keeps default
/// console flags: sign-in may need an interactive picker, so unlike
/// `run_capture` the child gets a real, visible console to ask in.
pub fn spawn_detached(program: &Path, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut cmd = base_command(program, false);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| spawn_error(program, &e.to_string()))
}

fn spawn_error(program: &Path, detail: &str) -> String {
    if detail.contains("No such file") || detail.contains("not found") {
        format!(
            "`{}` not found — install the CLI or set a custom path in Settings → AI",
            program.display()
        )
    } else {
        format!("`{}` failed: {detail}", program.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_path_used_when_file_exists() {
        let path = std::env::current_exe().unwrap();
        let resolved = resolve_cli("nonexistent", Some(path.to_str().unwrap()));
        assert_eq!(resolved, std::fs::canonicalize(path).ok());
    }

    #[cfg(windows)]
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("strand-ai-bin-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn find_in_dirs_prefers_spawnable_over_shell_shim() {
        let dir = temp_dir("shim");
        // npm layout: extensionless POSIX shim + .cmd wrapper side by side.
        std::fs::write(dir.join("codex"), "#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("codex.cmd"), "@echo off\r\n").unwrap();
        let found = find_in_dirs("codex", &[dir.clone()]);
        assert_eq!(found, Some(dir.join("codex.cmd")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn find_in_dirs_skips_extensionless_files_on_windows() {
        let dir = temp_dir("bare");
        std::fs::write(dir.join("claude"), "#!/bin/sh\n").unwrap();
        assert_eq!(find_in_dirs("claude", &[dir.clone()]), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_executes_cmd_shims() {
        let dir = temp_dir("run");
        let shim = dir.join("hello.cmd");
        std::fs::write(&shim, "@echo shim-ok\r\n").unwrap();
        let out = run_capture(&shim, &[], None, None, STATUS_TIMEOUT).unwrap();
        assert_eq!(out, "shim-ok");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_pipes_stdin_data() {
        let out = run_capture(
            Path::new("cmd.exe"),
            &["/C", "findstr", "hello"],
            None,
            Some("hello world\nother line\n"),
            STATUS_TIMEOUT,
        )
        .unwrap();
        assert_eq!(out, "hello world");
    }

    #[cfg(windows)]
    #[test]
    fn run_capture_times_out_instead_of_hanging() {
        let err = run_capture(
            Path::new("cmd.exe"),
            &["/C", "ping", "-n", "30", "127.0.0.1"],
            None,
            None,
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
    }

    #[cfg(not(windows))]
    #[test]
    fn run_capture_pipes_stdin_data() {
        let out = run_capture(
            Path::new("/bin/cat"),
            &[],
            None,
            Some("hello world\n"),
            STATUS_TIMEOUT,
        )
        .unwrap();
        assert_eq!(out, "hello world");
    }

    #[cfg(not(windows))]
    #[test]
    fn run_capture_times_out_instead_of_hanging() {
        let err = run_capture(
            Path::new("/bin/sleep"),
            &["30"],
            None,
            None,
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "unexpected error: {err}");
    }
}
