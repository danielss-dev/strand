//! strand-core — Strand's git engine.
//!
//! Reads go through `gix` (gitoxide) for speed; mutating ops use `git2` or
//! shell out to the user's `git` binary where stability matters (interactive
//! rebase, GPG signing, LFS, hooks).
//!
//! This crate is intentionally UI-agnostic: it returns plain data types that
//! the Tauri layer serializes to the frontend.

pub mod error;
pub mod repo;
pub mod status;
pub mod log;
pub mod diff;
pub mod stage;
pub mod commit;
pub mod network;

pub use error::{Error, Result};
pub use repo::Repo;
