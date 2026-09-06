//! Tag writes — create (lightweight + annotated) and delete.
//!
//! Tag *reads* live in `refs.rs` (`collect_tags`); this is the mutating side.
//! Creation uses system Git for inherited signing and agent/key configuration.

use serde::{Deserialize, Serialize};
use crate::{Error, Result, repo::Repo, signing::{SigningMode, git_bool}};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TagVerificationStatus { Unsigned, Verified, Failed }

#[derive(Debug, Serialize, Deserialize)]
pub struct TagVerification {
    pub oid: String,
    pub status: TagVerificationStatus,
    pub output: String,
}

fn run_tag_git(repo: &Repo, args: &[&str]) -> Result<std::process::Output> {
    crate::git_output::capture(crate::git_command().current_dir(&repo.path)
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", ":")
        .args(crate::GIT_SAFE_CONFIG).args(args))
}

fn transcript(output: &std::process::Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)).trim().to_owned()
}

impl Repo {
    /// Create a tag pointing at `target` (any revspec git understands — an
    /// OID, `HEAD`, a branch name; defaults to `HEAD`).
    ///
    /// When `message` is `Some` and non-empty, an **annotated** tag is created
    /// (the tagger is pulled from the repo's git config — `user.name` /
    /// `user.email`); otherwise a **lightweight** tag. Inherited signing may
    /// require an annotation. `force` mirrors
    /// `git tag -f`: overwrite an existing tag of the same name instead of
    /// erroring.
    pub fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
        force: bool,
    ) -> Result<()> {
        self.create_tag_with_signing(name, target, message, force, SigningMode::Inherit)
    }

    pub fn create_tag_with_signing(
        &self, name: &str, target: Option<&str>, message: Option<&str>, force: bool, signing: SigningMode,
    ) -> Result<()> {
        if name.starts_with('-') || !git2::Reference::is_valid_name(&format!("refs/tags/{name}")) {
            return Err(Error::Other("Invalid tag name".into()));
        }
        let repo = self.git2()?;
        let object = repo.revparse_single(target.unwrap_or("HEAD"))?.peel(git2::ObjectType::Commit)?;
        let oid = object.id().to_string();
        let message = message.filter(|msg| !msg.trim().is_empty());
        let signed = match signing {
            SigningMode::Sign => true,
            SigningMode::Unsigned => false,
            SigningMode::Inherit => git_bool(self, "tag.gpgsign")?
                || (message.is_some() && git_bool(self, "tag.forceSignAnnotated")?),
        };
        if signed && message.is_none() {
            return Err(Error::Other("A signed tag requires an annotation message".into()));
        }
        // Verbatim cleanup requires a final LF before Git appends the signature.
        let file = message.map(|message| crate::commit::temp_message_file(&format!("{}\n", message.trim_end_matches(['\r', '\n'])))).transpose()?;
        let file_arg = file.as_ref().map(|path| path.to_string_lossy().into_owned());
        let mut args = vec!["tag"];
        match signing {
            SigningMode::Sign => args.push("--sign"),
            SigningMode::Unsigned => args.push("--no-sign"),
            SigningMode::Inherit => {},
        }
        if force { args.push("--force"); }
        if let Some(file_arg) = file_arg.as_deref() {
            // --file already creates an annotation. Explicit --annotate
            // suppresses tag.forceSignAnnotated, so use it only for the
            // operation's unsigned override (alongside --no-sign).
            if matches!(signing, SigningMode::Unsigned) { args.push("--annotate"); }
            args.extend(["--cleanup=verbatim", "--file", file_arg]);
        }
        args.extend(["--", name, &oid]);
        let result = run_tag_git(self, &args);
        if let Some(file) = file { let _ = std::fs::remove_file(file); }
        let output = result?;
        if !output.status.success() {
            let text = transcript(&output);
            return Err(Error::Other(if text.is_empty() { "Git could not create the tag".into() } else { text }));
        }
        Ok(())
    }

    /// Verify the immutable tag object selected by this exact short tag name.
    /// No graph-wide verification or trusting a mutable ref after resolution.
    pub fn verify_tag(&self, name: &str) -> Result<TagVerification> {
        let repo = self.git2()?;
        let reference = repo.find_reference(&format!("refs/tags/{name}"))?;
        let target = reference.resolve()?.target().ok_or_else(|| Error::Other("Tag has no target".into()))?;
        let object = repo.find_object(target, None)?;
        let oid = object.id().to_string();
        let tag = object.as_tag();
        let signed = tag.is_some_and(|tag| {
            let message = String::from_utf8_lossy(tag.message_bytes().unwrap_or_default());
            ["-----BEGIN PGP SIGNATURE-----", "-----BEGIN SSH SIGNATURE-----", "-----BEGIN SIGNED MESSAGE-----"]
                .iter().any(|marker| message.contains(marker))
        });
        if !signed {
            return Ok(TagVerification { oid, status: TagVerificationStatus::Unsigned, output: "This tag has no signature.".into() });
        }
        let output = run_tag_git(self, &["verify-tag", "--raw", &oid])?;
        Ok(TagVerification {
            oid, status: if output.status.success() { TagVerificationStatus::Verified } else { TagVerificationStatus::Failed },
            output: transcript(&output),
        })
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
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("tag.gpgsign", "false"), ("tag.forcesignannotated", "false")] {
            repo.config().unwrap().set_str(key, value).unwrap();
        }
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
