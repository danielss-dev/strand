use std::path::Path;

use crate::{error::Result, repo::Repo};

impl Repo {
    /// Stage `path` — adds new/modified files, records deletions. Mirrors
    /// `git add <path>` for one path at a time.
    pub fn stage_path(&self, path: &str) -> Result<()> {
        let repo = self.git2()?;
        let mut index = repo.index()?;

        let on_disk = repo.workdir().map(|w| w.join(path));
        let exists = on_disk.as_deref().map(Path::exists).unwrap_or(false);

        if exists {
            index.add_path(Path::new(path))?;
        } else {
            // File was deleted in the working tree. Mirror that in the index.
            index.remove_path(Path::new(path))?;
        }
        index.write()?;
        Ok(())
    }

    /// Stage many paths in one shot: open the repo + index once and write the
    /// index a single time, instead of the per-path open/read/write the store's
    /// old loop did. The difference is dramatic on a large changeset (e.g. a
    /// squash-merge staging hundreds of files) — one index write, not N.
    pub fn stage_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let repo = self.git2()?;
        let mut index = repo.index()?;
        let workdir = repo.workdir().map(Path::to_path_buf);
        for path in paths {
            let p = Path::new(path);
            let exists = workdir.as_deref().map(|w| w.join(path).exists()).unwrap_or(false);
            if exists {
                index.add_path(p)?;
            } else {
                index.remove_path(p)?;
            }
        }
        index.write()?;
        Ok(())
    }

    /// Unstage many paths in one shot. `reset_default` already takes a pathspec
    /// list, so the common (born-HEAD) case is a single call; the unborn-branch
    /// fallback drops the entries with one index write.
    pub fn unstage_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let repo = self.git2()?;
        match repo.head().ok().map(|h| h.peel_to_commit()) {
            None => {
                let mut index = repo.index()?;
                for path in paths {
                    let _ = index.remove_path(Path::new(path));
                }
                index.write()?;
            }
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(commit)) => {
                repo.reset_default(Some(commit.as_object()), paths.iter())?;
            }
        }
        Ok(())
    }

    /// Discard working-tree changes for many paths in one `checkout_index`
    /// (each path added as a pathspec). **Destructive** — undo is a frontend
    /// concern, as in [`discard_path`](Repo::discard_path).
    pub fn discard_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let repo = self.git2()?;
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force();
        for path in paths {
            opts.path(path);
        }
        repo.checkout_index(None, Some(&mut opts))?;
        Ok(())
    }

    /// Unstage `path` — reset the index entry for that path back to HEAD,
    /// without touching the working tree. Equivalent to
    /// `git restore --staged <path>`.
    pub fn unstage_path(&self, path: &str) -> Result<()> {
        let repo = self.git2()?;
        match repo.head().ok().map(|h| h.peel_to_commit()) {
            // No HEAD yet (unborn branch): just drop the index entry.
            None => {
                let mut index = repo.index()?;
                let _ = index.remove_path(Path::new(path));
                index.write()?;
            }
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(commit)) => {
                repo.reset_default(Some(commit.as_object()), [path])?;
            }
        }
        Ok(())
    }

    /// Discard working-tree changes for `path` — restore the file from the
    /// index. Mirrors `git checkout -- <path>`.
    ///
    /// **Destructive.** The UI is responsible for offering an undo affordance
    /// (we don't snapshot here; the toast undo path is a frontend concern).
    pub fn discard_path(&self, path: &str) -> Result<()> {
        let repo = self.git2()?;
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force().path(path);
        repo.checkout_index(None, Some(&mut opts))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::FileStatus;

    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-stage-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        // Configure an identity so `Repo::commit` (which reads `repo.signature()`)
        // works without relying on the machine's global git config.
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    fn staged_paths(status: &[FileStatus]) -> Vec<&str> {
        status.iter().filter(|s| s.staged).map(|s| s.path.as_str()).collect()
    }

    #[test]
    fn stage_paths_then_unstage_paths_round_trips_in_one_call_each() {
        let (repo, dir) = scratch_repo();
        let files: Vec<String> = (0..5).map(|i| format!("f{i}.txt")).collect();
        for f in &files {
            std::fs::write(dir.join(f), "x\n").unwrap();
        }

        // One batched stage call lands every path in the index.
        repo.stage_paths(&files).unwrap();
        let status = repo.status().unwrap();
        let mut staged = staged_paths(&status);
        staged.sort();
        assert_eq!(staged, vec!["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);

        // One batched unstage call clears them all again.
        repo.unstage_paths(&files).unwrap();
        assert!(repo.status().unwrap().iter().all(|s| !s.staged), "nothing staged after unstage");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stage_paths_records_a_deletion() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("keep.txt"), "x\n").unwrap();
        repo.stage_paths(&["keep.txt".into()]).unwrap();
        repo.commit("add keep", None, false).unwrap();

        // Delete on disk, then a batched stage should stage the removal.
        std::fs::remove_file(dir.join("keep.txt")).unwrap();
        repo.stage_paths(&["keep.txt".into()]).unwrap();
        let status = repo.status().unwrap();
        let entry = status.iter().find(|s| s.path == "keep.txt").expect("deletion tracked");
        assert!(entry.staged, "deletion is staged");

        let _ = std::fs::remove_dir_all(dir);
    }
}
