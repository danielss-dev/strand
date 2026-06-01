//! Tag writes — create (lightweight + annotated) and delete.
//!
//! Tag *reads* live in `refs.rs` (`collect_tags`); this is the mutating side.
//! All ops go through `git2`, matching the branch-write policy (stable Rust
//! API, no spawn overhead). Pushing tags to a remote is a separate concern —
//! `git push` doesn't send tags by default — and is tracked as future work.

use crate::{error::Result, repo::Repo};

impl Repo {
    /// Create a tag pointing at `target` (any revspec git understands — an
    /// OID, `HEAD`, a branch name; defaults to `HEAD`).
    ///
    /// When `message` is `Some` and non-empty, an **annotated** tag is created
    /// (the tagger is pulled from the repo's git config — `user.name` /
    /// `user.email`); otherwise a **lightweight** tag. `force` mirrors
    /// `git tag -f`: overwrite an existing tag of the same name instead of
    /// erroring.
    pub fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
        force: bool,
    ) -> Result<()> {
        let repo = self.git2()?;
        let rev = target.unwrap_or("HEAD");
        // Peel to a commit so both flavours tag the commit (not, say, the
        // tag object of an already-annotated revspec).
        let object = repo.revparse_single(rev)?.peel(git2::ObjectType::Commit)?;

        match message {
            Some(msg) if !msg.trim().is_empty() => {
                let tagger = repo.signature()?;
                repo.tag(name, &object, &tagger, msg, force)?;
            }
            _ => {
                repo.tag_lightweight(name, &object, force)?;
            }
        }
        Ok(())
    }

    /// Delete a tag by short name (e.g. `v1.0.0`). Local only — a tag already
    /// pushed to a remote stays there until deleted on the remote too.
    pub fn delete_tag(&self, name: &str) -> Result<()> {
        self.git2()?.tag_delete(name)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a throwaway repo with a single commit and return its `Repo`.
    /// Uses a std-only unique temp dir so the test pulls in no new dependency
    /// (strand-core deliberately has no `tempfile` dev-dep).
    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-tag-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let repo = git2::Repository::init(&dir).unwrap();
        {
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            let tree_oid = {
                let mut idx = repo.index().unwrap();
                let tree = idx.write_tree().unwrap();
                repo.find_tree(tree).unwrap().id()
            };
            let tree = repo.find_tree(tree_oid).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }
        // Discover via our own API so we exercise the real code path.
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn create_and_delete_lightweight_and_annotated() {
        let (repo, dir) = scratch_repo();

        repo.create_tag("v-light", None, None, false).unwrap();
        repo.create_tag("v-annot", None, Some("a release"), false).unwrap();

        let tags = repo.refs().unwrap().tags;
        let light = tags.iter().find(|t| t.name == "v-light").expect("lightweight tag");
        let annot = tags.iter().find(|t| t.name == "v-annot").expect("annotated tag");
        assert!(!light.annotated, "empty message ⇒ lightweight");
        assert!(annot.annotated, "non-empty message ⇒ annotated");
        assert_eq!(annot.message.as_deref(), Some("a release"));
        // Both resolve to the same (only) commit.
        assert_eq!(light.target, annot.target);

        // Re-creating without force errors; with force it overwrites.
        assert!(repo.create_tag("v-light", None, None, false).is_err());
        repo.create_tag("v-light", None, Some("now annotated"), true).unwrap();
        let tags = repo.refs().unwrap().tags;
        assert!(tags.iter().find(|t| t.name == "v-light").unwrap().annotated);

        repo.delete_tag("v-light").unwrap();
        repo.delete_tag("v-annot").unwrap();
        assert!(repo.refs().unwrap().tags.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }
}
