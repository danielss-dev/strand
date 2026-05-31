//! Stash operations — save, list, apply, pop, drop.
//!
//! git2's stash entry points (`stash_save2`, `stash_apply`, `stash_pop`,
//! `stash_drop`, `stash_foreach`) all take `&mut git2::Repository`. Each
//! [`Repo::git2`] call hands back a freshly-opened *owned* `Repository`, so we
//! just bind it `mut` locally — no interior-mutability juggling, same as every
//! other write module here. Network-style stash work (none yet) would shell
//! out; these are pure index/working-tree ops, so `git2` is the right engine.

use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stash {
    /// Stash index; 0 is the most recent, matching git's `stash@{0}`.
    pub index: usize,
    /// OID of the stash commit.
    pub oid: String,
    /// Full stash message as git stores it, e.g.
    /// `WIP on main: 1a2b3c4 Subject`.
    pub message: String,
    /// Branch the stash was taken on, parsed from the message when git's
    /// default format is recognisable.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashOutcome {
    /// OID of the created stash commit, or `None` when there was nothing to
    /// stash (a clean working tree). Surfacing the no-op as success lets the
    /// UI say "nothing to stash" without treating it as an error.
    pub oid: Option<String>,
}

impl Repo {
    /// List all stashes, most-recent first — the order `git stash list` uses.
    pub fn stash_list(&self) -> Result<Vec<Stash>> {
        let mut repo = self.git2()?;
        let mut out = Vec::new();
        repo.stash_foreach(|index, message, oid| {
            out.push(Stash {
                index,
                oid: oid.to_string(),
                message: message.to_string(),
                branch: parse_stash_branch(message),
            });
            true
        })?;
        Ok(out)
    }

    /// Save the working-tree + index changes onto the stash stack.
    ///
    /// - `message` is an optional label; when `None` git writes its default
    ///   `WIP on <branch>: <oid> <subject>`.
    /// - `include_untracked` mirrors `git stash -u`.
    /// - `keep_index` mirrors `git stash --keep-index` (staged changes are
    ///   left in the working tree after stashing).
    ///
    /// A clean working tree makes git2 return [`NotFound`]; we map that to
    /// `StashOutcome { oid: None }` so "nothing to stash" reads as a no-op,
    /// not a failure.
    ///
    /// [`NotFound`]: git2::ErrorCode::NotFound
    pub fn stash_save(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
    ) -> Result<StashOutcome> {
        let mut repo = self.git2()?;
        let sig = repo.signature()?;

        let mut flags = git2::StashFlags::DEFAULT;
        if include_untracked {
            flags |= git2::StashFlags::INCLUDE_UNTRACKED;
        }
        if keep_index {
            flags |= git2::StashFlags::KEEP_INDEX;
        }

        match repo.stash_save2(&sig, message, Some(flags)) {
            Ok(oid) => Ok(StashOutcome {
                oid: Some(oid.to_string()),
            }),
            // libgit2 returns GIT_ENOTFOUND ("there is nothing to stash").
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(StashOutcome { oid: None }),
            Err(e) => Err(e.into()),
        }
    }

    /// Apply a stash by index, leaving it on the stack (`git stash apply`).
    /// Errors (rather than clobbering) if applying would conflict with the
    /// current working tree.
    pub fn stash_apply(&self, index: usize) -> Result<()> {
        let mut repo = self.git2()?;
        repo.stash_apply(index, None)?;
        Ok(())
    }

    /// Apply a stash by index and drop it on success (`git stash pop`). If the
    /// apply conflicts the stash is left intact, matching git.
    pub fn stash_pop(&self, index: usize) -> Result<()> {
        let mut repo = self.git2()?;
        repo.stash_pop(index, None)?;
        Ok(())
    }

    /// Drop a stash by index without applying it (`git stash drop`).
    ///
    /// **Destructive** — the discarded changes are unrecoverable through the
    /// app. The UI confirms before calling.
    pub fn stash_drop(&self, index: usize) -> Result<()> {
        let mut repo = self.git2()?;
        repo.stash_drop(index)?;
        Ok(())
    }
}

/// Parse the branch a stash was taken on out of its message. git formats the
/// default as `WIP on <branch>: <oid> <subject>`, and `git stash push -m msg`
/// as `On <branch>: <msg>`, so we read the segment between the leading
/// `WIP on `/`On ` and the first `:`. Returns `None` for any other shape.
fn parse_stash_branch(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))?;
    let branch = rest.split(':').next()?.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_wip_message() {
        assert_eq!(
            parse_stash_branch("WIP on main: 1a2b3c4 Add the thing"),
            Some("main".to_string())
        );
    }

    #[test]
    fn parses_custom_push_message() {
        assert_eq!(
            parse_stash_branch("On feature/login: half-finished form"),
            Some("feature/login".to_string())
        );
    }

    #[test]
    fn handles_branch_names_without_a_colon_body() {
        // Defensive: a message that starts right but has no `:` segment.
        assert_eq!(parse_stash_branch("WIP on main"), Some("main".to_string()));
    }

    #[test]
    fn returns_none_for_unrecognised_shape() {
        assert_eq!(parse_stash_branch("something else entirely"), None);
        assert_eq!(parse_stash_branch(""), None);
    }
}
