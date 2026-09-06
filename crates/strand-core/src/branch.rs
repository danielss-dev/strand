//! Branch writes — checkout, create, delete.
//!
//! All ops go through `git2` so we get a stable Rust API and avoid spawning
//! the user's `git` for index-touching work. Network ops still shell out
//! (see `network.rs`) so credentials and hooks come along for free.

use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutOutcome {
    /// Branch we ended up on (short name).
    pub branch: String,
}

impl Repo {
    /// Check out an existing local branch by short name (e.g. `main`).
    ///
    /// Uses a safe checkout — if the working tree has changes that would be
    /// overwritten, this errors instead of clobbering them. The UI is
    /// responsible for offering a force/stash escape hatch.
    ///
    /// A branch that is HEAD of another worktree is rejected up front (same
    /// rule as `git switch`). libgit2 only enforces this at `set_head` —
    /// *after* `checkout_tree` has rewritten the workdir and index — which
    /// would strand the repo half-switched: HEAD on the old branch, files on
    /// the new one, and every later safe checkout failing with phantom
    /// conflicts. git2-rs doesn't bind `git_branch_is_checked_out`, so the
    /// check goes through the worktree registry; a registry read failure
    /// falls through (the rollback below still protects the repo).
    pub fn checkout_branch(&self, name: &str) -> Result<CheckoutOutcome> {
        if self.sparse_enabled() || self.is_partial_clone() {
            self.git2()?.find_branch(name, git2::BranchType::Local)?;
            crate::network::run_git_streaming(&self.path, &["switch", "--", name], |_| {}, None)?;
            return Ok(CheckoutOutcome { branch: name.into() });
        }
        if let Some(wt) = self
            .worktrees()
            .unwrap_or_default()
            .into_iter()
            .find(|w| !w.is_current && w.branch.as_deref() == Some(name))
        {
            return Err(crate::Error::Other(format!(
                "branch {name} is already checked out in worktree {}",
                wt.path
            )));
        }

        let repo = self.git2()?;
        let branch = repo.find_branch(name, git2::BranchType::Local)?;
        let full = branch
            .get()
            .name()
            .ok_or_else(|| crate::Error::Other(format!("branch {name} has no ref name")))?
            .to_string();

        // Kept for the rollback path: what the workdir/index looked like
        // before we touch anything.
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

        let tree = branch.get().peel_to_tree()?;
        if self.lfs_checkout_needed(&tree)? {
            self.run_lfs_filtered(&["checkout", name, "--"])?;
            return Ok(CheckoutOutcome { branch: name.to_string() });
        }
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.safe();
        repo.checkout_tree(tree.as_object(), Some(&mut opts))?;
        if let Err(e) = repo.set_head(&full) {
            // checkout_tree already rewrote workdir + index; put them back so
            // a refused HEAD move can't leave the repo half-switched. Restore
            // only the paths that differ between the two trees — any file the
            // safe checkout carried local modifications over on is identical
            // in both trees (it would have conflicted otherwise), so scoping
            // the force to the diff can't clobber user changes.
            if let Some(orig) = head_tree {
                let _ = Self::restore_tree_diff(repo, &orig, &tree);
            }
            return Err(e.into());
        }

        Ok(CheckoutOutcome { branch: name.to_string() })
    }

    /// Force-checkout `orig` for just the paths that differ between `orig`
    /// and `switched` — the rollback half of [`checkout_branch`]'s failed
    /// `set_head`. Returns Ok even when there is nothing to restore.
    ///
    /// [`checkout_branch`]: Repo::checkout_branch
    fn restore_tree_diff(
        repo: &git2::Repository,
        orig: &git2::Tree<'_>,
        switched: &git2::Tree<'_>,
    ) -> std::result::Result<(), git2::Error> {
        let diff = repo.diff_tree_to_tree(Some(orig), Some(switched), None)?;
        let mut restore = git2::build::CheckoutBuilder::new();
        restore.force();
        let mut any = false;
        for delta in diff.deltas() {
            for file in [delta.old_file(), delta.new_file()] {
                if let Some(p) = file.path() {
                    restore.path(p);
                    any = true;
                }
            }
        }
        if any {
            repo.checkout_tree(orig.as_object(), Some(&mut restore))?;
        }
        Ok(())
    }

