//! Repository file listings — powers the Files sidebar tab.
//!
//! The working-tree path lists every tracked file (from the index) plus
//! untracked-but-not-ignored files, each tagged with its change status so the
//! UI can paint a badge. The revision path walks a commit tree and returns the
//! immutable file set at that point in history. The frontend groups either
//! flat list into a folder tree.

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
        let statuses = repo.statuses(Some(&mut crate::status::status_options()))?;
        from_index_and_statuses(repo, &statuses)
    }

    /// List every file present at `rev`. Revision entries are immutable and
    /// therefore carry no working-tree status badge.
    pub fn tree_at(&self, rev: &str) -> Result<Vec<WorkTreeEntry>> {
        let repo = self.git2()?;
        let tree = repo.revparse_single(rev)?.peel_to_commit()?.tree()?;
        let mut entries = Vec::new();

        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            let is_file = matches!(
                entry.kind(),
                Some(git2::ObjectType::Blob | git2::ObjectType::Commit)
            );
            if is_file {
                if let Some(name) = entry.name() {
                    entries.push(WorkTreeEntry {
                        path: format!("{root}{name}"),
                        status: None,
                    });
                }
            }
            git2::TreeWalkResult::Ok
        })?;

        entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }
}

/// Build the work-tree listing from an already-open repo and an already-run
/// `statuses()` walk. Split out so [`Repo::snapshot`](crate::snapshot) can
/// share one walk between this and the staging-status rows.
pub(crate) fn from_index_and_statuses(
    repo: &git2::Repository,
    statuses: &git2::Statuses<'_>,
) -> Result<Vec<WorkTreeEntry>> {
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
    for e in statuses.iter() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-tree-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = git2::Repository::init(&dir).unwrap();
        {
            let mut cfg = git.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        (Repo::discover(&dir).unwrap(), dir)
    }

    fn commit_all(repo: &Repo, message: &str) -> String {
        let git = repo.git2().unwrap();
        let mut index = git.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = git.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = git.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        git.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap()
            .to_string()
    }

    #[test]
    fn tree_at_lists_the_selected_revision_only() {
        let (repo, dir) = scratch_repo();
        std::fs::create_dir_all(dir.join("src/nested")).unwrap();
        std::fs::write(dir.join("README.md"), "first\n").unwrap();
        std::fs::write(dir.join("src/nested/a.rs"), "fn a() {}\n").unwrap();
        let first = commit_all(&repo, "first");

        std::fs::remove_file(dir.join("README.md")).unwrap();
        std::fs::write(dir.join("src/b.rs"), "fn b() {}\n").unwrap();
        let second = commit_all(&repo, "second");

        assert_eq!(
            repo.tree_at(&first)
                .unwrap()
                .into_iter()
                .map(|e| (e.path, e.status))
                .collect::<Vec<_>>(),
            vec![("README.md".into(), None), ("src/nested/a.rs".into(), None),]
        );
        assert_eq!(
            repo.tree_at(&second)
                .unwrap()
                .into_iter()
                .map(|e| e.path)
                .collect::<Vec<_>>(),
            vec!["src/b.rs", "src/nested/a.rs"]
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tree_at_accepts_refs_and_rejects_unknown_revisions() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join(Path::new("a.txt")), "a\n").unwrap();
        commit_all(&repo, "first");

        assert_eq!(repo.tree_at("HEAD").unwrap()[0].path, "a.txt");
        assert!(repo.tree_at("does-not-exist").is_err());

        let _ = std::fs::remove_dir_all(dir);
    }
}
