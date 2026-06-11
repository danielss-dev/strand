//! `.gitignore` quick-edits — append a pattern to the workdir root file.
//!
//! Powers the "Add to .gitignore" context-menu action on untracked files.
//! Plain file I/O (no git involvement): git picks the change up on the next
//! status walk.

use crate::{error::Result, repo::Repo, Error};

impl Repo {
    /// Append `pattern` as its own line to the working-tree root `.gitignore`,
    /// creating the file if missing. An exact-line duplicate is a no-op.
    /// Rejects empty patterns and embedded newlines (a crafted "pattern" must
    /// not smuggle extra ignore lines in).
    pub fn gitignore_add(&self, pattern: &str) -> Result<()> {
        let pattern = pattern.trim();
        if pattern.is_empty() || pattern.contains('\n') || pattern.contains('\r') {
            return Err(Error::Other("invalid ignore pattern".into()));
        }

        let file = self.path.join(".gitignore");
        let existing = match std::fs::read_to_string(&file) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        // `lines()` strips a trailing `\r`, so this also matches CRLF files.
        if existing.lines().any(|line| line == pattern) {
            return Ok(());
        }

        let mut out = existing;
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(pattern);
        out.push('\n');
        std::fs::write(&file, out)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a throwaway repo and return its `Repo`. Uses a std-only unique
    /// temp dir so the test pulls in no new dependency (strand-core
    /// deliberately has no `tempfile` dev-dep). No commit needed —
    /// `gitignore_add` only touches the working tree.
    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-ignore-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        // Discover via our own API so we exercise the real code path.
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn creates_file_when_missing() {
        let (repo, dir) = scratch_repo();
        repo.gitignore_add("/target").unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(content, "/target\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn appends_after_content_without_trailing_newline() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join(".gitignore"), "node_modules").unwrap();
        repo.gitignore_add("*.log").unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(content, "node_modules\n*.log\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exact_duplicate_is_a_noop() {
        let (repo, dir) = scratch_repo();
        repo.gitignore_add("*.log").unwrap();
        let before = std::fs::read(dir.join(".gitignore")).unwrap();
        repo.gitignore_add("*.log").unwrap();
        let after = std::fs::read(dir.join(".gitignore")).unwrap();
        assert_eq!(before, after, "duplicate add must leave the file byte-identical");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_empty_and_newline_injection() {
        let (repo, dir) = scratch_repo();
        assert!(repo.gitignore_add("   ").is_err());
        assert!(repo.gitignore_add("a\nb").is_err());
        assert!(repo.gitignore_add("a\rb").is_err());
        assert!(!dir.join(".gitignore").exists(), "rejected patterns write nothing");
        let _ = std::fs::remove_dir_all(dir);
    }
}
