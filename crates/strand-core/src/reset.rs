//! `git reset` — move HEAD (and per mode the index / working tree) to a
//! target commit.
//!
//! Hard resets snapshot tracked changes and refuse collisions with untracked
//! or ignored data. Unrelated untracked entries remain untouched; snapshots
//! use `stash create` without a working-tree push/apply round trip.

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

        // Reject untracked/ignored collisions before even taking a snapshot.
        // This guard applies to libgit2, sparse, partial-clone and LFS resets.
        let mut snapshot_oid = None;
        if matches!(mode, ResetMode::Hard) {
            if self.sparse_enabled() { self.sparse_read_index(repo)?; }
            guard_reset_tree(repo, &repo.index()?, &obj.peel_to_tree()?, self.path(), std::path::Path::new(""))?;
            let dirty = if self.sparse_enabled() {
                self.status()?.iter().any(|entry| entry.kind != crate::status::StatusKind::Untracked)
            } else { repo
                .statuses(Some(&mut crate::status::status_options()))?
                .iter()
                .any(|e| {
                    !(e.status() & !(git2::Status::WT_NEW | git2::Status::IGNORED)).is_empty()
                }) };
            if dirty {
                let msg = format!("Safety: before hard reset to {target_short}");
                snapshot_oid = self.stash_snapshot(Some(&msg), false)?.oid;
            }
        }

        if self.sparse_enabled() || self.is_partial_clone() {
            let flag = match mode { ResetMode::Soft => "--soft", ResetMode::Mixed => "--mixed", ResetMode::Hard => "--hard" };
            crate::network::run_git_streaming(&self.path, &["reset", flag, &obj.id().to_string(), "--"], |_| {}, None)?;
        } else { match mode {
            ResetMode::Soft => repo.reset(&obj, git2::ResetType::Soft, None)?,
            ResetMode::Mixed => repo.reset(&obj, git2::ResetType::Mixed, None)?,
            ResetMode::Hard => {
                if self.lfs_checkout_needed(&obj.peel_to_tree()?)? {
                    self.run_lfs_filtered(&["reset", "--hard", &obj.id().to_string(), "--"])?;
                } else {
                    let mut co = git2::build::CheckoutBuilder::new();
                    co.force();
                    repo.reset(&obj, git2::ResetType::Hard, Some(&mut co))?;
                }
            }
        } }

        Ok(ResetOutcome {
            target_short,
            snapshot_oid,
        })
    }
}

fn collision(path: &std::path::Path) -> Error {
    Error::Other(format!("Hard reset would overwrite untracked or ignored data at {}. Move or commit it before retrying.", path.display()))
}

/// Inspect only target paths and directories that would be replaced. In
/// particular, do not enumerate unrelated ignored build/dependency trees.
fn guard_reset_tree(repo: &git2::Repository, index: &git2::Index, tree: &git2::Tree<'_>, root: &std::path::Path, parent: &std::path::Path) -> Result<()> {
    for entry in tree.iter() {
        #[cfg(unix)]
        let name = {
            use std::os::unix::ffi::OsStrExt;
            std::ffi::OsStr::from_bytes(entry.name_bytes())
        };
        #[cfg(not(unix))]
        let name = entry.name().ok_or_else(|| Error::Other("Cannot safely reset a non-UTF-8 target path".into()))?;
        let rel = parent.join(name);
        let metadata = match std::fs::symlink_metadata(root.join(&rel)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if entry.kind() == Some(git2::ObjectType::Tree) && metadata.is_dir() {
            guard_reset_tree(repo, index, &repo.find_tree(entry.id())?, root, &rel)?;
        } else if metadata.is_dir() && entry.kind() != Some(git2::ObjectType::Commit) {
            guard_replaced_directory(index, root, &rel)?;
        } else if index.get_path(&rel, 0).is_none() {
            return Err(collision(&rel));
        }
        // A tracked file/symlink blocking a target directory is itself
        // snapshotted; never follow it to inspect external descendants.
    }
    Ok(())
}

fn guard_replaced_directory(index: &git2::Index, root: &std::path::Path, rel: &std::path::Path) -> Result<()> {
    for child in std::fs::read_dir(root.join(rel))? {
        let child = child?;
        let path = rel.join(child.file_name());
        if child.file_type()?.is_dir() {
            guard_replaced_directory(index, root, &path)?;
        } else if index.get_path(&path, 0).is_none() {
            return Err(collision(&path));
        }
    }
    Ok(())
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
        // An unrelated untracked file survives; no snapshot is needed.
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
    #[test]
    fn hard_reset_refuses_untracked_and_ignored_target_collisions() {
        // Exercise both the normal and sparse-index dispatches, before any
        // reset/filter command can modify HEAD, the index or working bytes.
        for sparse in [false, true] {
            for ignored in [false, true] {
                let (_repo, dir) = scratch_repo();
                std::fs::create_dir_all(dir.join("included")).unwrap();
                std::fs::create_dir_all(dir.join("excluded")).unwrap();
                std::fs::write(dir.join("included/file"), "included").unwrap();
                std::fs::write(dir.join("excluded/file"), "excluded").unwrap();
                git(&dir, &["add", "included", "excluded"]);
                write_commit(&dir, "collision", "committed", "target");
                git(&dir, &["rm", "collision"]);
                std::fs::write(dir.join("keep"), "keep").unwrap();
                git(&dir, &["add", "keep"]);
                git(&dir, &["commit", "-qm", "remove collision"]);
                if sparse {
                    git(&dir, &["sparse-checkout", "set", "--cone", "--sparse-index", "included"]);
                    assert!(git(&dir, &["ls-files", "--sparse"]).contains("excluded/"));
                }
                if ignored { std::fs::write(dir.join(".git/info/exclude"), "collision\n").unwrap(); }
                std::fs::write(dir.join("collision"), "irreplaceable").unwrap();
                let head = git(&dir, &["rev-parse", "HEAD"]);
                let index = std::fs::read(dir.join(".git/index")).unwrap();
                let repo = Repo::discover(&dir).unwrap();
                let error = repo.reset("HEAD~1", ResetMode::Hard).unwrap_err();
                assert!(error.to_string().contains("untracked or ignored"), "{error}");
                assert_eq!(std::fs::read_to_string(dir.join("collision")).unwrap(), "irreplaceable");
                assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
                assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
                assert!(repo.stash_list().unwrap().is_empty());
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn hard_reset_refuses_file_directory_collisions_but_keeps_unrelated_data() {
        for target_directory in [false, true] {
            let (_repo, dir) = scratch_repo();
            if target_directory { std::fs::create_dir(dir.join("target")).unwrap(); }
            let path = if target_directory { "target/file" } else { "target" };
            write_commit(&dir, path, "old", "target");
            git(&dir, &["rm", "-r", "target"]);
            git(&dir, &["commit", "-qm", "remove target"]);
            let untracked = if target_directory { "target" } else { "target/ignored/local" };
            if !target_directory { std::fs::create_dir_all(dir.join("target/ignored")).unwrap(); }
            std::fs::write(dir.join(".git/info/exclude"), "target\n").unwrap();
            std::fs::write(dir.join(untracked), "keep").unwrap();
            let repo = Repo::discover(&dir).unwrap();
            assert!(repo.reset("HEAD~1", ResetMode::Hard).is_err());
            assert_eq!(std::fs::read_to_string(dir.join(untracked)).unwrap(), "keep");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

}
