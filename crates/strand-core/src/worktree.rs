//! Linked worktrees — list (read) and add / remove / prune (write).
//!
//! Every op **shells out** to the user's `git`, like [`history`](crate::history)
//! and the `stash` apply/pop paths. `git worktree add` checks out a fresh
//! working tree (and may run the user's `post-checkout` hook); `list
//! --porcelain` is the one robust, stable source for path / HEAD / branch /
//! bare / detached / locked / prunable in a single parse. git2's worktree
//! support exists but is thinner and wouldn't run hooks, so the shell-out is the
//! better fit (same reasoning as the other shell-out modules).
//!
//! Why worktrees matter to Strand: AI agents commonly spin up one worktree per
//! feature in the same repo, and a linked worktree's directory is itself a valid
//! repo path — so the UI opens one as its own tab via the normal open flow, and
//! per-worktree stats reuse the existing status/meta/log commands. This module
//! only owns the worktree *registry* (list + lifecycle).

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// One entry in the repository's worktree registry. Mirrors a record from
/// `git worktree list --porcelain`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    /// Absolute worktree directory, forward-slashed.
    pub path: String,
    /// Short branch name (`refs/heads/` stripped); `None` when detached/bare.
    pub branch: Option<String>,
    /// Checked-out HEAD oid; `None` for a bare entry.
    pub head: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    /// Lock reason, when locked and a reason was recorded.
    pub lock_reason: Option<String>,
    /// `git` considers this worktree's directory missing/removable.
    pub is_prunable: bool,
    /// The primary worktree (the one holding the repo's own `.git` dir).
    pub is_main: bool,
    /// Matches the currently-open repo path (`self.path`).
    pub is_current: bool,
}

impl Repo {
    /// List every worktree (main + linked) via `git worktree list --porcelain`.
    /// The first record is always the main worktree.
    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let raw = run_git(&self.path, &["worktree", "list", "--porcelain"])?;
        // Resolve self.path once so `is_current` survives symlinked temp dirs.
        let current = self.path.canonicalize().ok();
        let mut out = Vec::new();
        // Records are separated by a blank line; split and skip empties.
        for (idx, record) in raw.split("\n\n").filter(|r| !r.trim().is_empty()).enumerate() {
            if let Some(wt) = parse_record(record, idx == 0, current.as_deref()) {
                out.push(wt);
            }
        }
        Ok(out)
    }

    /// Add a worktree at `dest`. When `new_branch` is set, create branch
    /// `branch` at HEAD and check it out (`git worktree add -b <branch>
    /// <dest>`); otherwise check out the existing `branch`
    /// (`git worktree add <dest> <branch>`). git refuses if the branch is
    /// already checked out in another worktree — that error is surfaced as-is.
    pub fn add_worktree(&self, dest: &str, branch: &str, new_branch: bool) -> Result<()> {
        reject_dash("worktree path", dest)?;
        reject_dash("branch", branch)?;
        let args: Vec<&str> = if new_branch {
            vec!["worktree", "add", "-b", branch, dest]
        } else {
            vec!["worktree", "add", dest, branch]
        };
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Remove the worktree rooted at `dest` (`git worktree remove [--force]
    /// <dest>`). Without `force`, git refuses when the worktree has local
    /// changes — that guard is intentional, so the UI confirms before forcing.
    pub fn remove_worktree(&self, dest: &str, force: bool) -> Result<()> {
        reject_dash("worktree path", dest)?;
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(dest);
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Prune registry entries whose working trees are gone
    /// (`git worktree prune`). Used to clear `is_prunable` leftovers.
    pub fn prune_worktrees(&self) -> Result<()> {
        run_git(&self.path, &["worktree", "prune"])?;
        Ok(())
    }
}

/// Parse one porcelain record into a [`Worktree`]. Lines seen:
/// `worktree <path>`, `HEAD <oid>`, `branch <ref>`, `bare`, `detached`,
/// `locked [reason]`, `prunable [reason]`. Returns `None` if the record has no
/// `worktree` line (shouldn't happen, but stays defensive).
fn parse_record(record: &str, is_main: bool, current: Option<&Path>) -> Option<Worktree> {
    let mut path: Option<String> = None;
    let mut head = None;
    let mut branch = None;
    let mut is_bare = false;
    let mut is_detached = false;
    let mut is_locked = false;
    let mut lock_reason = None;
    let mut is_prunable = false;

    for line in record.lines() {
        let line = line.trim_end();
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.replace('\\', "/"));
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = Some(h.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            // Porcelain gives the full ref; show the short name.
            branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" {
            is_bare = true;
        } else if line == "detached" {
            is_detached = true;
        } else if line == "locked" || line.starts_with("locked ") {
            is_locked = true;
            lock_reason = line.strip_prefix("locked ").map(|r| r.to_string());
        } else if line == "prunable" || line.starts_with("prunable ") {
            is_prunable = true;
        }
    }

    let path = path?;
    let is_current = current
        .and_then(|c| Path::new(&path).canonicalize().ok().map(|p| p == c))
        .unwrap_or(false);

    Some(Worktree {
        path,
        branch,
        head,
        is_bare,
        is_detached,
        is_locked,
        lock_reason,
        is_prunable,
        is_main,
        is_current,
    })
}

/// Reject an argument git would mis-read as an option flag. Mirrors the
/// submodule-path / revspec guards elsewhere in the crate.
fn reject_dash(what: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(Error::Other(format!("empty {what}")));
    }
    if value.starts_with('-') {
        return Err(Error::Other(format!("{what} may not start with '-': {value}")));
    }
    Ok(())
}

/// Blocking `git` subcommand in `cwd`, trimmed stdout / combined error on
/// failure. A module-local free fn (not a `Repo` method) so it doesn't collide
/// with `stash`'s same-named inherent helper — the shape matches `history`'s.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(args)
        .output()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let combined = format!("{stdout}{stderr}").trim().to_string();
        return Err(Error::Other(if combined.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            combined
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn lists_adds_and_removes_a_worktree() {
        let base = std::env::temp_dir().join(format!(
            "strand-worktree-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();

        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.name", "Test"]);
        git(&main, &["config", "user.email", "test@example.com"]);
        git(&main, &["config", "commit.gpgsign", "false"]);
        std::fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "a.txt"]);
        git(&main, &["commit", "-q", "-m", "init"]);

        let repo = Repo::discover(main.to_str().unwrap()).unwrap();

        // Only the main worktree to start.
        let wts = repo.worktrees().unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        assert!(wts[0].is_current);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));

        // Add a linked worktree on a new branch.
        let linked = base.join("feature");
        repo.add_worktree(linked.to_str().unwrap(), "feature", true).unwrap();
        let wts = repo.worktrees().unwrap();
        assert_eq!(wts.len(), 2, "main + linked");
        let feat = wts.iter().find(|w| w.branch.as_deref() == Some("feature")).unwrap();
        assert!(!feat.is_main);
        assert!(!feat.is_current);
        assert!(feat.head.is_some());

        // Remove it again.
        repo.remove_worktree(linked.to_str().unwrap(), false).unwrap();
        let wts = repo.worktrees().unwrap();
        assert_eq!(wts.len(), 1, "back to just main");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_dash_leading_args() {
        let base = std::env::temp_dir().join(format!(
            "strand-worktree-dash-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        git(&base, &["init", "-q", "-b", "main"]);
        let repo = Repo::discover(base.to_str().unwrap()).unwrap();
        assert!(repo.add_worktree("--force", "x", false).is_err());
        assert!(repo.remove_worktree("-rf", true).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
