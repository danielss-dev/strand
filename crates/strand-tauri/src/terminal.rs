//! Embedded terminal runtime.
//!
//! Shells are resolved to absolute executables before the repository becomes
//! their cwd.  Each live PTY is process-owned (never component-owned), so the
//! frontend can keep an xterm renderer mounted while Strand switches views or
//! repositories without interrupting the process.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use uuid::Uuid;

use crate::{
    ai::bin::resolve_cli,
    commands::{CmdError, CmdResult},
    path_env,
};

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_DIMENSION: u16 = 1_000;
const READ_CHUNK_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EmbeddedShellChoice {
    System,
    Preset { id: String },
    Wsl { distribution: String },
    Custom { command: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHandle {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCheck {
    pub available: bool,
    pub label: String,
    pub executable: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: String },
    Exit { code: u32 },
    Error { message: String },
}

struct ResolvedShell {
    program: PathBuf,
    args: Vec<String>,
    label: String,
}

struct TerminalSession {
    repo_path: String,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    closed: AtomicBool,
    #[cfg(unix)]
    process_group: Option<i32>,
    #[cfg(windows)]
    _job: WindowsJob,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalManager {
    pub fn create(
        &self,
        repo_path: String,
        shell: EmbeddedShellChoice,
        cols: u16,
        rows: u16,
        on_event: Channel<TerminalEvent>,
    ) -> CmdResult<TerminalHandle> {
        validate_size(cols, rows)?;
        let resolved = resolve_shell(&shell, Some(Path::new(&repo_path)))?;
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| cmd_err(format!("could not create terminal: {e}")))?;

        let mut command = CommandBuilder::new(&resolved.program);
        command.args(&resolved.args);
        command.cwd(Path::new(&repo_path));
        configure_terminal_environment(&mut command);
        if let Some(path) = path_env::effective_path() {
            command.env("PATH", path);
        }

        let mut child = pty
            .slave
            .spawn_command(command)
            .map_err(|e| cmd_err(format!("could not start {}: {e}", resolved.label)))?;
        drop(pty.slave);

        #[cfg(unix)]
        let process_group = pty.master.process_group_leader();
        #[cfg(windows)]
        let job = WindowsJob::assign(&*child).map_err(|e| {
            let _ = child.kill();
            cmd_err(format!("could not secure terminal process tree: {e}"))
        })?;

        let reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| cmd_err(format!("could not read terminal output: {e}")))?;
        let writer = pty
            .master
            .take_writer()
            .map_err(|e| cmd_err(format!("could not open terminal input: {e}")))?;
        let killer = child.clone_killer();
        let id = Uuid::new_v4().to_string();
        let session = Arc::new(TerminalSession {
            repo_path,
            master: Mutex::new(Some(pty.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            closed: AtomicBool::new(false),
            #[cfg(unix)]
            process_group,
            #[cfg(windows)]
            _job: job,
        });
        self.sessions
            .lock()
            .map_err(|_| cmd_err("terminal registry poisoned"))?
            .insert(id.clone(), Arc::clone(&session));

        let sessions = Arc::clone(&self.sessions);
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("strand-terminal-{}", &id[..8]))
            .spawn(move || terminal_reader(thread_id, session, sessions, reader, child, on_event))
            .map_err(|e| {
                self.close(&id).ok();
                cmd_err(format!("could not start terminal reader: {e}"))
            })?;

        Ok(TerminalHandle {
            id,
            label: resolved.label,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> CmdResult<()> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(cmd_err(format!(
                "terminal input exceeds {MAX_INPUT_BYTES} bytes"
            )));
        }
        let session = self.session(id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| cmd_err("terminal input poisoned"))?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| cmd_err("terminal is not running"))?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| cmd_err(format!("terminal write failed: {e}")))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> CmdResult<()> {
        validate_size(cols, rows)?;
        let session = self.session(id)?;
        let result = session
            .master
            .lock()
            .map_err(|_| cmd_err("terminal resize poisoned"))?
            .as_ref()
            .ok_or_else(|| cmd_err("terminal is not running"))?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| cmd_err(format!("terminal resize failed: {e}")));
        result
    }

    pub fn close(&self, id: &str) -> CmdResult<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| cmd_err("terminal registry poisoned"))?
            .remove(id);
        if let Some(session) = session {
            terminate(&session);
        }
        Ok(())
    }

    pub fn close_all(&self, repo_path: Option<&str>) -> usize {
        let sessions = match self.sessions.lock() {
            Ok(mut all) => {
                let ids: Vec<_> = all
                    .iter()
                    .filter(|(_, session)| repo_path.is_none_or(|path| session.repo_path == path))
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| all.remove(&id))
                    .collect::<Vec<_>>()
            }
            Err(_) => return 0,
        };
        let count = sessions.len();
        for session in sessions {
            terminate(&session);
        }
        count
    }

    pub fn count(&self, repo_path: &str) -> usize {
        self.sessions
            .lock()
            .map(|all| {
                all.values()
                    .filter(|session| session.repo_path == repo_path)
                    .count()
            })
            .unwrap_or(0)
    }

    fn session(&self, id: &str) -> CmdResult<Arc<TerminalSession>> {
        self.sessions
            .lock()
            .map_err(|_| cmd_err("terminal registry poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| cmd_err("terminal is not running"))
    }
}

fn terminal_reader(
    id: String,
    session: Arc<TerminalSession>,
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    on_event: Channel<TerminalEvent>,
) {
    enum RuntimeEvent {
        Output(Vec<u8>),
        ReaderDone(Option<String>),
        Exit(Result<u32, String>),
    }

    // Reading and waiting must be independent: on Windows ConPTY keeps its
    // output pipe open while Strand owns the pseudoconsole. A small bounded
    // fan-in lets us forward chunks continuously and drain buffered output
    // before the exit event without allowing unbounded native buffering.
    let (send, receive) = std::sync::mpsc::sync_channel(64);
    let output_send = send.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; READ_CHUNK_BYTES];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => {
                    let _ = output_send.send(RuntimeEvent::ReaderDone(None));
                    return;
                }
                Ok(read) => {
                    if output_send
                        .send(RuntimeEvent::Output(chunk[..read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = output_send.send(RuntimeEvent::ReaderDone(Some(error.to_string())));
                    return;
                }
            }
        }
    });
    let wait_session = Arc::clone(&session);
    std::thread::spawn(move || {
        let result = child
            .wait()
            .map(|status| status.exit_code())
            .map_err(|error| error.to_string());
        let _ = send.send(RuntimeEvent::Exit(result));
        close_pty_handles(&wait_session);
    });

    let mut exit_result = None;
    let mut reader_done = None;
    while let Ok(event) = receive.recv() {
        match event {
            RuntimeEvent::Output(bytes) => {
                let _ = on_event.send(TerminalEvent::Output {
                    data: BASE64.encode(bytes),
                });
            }
            RuntimeEvent::ReaderDone(error) => reader_done = Some(error),
            RuntimeEvent::Exit(result) => exit_result = Some(result),
        }
        if let (Some(result), Some(_)) = (&exit_result, &reader_done) {
            if !session.closed.load(Ordering::Acquire) {
                match result {
                    Ok(code) => {
                        let _ = on_event.send(TerminalEvent::Exit { code: *code });
                    }
                    Err(message) => {
                        let _ = on_event.send(TerminalEvent::Error {
                            message: message.clone(),
                        });
                    }
                }
            }
            break;
        }
    }
    if let Ok(mut all) = sessions.lock() {
        all.remove(&id);
    }
}

