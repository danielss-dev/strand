//! Explicit user commands, separate from Workbench/plugin registries.
use crate::ai::bin::{self, AiCancelHandle};
use serde::Serialize;
use std::{
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use strand_core::{
    user_actions::{ActionContext, ActionPreview, UserAction},
    Repo,
};

const OUTPUT_LIMIT: usize = 128 * 1024; // Per pipe; never buffer an unbounded transcript.
const TIMEOUT: Duration = Duration::from_secs(600);

#[cfg(unix)]
static LIVE_GROUPS: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

/// App exit must stop action descendants as well as embedded terminals.
pub fn shutdown() {
    #[cfg(unix)]
    if let Ok(groups) = LIVE_GROUPS.lock() {
        for pid in groups.iter() {
            // SAFETY: these are only process groups created by action commands.
            unsafe {
                libc::kill(-(*pid as i32), libc::SIGKILL);
            }
        }
    }
    // On Windows, KILL_ON_JOB_CLOSE handles app exit (including a crash).
}

pub fn preview(action: &UserAction, context: &ActionContext) -> Result<ActionPreview, String> {
    let mut preview = Repo::discover(&context.path)
        .map_err(|e| e.to_string())?
        .preview_user_action(action, context)
        .map_err(|e| e.to_string())?;
    let path = Path::new(&action.executable);
    if !path.is_absolute() && (action.executable.contains(['/', '\\']) || action.executable == ".")
    {
        return Err("Use an absolute executable path or a command installed on PATH".into());
    }
    #[cfg(windows)]
    let name = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        &action.executable[..action.executable.len() - 4]
    } else {
        &action.executable
    };
    #[cfg(not(windows))]
    let name = &action.executable;
    let executable = bin::resolve_cli(
        name,
        path.is_absolute().then_some(action.executable.as_str()),
    )
    .ok_or_else(|| {
        "Executable not found. Use an installed command or absolute executable path.".to_string()
    })?;
    // Batch shims introduce cmd.exe reparsing of repository-controlled values.
    // Users can invoke a native interpreter with a script path as an argument.
    #[cfg(windows)]
    if !executable
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("Actions require a native .exe on Windows; pass scripts as arguments to their interpreter.".into());
    }
    preview.executable = executable.to_string_lossy().into_owned();
    Ok(preview)
}

#[derive(Debug, Serialize)]
pub struct ActionOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub status: String,
    pub truncated: bool,
    pub duration_ms: u64,
}

pub fn run(preview: &ActionPreview, cancel: &AiCancelHandle) -> Result<ActionOutcome, String> {
    capture(preview, cancel, TIMEOUT)
}

