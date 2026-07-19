use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum StatusKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub kind: StatusKind,
    pub staged: bool,
}

impl Repo {
    /// Working-tree + index status, in a shape ready for the staging UI.
    ///
    /// Uses `git2` for now because gix's status APIs are still maturing;
    /// the public type intentionally hides which engine produced it.
    pub fn status(&self) -> Result<Vec<FileStatus>> {
        let repo = self.git2()?;
        let statuses = repo.statuses(Some(&mut status_options()))?;
        Ok(from_statuses(&statuses))
    }
}

/// The status options every walk in this crate uses, so `status`,
/// `work_tree`, and `snapshot` can't drift apart.
pub(crate) fn status_options() -> git2::StatusOptions {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    opts
}

/// The Files tree can opt into ignored paths without making every status and
/// snapshot refresh recursively enumerate large ignored build directories.
pub(crate) fn tree_status_options(include_ignored: bool) -> git2::StatusOptions {
    let mut opts = status_options();
    if include_ignored {
        // Let git identify each ignored boundary, but do not make libgit2 walk
        // generated trees itself. On Windows it aborts the entire status call
        // when one descendant exceeds its legacy path limit. `tree.rs`
        // expands these already-ignored directories with the filesystem APIs.
        opts.include_ignored(true).recurse_ignored_dirs(false);
    }
    opts
}

/// Convert an already-run `statuses()` walk into staging-UI rows. Split out
/// so [`Repo::snapshot`](crate::snapshot) can share one walk between this
/// and the work-tree listing.
pub(crate) fn from_statuses(statuses: &git2::Statuses<'_>) -> Vec<FileStatus> {
    let mut out = Vec::new();
    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let s = entry.status();

        // An unmerged (conflicted) entry carries the CONFLICTED bit but not
        // necessarily any wt/index-modified bit, so it would otherwise be
        // dropped. Emit it once as a single conflicted row — the conflict
        // resolver keys off this.
        if s.is_conflicted() {
            out.push(FileStatus {
                path,
                kind: StatusKind::Conflicted,
                staged: false,
            });
            continue;
        }

        if s.is_index_modified() || s.is_index_new() || s.is_index_deleted() || s.is_index_renamed() {
            out.push(FileStatus {
                path: path.clone(),
                kind: classify(s, true),
                staged: true,
            });
        }
        if s.is_wt_modified() || s.is_wt_new() || s.is_wt_deleted() || s.is_wt_renamed() {
            out.push(FileStatus {
                path,
                kind: classify(s, false),
                staged: false,
            });
        }
    }
    out
}

fn classify(s: git2::Status, staged: bool) -> StatusKind {
    if s.is_conflicted() {
        return StatusKind::Conflicted;
    }
    if staged {
        if s.is_index_new() { return StatusKind::Added; }
        if s.is_index_deleted() { return StatusKind::Deleted; }
        if s.is_index_renamed() { return StatusKind::Renamed; }
        return StatusKind::Modified;
    }
    if s.is_wt_new() { return StatusKind::Untracked; }
    if s.is_wt_deleted() { return StatusKind::Deleted; }
    if s.is_wt_renamed() { return StatusKind::Renamed; }
    StatusKind::Modified
}
