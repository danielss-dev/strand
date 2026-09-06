//! Repository file listings — powers the Files sidebar tab.
//!
//! The working-tree path lists every tracked file (from the index) plus
//! local untracked files and, on request, ignored files, with Git changes
//! tagged so the UI can paint a badge. The revision path walks a commit tree
//! and returns the immutable file set at that point in history. The frontend
//! groups either flat list into a folder tree.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo, status::StatusKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTreeEntry {
    pub path: String,
    /// Change status if the file differs from HEAD/index; `None` for a clean
    /// tracked file. Drives the status badge in the Files tree.
    pub status: Option<StatusKind>,
    /// Whether Git excludes this local path. Kept separate from `status`
    /// because ignored files are not working-tree changes.
    #[serde(default)]
    pub ignored: bool,
    /// Tracked in Git but intentionally absent from this sparse working tree.
    #[serde(default)]
    pub excluded: bool,
}

impl Repo {
    /// List the working tree: tracked paths (from the index) overlaid with
    /// change status, plus untracked local files.
    pub fn work_tree(&self) -> Result<Vec<WorkTreeEntry>> {
        self.work_tree_with_ignored(false)
    }

    /// List the working tree, optionally including Git-ignored boundaries.
    /// Ignored directories stay collapsed until the Files tree requests one
    /// level through [`Repo::ignored_directory_children`].
    pub fn work_tree_with_ignored(&self, include_ignored: bool) -> Result<Vec<WorkTreeEntry>> {
        let repo = self.git2()?;
        let statuses = repo.statuses(Some(&mut crate::status::status_options()))?;
        let entries = from_index_and_statuses(repo, &statuses)?;
        if include_ignored {
            ignored_boundaries(repo, &self.path, entries)
        } else {
            Ok(entries)
        }
    }

    /// List one ignored directory's immediate children. Directories use
    /// Pierre's canonical trailing slash and remain lazy themselves.
    pub fn ignored_directory_children(&self, rel_path: &str) -> Result<Vec<WorkTreeEntry>> {
        let relative = validate_ignored_directory_path(rel_path)?;
        let repo = self.git2()?;
        if !is_ignored_path(repo, relative)? {
            return Err(crate::Error::Other(format!(
                "path is not ignored: {relative}"
            )));
        }
        let absolute = self.safe_workdir_path(relative)?;
        let metadata = std::fs::symlink_metadata(&absolute)
            .map_err(|_| crate::Error::Other(format!("directory does not exist: {relative}")))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(crate::Error::Other(format!("not a directory: {relative}")));
        }

        let mut entries = Vec::new();
        for child in std::fs::read_dir(absolute)?.flatten() {
            let Ok(name) = child.file_name().into_string() else {
                continue;
            };
            if name.eq_ignore_ascii_case(".git") {
                continue;
            }
            let Ok(file_type) = child.file_type() else {
                continue;
            };
            let mut path = format!("{relative}/{name}");
            if file_type.is_dir() && !file_type.is_symlink() {
                path.push('/');
            }
            entries.push(WorkTreeEntry {
                path,
                status: None,
                ignored: true,
                excluded: false,
            });
        }
        entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
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
                        ignored: false,
                        excluded: false,
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
    let mut map: BTreeMap<String, (Option<StatusKind>, bool, bool)> = BTreeMap::new();
    let index = repo.index()?;
    for entry in index.iter() {
        if let Ok(p) = std::str::from_utf8(&entry.path) {
            map.entry(p.to_string()).or_insert((None, false, entry.flags_extended & (1 << 14) != 0));
        }
    }

    // Overlay status: local files get inserted and changed tracked files get
    // a kind. Ignored files intentionally have no change badge. `statuses()`
    // only returns changed entries, so clean tracked files keep the `None`
    // from the index pass above.
    for e in statuses.iter() {
        let Some(path) = e.path() else { continue };
        let s = e.status();
        // libgit2 reports absent skip-worktree entries as deletions. These
        // remain tracked; only a real staged change overrides their identity.
        if map.get(path).is_some_and(|(_, _, excluded)| *excluded)
            && s == git2::Status::WT_DELETED { continue; }
        if s.is_ignored() {
            map.entry(path.to_string()).or_insert((None, true, false));
            continue;
        }
        map.insert(path.to_string(), (Some(classify(s)), false, false));
    }

    Ok(map
        .into_iter()
        .map(|(path, (status, ignored, excluded))| WorkTreeEntry { path, status, ignored, excluded })
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

fn validate_ignored_directory_path(rel_path: &str) -> Result<&str> {
    let relative = rel_path.trim_end_matches(['/', '\\']);
    if relative.is_empty() {
        return Err(crate::Error::Other("empty ignored directory path".into()));
    }
    if std::path::Path::new(relative)
        .components()
        .any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|part| part.eq_ignore_ascii_case(".git"))
        })
    {
        return Err(crate::Error::Other("cannot enumerate .git".into()));
    }
    Ok(relative)
}

