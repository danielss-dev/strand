use std::path::Path;

use crate::{error::Result, repo::Repo};

impl Repo {
    /// Stage `path` — adds new/modified files, records deletions. Mirrors
    /// `git add <path>` for one path at a time.
    pub fn stage_path(&self, path: &str) -> Result<()> {
        if self.is_lfs_path(Path::new(path))? {
            return self.stage_lfs_paths(&[path.to_owned()]);
        }
        if self.sparse_enabled() { return self.stage_paths(&[path.into()]); }
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
        for path in paths {
            if self.is_lfs_path(Path::new(path))? {
                return self.stage_lfs_paths(paths);
            }
        }
        if self.sparse_enabled() {
            let mut args = vec!["--literal-pathspecs", "add", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.sparse_git(&args, None)?;
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
        if self.sparse_enabled() {
            let mut args = vec!["--literal-pathspecs", "restore", "--staged", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.sparse_git(&args, None)?;
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
    /// (each path added as a pathspec). Untracked paths have no index entry
    /// for checkout to restore from — `checkout_index` would silently skip
    /// them — so "discard" for those means deleting the file from disk, the
    /// same way `git clean` would. **Destructive** — undo is a frontend
    /// concern, as in [`discard_path`](Repo::discard_path).
    pub fn discard_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let repo = self.git2()?;
        let index = repo.index()?;
        let workdir = repo.workdir().map(Path::to_path_buf);
        let mut tracked: Vec<&str> = Vec::new();
        for path in paths {
            if index.get_path(Path::new(path), 0).is_some() {
                tracked.push(path);
            } else if let Some(w) = workdir.as_deref() {
                match std::fs::remove_file(w.join(path)) {
                    Ok(()) => {}
                    // Already gone (e.g. a stale status entry) — nothing to do.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        if !tracked.is_empty() {
            for path in &tracked {
                if self.is_lfs_path(Path::new(path))? {
                    return self.discard_lfs_paths(&tracked);
                }
            }
            if self.sparse_enabled() {
                let mut args = vec!["--literal-pathspecs", "checkout-index", "--force", "--"];
                args.extend(tracked);
                self.sparse_git(&args, None)?;
                return Ok(());
            }
            let mut opts = git2::build::CheckoutBuilder::new();
            // This command opened a fresh repository + index above, so there
            // is nothing stale to refresh. More importantly, libgit2's refresh
            // can walk unrelated ignored directories and hit its legacy
            // MAX_PATH guard on Windows before it checks the pathspec.
            opts.force().refresh(false);
            for path in &tracked {
                opts.path(path);
            }
            if let Err(error) = repo.checkout_index(None, Some(&mut opts)) {
                #[cfg(windows)]
                if is_windows_path_too_long(&error) {
                    checkout_index_with_system_git(self, &tracked)?;
                } else {
                    return Err(error.into());
                }
                #[cfg(not(windows))]
                return Err(error.into());
            }
        }
        Ok(())
    }

    /// Unstage `path` — reset the index entry for that path back to HEAD,
    /// without touching the working tree. Equivalent to
    /// `git restore --staged <path>`.
    pub fn unstage_path(&self, path: &str) -> Result<()> {
        if self.sparse_enabled() { return self.unstage_paths(&[path.into()]); }
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
    /// index (mirrors `git checkout -- <path>`), or delete it if untracked.
    ///
    /// **Destructive.** The UI is responsible for offering an undo affordance
    /// (we don't snapshot here; the toast undo path is a frontend concern).
    pub fn discard_path(&self, path: &str) -> Result<()> {
        self.discard_paths(&[path.to_owned()])
    }
}

#[cfg(windows)]
fn is_windows_path_too_long(error: &git2::Error) -> bool {
    error.class() == git2::ErrorClass::Filesystem
        && error
            .message()
            .to_ascii_lowercase()
            .contains("path too long")
}

#[cfg(windows)]
fn checkout_index_with_system_git(repo: &Repo, paths: &[&str]) -> Result<()> {
    let mut args = vec![
        "-c".to_string(),
        "core.longpaths=true".to_string(),
        "checkout-index".to_string(),
        "--force".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| (*path).to_string()));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    repo.run_git(&refs)?;
    Ok(())
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
    fn discard_paths_deletes_untracked_and_restores_tracked() {
        let (repo, dir) = scratch_repo();
        // Tracked file with a local edit…
        std::fs::write(dir.join("tracked.txt"), "clean\n").unwrap();
        repo.stage_paths(&["tracked.txt".into()]).unwrap();
        repo.commit("add tracked", None, false).unwrap();
        std::fs::write(dir.join("tracked.txt"), "dirty\n").unwrap();
        // …plus an untracked file, discarded together in one call.
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();

        repo.discard_paths(&["tracked.txt".into(), "untracked.txt".into()]).unwrap();

        let restored = std::fs::read_to_string(dir.join("tracked.txt")).unwrap();
        // autocrlf may rewrite line endings on checkout — compare normalized.
        assert_eq!(restored.replace("\r\n", "\n"), "clean\n");
        assert!(!dir.join("untracked.txt").exists(), "untracked file deleted from disk");
        // Discarding an already-gone path is a no-op, not an error.
        repo.discard_paths(&["untracked.txt".into()]).unwrap();

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn system_git_checkout_restores_with_unrelated_long_ignored_path() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("tracked.txt"), "clean\n").unwrap();
        repo.stage_paths(&["tracked.txt".into()]).unwrap();
        repo.commit("add tracked", None, false).unwrap();
        std::fs::write(dir.join("tracked.txt"), "dirty\n").unwrap();

        let ignored = dir
            .join(".claude/worktrees/generated/node_modules/.pnpm")
            .join("react-resizable-panels@2.1.9_react-dom@18.3.1_react@18.3.1__react@18.3.1")
            .join("node_modules/react-resizable-panels/dist/declarations/src/utils/dom");
        std::fs::create_dir_all(&ignored).unwrap();
        std::fs::write(
            ignored.join("getResizeHandleElementsForGroup.d.ts"),
            "generated\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(".claude/worktrees/generated/.git"),
            "gitdir: nowhere\n",
        )
        .unwrap();
        std::fs::write(dir.join(".git/info/exclude"), ".claude/worktrees/\n").unwrap();

        checkout_index_with_system_git(&repo, &["tracked.txt"]).unwrap();

        let restored = std::fs::read_to_string(dir.join("tracked.txt")).unwrap();
        assert_eq!(restored.replace("\r\n", "\n"), "clean\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_long_path_checkout_error_is_detected_narrowly() {
        let long_path = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Filesystem,
            "path too long: 'generated/file'",
        );
        assert!(is_windows_path_too_long(&long_path));

        let other_filesystem = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Filesystem,
            "permission denied",
        );
        assert!(!is_windows_path_too_long(&other_filesystem));

        let wrong_class = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Checkout,
            "path too long",
        );
        assert!(!is_windows_path_too_long(&wrong_class));
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