fn terminate(session: &TerminalSession) {
    if session.closed.swap(true, Ordering::AcqRel) {
        return;
    }
    #[cfg(unix)]
    if let Some(group) = session.process_group {
        // SAFETY: portable-pty reports the session/process-group leader for
        // this PTY.  A negative pid targets the complete group, including
        // children launched by the interactive shell.
        unsafe { libc::kill(-group, libc::SIGKILL) };
    }
    if let Ok(mut killer) = session.killer.lock() {
        let _ = killer.kill();
    }
    close_terminal_input(session);
    // On Windows dropping `_job` after `KILL_ON_JOB_CLOSE` terminates every
    // process the shell added to its job, even if the shell spawned children.
}

fn close_terminal_input(session: &TerminalSession) {
    if let Ok(mut writer) = session.writer.lock() {
        writer.take();
    }
}

fn close_pty_handles(session: &TerminalSession) {
    close_terminal_input(session);
    if let Ok(mut master) = session.master.lock() {
        master.take();
    }
}

fn validate_size(cols: u16, rows: u16) -> CmdResult<()> {
    if cols == 0 || rows == 0 || cols > MAX_DIMENSION || rows > MAX_DIMENSION {
        return Err(cmd_err(format!(
            "terminal size must be between 1 and {MAX_DIMENSION} columns/rows"
        )));
    }
    Ok(())
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Strand");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    // Claude Code normally collapses its welcome dashboard after its setup
    // tips and release notes have been seen. Strand is primarily an agent
    // workspace, so keep the complete dashboard visible and opt into Claude's
    // alternate-screen renderer. These variables are inert for other shells
    // and CLI agents.
    command.env("CLAUDE_CODE_FORCE_FULL_LOGO", "1");
    command.env("CLAUDE_CODE_NO_FLICKER", "1");
}

