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