fn capture(
    preview: &ActionPreview,
    cancel: &AiCancelHandle,
    timeout: Duration,
) -> Result<ActionOutcome, String> {
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let mut command = bin::base_command(Path::new(&preview.executable), true);
    command
        .args(&preview.args)
        .current_dir(&preview.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    capture_command(command, cancel, timeout)
}

fn capture_command(
    mut command: std::process::Command,
    cancel: &AiCancelHandle,
    timeout: Duration,
) -> Result<ActionOutcome, String> {
    let start = Instant::now();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start action: {e}"))?;
    #[cfg(windows)]
    let job = match bin::WindowsJob::assign(&child).and_then(|job| {
        job.kill_on_close()?;
        Ok(job)
    }) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(unix)]
    if let Ok(mut groups) = LIVE_GROUPS.lock() {
        groups.push(child.id());
    }
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout = child
        .stdout
        .take()
        .map(|pipe| bin::drain_pipe_untrimmed(pipe, OUTPUT_LIMIT, exceeded.clone()));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| bin::drain_pipe_untrimmed(pipe, OUTPUT_LIMIT, exceeded.clone()));
    let (status, exit_code) = loop {
        if cancel.is_cancelled() {
            break ("cancelled", None);
        }
        if exceeded.load(Ordering::Acquire) {
            break ("output-limit", None);
        }
        if start.elapsed() >= timeout {
            break ("timed-out", None);
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                break (
                    if exit.success() {
                        "completed"
                    } else {
                        "failed"
                    },
                    exit.code(),
                )
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break ("failed", None),
        }
    };
    // Kill descendants even after a natural parent exit: they may still hold
    // stdout/stderr open. Joining reader threads first can hang cancellation.
    #[cfg(unix)]
    bin::kill_process_tree(&mut child);
    #[cfg(windows)]
    bin::kill_process_tree(&mut child, &job);
    let _ = child.wait();
    #[cfg(unix)]
    if let Ok(mut groups) = LIVE_GROUPS.lock() {
        groups.retain(|pid| *pid != child.id());
    }
    let stdout = bin::join_pipe(stdout);
    let stderr = bin::join_pipe(stderr);
    let truncated = stdout.exceeded || stderr.exceeded;
    Ok(ActionOutcome {
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code,
        status: if truncated && status != "cancelled" {
            "output-limit"
        } else {
            status
        }
        .into(),
        truncated,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A child of the test executable provides real argv/pipe/process behavior
    // on every platform, without shell quoting or installed test runtimes.
    #[test]
    fn action_child() {
        let Ok(mode) = std::env::var("STRAND_ACTION_TEST") else {
            return;
        };
        match mode.as_str() {
            "echo" => {
                println!("{:?}", std::env::args().collect::<Vec<_>>());
                println!("cwd={}", std::env::current_dir().unwrap().display());
                eprintln!("stderr retained");
            }
            "fail" => {
                eprintln!("intentional failure");
                std::process::exit(7);
            }
            "flood" => loop {
                println!("{}", "x".repeat(8192));
            },
            "wait" => {
                println!("started");
                std::thread::sleep(Duration::from_secs(60));
            }
            "descendant" => {
                let mut child = child_command("mark");
                child.stdout(Stdio::inherit()).stderr(Stdio::inherit());
                child.spawn().unwrap();
                println!("spawned child");
                std::thread::sleep(Duration::from_secs(60));
            }
            "parent-exit" => {
                child_command("wait")
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
            }
            "mark" => {
                std::thread::sleep(Duration::from_secs(2));
                std::fs::write(std::env::var("STRAND_ACTION_MARKER").unwrap(), "escaped").unwrap();
            }
            _ => panic!("bad mode"),
        }
    }

    fn child_command(mode: &str) -> std::process::Command {
        let mut command = bin::base_command(&std::env::current_exe().unwrap(), true);
        command
            .args([
                "--exact",
                "user_actions::tests::action_child",
                "--nocapture",
            ])
            .env("STRAND_ACTION_TEST", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[test]
    fn captures_exact_arguments_working_directory_and_both_pipes() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("space & %PATH% {repo}");
        std::fs::create_dir(&dir).unwrap();
        let mut command = child_command("echo");
        let hostile = "a b;&%PATH%{repo}'$(echo)";
        command.args(["--skip", hostile]).current_dir(&dir);
        let output =
            capture_command(command, &AiCancelHandle::new(), Duration::from_secs(15)).unwrap();
        assert_eq!(output.status, "completed");
        assert!(output.stdout.contains(hostile), "{}", output.stdout);
        assert!(output.stdout.contains("space & %PATH% {repo}"));
        assert!(output.stderr.contains("stderr retained"));
        let output = capture_command(
            child_command("fail"),
            &AiCancelHandle::new(),
            Duration::from_secs(15),
        )
        .unwrap();
        assert_eq!(output.exit_code, Some(7));
        assert_eq!(output.status, "failed");
        assert!(output.stderr.contains("intentional failure"));
    }

    #[test]
    fn bounds_output_and_timeout_and_does_not_wait_for_exited_parents_descendants() {
        let output = capture_command(
            child_command("flood"),
            &AiCancelHandle::new(),
            Duration::from_secs(15),
        )
        .unwrap();
        assert_eq!(output.status, "output-limit");
        assert!(output.truncated);
        assert!(output.stdout.len() <= OUTPUT_LIMIT);
        let output = capture_command(
            child_command("wait"),
            &AiCancelHandle::new(),
            Duration::from_millis(300),
        )
        .unwrap();
        assert_eq!(output.status, "timed-out");
        let start = Instant::now();
        let output = capture_command(
            child_command("parent-exit"),
            &AiCancelHandle::new(),
            Duration::from_secs(15),
        )
        .unwrap();
        assert_eq!(output.status, "completed");
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn cancellation_stops_descendants_and_pre_cancel_never_spawns() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        let mut command = child_command("descendant");
        command.env("STRAND_ACTION_MARKER", &marker);
        let cancel = AiCancelHandle::new();
        let trigger = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            trigger.cancel();
        });
        let output = capture_command(command, &cancel, Duration::from_secs(10)).unwrap();
        assert_eq!(output.status, "cancelled");
        assert!(output.stdout.contains("spawned child"));
        std::thread::sleep(Duration::from_secs(2));
        assert!(!marker.exists());
        assert_eq!(
            capture(
                &ActionPreview {
                    executable: "missing".into(),
                    args: vec![],
                    cwd: ".".into()
                },
                &cancel,
                TIMEOUT
            )
            .unwrap_err(),
            "cancelled"
        );
    }

    #[test]
    fn resolves_installed_executable_before_repository_cwd_and_rejects_relative_program() {
        // `git init` is delegated to core's normal creation fixture helpers elsewhere;
        // this test uses this worktree's actual repository read-only.
        let context = ActionContext {
            path: env!("CARGO_MANIFEST_DIR").into(),
            target: strand_core::user_actions::ActionTarget::Repository,
        };
        let mut action = UserAction {
            id: "test".into(),
            name: "Test".into(),
            scope: "repository".into(),
            executable: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![],
            cwd: "repository".into(),
        };
        let resolved = preview(&action, &context).unwrap();
        assert!(Path::new(&resolved.executable).is_absolute());
        action.executable = if cfg!(windows) { "git.EXE" } else { "git" }.into();
        let resolved = preview(&action, &context).unwrap();
        assert!(Path::new(&resolved.executable).is_absolute());
        assert!(resolved.args.iter().any(|arg| arg == "core.fsmonitor="));
        action.executable = "./repo-program".into();
        assert!(preview(&action, &context).unwrap_err().contains("absolute"));
    }
}
