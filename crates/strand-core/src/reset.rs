//! `git reset` — move HEAD (and per mode the index / working tree) to a
//! target commit.
//!
//! Hard resets of a dirty tree take a safety snapshot first (the same
//! stash-based net `discard_paths` callers use), so "discard all changes"
//! is always recoverable from the stash stack. "Dirty" means tracked
//! changes only — `git reset --hard` never touches untracked files, so an
//! untracked-only tree needs no snapshot and the snapshot itself skips
//! untracked files (the lighter `stash create` path, no working-tree churn).

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// Reset flavour: what happens to the index + working tree.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    /// Move HEAD only — all changes stay staged.
    Soft,
    /// Move HEAD + reset the index — changes stay in the working tree, unstaged.
    Mixed,
    /// Move HEAD + reset index and working tree — changes are discarded.
    Hard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResetOutcome {
    /// Short hash of the commit HEAD now points at.
    pub target_short: String,
    /// OID of the safety snapshot stash taken before a hard reset of a dirty
    /// tree; `None` for soft/mixed or a clean tree.
    pub snapshot_oid: Option<String>,
}

impl Repo {
    /// Reset HEAD (the current branch, or HEAD itself when detached) to
    /// `target`. Refuses while a merge/rebase/cherry-pick/revert is paused —
    /// resetting mid-operation strands the sequencer state.
    pub fn reset(&self, target: &str, mode: ResetMode) -> Result<ResetOutcome> {
        if let Some(op) = self.meta()?.operation {
            return Err(Error::Other(format!(
                "finish or abort the in-progress {op} first"
            )));
        }

        let repo = self.git2()?;
        let obj = repo
            .revparse_single(target)?
            .peel(git2::ObjectType::Commit)?;
        let target_short = obj
            .short_id()
            .ok()
            .and_then(|b| b.as_str().map(str::to_string))
            .unwrap_or_else(|| target.to_string());

        // A hard reset destroys uncommitted *tracked* work — snapshot it onto
        // the stash stack first, mirroring discardMany's safety net. Untracked
        // files survive a hard reset untouched, so a pure-WT_NEW entry doesn't
        // count as dirty and the snapshot skips untracked files (avoiding the
        // push+apply round-trip that can fail on Windows file locks).
        let mut snapshot_oid = None;
        if matches!(mode, ResetMode::Hard) {
            let dirty = repo
                .statuses(Some(&mut crate::status::status_options()))?
                .iter()
                .any(|e| {
                    !(e.status() & !(git2::Status::WT_NEW | git2::Status::IGNORED)).is_empty()
                });
            if dirty {
                let msg = format!("Safety: before hard reset to {target_short}");
                snapshot_oid = self.stash_snapshot(Some(&msg), false)?.oid;
            }
        }

        match mode {
            ResetMode::Soft => repo.reset(&obj, git2::ResetType::Soft, None)?,
            ResetMode::Mixed => repo.reset(&obj, git2::ResetType::Mixed, None)?,
            ResetMode::Hard => {
                let mut co = git2::build::CheckoutBuilder::new();
                co.force();
                repo.reset(&obj, git2::ResetType::Hard, Some(&mut co))?;
            }
        }

        Ok(ResetOutcome {
            target_short,
            snapshot_oid,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// Build a throwaway repo, configured enough to commit, and return its
    /// `Repo` + working dir. Std-only (no `tempfile` dev-dep), like `tag.rs`.
    fn scratch_repo() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-reset-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

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

    fn write_commit(dir: &Path, file: &str, contents: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), contents).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-q", "-m", msg]);
        git(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn soft_reset_moves_head_and_keeps_changes_staged() {
        let (repo, dir) = scratch_repo();
        let first = write_commit(&dir, "a.txt", "one\n", "first");
        write_commit(&dir, "a.txt", "two\n", "second");

        let outcome = repo.reset("HEAD~1", ResetMode::Soft).unwrap();
        assert!(outcome.snapshot_oid.is_none());
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), first);
        // The second commit's content stays staged ("M  <file>" in porcelain;
        // the git() helper trims, which only strips the unstaged leading space).
        let status = git(&dir, &["status", "--porcelain"]);
        assert_eq!(status, "M  a.txt", "expected staged change");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mixed_reset_leaves_changes_unstaged() {
        let (repo, dir) = scratch_repo();
        let first = write_commit(&dir, "a.txt", "one\n", "first");
        write_commit(&dir, "a.txt", "two\n", "second");

        repo.reset("HEAD~1", ResetMode::Mixed).unwrap();
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), first);
        // Porcelain " M <file>", with the leading space lost to git()'s trim.
        let status = git(&dir, &["status", "--porcelain"]);
        assert_eq!(status, "M a.txt", "expected unstaged change");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hard_reset_cleans_tree_and_snapshots_dirty_changes() {
        let (repo, dir) = scratch_repo();
        let first = write_commit(&dir, "a.txt", "one\n", "first");
        write_commit(&dir, "a.txt", "two\n", "second");
        // Dirty the tree (tracked change) so the safety snapshot fires.
        std::fs::write(dir.join("a.txt"), "wip\n").unwrap();

        let outcome = repo.reset("HEAD~1", ResetMode::Hard).unwrap();
        assert!(outcome.snapshot_oid.is_some(), "tracked-dirty hard reset takes a snapshot");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), first);
        assert_eq!(git(&dir, &["status", "--porcelain"]), "");
        // The snapshot is on the stash stack, ready to recover from.
        let stashes = repo.stash_list().unwrap();
        assert!(!stashes.is_empty(), "snapshot stash is on the stack");
        assert!(stashes[0].message.contains("Safety: before hard reset"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hard_reset_of_untracked_only_tree_takes_no_snapshot() {
        let (repo, dir) = scratch_repo();
        let first = write_commit(&dir, "a.txt", "one\n", "first");
        write_commit(&dir, "a.txt", "two\n", "second");
        // Untracked-only "dirt": `git reset --hard` never touches untracked
        // files, so no snapshot is needed (and none should be taken).
        std::fs::write(dir.join("new.txt"), "untracked\n").unwrap();

        let outcome = repo.reset("HEAD~1", ResetMode::Hard).unwrap();
        assert!(outcome.snapshot_oid.is_none(), "untracked-only tree needs no snapshot");
        assert!(repo.stash_list().unwrap().is_empty());
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), first);
        assert!(dir.join("new.txt").exists(), "untracked file survives the hard reset");
        assert_eq!(git(&dir, &["status", "--porcelain"]), "?? new.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hard_reset_of_clean_tree_takes_no_snapshot() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "a.txt", "one\n", "first");
        write_commit(&dir, "a.txt", "two\n", "second");

        let outcome = repo.reset("HEAD~1", ResetMode::Hard).unwrap();
        assert!(outcome.snapshot_oid.is_none());
        assert!(repo.stash_list().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_during_merge_in_progress_errors() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "a.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "a.txt", "feature\n", "feat");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "a.txt", "main\n", "main change");
        // Conflicting merge: exits non-zero and leaves MERGE_HEAD behind.
        let _ = Command::new("git")
            .current_dir(&dir)
            .args(["merge", "feature"])
            .output()
            .unwrap();

        let err = repo.reset("HEAD", ResetMode::Mixed).unwrap_err();
        assert!(
            err.to_string().contains("in-progress merge"),
            "unexpected error: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