    /// Create a new local branch.
    ///
    /// - `start_point` is any revspec git understands (`HEAD`, a commit OID,
    ///   a branch name, `origin/foo`). Defaults to `HEAD`.
    /// - When `start_point` resolves through a remote-tracking branch, the
    ///   new branch is set to track it automatically — matching what
    ///   `git checkout -b foo origin/foo` does.
    /// - If `checkout` is true, also switches HEAD onto the new branch.
    pub fn create_branch(
        &self,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<CheckoutOutcome> {
        let repo = self.git2()?;

        let target_rev = start_point.unwrap_or("HEAD");
        let target = repo.revparse_single(target_rev)?;
        let target_commit = target.peel_to_commit()?;

        let mut branch = repo.branch(name, &target_commit, false)?;

        // If the start point was a remote-tracking branch, wire up upstream
        // so push/pull pick the right remote without extra UI.
        if let Some(rev) = start_point {
            if repo
                .find_branch(rev, git2::BranchType::Remote)
                .is_ok()
            {
                let _ = branch.set_upstream(Some(rev));
            }
        }

        if checkout {
            self.checkout_branch(name)?;
        }
        Ok(CheckoutOutcome { branch: name.to_string() })
    }

    /// Check out an arbitrary commit (any revspec git understands — an OID,
    /// `HEAD~3`, a tag) as a **detached HEAD**. Like [`checkout_branch`] this
    /// is a safe checkout: it errors rather than clobbering conflicting
    /// working-tree changes. The returned `branch` is the short OID, which is
    /// what the topbar shows while detached.
    ///
    /// [`checkout_branch`]: Repo::checkout_branch
    pub fn checkout_commit(&self, rev: &str) -> Result<CheckoutOutcome> {
        let repo = self.git2()?;
        let commit = repo.revparse_single(rev)?.peel_to_commit()?;

        if self.sparse_enabled() || self.is_partial_clone() {
            let oid = commit.id().to_string();
            crate::network::run_git_streaming(&self.path, &["switch", "--detach", &oid], |_| {}, None)?;
            return Ok(CheckoutOutcome { branch: oid[..7].into() });
        }

        let tree = commit.tree()?;
        if self.lfs_checkout_needed(&tree)? {
            let oid = commit.id().to_string();
            self.run_lfs_filtered(&["checkout", "--detach", &oid, "--"])?;
            return Ok(CheckoutOutcome { branch: oid[..7].to_string() });
        }
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.safe();
        repo.checkout_tree(tree.as_object(), Some(&mut opts))?;
        repo.set_head_detached(commit.id())?;

        let oid = commit.id().to_string();
        Ok(CheckoutOutcome {
            branch: oid[..7.min(oid.len())].to_string(),
        })
    }

    /// Delete a local branch by short name. Refuses to delete the current
    /// branch — git can't either, since HEAD would be left dangling.
    ///
    /// `force` mirrors `git branch -D`. Without it, re-check that the branch
    /// tip is contained by the repository's primary branch at deletion time.
    /// This keeps a confirmation opened from stale UI state from deleting a
    /// branch that moved in the meantime.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        let repo = self.git2()?;
        let mut branch = repo.find_branch(name, git2::BranchType::Local)?;
        if branch.is_head() {
            return Err(crate::Error::Other(format!(
                "cannot delete branch {name}: it is the current branch"
            )));
        }
        if let Some(worktree) = self
            .worktrees()
            .unwrap_or_default()
            .into_iter()
            .find(|worktree| !worktree.is_current && worktree.branch.as_deref() == Some(name))
        {
            return Err(crate::Error::Other(format!(
                "cannot delete branch {name}: it is checked out in worktree {}",
                worktree.path
            )));
        }
        // git2's `Branch::delete` is unconditional, so the safe form must be
        // enforced explicitly before calling it.
        if !force {
            let refs = self.refs()?;
            if !refs
                .branches
                .iter()
                .any(|candidate| candidate.name == name && candidate.merged)
            {
                let target = refs
                    .primary_branch
                    .as_deref()
                    .unwrap_or("the primary branch");
                return Err(crate::Error::Other(format!(
                    "cannot delete branch {name}: it is not merged into {target}"
                )));
            }
        }
        branch.delete()?;
        Ok(())
    }

