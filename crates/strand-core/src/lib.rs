//! strand-core — Strand's git engine.
//!
//! Reads go through `gix` (gitoxide) for speed; mutating ops use `git2` or
//! shell out to the user's `git` binary where stability matters (interactive
//! rebase, GPG signing, LFS, hooks).
//!
//! This crate is intentionally UI-agnostic: it returns plain data types that
//! the Tauri layer serializes to the frontend.

// `Error` embeds gix's (large) open/discover errors by value, which trips
// clippy's result_large_err on every fallible function. Boxing them would
// touch every `?` conversion for a moot win — these are user-action-scale
// ops (not per-line hot loops), so the move cost is irrelevant.
#![allow(clippy::result_large_err)]

pub mod error;
pub mod init;
pub mod repo;
pub mod status;
pub mod log;
pub mod diff;
pub mod stage;
pub mod apply;
pub mod commit;
pub mod commit_metadata;
pub mod network;
pub mod refs;
pub mod branch;
pub mod remote;
pub mod maintenance;
pub mod conflict;
pub mod external;
pub mod gitconfig;
mod git_output;
pub mod history;
pub mod ignore;
pub mod stash;
pub mod tag;
pub mod tree;
pub mod submodule;
pub mod worktree;
pub mod blame;
pub mod file;
pub mod file_actions;
pub mod reflog;
pub mod rename;
pub mod reset;
pub mod snapshot;
pub mod watch;

pub use error::{Error, Result};
pub use repo::Repo;

/// Global `git -c` overrides prepended to every shell-out so a repo-local
/// `.git/config` can't silently run code as a side effect of an internal git
/// step. `core.fsmonitor` runs a configured program on status/fetch (a
/// confirmed RCE vector when opening an untrusted repo); `core.pager` could
/// spawn a pager. We deliberately do **not** clear `core.sshCommand`,
/// `credential.helper`, or `GIT_ASKPASS` — those are how the user
/// authenticates (see `network` module docs). Hooks remain the same accepted
/// trust boundary git itself has (PRD §10). Single source of truth so the
/// three per-module `run_git` helpers can't drift.
pub(crate) const GIT_SAFE_CONFIG: &[&str] =
    &["-c", "core.fsmonitor=", "-c", "core.pager=cat"];

/// One-time, process-global git2 setup. Call once at startup, before any repo
/// command can run.
///
/// **Disables git2's repository owner validation.** libgit2 — like `git`'s
/// `safe.directory` / "dubious ownership" check — refuses to open a repo whose
/// directory isn't owned by the current user, failing with
/// `class=Config (7); code=Owner (-36)`. On Windows this fires routinely for
/// the user's *own* repos: anything created directly under a drive root
/// (`C:\GitSources\…`) or by an elevated process is owned by the
/// `Administrators` group, not the user account, so a normal (non-elevated) run
/// rejects it. The symptom is a repo that opens but won't track — `gix` opens
/// it (reads render the worktree/branches), while every `git2`-backed op
/// (status snapshot, staging, commit) trips the ownership check, leaving the
/// tab half-loaded.
///
/// Disabling the check makes `git2` match `gix`, which already opens these
/// repos (with reduced trust) rather than hard-failing — restoring the
/// "both backends open the same path" invariant the [`repo`] module relies on.
/// The disable is process-global (not `#[cfg(windows)]`-gated) on purpose: the
/// same ownership mismatch — and the same gix/git2 divergence — also fires on
/// macOS/Linux for repos on mounted volumes, NFS, or trees checked out under a
/// different uid (Docker bind mounts, root-cloned). Windows is just where it
/// fires most routinely.
/// It does **not** widen the RCE surface that motivates the check: the
/// dangerous vector — a repo-local `core.fsmonitor`/`core.pager` running a
/// program as a side effect of an internal git step — is on the shell-out
/// paths, already neutralized by [`GIT_SAFE_CONFIG`]; `git2`/`gix` don't honor
/// fsmonitor's exec. Strand is a single-user desktop client opening repos the
/// user explicitly picked, so git2's cross-user ownership guard only ever
/// blocks legitimate use here.
pub fn init() {
    // SAFETY: `set_verify_owner_validation` mutates a process-global libgit2
    // static. Calling it once from `main` before the Tauri runtime spawns any
    // command thread means no other thread is touching libgit2 yet — the
    // documented-safe ordering. The call itself cannot fail (per git2's docs).
    unsafe {
        let _ = git2::opts::set_verify_owner_validation(false);
    }
}

/// Construct a `git` [`std::process::Command`] for shell-outs. Every spawn
/// must start here: the release build is a GUI-subsystem process with no
/// console, so on Windows a child `git.exe` spawned with default flags
/// allocates a **visible** console window — one flash per call, stealing
/// focus from the app (which re-triggers the focus-refresh loop and reads as
/// a freeze). `CREATE_NO_WINDOW` gives the child a console with no window;
/// descendants that show GUI dialogs (credential helpers, askpass) still do.
/// Exception: `mergetool` keeps default flags — a console-based merge tool
/// needs a real console window to be usable.
pub(crate) fn git_command() -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = std::process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
