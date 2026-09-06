//! Lazy Git notes/replacements and explicit, compare-and-swap tag editing.
use crate::{Error, Repo, Result};
use serde::{Deserialize, Serialize};

const LIMIT: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSummary {
    pub oid: String,
    pub kind: String,
    pub subject: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interchange::InterchangeScratch;
    fn git(path: &std::path::Path, args: &[&str]) -> String {
        let out = crate::git_command()
            .current_dir(path)
            .args(crate::GIT_SAFE_CONFIG)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().into()
    }
    fn fixture() -> (InterchangeScratch, Repo, Vec<String>) {
        let scratch = InterchangeScratch::new().unwrap();
        let raw = git2::Repository::init(&scratch.0).unwrap();
        let mut config = raw.config().unwrap();
        config.set_str("user.name", "Refs Tester").unwrap();
        config.set_str("user.email", "refs@example.test").unwrap();
        config.set_bool("commit.gpgsign", false).unwrap();
        config.set_bool("tag.gpgsign", false).unwrap();
        config.set_str("core.hooksPath", "/dev/null").unwrap();
        let mut ids = vec![];
        for i in 0..3 {
            std::fs::write(scratch.0.join("file"), format!("{i}\n")).unwrap();
            git(&scratch.0, &["add", "."]);
            git(&scratch.0, &["commit", "-m", &format!("step {i}")]);
            ids.push(git(&scratch.0, &["rev-parse", "HEAD"]));
        }
        let repo = Repo::discover(&scratch.0).unwrap();
        (scratch, repo, ids)
    }
    #[test]
    fn notes_preserve_namespaces_external_edits_and_worktree_sharing() {
        let (scratch, repo, ids) = fixture();
        let ns = "refs/notes/commits";
        repo.write_git_note(ns, &ids[0], None, Some("first note"))
            .unwrap();
        let note = repo.git_note(ns, &ids[0]).unwrap();
        assert_eq!(note.message.as_deref(), Some("first note"));
        git(
            &repo.path,
            &["notes", "add", "-m", "external note", &ids[1]],
        );
        assert!(repo
            .write_git_note(ns, &ids[0], note.ref_tip.as_deref(), Some("stale"))
            .is_err());
        assert_eq!(
            repo.git_note(ns, &ids[1]).unwrap().message.as_deref(),
            Some("external note\n")
        );
        let fresh = repo.git_note(ns, &ids[0]).unwrap();
        repo.write_git_note(ns, &ids[0], fresh.ref_tip.as_deref(), Some("edited"))
            .unwrap();
        repo.write_git_note("refs/notes/other", &ids[0], None, Some("separate"))
            .unwrap();
        let link = scratch.0.join("linked");
        git(
            &repo.path,
            &["worktree", "add", "-b", "linked", link.to_str().unwrap()],
        );
        let linked = Repo::discover(&link).unwrap();
        let fresh = linked.git_note(ns, &ids[0]).unwrap();
        assert_eq!(fresh.message.as_deref(), Some("edited"));
        linked
            .write_git_note(ns, &ids[0], fresh.ref_tip.as_deref(), None)
            .unwrap();
        assert!(repo.git_note(ns, &ids[0]).unwrap().message.is_none());
        assert_eq!(repo.advanced_refs(ns).unwrap().notes.len(), 1);
        assert_eq!(
            repo.git_note("refs/notes/other", &ids[0])
                .unwrap()
                .message
                .as_deref(),
            Some("separate")
        );
        assert!(git(&repo.path, &["for-each-ref", "refs/strand/notes-"]).is_empty());
    }
    #[test]
    fn replacements_reject_cycles_type_mismatch_and_stale_writes() {
        let (_s, repo, ids) = fixture();
        repo.write_replacement(&ids[0], Some(&ids[1]), None)
            .unwrap();
        assert_eq!(
            repo.review_replacement(&ids[0], &ids[2])
                .unwrap()
                .original
                .oid,
            ids[0]
        );
        assert!(repo.review_replacement(&ids[1], &ids[0]).is_err());
        assert!(repo.review_replacement(&ids[0], "HEAD:file").is_err());
        assert!(repo
            .write_replacement(&ids[0], Some(&ids[2]), None)
            .is_err());
        repo.write_replacement(&ids[0], Some(&ids[2]), Some(&ids[1]))
            .unwrap();
        assert_eq!(
            git(
                &repo.path,
                &["--no-replace-objects", "show", "-s", "--format=%s", &ids[0]]
            ),
            "step 0"
        );
        assert!(repo
            .write_replacement(&ids[0], None, Some(&ids[1]))
            .is_err());
        repo.write_replacement(&ids[0], None, Some(&ids[2]))
            .unwrap();
        assert!(repo
            .advanced_refs("refs/notes/commits")
            .unwrap()
            .replacements
            .is_empty());
    }
    #[test]
    fn tag_edit_preserves_kind_annotation_and_detects_publication_and_staleness() {
        let (scratch, repo, ids) = fixture();
        git(&repo.path, &["tag", "light", &ids[0]]);
        repo.edit_tag("light", &ids[1], &ids[0], TagEditKind::Retarget, None)
            .unwrap();
        assert_eq!(
            git(&repo.path, &["cat-file", "-t", "refs/tags/light"]),
            "commit"
        );
        assert!(repo
            .edit_tag("light", &ids[2], &ids[0], TagEditKind::Retarget, None)
            .is_err());
        git(
            &repo.path,
            &["tag", "-a", "annotated", "-m", "preserve me", &ids[0]],
        );
        let review = repo.review_tag_edit("annotated", &ids[1]).unwrap();
        assert_eq!(review.changed_files, 1);
        repo.edit_tag(
            "annotated",
            &ids[1],
            &review.ref_oid,
            TagEditKind::Retarget,
            None,
        )
        .unwrap();
        let review = repo.review_tag_edit("annotated", &ids[1]).unwrap();
        assert_eq!(review.annotation.as_deref(), Some("preserve me\n"));
        assert!(repo
            .edit_tag(
                "annotated",
                &ids[2],
                &review.ref_oid,
                TagEditKind::Reannotate,
                Some("new")
            )
            .is_err());
        repo.edit_tag(
            "annotated",
            &ids[1],
            &review.ref_oid,
            TagEditKind::Reannotate,
            Some("new annotation"),
        )
        .unwrap();
        let bare = scratch.0.join("remote.git");
        git2::Repository::init_bare(&bare).unwrap();
        git(
            &repo.path,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        assert!(repo
            .published_tag("origin", "annotated")
            .unwrap()
            .oid
            .is_none());
        git(&repo.path, &["push", "origin", "refs/tags/annotated"]);
        let review = repo.review_tag_edit("annotated", &ids[2]).unwrap();
        assert_eq!(
            repo.published_tag("origin", "annotated")
                .unwrap()
                .oid
                .as_deref(),
            Some(review.ref_oid.as_str())
        );
        repo.edit_tag(
            "annotated",
            &ids[2],
            &review.ref_oid,
            TagEditKind::Retarget,
            None,
        )
        .unwrap();
        assert_ne!(
            repo.published_tag("origin", "annotated").unwrap().oid,
            Some(repo.review_tag_edit("annotated", &ids[2]).unwrap().ref_oid)
        );
        let raw = repo.git2_owned().unwrap();
        raw.tag(
            "signed",
            &raw.find_object(git2::Oid::from_str(&ids[0]).unwrap(), None)
                .unwrap(),
            &raw.signature().unwrap(),
            "signed\n-----BEGIN SSH SIGNATURE-----\nfixture",
            false,
        )
        .unwrap();
        let signed = repo.review_tag_edit("signed", &ids[1]).unwrap();
        assert!(signed.signed);
        assert!(repo
            .edit_tag(
                "signed",
                &ids[1],
                &signed.ref_oid,
                TagEditKind::Retarget,
                None
            )
            .is_err());
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteEntry {
    pub object: String,
    pub note: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceEntry {
    pub original: String,
    pub replacement: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedRefs {
    pub notes_refs: Vec<String>,
    pub notes_tip: Option<String>,
    pub notes: Vec<NoteEntry>,
    pub notes_truncated: bool,
    pub replacements: Vec<ReplaceEntry>,
    pub replacements_truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitNote {
    pub target: ObjectSummary,
    pub ref_tip: Option<String>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceReview {
    pub original: ObjectSummary,
    pub replacement: ObjectSummary,
    pub previous: Option<String>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TagEditKind {
    Retarget,
    Reannotate,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagEditReview {
    pub name: String,
    pub ref_oid: String,
    pub current: ObjectSummary,
    pub proposed: ObjectSummary,
    pub annotation: Option<String>,
    pub signed: bool,
    pub changed_files: usize,
    pub remotes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedTag {
    pub remote: String,
    pub oid: Option<String>,
}

fn notes_name(name: &str) -> Result<()> {
    if !name.starts_with("refs/notes/") || !git2::Reference::is_valid_name(name) {
        return Err(Error::Other(
            "use a full notes ref such as refs/notes/commits".into(),
        ));
    }
    Ok(())
}
fn ref_tip(repo: &git2::Repository, name: &str) -> Result<Option<String>> {
    match repo.find_reference(name) {
        Ok(r) => r
            .target()
            .map(|o| Some(o.to_string()))
            .ok_or_else(|| Error::Other("symbolic refs cannot be edited here".into())),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn summary(object: &git2::Object<'_>) -> ObjectSummary {
    ObjectSummary {
        oid: object.id().to_string(),
        kind: object.kind().map(|k| k.str()).unwrap_or("unknown").into(),
        subject: object
            .as_commit()
            .and_then(|c| c.summary())
            .or_else(|| object.as_tag().and_then(|t| t.name()))
            .unwrap_or("")
            .into(),
    }
}
fn expect_tip(repo: &git2::Repository, name: &str, expected: Option<&str>) -> Result<()> {
    if ref_tip(repo, name)?.as_deref() != expected {
        return Err(Error::Other(
            "reference changed externally; inspect it again before editing".into(),
        ));
    }
    Ok(())
}

impl Repo {
    pub fn advanced_refs(&self, notes_ref: &str) -> Result<AdvancedRefs> {
        notes_name(notes_ref)?;
        let repo = self.git2_owned()?;
        let mut notes_refs = vec![];
        for reference in repo.references_glob("refs/notes/*")? {
            if let Some(name) = reference?.name() {
                notes_refs.push(name.to_owned());
            }
            if notes_refs.len() >= LIMIT {
                break;
            }
        }
        let notes_tip = ref_tip(&repo, notes_ref)?;
        let mut notes = vec![];
        if notes_tip.is_some() {
            for entry in repo.notes(Some(notes_ref))?.take(LIMIT + 1) {
                let (note, object) = entry?;
                notes.push(NoteEntry {
                    object: object.to_string(),
                    note: note.to_string(),
                });
            }
        }
        let notes_truncated = notes.len() > LIMIT;
        notes.truncate(LIMIT);
        let mut replacements = vec![];
        for reference in repo.references_glob("refs/replace/*")?.take(LIMIT + 1) {
            let reference = reference?;
            if let (Some(original), Some(target)) = (
                reference
                    .name()
                    .and_then(|n| n.strip_prefix("refs/replace/")),
                reference.target(),
            ) {
                replacements.push(ReplaceEntry {
                    original: original.to_owned(),
                    replacement: target.to_string(),
                });
            }
        }
        let replacements_truncated = replacements.len() > LIMIT;
        replacements.truncate(LIMIT);
        Ok(AdvancedRefs {
            notes_refs,
            notes_tip,
            notes,
            notes_truncated,
            replacements,
            replacements_truncated,
        })
    }

    pub fn git_note(&self, notes_ref: &str, revision: &str) -> Result<GitNote> {
        notes_name(notes_ref)?;
        let repo = self.git2_owned()?;
        let target = repo.revparse_single(revision)?;
        let tip = ref_tip(&repo, notes_ref)?;
        let message = match repo.find_note(Some(notes_ref), target.id()) {
            Ok(note) => {
                if note.message_bytes().len() > 1024 * 1024 {
                    return Err(Error::Other("note exceeds the 1 MiB editing limit".into()));
                }
                Some(
                    note.message()
                        .ok_or_else(|| {
                            Error::Other("this note is not UTF-8 and cannot be edited here".into())
                        })?
                        .to_owned(),
                )
            }
            Err(e) if e.code() == git2::ErrorCode::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        Ok(GitNote {
            target: summary(&target),
            ref_tip: tip,
            message,
        })
    }

    pub fn write_git_note(
        &self,
        notes_ref: &str,
        object: &str,
        expected: Option<&str>,
        message: Option<&str>,
    ) -> Result<()> {
        notes_name(notes_ref)?;
        if message.is_some_and(|m| m.trim().is_empty() || m.len() > 1024 * 1024) {
            return Err(Error::Other(
                "notes must contain text and be at most 1 MiB; use Remove to delete a note".into(),
            ));
        }
        let repo = self.git2_owned()?;
        let object = git2::Oid::from_str(object)?;
        repo.find_object(object, None)?;
        let mut transaction = repo.transaction()?;
        transaction.lock_ref(notes_ref)?;
        expect_tip(&repo, notes_ref, expected)?;
        // libgit2's notes writer publishes a ref. Write through a private temporary
        // ref, then publish its commit to the locked real namespace. External notes
        // updates cannot be lost between reading the tree and replacing its tip.
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temporary = format!(
            "refs/strand/notes-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| Error::Other(e.to_string()))?
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        if ref_tip(&repo, &temporary)?.is_some() {
            return Err(Error::Other("temporary notes ref already exists".into()));
        }
        let signature = repo.signature()?;
        if let Some(tip) = expected {
            repo.reference(
                &temporary,
                git2::Oid::from_str(tip)?,
                false,
                "Strand notes preparation",
            )?;
        }
        let result = (|| -> Result<()> {
            match message {
                Some(text) => {
                    repo.note(&signature, &signature, Some(&temporary), object, text, true)?;
                }
                None => repo.note_delete(object, Some(&temporary), &signature, &signature)?,
            }
            let tip = repo
                .find_reference(&temporary)?
                .target()
                .ok_or_else(|| Error::Other("notes writer returned a symbolic ref".into()))?;
            transaction.set_target(notes_ref, tip, Some(&signature), "Strand edit Git note")?;
            transaction.commit()?;
            Ok(())
        })();
        if let Ok(mut reference) = repo.find_reference(&temporary) {
            let _ = reference.delete();
        }
        result
    }

    pub fn review_replacement(&self, original: &str, replacement: &str) -> Result<ReplaceReview> {
        let repo = self.git2_owned()?;
        let old = repo.revparse_single(original)?;
        let new = repo.revparse_single(replacement)?;
        if old.kind() != new.kind() {
            return Err(Error::Other(
                "replacement objects must have the same Git object type".into(),
            ));
        }
        let mut next = new.id();
        let mut visited = std::collections::HashSet::new();
        loop {
            if next == old.id() || !visited.insert(next) {
                return Err(Error::Other("replacement would create a cycle".into()));
            }
            let Some(target) = ref_tip(&repo, &format!("refs/replace/{next}"))? else {
                break;
            };
            next = git2::Oid::from_str(&target)?;
            if visited.len() >= 5 {
                return Err(Error::Other(
                    "replacement chain exceeds Git's supported depth".into(),
                ));
            }
        }
        Ok(ReplaceReview {
            original: summary(&old),
            replacement: summary(&new),
            previous: ref_tip(&repo, &format!("refs/replace/{}", old.id()))?,
        })
    }

    pub fn write_replacement(
        &self,
        original: &str,
        replacement: Option<&str>,
        expected: Option<&str>,
    ) -> Result<()> {
        let original = git2::Oid::from_str(original)?.to_string();
        let repo = self.git2_owned()?;
        let refname = format!("refs/replace/{original}");
        let mut transaction = repo.transaction()?;
        transaction.lock_ref(&refname)?;
        expect_tip(&repo, &refname, expected)?;
        if let Some(replacement) = replacement {
            let review = self.review_replacement(&original, replacement)?;
            let target = git2::Oid::from_str(&review.replacement.oid)?;
            transaction.set_target(&refname, target, None, "Strand edit replacement")?;
        } else {
            if expected.is_none() {
                return Err(Error::Other("no replacement exists for this object".into()));
            }
            transaction.remove(&refname)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn review_tag_edit(&self, name: &str, target: &str) -> Result<TagEditReview> {
        let repo = self.git2_owned()?;
        let refname = format!("refs/tags/{name}");
        if !git2::Reference::is_valid_name(&refname) {
            return Err(Error::Other("invalid tag name".into()));
        }
        let ref_oid =
            ref_tip(&repo, &refname)?.ok_or_else(|| Error::Other("tag no longer exists".into()))?;
        let raw = repo.find_object(git2::Oid::from_str(&ref_oid)?, None)?;
        let current = raw.peel_to_commit()?;
        let proposed = repo.revparse_single(target)?.peel_to_commit()?;
        let annotation = if let Some(tag) = raw.as_tag() {
            let message = tag
                .message()
                .ok_or_else(|| Error::Other("tag annotation is not UTF-8".into()))?;
            if message.len() > 1024 * 1024 {
                return Err(Error::Other("annotation exceeds 1 MiB".into()));
            }
            Some(message.to_owned())
        } else {
            None
        };
        let signed = annotation.as_deref().is_some_and(|m| {
            [
                "-----BEGIN PGP SIGNATURE-----",
                "-----BEGIN SSH SIGNATURE-----",
                "-----BEGIN SIGNED MESSAGE-----",
            ]
            .iter()
            .any(|marker| m.contains(marker))
        });
        let changed_files = repo
            .diff_tree_to_tree(Some(&current.tree()?), Some(&proposed.tree()?), None)?
            .deltas()
            .len();
        let remotes = repo
            .remotes()?
            .iter()
            .flatten()
            .map(str::to_owned)
            .collect();
        Ok(TagEditReview {
            name: name.into(),
            ref_oid,
            current: summary(current.as_object()),
            proposed: summary(proposed.as_object()),
            annotation,
            signed,
            changed_files,
            remotes,
        })
    }

    pub fn edit_tag(
        &self,
        name: &str,
        target: &str,
        expected: &str,
        kind: TagEditKind,
        message: Option<&str>,
    ) -> Result<()> {
        let review = self.review_tag_edit(name, target)?;
        if review.ref_oid != expected {
            return Err(Error::Other(
                "tag changed externally; review the targets again".into(),
            ));
        }
        if review.signed {
            return Err(Error::Other(
                "editing this signed tag requires a new signature; use the signed-tag workflow"
                    .into(),
            ));
        }
        if kind == TagEditKind::Reannotate && review.current.oid != review.proposed.oid {
            return Err(Error::Other(
                "re-annotation must keep the current target; use Retarget for a different commit"
                    .into(),
            ));
        }
        let repo = self.git2_owned()?;
        let object = repo.find_object(git2::Oid::from_str(&review.proposed.oid)?, None)?;
        let annotation = if kind == TagEditKind::Reannotate {
            let text = message
                .filter(|m| !m.trim().is_empty())
                .ok_or_else(|| Error::Other("an annotation is required".into()))?;
            if text.len() > 1024 * 1024 {
                return Err(Error::Other("annotation exceeds 1 MiB".into()));
            }
            Some(text)
        } else {
            review.annotation.as_deref()
        };
        let oid = if let Some(annotation) = annotation {
            repo.tag_annotation_create(name, &object, &repo.signature()?, annotation)?
        } else {
            object.id()
        };
        repo.reference_matching(
            &format!("refs/tags/{name}"),
            oid,
            true,
            git2::Oid::from_str(expected)?,
            "Strand edit tag",
        )?;
        Ok(())
    }

    pub fn published_tag(&self, remote: &str, name: &str) -> Result<PublishedTag> {
        let repo = self.git2_owned()?;
        repo.find_remote(remote)?;
        let refname = format!("refs/tags/{name}");
        if remote.starts_with('-') || !git2::Reference::is_valid_name(&refname) {
            return Err(Error::Other("invalid remote or tag name".into()));
        }
        let result = crate::network::run_git_streaming_transcript(
            &self.path,
            &["ls-remote", "--refs", "--tags", "--", remote, &refname],
            |_| {},
            None,
        )?;
        if !result.success {
            return Err(Error::Other(result.output));
        }
        let oid = result.output.lines().find_map(|line| {
            let mut fields = line.split_whitespace();
            let oid = fields.next()?;
            (fields.next()? == refname).then(|| oid.to_owned())
        });
        Ok(PublishedTag {
            remote: remote.into(),
            oid,
        })
    }
}