    /// Delete a provider-confirmed merged branch only while it still points at
    /// the exact source commit the provider reported. This is the squash/rebase
    /// merge counterpart to [`delete_branch`]'s ancestry guard.
    pub fn delete_branch_at(&self, name: &str, expected_target: &str) -> Result<()> {
        let expected = git2::Oid::from_str(expected_target)?;
        let repo = self.git2()?;
        let mut branch = repo.find_branch(name, git2::BranchType::Local)?;
        if branch.is_head() {
            return Err(crate::Error::Other(format!(
                "cannot delete branch {name}: it is the current branch"
            )));
        }
        if let Some(worktree) = self
            .worktrees()
            .unwrap_or_default()
            .into_iter()
            .find(|worktree| !worktree.is_current && worktree.branch.as_deref() == Some(name))
        {
            return Err(crate::Error::Other(format!(
                "cannot delete branch {name}: it is checked out in worktree {}",
                worktree.path
            )));
        }
        let actual = branch.get().target().ok_or_else(|| {
            crate::Error::Other(format!("cannot delete branch {name}: it has no commit target"))
        })?;
        if actual != expected {
            return Err(crate::Error::Other(format!(
                "cannot delete branch {name}: it moved after its pull request was checked; refresh and try again"
            )));
        }
        branch.delete()?;
        Ok(())
    }

    /// Rename a local branch (`git branch -m <old> <new>`). git2 moves the
    /// branch's config section (upstream) along, and HEAD follows when the
    /// renamed branch is checked out. No force — errors if `new` exists.
    pub fn rename_branch(&self, old: &str, new: &str) -> Result<()> {
        let new = new.trim();
        if new.is_empty() {
            return Err(crate::Error::Other("branch name is required".into()));
        }
        let repo = self.git2()?;
        let mut branch = repo.find_branch(old, git2::BranchType::Local)?;
        branch.rename(new, false)?;
        Ok(())
    }

