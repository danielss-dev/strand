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
pub mod repo;
pub mod status;
pub mod log;
pub mod diff;
pub mod stage;
pub mod apply;
pub mod commit;
pub mod network;
pub mod refs;
pub mod branch;
pub mod remote;
pub mod conflict;
pub mod external;
pub mod gitconfig;
pub mod history;
pub mod ignore;
pub mod stash;
pub mod tag;
pub mod tree;
pub mod submodule;
pub mod worktree;
pub mod blame;
pub mod file;
pub mod reflog;
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
