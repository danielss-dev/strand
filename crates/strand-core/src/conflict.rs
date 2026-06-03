//! Conflict resolution support — read a conflicted file's raw text (with its
//! `<<<<<<<` / `=======` / `>>>>>>>` markers) and write back the resolved
//! contents, marking the file resolved by staging it.
//!
//! The *resolution choices* (accept current / incoming / both) are made in the
//! UI via `@pierre/diffs`' conflict primitive, which produces the resolved
//! text; this module is just the file I/O + `git add` that git itself does
//! when you save a resolved file and `git add` it. Once every conflict is
//! resolved and staged the merge/rebase/cherry-pick can be committed/continued
//! (the in-progress state clears then, not here).

use std::path::Path;

use crate::{
    error::{Error, Result},
    repo::Repo,
};

impl Repo {
    /// Read a working-tree file as UTF-8 — used to load a conflicted file
    /// (markers and all) into the resolver. Errors if the path escapes the
    /// working tree or the bytes aren't valid UTF-8 (binary conflicts aren't
    /// resolvable as text here).
    pub fn read_conflict_file(&self, rel_path: &str) -> Result<String> {
        let full = self.workdir_path(rel_path)?;
        let bytes = std::fs::read(&full)?;
        String::from_utf8(bytes)
            .map_err(|_| Error::Other(format!("{rel_path} is not valid UTF-8 (binary conflict)")))
    }

    /// Write the resolved `contents` back to `rel_path` and stage it, which is
    /// how git marks an unmerged file resolved (`git add`). Staging clears the
    /// conflict's higher-stage index entries.
    pub fn resolve_conflict(&self, rel_path: &str, contents: &str) -> Result<()> {
        let full = self.workdir_path(rel_path)?;
        std::fs::write(&full, contents)?;
        // Reuse the single-path stage logic (opens its own index + writes once).
        self.stage_path(rel_path)?;
        Ok(())
    }

    /// Resolve `rel_path` against the working directory, rejecting absolute
    /// paths and `..` traversal so a crafted path can't read/write outside the
    /// repo.
    fn workdir_path(&self, rel_path: &str) -> Result<std::path::PathBuf> {
        let p = Path::new(rel_path);
        if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(Error::Other(format!("invalid path: {rel_path}")));
        }
        Ok(self.path().join(p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-conflict-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
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

    #[test]
    fn reads_then_resolves_and_stages() {
        let (repo, dir) = scratch_repo();
        let conflicted = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nb\n";
        std::fs::write(dir.join("f.txt"), conflicted).unwrap();

        assert_eq!(repo.read_conflict_file("f.txt").unwrap(), conflicted);

        repo.resolve_conflict("f.txt", "a\nours\nb\n").unwrap();
        // File on disk holds the resolved text...
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "a\nours\nb\n");
        // ...and it's staged (resolved).
        let status = repo.status().unwrap();
        let entry = status.iter().find(|s| s.path == "f.txt").expect("f.txt in status");
        assert!(entry.staged, "resolved file is staged");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_path_traversal() {
        let (repo, dir) = scratch_repo();
        assert!(repo.read_conflict_file("../escape.txt").is_err());
        assert!(repo.resolve_conflict("/etc/passwd", "x").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