    /// Set, change, or unset the tracking branch for any local branch.
    /// `upstream` uses Git's short remote-branch spelling (`origin/main`).
    /// Passing `None` removes both branch remote/merge config entries.
    pub fn set_branch_upstream(&self, name: &str, upstream: Option<&str>) -> Result<()> {
        let repo = self.git2()?;
        let mut branch = repo.find_branch(name, git2::BranchType::Local)?;
        if let Some(upstream) = upstream {
            repo.find_branch(upstream, git2::BranchType::Remote)?;
            branch.set_upstream(Some(upstream))?;
        } else {
            branch.set_upstream(None)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// Throwaway repo built with shell git (so `--set-upstream-to` is
    /// available), std-only temp dir — same fixture as `history.rs`.
    fn scratch_repo() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-branch-test-{}-{:?}",
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

    #[test]
    fn checkout_refuses_branch_of_linked_worktree_without_touching_workdir() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["branch", "feature"]);

        let wt = dir.with_file_name(format!(
            "{}-wt",
            dir.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        git(&dir, &["worktree", "add", wt.to_str().unwrap(), "feature"]);

        let err = repo.checkout_branch("feature").unwrap_err();
        assert!(
            err.to_string().contains("checked out in worktree"),
            "unexpected error: {err}"
        );
        // The guard fires before checkout_tree, so nothing was mutated:
        // HEAD still on main and the workdir/index are clean.
        assert_eq!(git(&dir, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert_eq!(git(&dir, &["status", "--porcelain"]), "");
        let err = repo.delete_branch("feature", true).unwrap_err();
        assert!(err.to_string().contains("checked out in worktree"));
        assert!(repo
            .refs()
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "feature"));

        git(&dir, &["worktree", "remove", wt.to_str().unwrap()]);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn rename_branch_moves_upstream_config_and_head_follows() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        // Non-head branch with an upstream: the config moves with the rename.
        git(&dir, &["branch", "feature"]);
        git(&dir, &["branch", "--set-upstream-to=main", "feature"]);
        repo.rename_branch("feature", "renamed").unwrap();
        assert_eq!(git(&dir, &["config", "branch.renamed.merge"]), "refs/heads/main");
        let branches = repo.refs().unwrap().branches;
        assert!(branches.iter().any(|b| b.name == "renamed"));
        assert!(!branches.iter().any(|b| b.name == "feature"));

        // Renaming onto an existing name errors (no force).
        assert!(repo.rename_branch("renamed", "main").is_err());
        // Blank target is rejected.
        assert!(repo.rename_branch("renamed", "  ").is_err());

        // Renaming the HEAD branch works and HEAD follows.
        repo.rename_branch("main", "trunk").unwrap();
        assert_eq!(git(&dir, &["symbolic-ref", "HEAD"]), "refs/heads/trunk");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sets_changes_and_unsets_a_branch_upstream() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["branch", "feature"]);
        git(&dir, &["branch", "other"]);

        let remote = dir.with_file_name(format!(
            "{}-remote.git",
            dir.file_name().unwrap().to_string_lossy()
        ));
        let _ = std::fs::remove_dir_all(&remote);
        git(&dir, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&dir, &["push", "-q", "origin", "main", "other"]);
        git(&dir, &["fetch", "-q", "origin"]);

        repo.set_branch_upstream("feature", Some("origin/main")).unwrap();
        let branch = repo.refs().unwrap().branches.into_iter().find(|b| b.name == "feature").unwrap();
        assert_eq!(branch.upstream.unwrap().name, "origin/main");

        repo.set_branch_upstream("feature", Some("origin/other")).unwrap();
        let branch = repo.refs().unwrap().branches.into_iter().find(|b| b.name == "feature").unwrap();
        assert_eq!(branch.upstream.unwrap().name, "origin/other");

        repo.set_branch_upstream("feature", None).unwrap();
        let branch = repo.refs().unwrap().branches.into_iter().find(|b| b.name == "feature").unwrap();
        assert!(branch.upstream.is_none());

        drop(repo);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(remote);
    }

    #[test]
    fn safe_delete_rechecks_primary_branch_containment() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);

        git(&dir, &["switch", "-q", "-c", "unmerged"]);
        std::fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        git(&dir, &["add", "feature.txt"]);
        git(&dir, &["commit", "-q", "-m", "feature"]);
        git(&dir, &["switch", "-q", "main"]);

        let err = repo.delete_branch("unmerged", false).unwrap_err();
        assert!(err.to_string().contains("not merged into main"));
        assert!(repo
            .refs()
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "unmerged"));

        git(
            &dir,
            &["merge", "-q", "--no-ff", "unmerged", "-m", "merge feature"],
        );
        repo.delete_branch("unmerged", false).unwrap();
        assert!(!repo
            .refs()
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "unmerged"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn provider_merged_delete_requires_the_exact_unchanged_tip() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        git(&dir, &["branch", "squashed"]);
        let target = git(&dir, &["rev-parse", "squashed"]);

        let err = repo
            .delete_branch_at("squashed", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .unwrap_err();
        assert!(err.to_string().contains("it moved"));
        assert!(repo
            .refs()
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "squashed"));

        repo.delete_branch_at("squashed", &target).unwrap();
        assert!(!repo
            .refs()
            .unwrap()
            .branches
            .iter()
            .any(|branch| branch.name == "squashed"));

        let _ = std::fs::remove_dir_all(dir);
    }
}