fn resolve_shell(choice: &EmbeddedShellChoice, cwd: Option<&Path>) -> CmdResult<ResolvedShell> {
    let (program, args, label) = match choice {
        EmbeddedShellChoice::System => return resolve_system_shell(),
        EmbeddedShellChoice::Preset { id } => {
            let (program, label) =
                preset(id).ok_or_else(|| cmd_err("unknown embedded shell preset"))?;
            (program.to_string(), Vec::new(), label.to_string())
        }
        EmbeddedShellChoice::Custom { command } => {
            let argv = strand_core::external::build_argv(command, &[]).map_err(CmdError::from)?;
            let (program, args) = argv
                .split_first()
                .ok_or_else(|| cmd_err("custom shell command is empty"))?;
            (program.clone(), args.to_vec(), shell_label(program))
        }
        #[cfg(windows)]
        EmbeddedShellChoice::Wsl { distribution } => {
            let distribution = distribution.trim();
            if distribution.is_empty() {
                return Err(cmd_err("WSL distribution is empty"));
            }
            let wsl = resolve_wsl_program()
                .ok_or_else(|| cmd_err("Windows Subsystem for Linux was not found"))?;
            let mut args = vec!["--distribution".into(), distribution.into()];
            if let Some(cwd) = cwd {
                args.extend(["--cd".into(), cwd.to_string_lossy().into_owned()]);
            }
            (
                wsl.to_string_lossy().into_owned(),
                args,
                format!("WSL · {distribution}"),
            )
        }
        #[cfg(not(windows))]
        EmbeddedShellChoice::Wsl { .. } => {
            return Err(cmd_err("WSL terminals are only available on Windows"));
        }
    };
    resolved(program, args, label)
}

/// Installed WSL distributions suitable for an interactive terminal. WSL
/// writes redirected list output as UTF-16LE, even when the desktop locale is
/// UTF-8, so decode the bytes explicitly instead of treating them as UTF-8.
#[cfg(windows)]
pub fn wsl_distributions() -> Vec<String> {
    let Some(wsl) = resolve_wsl_program() else {
        return Vec::new();
    };
    let Ok(output) = std::process::Command::new(wsl)
        .args(["--list", "--quiet"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut distributions = Vec::new();
    for name in decode_wsl_output(&output.stdout).lines().map(str::trim) {
        if name.is_empty()
            || name.eq_ignore_ascii_case("docker-desktop")
            || name.eq_ignore_ascii_case("docker-desktop-data")
            || distributions
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(name))
        {
            continue;
        }
        distributions.push(name.to_string());
    }
    distributions
}

#[cfg(windows)]
fn resolve_wsl_program() -> Option<PathBuf> {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("wsl.exe"))
        .and_then(|path| resolve_cli("wsl", path.to_str()))
        .or_else(|| resolve_cli("wsl", None))
        .map(normalize_windows_program_path)
}

