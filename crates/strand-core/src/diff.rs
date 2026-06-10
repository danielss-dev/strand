use std::collections::HashMap;

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

    /// Everything that changed since `baseline` (a commit-ish): baseline tree
    /// vs the working tree overlaid with the index. This is the "review
    /// since…" view for agent sessions — unlike `diff_unstaged` it keeps
    /// showing work the agent already staged or committed away from the
    /// baseline, so the reviewer sees the whole session in one diff.
    pub fn diff_since(&self, baseline: &str) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let tree = repo.revparse_single(baseline)?.peel_to_commit()?.tree()?;
        let mut opts = diff_options();
        let diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))?;
        collect(diff)
    }

    /// `diff_unstaged` with whole-file context: every changed file's patch
    /// carries the entire file, not just hunks. Powers the Review view, which
    /// shows an agent's edits in the context of the full file.
    pub fn diff_unstaged_full(&self) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let mut opts = diff_options_with(WHOLE_FILE_CONTEXT);
        let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
        collect(diff)
    }

    /// `diff_since` with whole-file context — see `diff_unstaged_full`.
    pub fn diff_since_full(&self, baseline: &str) -> Result<Vec<FileDiff>> {
        let repo = self.git2()?;
        let tree = repo.revparse_single(baseline)?.peel_to_commit()?.tree()?;
        let mut opts = diff_options_with(WHOLE_FILE_CONTEXT);
        let diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))?;
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

/// "Whole file" context: big enough that one hunk swallows any real file,
/// small enough to stay clear of libgit2's u32 line arithmetic.
const WHOLE_FILE_CONTEXT: u32 = 1_000_000;

fn diff_options() -> git2::DiffOptions {
    diff_options_with(3)
}

fn diff_options_with(context: u32) -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        // Without this, untracked deltas land in the diff but their patch
        // bodies are empty — Pierre then renders "No textual diff".
        .show_untracked_content(true)
        .context_lines(context);
    opts
}

/// Walk a `git2::Diff` and produce one `FileDiff` per delta. We build the
/// per-file unified-patch text ourselves (git2's `print` callback is
/// per-line and global, so we slot lines into the matching FileDiff as we
/// go). Line counts are accumulated in the same pass, and deltas are looked
/// up through a path→index map — a 500-file changeset used to pay a second
/// full walk plus an O(files×lines) linear search here.
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

    let index_by_path: HashMap<String, usize> = files
        .iter()
        .enumerate()
        .map(|(i, f)| (f.path.clone(), i))
        .collect();
    let delta_index = |delta: &git2::DiffDelta<'_>| -> Option<usize> {
        let new_path = delta.new_file().path()?.to_string_lossy();
        index_by_path.get(new_path.as_ref()).copied()
    };

    // Single pass: route each printed line into the right file's patch text
    // and bump its add/del counters as we go. This mirrors what `git diff`
    // emits.
    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let Some(i) = delta_index(&delta) else { return true; };
        let f = &mut files[i];
        let origin = line.origin();
        if matches!(origin, 'F' | 'H' | ' ' | '+' | '-' | '=' | '<' | '>') {
            match origin {
                '+' => f.adds += 1,
                '-' => f.dels += 1,
                _ => {}
            }
            if matches!(origin, ' ' | '+' | '-') {
                f.patch.push(origin);
            }
            f.patch.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    })?;

    Ok(files)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-diff-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn unstaged_diff_counts_lines_and_builds_patch() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        repo.stage_paths(&["a.txt".into()]).unwrap();
        repo.commit("add a", None, false).unwrap();

        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        std::fs::write(dir.join("new.txt"), "hello\n").unwrap();

        let mut diffs = repo.diff_unstaged().unwrap();
        diffs.sort_by(|x, y| x.path.cmp(&y.path));
        assert_eq!(diffs.len(), 2);

        let a = &diffs[0];
        assert_eq!(a.path, "a.txt");
        assert_eq!(a.status, DiffStatus::Modified);
        assert_eq!((a.adds, a.dels), (2, 1)); // TWO replaces two, four added
        assert!(a.patch.contains("+TWO"), "patch carries added line: {}", a.patch);
        assert!(a.patch.contains("-two"), "patch carries removed line: {}", a.patch);

        let n = &diffs[1];
        assert_eq!(n.path, "new.txt");
        assert_eq!(n.status, DiffStatus::Added);
        assert_eq!((n.adds, n.dels), (1, 0));
        assert!(n.patch.contains("+hello"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn full_context_diff_carries_the_whole_file() {
        let (repo, dir) = scratch_repo();
        // Enough lines that a context-3 patch could never cover them all.
        let base: String = (1..=20).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("a.txt"), &base).unwrap();
        repo.stage_paths(&["a.txt".into()]).unwrap();
        repo.commit("add a", None, false).unwrap();

        std::fs::write(dir.join("a.txt"), base.replace("line 10\n", "LINE 10\n")).unwrap();

        let diffs = repo.diff_unstaged_full().unwrap();
        assert_eq!(diffs.len(), 1);
        let a = &diffs[0];
        assert_eq!((a.adds, a.dels), (1, 1)); // context lines don't count
        // First and last lines are far from the change — only whole-file
        // context includes them.
        assert!(a.patch.contains(" line 1\n"), "patch starts at the top: {}", a.patch);
        assert!(a.patch.contains(" line 20\n"), "patch runs to the bottom: {}", a.patch);
        assert!(a.patch.contains("+LINE 10"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn diff_since_spans_commits_and_worktree() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        repo.stage_paths(&["a.txt".into()]).unwrap();
        repo.commit("baseline", None, false).unwrap();
        let baseline = repo.git2().unwrap().head().unwrap().target().unwrap().to_string();

        // Agent session: one committed change, one staged, one loose on disk.
        std::fs::write(dir.join("a.txt"), "base\ncommitted\n").unwrap();
        repo.stage_paths(&["a.txt".into()]).unwrap();
        repo.commit("agent commit", None, false).unwrap();
        std::fs::write(dir.join("b.txt"), "staged\n").unwrap();
        repo.stage_paths(&["b.txt".into()]).unwrap();
        std::fs::write(dir.join("c.txt"), "loose\n").unwrap();

        let mut paths: Vec<String> = repo
            .diff_since(&baseline)
            .unwrap()
            .into_iter()
            .map(|d| d.path)
            .collect();
        paths.sort();
        assert_eq!(paths, vec!["a.txt", "b.txt", "c.txt"]);

        // diff_unstaged would only see c.txt — that's the gap diff_since fills.
        let unstaged: Vec<String> =
            repo.diff_unstaged().unwrap().into_iter().map(|d| d.path).collect();
        assert_eq!(unstaged, vec!["c.txt"]);

        let _ = std::fs::remove_dir_all(dir);
    }
}
