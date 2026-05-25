use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitOutcome {
    /// The new HEAD oid as a hex string.
    pub oid: String,
    /// Whether this commit was an amend of the previous HEAD.
    pub amended: bool,
}

/// Write the current index as a new commit on HEAD.
///
/// GPG/SSH signing is out of scope for 0.1 — when the user has
/// `commit.gpgSign = true` set we still produce an unsigned commit. The
/// signing UX comes in 1.1+ (PRD §6.6 P2).
impl Repo {
    pub fn commit(&self, subject: &str, body: Option<&str>, amend: bool) -> Result<CommitOutcome> {
        let repo = self.git2()?;
        let sig = repo.signature()?;

        let mut index = repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;

        let message = match body.map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) => format!("{}\n\n{}\n", subject.trim(), b),
            None => format!("{}\n", subject.trim()),
        };

        let oid = if amend {
            let head = repo.head()?;
            let head_commit = head.peel_to_commit()?;
            head_commit.amend(
                Some("HEAD"),
                Some(&sig),
                Some(&sig),
                None,
                Some(&message),
                Some(&tree),
            )?
        } else {
            // Parent list: HEAD if it exists; empty for the initial commit.
            let parents: Vec<git2::Commit> = match repo.head() {
                Ok(h) => vec![h.peel_to_commit()?],
                Err(_) => Vec::new(),
            };
            let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)?
        };

        Ok(CommitOutcome {
            oid: oid.to_string(),
            amended: amend,
        })
    }
}