#[cfg(not(windows))]
pub fn wsl_distributions() -> Vec<String> {
    Vec::new()
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.starts_with(&[0xff, 0xfe])
        || (bytes.len() >= 2
            && bytes.len() % 2 == 0
            && bytes.chunks_exact(2).filter(|pair| pair[1] == 0).count() > bytes.len() / 8);
    if !looks_utf16 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let words = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .skip_while(|word| *word == 0xfeff);
    char::decode_utf16(words)
        .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn resolve_system_shell() -> CmdResult<ResolvedShell> {
    #[cfg(windows)]
    let candidates = [
        ("pwsh", "PowerShell 7"),
        ("powershell", "Windows PowerShell"),
        ("cmd", "Command Prompt"),
    ];
    #[cfg(unix)]
    let candidates = [("sh", "System shell")];

    #[cfg(unix)]
    if let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) {
        let display = shell.to_string_lossy().into_owned();
        if let Some(program) = resolve_program(&display) {
            return Ok(ResolvedShell {
                label: shell_label(&display),
                program,
                args: Vec::new(),
            });
        }
    }
    for (program, label) in candidates {
        if let Some(program) = resolve_program(program) {
            return Ok(ResolvedShell {
                program,
                args: Vec::new(),
                label: label.into(),
            });
        }
    }
    Err(cmd_err("no supported system shell was found"))
}

fn resolved(program: String, args: Vec<String>, label: String) -> CmdResult<ResolvedShell> {
    let executable = resolve_program(&program)
        .ok_or_else(|| cmd_err(format!("embedded shell `{program}` was not found")))?;
    #[cfg(windows)]
    if executable
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
    {
        return Err(cmd_err("batch files cannot be used as embedded shells"));
    }
    Ok(ResolvedShell {
        program: executable,
        args,
        label,
    })
}

fn resolve_program(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    let resolved = if path.is_absolute() || path.components().count() > 1 {
        resolve_cli(program, Some(program))
    } else {
        resolve_cli(program, None)
    };
    #[cfg(windows)]
    return resolved.map(normalize_windows_program_path);
    #[cfg(not(windows))]
    resolved
}

/// `std::fs::canonicalize` produces a `\\?\` path on Windows. Modern
/// executables accept that form, but Windows PowerShell 5.1 passes its own
/// executable path into .NET Framework during interactive startup, where the
/// verbatim prefix can break configuration loading and abort the shell.
#[cfg(windows)]
fn normalize_windows_program_path(path: PathBuf) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.starts_with(VERBATIM_UNC) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(&encoded[VERBATIM_UNC.len()..]);
        return PathBuf::from(std::ffi::OsString::from_wide(&normalized));
    }
    if encoded.starts_with(VERBATIM) {
        return PathBuf::from(std::ffi::OsString::from_wide(&encoded[VERBATIM.len()..]));
    }
    path
}

fn shell_label(program: &str) -> String {
    Path::new(program)
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Terminal")
        .to_string()
}

fn preset(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        #[cfg(windows)]
        "pwsh" => Some(("pwsh", "PowerShell 7")),
        #[cfg(windows)]
        "powershell" => Some(("powershell", "Windows PowerShell")),
        #[cfg(windows)]
        "cmd" => Some(("cmd", "Command Prompt")),
        #[cfg(unix)]
        "zsh" => Some(("zsh", "zsh")),
        #[cfg(unix)]
        "bash" => Some(("bash", "bash")),
        #[cfg(unix)]
        "fish" => Some(("fish", "fish")),
        #[cfg(unix)]
        "sh" => Some(("sh", "sh")),
        _ => None,
    }
}

