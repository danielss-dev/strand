//! Network ops (`fetch` / `pull` / `push`) by shelling out to the user's
//! `git` binary.
//!
//! Rationale: the user already has credentials configured (`credential.helper`,
//! SSH agent, GPG signing, etc.) for their `git`. Re-implementing that in
//! `git2` or `gix` adds a lot of surface for v1. Sublime Merge and Tower
//! both shell out for the same reason. Streaming progress events come in a
//! follow-up — for now we run synchronously and refresh state when done.

use std::process::{Command, Output};

use serde::{Deserialize, Serialize};

use crate::{error::Error, error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkOutcome {
    /// Combined stdout + stderr from `git`, trimmed. Surfaced to the UI so
    /// the user sees what git said — credential prompts, conflicts, etc.
    pub output: String,
}

impl Repo {
    pub fn fetch(&self, remote: Option<&str>) -> Result<NetworkOutcome> {
        let mut args = vec!["fetch", "--prune"];
        if let Some(r) = remote {
            args.push(r);
        }
        self.run_git(&args)
    }

    pub fn pull(&self, rebase: bool) -> Result<NetworkOutcome> {
        let mut args = vec!["pull"];
        if rebase {
            args.push("--rebase");
        }
        self.run_git(&args)
    }

    /// Push the current branch. If `force_with_lease` is set, uses the safer
    /// force variant — plain `--force` is never exposed from the UI.
    pub fn push(&self, force_with_lease: bool) -> Result<NetworkOutcome> {
        let mut args = vec!["push"];
        if force_with_lease {
            args.push("--force-with-lease");
        }
        self.run_git(&args)
    }

    fn run_git(&self, args: &[&str]) -> Result<NetworkOutcome> {
        // Use the user's PATH so their configured `git` (Xcode, Homebrew,
        // distro) is the one we shell out to. We force `GIT_TERMINAL_PROMPT=0`
        // so a missing credential helper fails fast with an error instead
        // of hanging on a TTY prompt that no one can see.
        let out: Output = Command::new("git")
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(args)
            .output()
            .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;

        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let combined = format!("{stdout}{stderr}").trim().to_string();

        if !out.status.success() {
            return Err(Error::Other(if combined.is_empty() {
                format!("git {} failed", args.join(" "))
            } else {
                combined
            }));
        }

        Ok(NetworkOutcome { output: combined })
    }
}
