//! Working-tree file listing — powers the Files sidebar tab.
//!
//! Lists every tracked file (from the index) plus untracked-but-not-ignored
//! files, each tagged with its change status so the UI can paint a badge.
//! The frontend groups the flat list into a folder tree (it already does the
//! same for the Local Changes and Branches trees).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo, status::StatusKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTreeEntry {
    pub path: String,
    /// Change status if the file differs from HEAD/index; `None` for a clean
    /// tracked file. Drives the status badge in the Files tree.
    pub status: Option<StatusKind>,
}

impl Repo {
    /// List the working tree: tracked paths (from the index) overlaid with
    /// change status, plus untracked files. Ignored files are excluded.
    pub fn work_tree(&self) -> Result<Vec<WorkTreeEntry>> {
        let repo = self.git2()?;

        // Start from the index — the canonical set of tracked paths. A
        // BTreeMap keeps the output path-sorted and dedupes conflict entries
        // (which appear once per stage).
        let mut map: BTreeMap<String, Option<StatusKind>> = BTreeMap::new();
        let index = repo.index()?;
        for entry in index.iter() {
            if let Ok(p) = std::str::from_utf8(&entry.path) {
                map.entry(p.to_string()).or_insert(None);
            }
        }

        // Overlay status: untracked files get inserted, changed tracked files
        // get a kind. `statuses()` only returns changed entries, so clean
        // tracked files keep the `None` from the index pass above.
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        for e in repo.statuses(Some(&mut opts))?.iter() {
            let Some(path) = e.path() else { continue };
            let s = e.status();
            if s.is_ignored() {
                continue;
            }
            map.insert(path.to_string(), Some(classify(s)));
        }

        Ok(map
            .into_iter()
            .map(|(path, status)| WorkTreeEntry { path, status })
            .collect())
    }
}

/// Reduce a git2 status bitset to the single badge that best describes the
/// file. Conflicts win; then working-tree changes; then index changes.
fn classify(s: git2::Status) -> StatusKind {
    if s.is_conflicted() {
        return StatusKind::Conflicted;
    }
    if s.is_wt_new() {
        return StatusKind::Untracked;
    }
    if s.is_index_new() {
        return StatusKind::Added;
    }
    if s.is_wt_deleted() || s.is_index_deleted() {
        return StatusKind::Deleted;
    }
    if s.is_wt_renamed() || s.is_index_renamed() {
        return StatusKind::Renamed;
    }
    StatusKind::Modified
}
