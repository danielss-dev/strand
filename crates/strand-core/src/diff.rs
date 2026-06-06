use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

/// What happened to a file between two trees / index states.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Typechange,
}

/// One file's diff, ready for the staging UI and `@pierre/diffs`.
///
/// `patch` is unified-diff text (RFC-2440-ish, what `git diff` emits) for
/// this single file. Pierre's `<PatchDiff />` consumes it directly; we
/// don't parse hunks on the Rust side until we need to (hunk-level staging
/// in A3 will look at `patch` and a per-hunk index).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub adds: u32,
    pub dels: u32,
    pub binary: bool,
    pub patch: String,
}

impl Repo {
    /// Working tree vs index — the "unstaged" diff shown above the
    /// commit-form in Local Changes.
    pub fn diff_unstaged(&self) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let mut opts = diff_options();
        let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
        collect(diff)
    }

    /// Index vs HEAD — what `git diff --cached` would show.
    pub fn diff_staged(&self) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let mut opts = diff_options();
        let diff = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?;
        collect(diff)
    }

    /// Arbitrary commit-to-commit diff. Used by the commit-detail panel
    /// and the file view's Compare tab.
    pub fn diff_between(&self, from: &str, to: &str) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let from_oid = repo.revparse_single(from)?.id();
        let to_oid = repo.revparse_single(to)?.id();
        let from_tree = repo.find_commit(from_oid)?.tree()?;
        let to_tree = repo.find_commit(to_oid)?.tree()?;
        let mut opts = diff_options();
        let diff = repo.diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut opts))?;
        collect(diff)
    }

    /// Diff a single commit against its first parent — what the user expects
    /// to see when they click a commit in the All Commits graph. Root commits
    /// (no parents) diff against the empty tree, so every file shows up as
    /// added.
    pub fn diff_commit(&self, oid: &str) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let to_oid = repo.revparse_single(oid)?.id();
        let to_commit = repo.find_commit(to_oid)?;
        let to_tree = to_commit.tree()?;
        let from_tree = if to_commit.parent_count() == 0 {
            None
        } else {
            Some(to_commit.parent(0)?.tree()?)
        };
        let mut opts = diff_options();
        let diff = repo.diff_tree_to_tree(from_tree.as_ref(), Some(&to_tree), Some(&mut opts))?;
        collect(diff)
    }

    /// Diff a single commit against its first parent, restricted to one path
    /// (pathspec) — what the file view's History tab shows for a selected
    /// commit. Far cheaper than diffing the whole commit and filtering: the
    /// pathspec limits git2's walk to the file. Returns the matching `FileDiff`
    /// (usually one), or empty when the file wasn't part of that commit (e.g.
    /// it existed under a different name before a rename).
    pub fn diff_commit_file(&self, oid: &str, path: &str) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let to_commit = repo.revparse_single(oid)?.peel_to_commit()?;
        let to_tree = to_commit.tree()?;
        let from_tree = if to_commit.parent_count() == 0 {
            None
        } else {
            Some(to_commit.parent(0)?.tree()?)
        };
        let mut opts = diff_options();
        opts.pathspec(path);
        let diff = repo.diff_tree_to_tree(from_tree.as_ref(), Some(&to_tree), Some(&mut opts))?;
        collect(diff)
    }

    /// Diff one path's working-tree state against HEAD — the net uncommitted
    /// change (staged + unstaged combined) for a single file. Powers the file
    /// view's "Uncommitted changes" history entry. Compares the HEAD tree
    /// directly to the workdir (ignoring the index), so a half-staged file still
    /// shows its full on-disk delta; untracked files appear as additions.
    pub fn diff_workdir_file(&self, path: &str) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let mut opts = diff_options();
        opts.pathspec(path);
        let diff = repo.diff_tree_to_workdir(head_tree.as_ref(), Some(&mut opts))?;
        collect(diff)
    }
}

fn diff_options() -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        // Without this, untracked deltas land in the diff but their patch
        // bodies are empty — Pierre then renders "No textual diff".
        .show_untracked_content(true)
        .context_lines(3);
    opts
}

/// Walk a `git2::Diff` and produce one `FileDiff` per delta. We build the
/// per-file unified-patch text ourselves (git2's `print` callback is
/// per-line and global, so we slot lines into the matching FileDiff as we
/// go).
fn collect(mut diff: git2::Diff<'_>) -> Result<Vec<FileDiff>> {
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).copies(true);
    diff.find_similar(Some(&mut find))?;

    // Pre-populate one FileDiff per delta so the print callback can index
    // into us by delta_idx.
    let mut files: Vec<FileDiff> = (0..diff.deltas().len())
        .map(|i| {
            let d = diff.get_delta(i).expect("delta in range");
            let new_path = d
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let old_path = d.old_file().path().map(|p| p.to_string_lossy().into_owned());
            let renamed = matches!(
                d.status(),
                git2::Delta::Renamed | git2::Delta::Copied
            );
            FileDiff {
                path: new_path,
                old_path: if renamed { old_path } else { None },
                status: map_status(d.status()),
                adds: 0,
                dels: 0,
                binary: d.new_file().is_binary() || d.old_file().is_binary(),
                patch: String::new(),
            }
        })
        .collect();

    // Per-file line counts via the stats walker.
    diff.foreach(
        &mut |_, _| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let idx = delta_index(&delta, &files);
            if let Some(i) = idx {
                match line.origin() {
                    '+' => files[i].adds += 1,
                    '-' => files[i].dels += 1,
                    _ => {}
                }
            }
            true
        }),
    )?;

    // Build per-file patch text by re-printing the diff and routing each
    // line into the right file. This mirrors what `git diff` emits.
    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let Some(i) = delta_index(&delta, &files) else { return true; };
        let f = &mut files[i];
        let origin = line.origin();
        if matches!(origin, 'F' | 'H' | ' ' | '+' | '-' | '=' | '<' | '>') {
            if matches!(origin, ' ' | '+' | '-') {
                f.patch.push(origin);
            }
            f.patch.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    })?;

    Ok(files)
}

fn delta_index(delta: &git2::DiffDelta<'_>, files: &[FileDiff]) -> Option<usize> {
    let new_path = delta.new_file().path()?.to_string_lossy();
    files.iter().position(|f| f.path == new_path)
}

fn map_status(s: git2::Delta) -> DiffStatus {
    match s {
        git2::Delta::Added | git2::Delta::Untracked => DiffStatus::Added,
        git2::Delta::Deleted => DiffStatus::Deleted,
        git2::Delta::Renamed => DiffStatus::Renamed,
        git2::Delta::Copied => DiffStatus::Copied,
        git2::Delta::Typechange => DiffStatus::Typechange,
        _ => DiffStatus::Modified,
    }
}
