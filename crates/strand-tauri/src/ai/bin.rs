use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve the Codex CLI binary: user override, then `codex` on PATH.
pub fn resolve_codex(override_path: Option<&str>) -> Option<PathBuf> {
    resolve_cli("codex", override_path)
}

/// Resolve the Claude Code CLI binary: user override, then `claude` on PATH.
pub fn resolve_claude(override_path: Option<&str>) -> Option<PathBuf> {
    resolve_cli("claude", override_path)
}

fn resolve_cli(default_name: &str, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
        return None;
    }
    which_on_path(default_name)
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

/// Run a CLI command and capture stdout + stderr. Returns Err with stderr on
/// non-zero exit.
pub fn run_capture(program: &Path, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let output = cmd
        .output()
        .map_err(|e| spawn_error(program, &e.to_string()))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(if detail.is_empty() {
            format!("`{}` exited with status {}", program.display(), output.status)
        } else {
            detail
        })
    }
}

/// Spawn a CLI detached (login flows that open a browser).
pub fn spawn_detached(program: &Path, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut cmd = Command::new(program);
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
        assert_eq!(resolved, Some(path));
    }
}
