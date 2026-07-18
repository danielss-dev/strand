//! Recover the user's shell `PATH` for desktop-launched CLI processes.
//!
//! Desktop launchers can start GUI apps with a stale or minimal environment
//! that omits package-manager and version-manager directories. Resolve the
//! interactive login shell on Unix and merge the persisted user/machine PATH
//! on Windows, then pass the result directly to child processes. We
//! deliberately do not mutate the process environment after Tauri has started
//! its worker threads.

use std::ffi::{OsStr, OsString};
use std::sync::OnceLock;

static EFFECTIVE_PATH: OnceLock<Option<OsString>> = OnceLock::new();

/// Start shell discovery without delaying the first window. A CLI command that
/// arrives before discovery finishes waits on the same `OnceLock` rather than
/// launching a second shell.
pub fn warm_up() {
    #[cfg(unix)]
    {
        let _ = std::thread::Builder::new()
            .name("strand-shell-path".into())
            .spawn(|| {
                let _ = effective_path();
            });
    }
}

/// Path to apply to CLI children and use for executable discovery.
pub fn effective_path() -> Option<&'static OsStr> {
    EFFECTIVE_PATH
        .get_or_init(resolve_effective_path)
        .as_deref()
}

fn resolve_effective_path() -> Option<OsString> {
    let inherited = std::env::var_os("PATH");
    #[cfg(unix)]
    {
        let conventional = conventional_desktop_path();
        let fallback = merge_paths(conventional.as_deref(), inherited.as_deref());
        merge_paths(shell_path().as_deref(), fallback.as_deref())
    }
    #[cfg(windows)]
    {
        // Explorer and already-running launchers can retain an older PATH
        // after a CLI installer updates the persisted environment. Preserve
        // the inherited ordering, then append any current registry entries it
        // missed so a newly installed npm/WinGet/tool shim remains reachable.
        let registered = merge_paths(
            windows_registry_path(
                windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            )
            .as_deref(),
            windows_registry_path(
                windows_sys::Win32::System::Registry::HKEY_CURRENT_USER,
                "Environment",
            )
            .as_deref(),
        );
        merge_paths(inherited.as_deref(), registered.as_deref())
    }
    #[cfg(not(any(unix, windows)))]
    inherited
}

#[cfg(windows)]
fn windows_registry_path(
    root: windows_sys::Win32::System::Registry::HKEY,
    key: &str,
) -> Option<OsString> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegGetValueW, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ},
    };

    let key: Vec<u16> = OsStr::new(key).encode_wide().chain(Some(0)).collect();
    let value: Vec<u16> = OsStr::new("Path").encode_wide().chain(Some(0)).collect();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut bytes = 0u32;
    // SAFETY: both strings are NUL-terminated and the first call only asks
    // advapi32 for the required output size.
    if unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut bytes,
        )
    } != ERROR_SUCCESS
        || bytes < 2
    {
        return None;
    }

    let mut buffer = vec![0u16; (bytes as usize).div_ceil(2)];
    // SAFETY: `buffer` owns at least the byte count returned by the size
    // query, and RegGetValueW receives that capacity through `bytes`.
    if unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut bytes,
        )
    } != ERROR_SUCCESS
    {
        return None;
    }
    buffer.truncate(
        buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len()),
    );
    (!buffer.is_empty()).then(|| OsString::from_wide(&buffer))
}

#[cfg(unix)]
fn conventional_desktop_path() -> Option<OsString> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "macos")]
    dirs.extend(
        ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
            .into_iter()
            .map(std::path::PathBuf::from),
    );
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    (!dirs.is_empty())
        .then(|| std::env::join_paths(dirs).ok())
        .flatten()
}