/// Stop as soon as an ignored ancestor is found. Asking libgit2 about the
/// complete generated path can fail on Windows before the native filesystem
/// APIs reach it, even though an early component such as `node_modules/`
/// already proves every descendant is ignored.
fn is_ignored_path(repo: &git2::Repository, relative: &str) -> Result<bool> {
    let mut prefix = std::path::PathBuf::new();
    for component in std::path::Path::new(relative).components() {
        prefix.push(component);
        if repo.status_should_ignore(&prefix)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Find ignored file/directory boundaries without entering ignored folders.
/// Walking only non-ignored directories keeps generated trees out of the
/// initial Files payload while still finding nested rules such as `ui/dist/`.
fn ignored_boundaries(
    repo: &git2::Repository,
    workdir: &std::path::Path,
    entries: Vec<WorkTreeEntry>,
) -> Result<Vec<WorkTreeEntry>> {
    let mut map = entries
        .into_iter()
        .map(|entry| (entry.path, (entry.status, entry.ignored, entry.excluded)))
        .collect::<BTreeMap<_, _>>();
    let mut pending = vec![(workdir.to_path_buf(), String::new())];

    while let Some((directory, prefix)) = pending.pop() {
        let Ok(children) = std::fs::read_dir(directory) else {
            continue;
        };
        for child in children.flatten() {
            let Ok(name) = child.file_name().into_string() else {
                continue;
            };
            if prefix.is_empty() && name.eq_ignore_ascii_case(".git") {
                continue;
            }
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let Ok(file_type) = child.file_type() else {
                continue;
            };
            // The index/status walk already classified these files. Besides
            // avoiding one ignore lookup per tracked file, this keeps a tracked
            // file tracked when a later .gitignore rule matches its name.
            if !file_type.is_dir() && map.contains_key(&relative) {
                continue;
            }
            if repo.status_should_ignore(std::path::Path::new(&relative))? {
                let path = if file_type.is_dir() && !file_type.is_symlink() {
                    format!("{relative}/")
                } else {
                    relative
                };
                map.insert(path, (None, true, false));
                continue;
            }
            if file_type.is_dir() && !file_type.is_symlink() && !child.path().join(".git").exists() {
                pending.push((child.path(), relative));
            }
        }
    }

    Ok(map
        .into_iter()
        .map(|(path, (status, ignored, excluded))| WorkTreeEntry {
            path,
            status,
            ignored,
            excluded,
        })
        .collect())
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

    #[test]
    fn work_tree_includes_ignored_boundaries_without_change_badges() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join(".gitignore"), "target/\n*.local\n").unwrap();
        std::fs::create_dir_all(dir.join("target/nested")).unwrap();
        std::fs::write(dir.join("target/nested/cache.bin"), "cache\n").unwrap();
        std::fs::write(dir.join("settings.local"), "local\n").unwrap();
        std::fs::write(dir.join("visible.txt"), "visible\n").unwrap();

        let entries = repo
            .work_tree_with_ignored(true)
            .unwrap()
            .into_iter()
            .map(|entry| (entry.path, (entry.status, entry.ignored)))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(entries.get("target/"), Some(&(None, true)));
        assert!(!entries.contains_key("target/nested/cache.bin"));
        assert_eq!(entries.get("settings.local"), Some(&(None, true)));
        assert_eq!(
            entries.get("visible.txt"),
            Some(&(Some(StatusKind::Untracked), false))
        );
        assert!(repo
            .work_tree()
            .unwrap()
            .iter()
            .all(|entry| entry.path != "settings.local" && entry.path != "target/nested/cache.bin"));
        assert!(repo
            .status()
            .unwrap()
            .iter()
            .all(|entry| entry.path != "settings.local" && entry.path != "target/nested/cache.bin"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ignored_boundary_scan_preserves_tracked_files_matching_ignore_rules() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("settings.local"), "tracked\n").unwrap();
        repo.stage_paths(&["settings.local".into()]).unwrap();
        std::fs::write(dir.join(".gitignore"), "*.local\n").unwrap();
        let entries = repo.work_tree_with_ignored(true).unwrap();
        let tracked = entries.iter().find(|entry| entry.path == "settings.local").unwrap();
        assert!(!tracked.ignored);
        assert_eq!(tracked.status, Some(StatusKind::Added));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ignored_directory_children_are_lazy_and_handle_long_paths() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();

        let mut nested = dir.join("node_modules/.pnpm");
        for _ in 0..8 {
            nested.push("react-resizable-panels-2.1.9_react-dom-18.3.1");
        }
        std::fs::create_dir_all(&nested).unwrap();
        let ignored = nested.join("getResizeHandleElement.js");
        std::fs::write(&ignored, "export {};\n").unwrap();

        let relative = ignored
            .strip_prefix(&dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let entries = repo.work_tree_with_ignored(true).unwrap();
        assert!(entries.iter().any(|entry| entry.path == "node_modules/"));
        assert!(entries.iter().all(|entry| entry.path != relative));

        std::fs::create_dir_all(dir.join("node_modules/.git")).unwrap();
        let root_children = repo.ignored_directory_children("node_modules").unwrap();
        assert!(root_children.iter().all(|entry| entry.path != "node_modules/.git/"));

        let parent = nested
            .strip_prefix(&dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let children = repo.ignored_directory_children(&parent).unwrap();
        assert!(children
            .iter()
            .any(|entry| entry.path == relative && entry.status.is_none() && entry.ignored));

        assert!(repo.ignored_directory_children(".git/objects").is_err());

        let _ = std::fs::remove_dir_all(dir);
    }
}