pub fn shell_check(choice: EmbeddedShellChoice) -> ShellCheck {
    #[cfg(windows)]
    if let EmbeddedShellChoice::Wsl { distribution } = &choice {
        if !wsl_distributions()
            .iter()
            .any(|installed| installed.eq_ignore_ascii_case(distribution))
        {
            return ShellCheck {
                available: false,
                label: format!("WSL · {distribution}"),
                executable: resolve_wsl_program().map(|path| path.to_string_lossy().into_owned()),
                error: Some(format!(
                    "WSL distribution `{distribution}` is not installed"
                )),
            };
        }
    }
    match resolve_shell(&choice, None) {
        Ok(shell) => ShellCheck {
            available: true,
            label: shell.label,
            executable: Some(shell.program.to_string_lossy().into_owned()),
            error: None,
        },
        Err(error) => ShellCheck {
            available: false,
            label: match choice {
                EmbeddedShellChoice::System => "System default".into(),
                EmbeddedShellChoice::Preset { id } => {
                    preset(&id).map(|p| p.1).unwrap_or("Shell").into()
                }
                EmbeddedShellChoice::Wsl { distribution } => format!("WSL · {distribution}"),
                EmbeddedShellChoice::Custom { ref command } => shell_label(command),
            },
            executable: None,
            error: Some(error.message),
        },
    }
}

fn cmd_err(message: impl Into<String>) -> CmdError {
    CmdError {
        message: message.into(),
    }
}