#[cfg(any(unix, windows, test))]
fn merge_paths(preferred: Option<&OsStr>, fallback: Option<&OsStr>) -> Option<OsString> {
    let mut dirs = Vec::new();
    for path in [preferred, fallback].into_iter().flatten() {
        for dir in std::env::split_paths(path) {
            // An empty PATH component means the current directory. Provider
            // lookup must never select an executable from an opened repo.
            if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    (!dirs.is_empty())
        .then(|| std::env::join_paths(dirs).ok())
        .flatten()
}

#[cfg(unix)]
fn shell_path() -> Option<OsString> {
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| {
        #[cfg(target_os = "macos")]
        {
            OsString::from("/bin/zsh")
        }
        #[cfg(not(target_os = "macos"))]
        {
            OsString::from("/bin/sh")
        }
    });
    capture_shell_path(
        OsStr::new(&shell),
        std::env::var_os("HOME").as_deref(),
        std::time::Duration::from_secs(10),
    )
}

#[cfg(unix)]
fn capture_shell_path(
    shell: &OsStr,
    home: Option<&OsStr>,
    timeout: std::time::Duration,
) -> Option<OsString> {
    use std::io::Read;
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const MARKER: &[u8] = b"__STRAND_PATH__";
    const MAX_OUTPUT: usize = 1_048_576;
    let shell = std::fs::canonicalize(shell).ok()?;
    if !shell.is_file() {
        return None;
    }

    let mut command = Command::new(shell);
    command
        .args(["-ilc", "/usr/bin/printf '__STRAND_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    if let Some(home) = home {
        command.current_dir(home);
    }

    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (output_tx, output_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut retained = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) if retained.len() < MAX_OUTPUT => {
                    let remaining = MAX_OUTPUT - retained.len();
                    retained.extend_from_slice(&chunk[..read.min(remaining)]);
                }
                Ok(_) => {}
            }
        }
        let _ = output_tx.send(retained);
    });

    let deadline = Instant::now() + timeout;
    let succeeded = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) | Err(_) => {
                // SAFETY: the shell was created as the leader of this process
                // group, so a negative PID terminates startup-script children
                // as well as the shell itself.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                break false;
            }
        }
    };
    let output = match output_rx.recv_timeout(Duration::from_millis(250)) {
        Ok(output) => output,
        Err(_) => {
            // A startup script may leave a background child holding stdout
            // open after the shell exits. It belongs to the probe's process
            // group, so terminate it rather than blocking CLI discovery.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            output_rx.recv_timeout(Duration::from_millis(250)).ok()?
        }
    };
    if !succeeded {
        return None;
    }

    output
        .split(|byte| *byte == b'\n')
        .rev()
        .find_map(|line| line.strip_prefix(MARKER))
        .filter(|path| !path.is_empty())
        .map(|path| OsString::from_vec(path.to_vec()))
        .filter(|path| !path.as_os_str().as_bytes().contains(&0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferred_shell_path_wins_and_fallback_entries_are_kept_once() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let preferred = OsString::from(format!("/shell/bin{separator}/shared/bin"));
        let fallback = OsString::from(format!("/system/bin{separator}/shared/bin"));
        let merged = merge_paths(Some(&preferred), Some(&fallback)).unwrap();
        let dirs: Vec<_> = std::env::split_paths(&merged).collect();
        assert_eq!(
            dirs,
            ["/shell/bin", "/shared/bin", "/system/bin"]
                .into_iter()
                .map(std::path::PathBuf::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn inherited_path_survives_when_shell_discovery_is_unavailable() {
        let inherited = OsStr::new(if cfg!(windows) {
            r"C:\\Windows\\System32"
        } else {
            "/usr/bin:/bin"
        });
        assert_eq!(
            merge_paths(None, Some(inherited)).as_deref(),
            Some(inherited)
        );
    }

    #[test]
    fn empty_path_components_never_enable_current_directory_lookup() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let path = OsString::from(format!("{separator}/usr/bin{separator}"));
        let merged = merge_paths(Some(&path), None).unwrap();
        assert_eq!(
            std::env::split_paths(&merged).collect::<Vec<_>>(),
            vec![std::path::PathBuf::from("/usr/bin")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn persisted_windows_paths_fill_gaps_without_reordering_inherited_entries() {
        let inherited = OsStr::new(r"C:\Inherited;C:\Shared");
        let registered = merge_paths(
            Some(OsStr::new(r"C:\Machine;C:\Shared")),
            Some(OsStr::new(r"C:\Users\me\AppData\Roaming\npm")),
        );
        let merged = merge_paths(Some(inherited), registered.as_deref()).unwrap();
        assert_eq!(
            std::env::split_paths(&merged).collect::<Vec<_>>(),
            [
                r"C:\Inherited",
                r"C:\Shared",
                r"C:\Machine",
                r"C:\Users\me\AppData\Roaming\npm",
            ]
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn conventional_macos_path_includes_homebrew() {
        let path = conventional_desktop_path().unwrap();
        let dirs: Vec<_> = std::env::split_paths(&path).collect();
        assert!(dirs.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&std::path::PathBuf::from("/usr/local/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn shell_capture_accepts_noisy_startup_output() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("test-shell");
        let mut file = std::fs::File::create(&shell).unwrap();
        file.write_all(
            b"#!/bin/sh\nprintf 'startup noise\\n__STRAND_PATH__/shell/bin:/usr/bin\\nexit noise\\n'\n",
        )
        .unwrap();
        let mut permissions = file.metadata().unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shell, permissions).unwrap();
        drop(file);

        let path = capture_shell_path(
            shell.as_os_str(),
            Some(dir.path().as_os_str()),
            std::time::Duration::from_secs(1),
        );
        assert_eq!(path.as_deref(), Some(OsStr::new("/shell/bin:/usr/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn shell_capture_times_out_and_kills_startup_children() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("slow-shell");
        let mut file = std::fs::File::create(&shell).unwrap();
        file.write_all(b"#!/bin/sh\nsleep 30\n").unwrap();
        let mut permissions = file.metadata().unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shell, permissions).unwrap();
        drop(file);

        let started = std::time::Instant::now();
        let path = capture_shell_path(
            shell.as_os_str(),
            Some(dir.path().as_os_str()),
            std::time::Duration::from_millis(50),
        );
        assert!(path.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }
}
