//! Working-tree renames / moves — powers drag-and-drop (and the Rename
//! dialog) in the sidebar Files tree.
//!
//! Tracked sources shell out to `git mv` so the index entry moves with the
//! file (staged content preserved, directory moves handled natively, and
//! case-only renames work on case-insensitive filesystems). Untracked
//! sources are a plain filesystem rename that git picks up on the next
//! status walk.

use std::path::{Path, PathBuf};

use crate::{error::Result, repo::Repo, Error};

impl Repo {
    /// Move / rename `from` to `to` (both workdir-relative, `/`-separated).
    /// `to` is the full destination path including the new name, not a
    /// directory to move into. Missing destination parent directories are
    /// created (git doesn't track empty directories, so this is inert on
    /// its own). Refuses to overwrite an existing destination.
    pub fn move_path(&self, from: &str, to: &str) -> Result<()> {
        let from = from.trim_end_matches('/');
        let to = to.trim_end_matches('/');
        if from.is_empty() || to.is_empty() {
            return Err(Error::Other("move: empty path".into()));
        }
        if from == to {
            return Err(Error::Other("move: source and destination are the same".into()));
        }

        let full_from = self.safe_workdir_path(from)?;
        let full_to = self.safe_dest_path(to)?;

        // `exists()` follows symlinks; a dangling in-tree symlink is still a
        // movable entry, so probe with symlink_metadata.
        if std::fs::symlink_metadata(&full_from).is_err() {
            return Err(Error::Other(format!("move: {from} does not exist")));
        }
        if std::fs::symlink_metadata(&full_to).is_ok() {
            // On a case-insensitive filesystem a case-only rename resolves the
            // destination to the source itself — that's a legal rename, not a
            // collision.
            let same = match (full_from.canonicalize(), full_to.canonicalize()) {
                (Ok(a), Ok(b)) => a == b,
                _ => false,
            };
            if !same {
                return Err(Error::Other(format!("move: {to} already exists")));
            }
        }

        if let Some(parent) = full_to.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Tracked (any index entry at `from` or under `from/`, conflict
        // stages included) → `git mv` keeps the index in sync. Untracked →
        // plain rename; there is no index entry to move.
        if self.index_has(from)? {
            self.run_git(&["mv", "--", from, to])?;
        } else {
            std::fs::rename(&full_from, &full_to)?;
        }
        Ok(())
    }

    /// Whether the index holds `rel` itself or anything under `rel/`.
    fn index_has(&self, rel: &str) -> Result<bool> {
        let index = self.git2()?.index()?;
        let exact = rel.as_bytes();
        let prefix: Vec<u8> = [exact, b"/"].concat();
        Ok(index
            .iter()
            .any(|e| e.path == exact || e.path.starts_with(&prefix)))
    }

    /// [`safe_workdir_path`](Repo::safe_workdir_path) for a destination whose
    /// parent directories may not exist yet: canonicalize the nearest
    /// *existing* ancestor instead of the immediate parent, so `new/dir/file`
    /// validates while `../escape` and symlink escapes still fail.
    fn safe_dest_path(&self, rel_path: &str) -> Result<PathBuf> {
        let p = Path::new(rel_path);
        if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(Error::Other(format!("invalid path: {rel_path}")));
        }
        let full = self.path.join(p);

        let root = self
            .path
            .canonicalize()
            .map_err(|e| Error::Other(format!("cannot resolve working tree: {e}")))?;
        let probe = full
            .ancestors()
            .find(|a| a.exists())
            .unwrap_or(self.path.as_path());
        let resolved = probe
            .canonicalize()
            .map_err(|e| Error::Other(format!("invalid path: {rel_path} ({e})")))?;
        if !resolved.starts_with(&root) {
            return Err(Error::Other(format!("path escapes working tree: {rel_path}")));
        }
        Ok(full)
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    /// Throwaway repo with identity config so commits work; std-only temp
    /// dir (no `tempfile` dev-dep), like the other module tests.
    fn scratch_repo(tag: &str) -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-rename-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g2 = git2::Repository::init(&dir).unwrap();
        let mut cfg = g2.config().unwrap();
        cfg.set_str("user.name", "Test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    fn commit_all(dir: &Path) {
        let g2 = git2::Repository::open(dir).unwrap();
        let mut index = g2.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = g2.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = g2.signature().unwrap();
        let parent = g2.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        g2.commit(Some("HEAD"), &sig, &sig, "c", &tree, &parents).unwrap();
    }

    fn index_paths(dir: &Path) -> Vec<String> {
        let g2 = git2::Repository::open(dir).unwrap();
        let index = g2.index().unwrap();
        index
            .iter()
            .map(|e| String::from_utf8_lossy(&e.path).into_owned())
            .collect()
    }

    #[test]
    fn moves_tracked_file_and_index_follows() {
        let (repo, dir) = scratch_repo("tracked");
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        commit_all(&dir);

        repo.move_path("a.txt", "sub/b.txt").unwrap();

        assert!(!dir.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("sub/b.txt")).unwrap(), "hello");
        let idx = index_paths(&dir);
        assert!(idx.contains(&"sub/b.txt".to_string()), "index: {idx:?}");
        assert!(!idx.contains(&"a.txt".to_string()), "index: {idx:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn moves_untracked_file_without_touching_index() {
        let (repo, dir) = scratch_repo("untracked");
        std::fs::write(dir.join("u.txt"), "u").unwrap();

        repo.move_path("u.txt", "moved/u.txt").unwrap();

        assert!(!dir.join("u.txt").exists());
        assert!(dir.join("moved/u.txt").exists());
        assert!(index_paths(&dir).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn moves_directory_with_tracked_and_untracked_content() {
        let (repo, dir) = scratch_repo("dir");
        std::fs::create_dir_all(dir.join("pkg")).unwrap();
        std::fs::write(dir.join("pkg/one.txt"), "1").unwrap();
        commit_all(&dir);
        std::fs::write(dir.join("pkg/two.txt"), "2").unwrap(); // untracked

        repo.move_path("pkg", "renamed").unwrap();

        assert!(!dir.join("pkg").exists());
        assert!(dir.join("renamed/one.txt").exists());
        assert!(dir.join("renamed/two.txt").exists());
        let idx = index_paths(&dir);
        assert!(idx.contains(&"renamed/one.txt".to_string()), "index: {idx:?}");
        assert!(!idx.contains(&"pkg/one.txt".to_string()), "index: {idx:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_overwrite_missing_source_and_noop() {
        let (repo, dir) = scratch_repo("guards");
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        std::fs::write(dir.join("b.txt"), "b").unwrap();

        assert!(repo.move_path("a.txt", "b.txt").is_err(), "must not overwrite");
        assert!(repo.move_path("ghost.txt", "c.txt").is_err(), "missing source");
        assert!(repo.move_path("a.txt", "a.txt").is_err(), "same path");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "b");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let (repo, dir) = scratch_repo("traversal");
        std::fs::write(dir.join("a.txt"), "a").unwrap();

        assert!(repo.move_path("a.txt", "../escape.txt").is_err());
        assert!(repo.move_path("../outside.txt", "in.txt").is_err());
        let abs = dir.join("abs.txt");
        assert!(repo.move_path("a.txt", abs.to_str().unwrap()).is_err());
        assert!(dir.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
