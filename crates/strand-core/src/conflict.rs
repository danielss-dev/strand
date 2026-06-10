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

    /// Launch the user's configured external merge tool on `rel_path`
    /// (`git mergetool --no-prompt -- <file>`) and block until it exits.
    /// The escape hatch for conflicts the pick-sides resolver can't express;
    /// honors `merge.tool` per PRD §6.4. When the tool reports a successful
    /// resolution, git stages the file itself — callers just refresh.
    pub fn open_mergetool(&self, rel_path: &str) -> Result<()> {
        // Same traversal guard as the read/write paths, and the `--`
        // separator keeps the path out of option parsing.
        let _ = self.workdir_path(rel_path)?;
        let out = std::process::Command::new("git")
            .current_dir(self.path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args(["mergetool", "--no-prompt", "--", rel_path])
            .output()
            .map_err(|e| Error::Other(format!("spawn git mergetool failed: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let info = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return Err(Error::Other(if !err.is_empty() {
                err
            } else if !info.is_empty() {
                info
            } else {
                "git mergetool failed — is merge.tool configured?".to_string()
            }));
        }
        Ok(())
    }

    /// Resolve `rel_path` against the working directory, rejecting absolute
    /// paths and `..` traversal so a crafted path can't read/write outside the
    /// repo.
    ///
    /// The lexical check (no `..`, not absolute) isn't enough on its own: an
    /// in-tree **symlink** (`link/target` where `link` points outside the
    /// working tree) escapes it without ever containing `..`. So we also
    /// canonicalize and require the result to stay under the working tree.
    /// `canonicalize` needs an existing path, so for a not-yet-created file
    /// (the `resolve_conflict` write of a brand-new file) we canonicalize the
    /// parent directory instead.
    pub(crate) fn workdir_path(&self, rel_path: &str) -> Result<std::path::PathBuf> {
        let p = Path::new(rel_path);
        if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(Error::Other(format!("invalid path: {rel_path}")));
        }
        let full = self.path().join(p);

        let root = self
            .path()
            .canonicalize()
            .map_err(|e| Error::Other(format!("cannot resolve working tree: {e}")))?;
        // Canonicalize the path itself if it exists (read / overwrite), else its
        // parent (writing a new file). Either way the resolved location must sit
        // inside the working tree once symlinks are followed.
        let probe = if full.exists() {
            full.as_path()
        } else {
            full.parent().unwrap_or(full.as_path())
        };
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

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let (repo, dir) = scratch_repo();
        // An in-tree symlink pointing outside the working tree: `link/x` has no
        // `..` and isn't absolute, so only symlink resolution catches it.
        let outside = std::env::temp_dir();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        assert!(repo.read_conflict_file("link/anything.txt").is_err());
        assert!(repo.resolve_conflict("link/evil.txt", "x").is_err());
        // A normal nested path still works.
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        assert!(repo.resolve_conflict("sub/ok.txt", "hi\n").is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
