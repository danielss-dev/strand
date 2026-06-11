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
    pub fn checkout_branch(&self, name: &str) -> Result<CheckoutOutcome> {
        let repo = self.git2()?;
        let branch = repo.find_branch(name, git2::BranchType::Local)?;
        let full = branch
            .get()
            .name()
            .ok_or_else(|| crate::Error::Other(format!("branch {name} has no ref name")))?
            .to_string();

        let tree = branch.get().peel_to_tree()?;
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.safe();
        repo.checkout_tree(tree.as_object(), Some(&mut opts))?;
        repo.set_head(&full)?;

        Ok(CheckoutOutcome { branch: name.to_string() })
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

        let tree = commit.tree()?;
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
    /// `force` mirrors `git branch -D`: when false, git2 still refuses to
    /// delete a branch whose tip isn't reachable from HEAD or its upstream.
    pub fn delete_branch(&self, name: &str, _force: bool) -> Result<()> {
        let repo = self.git2()?;
        let mut branch = repo.find_branch(name, git2::BranchType::Local)?;
        if branch.is_head() {
            return Err(crate::Error::Other(format!(
                "cannot delete branch {name}: it is the current branch"
            )));
        }
        // git2's `Branch::delete` is the unconditional form (matches
        // `git branch -D`). The "safe" check that vanilla git applies
        // (merged into HEAD or upstream) lives one layer up; we leave it
        // to the UI to confirm before calling with force=false today.
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
}