#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &dyn portable_pty::Child) -> Result<Self, std::io::Error> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        let process = child
            .as_raw_handle()
            .ok_or_else(|| std::io::Error::other("terminal process handle unavailable"))?;
        // SAFETY: all pointers are either null or point to initialized Win32
        // structs for the documented duration of each call.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(job, process.cast()) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self(job))
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this guard and closed exactly once.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_oversized_terminal_dimensions() {
        assert!(validate_size(0, 24).is_err());
        assert!(validate_size(80, 0).is_err());
        assert!(validate_size(1_001, 24).is_err());
        assert!(validate_size(80, 24).is_ok());
    }

    #[test]
    fn terminal_environment_advertises_full_agent_capabilities() {
        let mut command = CommandBuilder::new("shell");
        configure_terminal_environment(&mut command);
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
        assert_eq!(
            command.get_env("TERM_PROGRAM"),
            Some(std::ffi::OsStr::new("Strand"))
        );
        assert_eq!(
            command.get_env("CLAUDE_CODE_FORCE_FULL_LOGO"),
            Some(std::ffi::OsStr::new("1"))
        );
        assert_eq!(
            command.get_env("CLAUDE_CODE_NO_FLICKER"),
            Some(std::ffi::OsStr::new("1"))
        );
    }

    #[test]
    fn custom_shell_is_tokenized_without_an_intermediary_shell() {
        let choice = EmbeddedShellChoice::Custom {
            command: "sh -l".into(),
        };
        #[cfg(unix)]
        {
            let resolved = resolve_shell(&choice, None).unwrap();
            assert_eq!(resolved.args, ["-l"]);
            assert!(resolved.program.is_absolute());
        }
        #[cfg(windows)]
        assert!(resolve_shell(&choice, None).is_err());
    }

    #[test]
    fn pty_streams_ordered_output_then_exit() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = format!(
            "\"{}\" /D /C echo strand-terminal",
            std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
        );
        #[cfg(unix)]
        let command = "/bin/sh -c 'printf strand-terminal'".to_string();
        let (send, receive) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str::<TerminalEvent>(&json) {
                    let _ = send.send(event);
                }
            }
            Ok(())
        });
        let manager = TerminalManager::default();
        let handle = manager
            .create(
                dir.path().to_string_lossy().into_owned(),
                EmbeddedShellChoice::Custom { command },
                80,
                24,
                channel,
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut output = Vec::new();
        let mut exited = false;
        while std::time::Instant::now() < deadline && !exited {
            match receive.recv_timeout(std::time::Duration::from_millis(250)) {
                Ok(TerminalEvent::Output { data }) => {
                    let bytes = BASE64.decode(data).unwrap();
                    if bytes.windows(3).any(|window| window == b"[6n") {
                        manager.write(&handle.id, "\u{1b}[1;1R").unwrap();
                    }
                    output.extend(bytes);
                }
                Ok(TerminalEvent::Exit { code }) => {
                    assert_eq!(code, 0);
                    exited = true;
                }
                Ok(TerminalEvent::Error { message }) => panic!("terminal error: {message}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("terminal channel failed: {error}"),
            }
        }
        if !exited {
            panic!(
                "terminal did not exit before the deadline; output={:?}",
                String::from_utf8_lossy(&output)
            );
        }
        assert!(String::from_utf8_lossy(&output).contains("strand-terminal"));
        assert_eq!(manager.count(&dir.path().to_string_lossy()), 0);
        manager.close(&handle.id).unwrap(); // natural exit made close idempotent
    }

    #[cfg(windows)]
    #[test]
    fn windows_powershell_preset_starts_in_a_pty() {
        let dir = tempfile::tempdir().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str::<TerminalEvent>(&json) {
                    let _ = send.send(event);
                }
            }
            Ok(())
        });
        let manager = TerminalManager::default();
        let handle = manager
            .create(
                dir.path().to_string_lossy().into_owned(),
                EmbeddedShellChoice::Preset {
                    id: "powershell".into(),
                },
                80,
                24,
                channel,
            )
            .unwrap();
        manager
            .write(&handle.id, "Write-Output strand-powershell; exit\r\n")
            .unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut output = Vec::new();
        let mut exited = false;
        while std::time::Instant::now() < deadline && !exited {
            match receive.recv_timeout(std::time::Duration::from_millis(250)) {
                Ok(TerminalEvent::Output { data }) => {
                    let bytes = BASE64.decode(data).unwrap();
                    if bytes.windows(3).any(|window| window == b"[6n") {
                        manager.write(&handle.id, "\u{1b}[1;1R").unwrap();
                    }
                    output.extend(bytes);
                }
                Ok(TerminalEvent::Exit { code }) => {
                    assert_eq!(code, 0, "output={:?}", String::from_utf8_lossy(&output));
                    exited = true;
                }
                Ok(TerminalEvent::Error { message }) => panic!("terminal error: {message}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => panic!("terminal channel failed: {error}"),
            }
        }
        if !exited {
            manager.close(&handle.id).unwrap();
            panic!(
                "Windows PowerShell did not exit before the deadline; output={:?}",
                String::from_utf8_lossy(&output)
            );
        }
        assert!(
            String::from_utf8_lossy(&output).contains("strand-powershell"),
            "output={:?}",
            String::from_utf8_lossy(&output)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_terminal_program_paths_drop_verbatim_prefixes() {
        assert_eq!(
            normalize_windows_program_path(PathBuf::from(r"\\?\C:\Windows\shell.exe")),
            PathBuf::from(r"C:\Windows\shell.exe")
        );
        assert_eq!(
            normalize_windows_program_path(PathBuf::from(r"\\?\UNC\server\share\shell.exe")),
            PathBuf::from(r"\\server\share\shell.exe")
        );
    }

    #[cfg(windows)]
    #[test]
    fn batch_launchers_are_rejected_as_embedded_shells() {
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("shell.cmd");
        std::fs::write(&launcher, "@echo off\r\n").unwrap();
        let choice = EmbeddedShellChoice::Custom {
            command: format!("\"{}\"", launcher.display()),
        };
        assert!(resolve_shell(&choice, None).is_err());
    }

    #[test]
    fn decodes_wsl_utf16_output_without_a_bom() {
        let bytes = "Ubuntu\r\ndocker-desktop\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(decode_wsl_output(&bytes), "Ubuntu\r\ndocker-desktop\r\n");
    }

    #[cfg(windows)]
    #[test]
    fn wsl_choice_uses_direct_distribution_and_repository_arguments() {
        let resolved = resolve_shell(
            &EmbeddedShellChoice::Wsl {
                distribution: "Ubuntu".into(),
            },
            Some(Path::new(r"D:\GitSources\strand")),
        )
        .unwrap();
        assert_eq!(resolved.label, "WSL · Ubuntu");
        assert_eq!(
            resolved.args,
            ["--distribution", "Ubuntu", "--cd", r"D:\GitSources\strand"]
        );
    }
}
