//! Per-repo journal of ref-moving Git actions, and the undo/redo that walks it.
//!
//! Each worktree keeps its own file at `.git/strand-journal.json` (a linked
//! worktree's git dir, not the shared common dir). Entries store the branch
//! tips and HEAD from before and after the operation, plus the index tree, so
//! undo can put those refs back without guessing from the reflog.
//!
//! Undo refuses when a recorded ref no longer points at its "after" target.
//! Pushes are not journaled. Conflicted merges, rebases, and cherry-picks are
//! not journaled either — the sequencer still owns Abort/Continue. Sparse and
//! partial clones are skipped: capturing the index with `write-tree` can
//! expand a sparse index or fault missing blobs.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

const VERSION: u32 = 1;
const MAX_ENTRIES: usize = 100;
const JOURNAL_FILE: &str = "strand-journal.json";

thread_local! {
    static DEPTH: Cell<u32> = const { Cell::new(0) };
    static SUPPRESS: Cell<bool> = const { Cell::new(false) };
}

/// A ref-moving operation the journal knows how to reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitOp {
    Commit,
    Amend,
    Reset,
    BranchCreate,
    BranchDelete,
    BranchRename,
    Checkout,
    Merge,
    Rebase,
    CherryPick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitActionDirection {
    Undo,
    Redo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHistoryItem {
    pub op: GitOp,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitActionHistory {
    /// Newest undoable action first.
    pub undo: Vec<GitHistoryItem>,
    /// Newest redoable action first.
    pub redo: Vec<GitHistoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitActionOutcome {
    pub op: GitOp,
    pub label: String,
    pub direction: GitActionDirection,
    /// Set when undo/redo had to snapshot tracked work before moving a tree.
    pub snapshot_oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Checkpoint {
    head_oid: Option<String>,
    /// Short branch name when HEAD is symbolic. Absent when detached.
    head_branch: Option<String>,
    /// `refs/heads/*` → oid. Absent keys were created or deleted by the op.
    refs: BTreeMap<String, String>,
    index_tree: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    op: GitOp,
    label: String,
    /// The operation replaced worktree files (hard reset, checkout, merge,
    /// rebase, cherry-pick). Soft commit/reset and branch ref edits do not.
    touches_worktree: bool,
    before: Checkpoint,
    after: Checkpoint,
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalFile {
    version: u32,
    undo: Vec<Entry>,
    redo: Vec<Entry>,
}

#[derive(Clone, Copy)]
enum Direction {
    Undo,
    Redo,
}

struct DepthGuard;
impl Drop for DepthGuard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

struct SuppressGuard;
impl SuppressGuard {
    fn enter() -> Self {
        SUPPRESS.with(|flag| flag.set(true));
        Self
    }
}
impl Drop for SuppressGuard {
    fn drop(&mut self) {
        SUPPRESS.with(|flag| flag.set(false));
    }
}

/// Run `body` and, when it finishes cleanly, append a journal entry if HEAD,
/// a local branch, or the index tree changed. Nested calls record only the
/// outer action (create-and-checkout is one entry). A journal write failure
/// does not fail the Git operation.
pub(crate) fn record<T>(
    repo: &Repo,
    op: GitOp,
    label: String,
    touches_worktree: bool,
    body: impl FnOnce() -> Result<T>,
) -> Result<T> {
    if SUPPRESS.with(|flag| flag.get()) || repo.sparse_enabled() || repo.is_partial_clone() {
        return body();
    }
    DEPTH.with(|depth| depth.set(depth.get() + 1));
    let _depth = DepthGuard;
    let nested = DEPTH.with(|depth| depth.get() > 1);
    let before = if nested { None } else { capture(repo).ok() };
    let result = body();
    if nested || result.is_err() || repo.operation_in_progress().is_some() {
        return result;
    }
    if let (Some(before), Ok(after)) = (before, capture(repo)) {
        if before != after {
            let _ = push_entry(repo, op, label, touches_worktree, before, after);
        }
    }
    result
}

impl Repo {
    pub fn undo_git_action(&self) -> Result<GitActionOutcome> {
        self.step(Direction::Undo)
    }

    pub fn redo_git_action(&self) -> Result<GitActionOutcome> {
        self.step(Direction::Redo)
    }

    /// Remove the newest undo (or redo) entry without applying it, for an
    /// entry that can no longer be undone or redone. Nothing in the repo moves.
    pub fn drop_git_action(&self, direction: GitActionDirection) -> Result<GitActionHistory> {
        let _lock = JournalLock::acquire(self)?;
        let mut file = load(self)?;
        let removed = match direction {
            GitActionDirection::Undo => file.undo.pop(),
            GitActionDirection::Redo => file.redo.pop(),
        };
        if removed.is_some() {
            save(self, &file)?;
        }
        drop(_lock);
        self.git_action_history()
    }

    pub fn git_action_history(&self) -> Result<GitActionHistory> {
        let file = load(self)?;
        Ok(GitActionHistory {
            undo: file.undo.iter().rev().map(history_item).collect(),
            redo: file.redo.iter().rev().map(history_item).collect(),
        })
    }

    fn step(&self, direction: Direction) -> Result<GitActionOutcome> {
        let _lock = JournalLock::acquire(self)?;
        let mut file = load(self)?;
        let entry = match direction {
            Direction::Undo => file.undo.pop(),
            Direction::Redo => file.redo.pop(),
        }
        .ok_or_else(|| {
            Error::Other(match direction {
                Direction::Undo => "Nothing to undo".into(),
                Direction::Redo => "Nothing to redo".into(),
            })
        })?;
        let applied = apply_entry(self, &entry, direction);
        let snapshot_oid = match applied {
            Ok(oid) => oid,
            Err(error) => {
                match direction {
                    Direction::Undo => file.undo.push(entry),
                    Direction::Redo => file.redo.push(entry),
                }
                return Err(error);
            }
        };
        let outcome = GitActionOutcome {
            op: entry.op,
            label: entry.label.clone(),
            direction: match direction {
                Direction::Undo => GitActionDirection::Undo,
                Direction::Redo => GitActionDirection::Redo,
            },
            snapshot_oid,
        };
        match direction {
            Direction::Undo => file.redo.push(entry),
            Direction::Redo => file.undo.push(entry),
        }
        save(self, &file)?;
        Ok(outcome)
    }
}

fn history_item(entry: &Entry) -> GitHistoryItem {
    GitHistoryItem {
        op: entry.op,
        label: entry.label.clone(),
    }
}

fn journal_path(repo: &Repo) -> PathBuf {
    repo.git_dir().join(JOURNAL_FILE)
}

fn load(repo: &Repo) -> Result<JournalFile> {
    let path = journal_path(repo);
    if !path.exists() {
        return Ok(JournalFile {
            version: VERSION,
            undo: Vec::new(),
            redo: Vec::new(),
        });
    }
    let data = std::fs::read(&path)?;
    let file: JournalFile = serde_json::from_slice(&data)
        .map_err(|error| Error::Other(format!("Couldn't read git action history: {error}")))?;
    if file.version != VERSION {
        return Err(Error::Other(
            "This git action history was written by a different Strand version and can't be used."
                .into(),
        ));
    }
    Ok(file)
}

/// Write to a temp file unique to this process and call, then rename over the
/// journal. `rename` replaces the target atomically (also on Windows), so a
/// reader never sees a missing or half-written file.
fn save(repo: &Repo, file: &JournalFile) -> Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = journal_path(repo);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}-{seq}.tmp", std::process::id()));
    let data = serde_json::to_vec_pretty(file)
        .map_err(|error| Error::Other(format!("Couldn't write git action history: {error}")))?;
    std::fs::write(&tmp, data)?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

/// Exclusive lock around one load → modify → save of the journal, so a
/// recorded action and an undo (or two windows) can't drop each other's
/// entries. A lock file older than [`JournalLock::STALE`] is left from a
/// crash and is taken over.
struct JournalLock(PathBuf);

impl JournalLock {
    const WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    const STALE: std::time::Duration = std::time::Duration::from_secs(60);

    fn acquire(repo: &Repo) -> Result<Self> {
        let path = journal_path(repo).with_extension("json.lock");
        let deadline = std::time::Instant::now() + Self::WAIT;
        loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|at| at.elapsed().ok())
                        .is_some_and(|age| age > Self::STALE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(Error::Other(
                            "Git action history is busy in another window. Try again.".into(),
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for JournalLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn push_entry(
    repo: &Repo,
    op: GitOp,
    label: String,
    touches_worktree: bool,
    before: Checkpoint,
    after: Checkpoint,
) -> Result<()> {
    let _lock = JournalLock::acquire(repo)?;
    let mut file = load(repo)?;
    file.redo.clear();
    file.undo.push(Entry {
        op,
        label,
        touches_worktree,
        before,
        after,
    });
    if file.undo.len() > MAX_ENTRIES {
        let overflow = file.undo.len() - MAX_ENTRIES;
        file.undo.drain(0..overflow);
    }
    save(repo, &file)
}

fn capture(repo: &Repo) -> Result<Checkpoint> {
    let git = repo.git2()?;
    let index_tree = index_tree_oid(repo)?;
    let detached = git.head_detached().unwrap_or(false);
    let head_oid = git
        .head()
        .ok()
        .and_then(|head| head.target())
        .map(|oid| oid.to_string());
    let head_branch = if detached {
        None
    } else {
        git.find_reference("HEAD").ok().and_then(|head| {
            head.symbolic_target()
                .map(|name| name.trim_start_matches("refs/heads/").to_string())
        })
    };
    let mut refs = BTreeMap::new();
    for reference in git.references()? {
        let reference = reference?;
        let Some(name) = reference.name() else {
            continue;
        };
        if !name.starts_with("refs/heads/") {
            continue;
        }
        if let Some(oid) = reference.target() {
            refs.insert(name.to_string(), oid.to_string());
        }
    }
    Ok(Checkpoint {
        head_oid,
        head_branch,
        refs,
        index_tree,
    })
}

fn index_tree_oid(repo: &Repo) -> Result<String> {
    // Out of process on purpose. `Repository::index()` caches the index for
    // the life of the git2 handle, so a capture taken before a merge would
    // make the later conflict check see the pre-merge index.
    //
    // A missing index (`git clone --no-checkout`) must stay missing.
    // `git write-tree` creates an empty one, and the checkout that follows
    // then reports every tracked file deleted instead of writing it.
    if !repo.git_dir().join("index").is_file() {
        return git_stdout(repo, &["mktree"]);
    }
    git_stdout(repo, &["write-tree"])
}

fn git_stdout(repo: &Repo, args: &[&str]) -> Result<String> {
    let mut cmd = crate::git_command();
    cmd.current_dir(&repo.path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(args);
    let out = cmd
        .output()
        .map_err(|error| Error::Other(format!("spawn git failed: {error}")))?;
    if !out.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        return Err(Error::Other(detail.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn apply_entry(repo: &Repo, entry: &Entry, direction: Direction) -> Result<Option<String>> {
    let _suppress = SuppressGuard::enter();
    let (expected, target) = match direction {
        Direction::Undo => (&entry.after, &entry.before),
        Direction::Redo => (&entry.before, &entry.after),
    };
    let verb = match direction {
        Direction::Undo => "undo",
        Direction::Redo => "redo",
    };
    let current = capture(repo)?;
    ensure_at(
        &current,
        expected,
        &entry.before,
        &entry.after,
        &entry.label,
        verb,
    )?;
    ensure_not_in_other_worktree(repo, entry, target, verb)?;
    ensure_not_pushed(repo, entry, expected, target, verb)?;

    let index_changed = entry.before.index_tree != entry.after.index_tree;
    let drift = current.index_tree != expected.index_tree;
    let dirty = if entry.touches_worktree || (index_changed && drift) {
        tracked_worktree_dirty(repo)?
    } else {
        false
    };
    if entry.touches_worktree {
        if let Some(oid) = target.head_oid.as_deref() {
            crate::reset::guard_target_commit_collisions(repo, oid)?;
        }
    }
    let need_stash = (entry.touches_worktree && (drift || dirty)) || (index_changed && drift);
    let snapshot_oid = if need_stash {
        let message = format!("Safety: before {verb} {}", entry.label);
        repo.stash_snapshot(Some(&message), false)?.oid
    } else {
        None
    };

    if let Err(error) = restore_state(repo, entry, target) {
        let _ = restore_state(repo, entry, expected);
        return Err(error);
    }
    Ok(snapshot_oid)
}

/// Refuse before writing anything when a branch this step would move, delete,
/// or check out is checked out in another linked worktree. Forward checkout
/// and branch ops refuse the same way.
fn ensure_not_in_other_worktree(
    repo: &Repo,
    entry: &Entry,
    target: &Checkpoint,
    verb: &str,
) -> Result<()> {
    let others: Vec<_> = repo
        .worktrees()
        .unwrap_or_default()
        .into_iter()
        .filter(|worktree| !worktree.is_current)
        .collect();
    if others.is_empty() {
        return Ok(());
    }
    let mut branches: BTreeSet<String> = changed_ref_names(&entry.before, &entry.after)
        .into_iter()
        .filter_map(|name| name.strip_prefix("refs/heads/").map(str::to_string))
        .collect();
    if let Some(branch) = &target.head_branch {
        branches.insert(branch.clone());
    }
    for branch in branches {
        if let Some(worktree) = others.iter().find(|w| w.branch.as_deref() == Some(branch.as_str())) {
            return Err(Error::Other(format!(
                "Can't {verb} {}: branch {branch} is checked out in worktree {}.",
                entry.label, worktree.path
            )));
        }
    }
    Ok(())
}

/// Never undo (or redo) what already left the machine: refuse when moving a
/// branch would drop a commit its upstream (or, with no upstream, a
/// same-named remote-tracking branch) already has.
fn ensure_not_pushed(
    repo: &Repo,
    entry: &Entry,
    expected: &Checkpoint,
    target: &Checkpoint,
    verb: &str,
) -> Result<()> {
    for name in changed_ref_names(&entry.before, &entry.after) {
        let (Some(from), Some(branch)) = (expected.refs.get(&name), name.strip_prefix("refs/heads/")) else {
            continue;
        };
        // A branch the step deletes keeps its commits on the remote; only a
        // move that leaves commits behind can rewrite pushed history.
        let Some(to) = target.refs.get(&name) else {
            continue;
        };
        let remotes = remote_refs_for(repo, branch);
        if remotes.is_empty() {
            continue;
        }
        // Commits the move drops, and how many of those no remote has.
        let range = [from.clone(), format!("^{to}")];
        let count = |extra: &[String]| -> Result<String> {
            let mut args = vec!["rev-list", "--count"];
            args.extend(range.iter().map(String::as_str));
            args.extend(extra.iter().map(String::as_str));
            git_stdout(repo, &args)
        };
        let excluded: Vec<String> = remotes.iter().map(|remote| format!("^{remote}")).collect();
        if count(&[])? != count(&excluded)? {
            let names: Vec<&str> = remotes
                .iter()
                .map(|remote| remote.trim_start_matches("refs/remotes/"))
                .collect();
            return Err(Error::Other(format!(
                "Can't {verb} {}: {branch} would drop commits already pushed to {}. Undo never rewrites pushed history.",
                entry.label,
                names.join(", ")
            )));
        }
    }
    Ok(())
}

/// The branch's upstream when it has one; otherwise every
/// `refs/remotes/*/<branch>`.
fn remote_refs_for(repo: &Repo, branch: &str) -> Vec<String> {
    if let Ok(upstream) = git_stdout(
        repo,
        &["rev-parse", "--symbolic-full-name", &format!("refs/heads/{branch}@{{upstream}}")],
    ) {
        if upstream.starts_with("refs/remotes/") {
            return vec![upstream];
        }
    }
    let Ok(git) = repo.git2() else {
        return Vec::new();
    };
    let Ok(references) = git.references_glob("refs/remotes/*") else {
        return Vec::new();
    };
    references
        .flatten()
        .filter_map(|reference| reference.name().map(str::to_string))
        .filter(|name| {
            name.strip_prefix("refs/remotes/")
                .and_then(|rest| rest.split_once('/'))
                .is_some_and(|(_, rest)| rest == branch)
        })
        .collect()
}

fn restore_state(repo: &Repo, entry: &Entry, target: &Checkpoint) -> Result<()> {
    restore_refs_and_head(repo, target, &entry.before, &entry.after)?;
    let index_changed = entry.before.index_tree != entry.after.index_tree;
    let absent_deletions = if entry.touches_worktree {
        absent_staged_deletions(repo, target)?
    } else {
        Vec::new()
    };
    if entry.touches_worktree {
        if let Some(oid) = target.head_oid.as_deref() {
            checkout_commit_tree(repo, oid)?;
        }
    }
    if entry.touches_worktree || index_changed {
        restore_index_tree(repo, &target.index_tree)?;
    }
    if entry.touches_worktree {
        checkout_staged_paths(repo)?;
        remove_recreated_deletions(repo, &absent_deletions)?;
    }
    Ok(())
}

/// Staged deletions the target state carries (in its HEAD tree, missing from
/// its index) whose file is absent from disk right now, with the HEAD blob.
///
/// A checkout carries a staged deletion without touching the worktree, so
/// presence on disk before the restore is presence in the recorded state:
/// `git rm` left no file, `git rm --cached` left an untracked one. Only the
/// absent ones get removed again after the forced tree checkout re-creates
/// them, so nothing that was on disk before the undo is ever deleted (the
/// `git rm --cached` file is refused earlier by the collision guard anyway).
/// Other actions (e.g. `reset --hard`) may leave the file present here; it
/// then stays as an untracked file.
fn absent_staged_deletions(repo: &Repo, target: &Checkpoint) -> Result<Vec<(String, git2::Oid)>> {
    let Some(head) = target.head_oid.as_deref() else {
        return Ok(Vec::new());
    };
    let git = repo.git2()?;
    let head_tree = git.find_commit(git2::Oid::from_str(head)?)?.tree()?;
    let index_tree = git.find_tree(git2::Oid::from_str(&target.index_tree)?)?;
    let diff = git.diff_tree_to_tree(Some(&head_tree), Some(&index_tree), None)?;
    let mut absent = Vec::new();
    for delta in diff.deltas() {
        let old = delta.old_file();
        let is_file = matches!(old.mode(), git2::FileMode::Blob | git2::FileMode::BlobExecutable);
        if delta.status() != git2::Delta::Deleted || !is_file {
            continue;
        }
        let Some(path) = old.path().and_then(|path| path.to_str()) else {
            continue;
        };
        match std::fs::symlink_metadata(repo.path.join(path)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                absent.push((path.to_string(), old.id()));
            }
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
    }
    Ok(absent)
}

/// Remove the files the forced tree checkout re-created for staged deletions
/// that were absent before the restore, but only where the content on disk
/// still hashes to the HEAD blob it wrote; anything else is left alone.
fn remove_recreated_deletions(repo: &Repo, deletions: &[(String, git2::Oid)]) -> Result<()> {
    // `--stdin-paths` reads lines and unquotes a leading `"`; keep such paths.
    let present: Vec<&(String, git2::Oid)> = deletions
        .iter()
        .filter(|(path, _)| !path.contains('\n') && !path.starts_with('"'))
        .filter(|(path, _)| repo.path.join(path).is_file())
        .collect();
    if present.is_empty() {
        return Ok(());
    }
    let input: String = present.iter().map(|(path, _)| format!("{path}\n")).collect();
    let out = git_with_input(repo, &["hash-object", "--stdin-paths"], input.into_bytes())?;
    let hashes = String::from_utf8_lossy(&out);
    for ((path, blob), hash) in present.into_iter().zip(hashes.lines()) {
        if hash == blob.to_string() {
            std::fs::remove_file(repo.path.join(path))?;
        }
    }
    Ok(())
}

/// After a forced tree checkout and an index restore, write the recorded
/// staged content of added or modified paths back to the worktree, so a
/// checkout that carried staged changes comes back staged and on disk.
/// `checkout-index` runs filters (LFS smudge), unlike a libgit2 checkout.
fn checkout_staged_paths(repo: &Repo) -> Result<()> {
    // Not `git_stdout`: its trim would eat spaces at the ends of a path.
    let out = crate::git_command()
        .current_dir(&repo.path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=AMT", "-z"])
        .output()
        .map_err(|error| Error::Other(format!("spawn git failed: {error}")))?;
    if !out.status.success() {
        return Err(Error::Other(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    let staged = String::from_utf8_lossy(&out.stdout);
    let paths: Vec<&str> = staged.split('\0').filter(|path| !path.is_empty()).collect();
    if paths.is_empty() {
        return Ok(());
    }
    // Paths go over stdin: thousands of them would overflow Windows' argv.
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    git_with_input(repo, &["checkout-index", "-f", "-z", "--stdin"], input)?;
    Ok(())
}

fn git_with_input(repo: &Repo, args: &[&str], input: Vec<u8>) -> Result<Vec<u8>> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = crate::git_command()
        .current_dir(&repo.path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(crate::GIT_SAFE_CONFIG)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Error::Other(format!("spawn git failed: {error}")))?;
    // Write concurrently so an early Git error cannot deadlock a large list.
    let mut stdin = child.stdin.take().expect("piped stdin");
    std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child
        .wait_with_output()
        .map_err(|error| Error::Other(format!("wait for git failed: {error}")))?;
    if !out.status.success() {
        return Err(Error::Other(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(out.stdout)
}

fn restore_refs_and_head(
    repo: &Repo,
    target: &Checkpoint,
    before: &Checkpoint,
    after: &Checkpoint,
) -> Result<()> {
    let git = repo.git2()?;
    let names = changed_ref_names(before, after);
    for name in &names {
        if let Some(oid) = target.refs.get(name) {
            let id = git2::Oid::from_str(oid)?;
            git.reference(name, id, true, "strand: git action")?;
        }
    }
    match &target.head_branch {
        Some(branch) => git.set_head(&format!("refs/heads/{branch}"))?,
        None => {
            let Some(oid) = target.head_oid.as_deref() else {
                return Err(Error::Other("recorded HEAD is missing".into()));
            };
            git.set_head_detached(git2::Oid::from_str(oid)?)?;
        }
    }
    for name in &names {
        if !target.refs.contains_key(name) {
            if let Ok(mut reference) = git.find_reference(name) {
                reference.delete()?;
            }
        }
    }
    Ok(())
}

fn checkout_commit_tree(repo: &Repo, oid: &str) -> Result<()> {
    if repo.sparse_enabled() || repo.is_partial_clone() {
        crate::network::run_git_streaming(
            &repo.path,
            &["reset", "--hard", "HEAD", "--"],
            |_| {},
            None,
        )?;
        return Ok(());
    }
    let git = repo.git2()?;
    let commit = git.find_commit(git2::Oid::from_str(oid)?)?;
    let tree = commit.tree()?;
    if repo.lfs_checkout_needed(&tree)? {
        repo.run_lfs_filtered(&["reset", "--hard", "HEAD", "--"])?;
        return Ok(());
    }
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    git.checkout_tree(tree.as_object(), Some(&mut checkout))?;
    Ok(())
}

fn restore_index_tree(repo: &Repo, tree_oid: &str) -> Result<()> {
    let git = repo.git2()?;
    let tree = git.find_tree(git2::Oid::from_str(tree_oid)?)?;
    let mut index = git.index()?;
    index.read(true)?;
    index.read_tree(&tree)?;
    index.write()?;
    Ok(())
}

fn tracked_worktree_dirty(repo: &Repo) -> Result<bool> {
    let git = repo.git2()?;
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(false);
    let statuses = git.statuses(Some(&mut opts))?;
    // Staged-only changes count too: the forced tree checkout would otherwise
    // overwrite those files without a safety snapshot.
    Ok(statuses.iter().any(|entry| {
        let status = entry.status();
        status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
            || status.is_index_typechange()
            || status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_typechange()
            || status.is_wt_renamed()
            || status.is_conflicted()
    }))
}

fn changed_ref_names(before: &Checkpoint, after: &Checkpoint) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for name in before.refs.keys().chain(after.refs.keys()) {
        if before.refs.get(name) != after.refs.get(name) {
            names.insert(name.clone());
        }
    }
    names
}

fn ensure_at(
    current: &Checkpoint,
    expected: &Checkpoint,
    before: &Checkpoint,
    after: &Checkpoint,
    label: &str,
    verb: &str,
) -> Result<()> {
    if let Some(name) = moved_branch_ref(current, expected, before, after) {
        return Err(Error::Other(mismatch(
            verb,
            label,
            &name,
            &describe_oid(current.refs.get(&name)),
            &describe_oid(expected.refs.get(&name)),
        )));
    }
    if current.head_oid != expected.head_oid || current.head_branch != expected.head_branch {
        return Err(Error::Other(mismatch(
            verb,
            label,
            "HEAD",
            &describe_head(current),
            &describe_head(expected),
        )));
    }
    for name in changed_ref_names(before, after) {
        let current_oid = current.refs.get(&name);
        let expected_oid = expected.refs.get(&name);
        if current_oid != expected_oid {
            return Err(Error::Other(mismatch(
                verb,
                label,
                &name,
                &describe_oid(current_oid),
                &describe_oid(expected_oid),
            )));
        }
    }
    Ok(())
}

/// When the op moved the current branch tip and that tip has since moved
/// again, name `refs/heads/…` rather than HEAD. Callers can see which ref
/// refused the undo.
fn moved_branch_ref(
    current: &Checkpoint,
    expected: &Checkpoint,
    before: &Checkpoint,
    after: &Checkpoint,
) -> Option<String> {
    let branch = expected.head_branch.as_deref()?;
    let name = format!("refs/heads/{branch}");
    if !changed_ref_names(before, after).contains(&name) {
        return None;
    }
    if current.refs.get(&name) == expected.refs.get(&name) {
        return None;
    }
    Some(name)
}

fn mismatch(verb: &str, label: &str, what: &str, current: &str, expected: &str) -> String {
    format!(
        "Can't {verb} {label}: {what} is {current}, not {expected}. The repository changed after this action."
    )
}

fn describe_head(checkpoint: &Checkpoint) -> String {
    match (&checkpoint.head_branch, &checkpoint.head_oid) {
        (Some(branch), Some(oid)) => format!("branch {branch} at {}", short(oid)),
        (Some(branch), None) => format!("unborn branch {branch}"),
        (None, Some(oid)) => format!("detached at {}", short(oid)),
        (None, None) => "unborn".to_string(),
    }
}

fn describe_oid(oid: Option<&String>) -> String {
    match oid {
        Some(oid) => format!("at {}", short(oid)),
        None => "absent".to_string(),
    }
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{MergeMode, RebaseAction, RebaseStep};
    use crate::network::PushMode;
    use crate::reset::ResetMode;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    struct Rm(PathBuf);
    impl Drop for Rm {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> (Repo, PathBuf, Rm) {
        let dir = std::env::temp_dir().join(format!(
            "strand-journal-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        let repo = Repo::discover(&dir).unwrap();
        let rm = Rm(dir.clone());
        (repo, dir, rm)
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn git_ok(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success()
    }

    fn write_commit(dir: &Path, file: &str, contents: &str, message: &str) -> String {
        std::fs::write(dir.join(file), contents).unwrap();
        git(dir, &["add", "--", file]);
        git(dir, &["commit", "-q", "-m", message]);
        git(dir, &["rev-parse", "HEAD"])
    }

    fn stage(dir: &Path, file: &str, contents: &str) {
        std::fs::write(dir.join(file), contents).unwrap();
        git(dir, &["add", "--", file]);
    }

    fn head_oid(dir: &Path) -> Option<String> {
        let out = Command::new("git")
            .current_dir(dir)
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .output()
            .unwrap();
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    fn view(dir: &Path) -> String {
        let symbolic = {
            let out = Command::new("git")
                .current_dir(dir)
                .args(["symbolic-ref", "-q", "HEAD"])
                .output()
                .unwrap();
            if out.status.success() {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            } else {
                String::new()
            }
        };
        format!(
            "head={}\nsym={symbolic}\nindex={}\nrefs={}\n",
            head_oid(dir).unwrap_or_default(),
            git(dir, &["write-tree"]),
            git(
                dir,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads"
                ]
            ),
        )
    }

    #[test]
    fn commit_and_amend_round_trip_head_and_index() {
        let (repo, dir, _rm) = scratch("commit");
        write_commit(&dir, "a.txt", "a\n", "base");
        stage(&dir, "b.txt", "b\n");
        let before = view(&dir);
        repo.commit("add b", None, false).unwrap();
        assert_ne!(view(&dir), before);
        assert!(!git(&dir, &["status", "--porcelain"]).contains("strand-journal"));
        let outcome = repo.undo_git_action().unwrap();
        assert_eq!(outcome.label, "Commit: add b");
        assert_eq!(outcome.direction, GitActionDirection::Undo);
        assert_eq!(
            view(&dir),
            before,
            "undo restores HEAD, branch tips, and index"
        );
        repo.redo_git_action().unwrap();
        assert_ne!(view(&dir), before);
        let committed = view(&dir);
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), committed);

        stage(&dir, "c.txt", "c\n");
        let amended_from = view(&dir);
        repo.commit("amended", None, true).unwrap();
        let amended = view(&dir);
        repo.undo_git_action().unwrap();
        assert_eq!(
            view(&dir),
            amended_from,
            "undo amend restores the pre-amend commit and index"
        );
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), amended, "redo restores the amended state");
    }

    fn index_line(snapshot: &str) -> String {
        snapshot
            .lines()
            .find(|line| line.starts_with("index="))
            .unwrap_or_default()
            .to_string()
    }

    fn head_oid_of(snapshot: &str) -> Option<String> {
        snapshot.lines().next().and_then(|line| {
            let oid = line.trim_start_matches("head=");
            if oid.is_empty() {
                None
            } else {
                Some(oid.to_string())
            }
        })
    }

    #[test]
    fn commit_undo_keeps_index_changes_made_afterwards() {
        let (repo, dir, _rm) = scratch("commit-later");
        write_commit(&dir, "a.txt", "a\n", "base");
        stage(&dir, "b.txt", "b\n");
        repo.commit("add b", None, false).unwrap();
        stage(&dir, "c.txt", "c\n");
        let index = git(&dir, &["write-tree"]);
        repo.undo_git_action().unwrap();
        assert_eq!(
            git(&dir, &["write-tree"]),
            index,
            "later staged files stay staged"
        );
        assert_eq!(head_oid(&dir), Some(git(&dir, &["rev-parse", "HEAD"])));
        let staged = git(&dir, &["diff", "--cached", "--name-only"]);
        assert!(staged.contains("b.txt"), "{staged}");
        assert!(staged.contains("c.txt"), "{staged}");
    }

    #[test]
    fn first_commit_undo_returns_to_unborn_index() {
        let (repo, dir, _rm) = scratch("unborn");
        stage(&dir, "a.txt", "a\n");
        let before = view(&dir);
        assert!(head_oid(&dir).is_none());
        repo.commit("init", None, false).unwrap();
        let committed = view(&dir);
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);
        assert!(head_oid(&dir).is_none());
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), committed);
    }

    #[test]
    fn reset_soft_mixed_and_hard_round_trip() {
        let (repo, dir, _rm) = scratch("reset");
        write_commit(&dir, "a.txt", "a\n", "base");
        write_commit(&dir, "b.txt", "b\n", "second");
        let tip = view(&dir);
        for mode in [ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard] {
            repo.reset("HEAD~1", mode).unwrap();
            let reset = view(&dir);
            assert_ne!(reset, tip);
            repo.undo_git_action().unwrap();
            assert_eq!(view(&dir), tip, "undo {mode:?}");
            repo.redo_git_action().unwrap();
            assert_eq!(view(&dir), reset, "redo {mode:?}");
            repo.undo_git_action().unwrap();
            assert_eq!(view(&dir), tip);
        }
    }

    #[test]
    fn branch_create_delete_and_rename_round_trip() {
        let (repo, dir, _rm) = scratch("branch");
        write_commit(&dir, "a.txt", "a\n", "base");
        let before = view(&dir);
        repo.create_branch("feature", None, false).unwrap();
        let created = view(&dir);
        assert_eq!(repo.git_action_history().unwrap().undo.len(), 1);
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);
        assert!(!git_ok(
            &dir,
            &["show-ref", "--verify", "--quiet", "refs/heads/feature"]
        ));
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), created);

        let sha = git(&dir, &["rev-parse", "refs/heads/feature"]);
        repo.delete_branch("feature", true).unwrap();
        let deleted = view(&dir);
        assert!(!git_ok(
            &dir,
            &["show-ref", "--verify", "--quiet", "refs/heads/feature"]
        ));
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), created);
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/feature"]), sha);
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), deleted);

        repo.create_branch("feature", None, true).unwrap();
        assert_eq!(
            repo.git_action_history().unwrap().undo[0].label,
            "Create and check out branch feature"
        );
        let checked_out = view(&dir);
        repo.rename_branch("feature", "renamed").unwrap();
        let renamed = view(&dir);
        assert_eq!(git(&dir, &["symbolic-ref", "--short", "HEAD"]), "renamed");
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), checked_out);
        assert_eq!(git(&dir, &["symbolic-ref", "--short", "HEAD"]), "feature");
        assert!(!git_ok(
            &dir,
            &["show-ref", "--verify", "--quiet", "refs/heads/renamed"]
        ));
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), renamed);
    }

    #[test]
    fn checkout_branch_and_detached_commit_round_trip() {
        let (repo, dir, _rm) = scratch("checkout");
        write_commit(&dir, "a.txt", "a\n", "base");
        let parent = write_commit(&dir, "b.txt", "b\n", "second");
        git(&dir, &["branch", "older", "HEAD~1"]);
        let on_main = view(&dir);
        repo.checkout_branch("older").unwrap();
        let on_older = view(&dir);
        assert!(!dir.join("b.txt").exists());
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), on_main);
        assert!(dir.join("b.txt").exists());
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), on_older);
        assert!(!dir.join("b.txt").exists());
        repo.undo_git_action().unwrap();

        repo.checkout_commit("HEAD~1").unwrap();
        let detached = view(&dir);
        assert!(
            !git_ok(&dir, &["symbolic-ref", "-q", "HEAD"]),
            "detached HEAD has no symbolic ref"
        );
        repo.undo_git_action().unwrap();
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), parent);
        assert_eq!(git(&dir, &["symbolic-ref", "--short", "HEAD"]), "main");
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), detached);
    }

    #[test]
    fn merge_undo_restores_pre_merge_tip_and_index() {
        let (repo, dir, _rm) = scratch("merge");
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feature.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main");
        let before = view(&dir);
        let tip = git(&dir, &["rev-parse", "HEAD"]);
        assert!(!repo.merge("feature", MergeMode::NoFastForward).unwrap());
        let merged = view(&dir);
        assert_ne!(git(&dir, &["rev-parse", "HEAD"]), tip);
        assert!(dir.join("feature.txt").exists());
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/main"]), tip);
        assert!(!dir.join("feature.txt").exists());
        assert!(git_ok(
            &dir,
            &["show-ref", "--verify", "--quiet", "refs/heads/feature"]
        ));
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), merged);
        assert!(dir.join("feature.txt").exists());
    }

    #[test]
    fn review_update_refs_rebase_undo_restores_stacked_branch() {
        if !crate::history::git_supports_update_refs() {
            return;
        }
        let (repo, dir, _rm) = scratch("stack-undo");
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "a"]);
        write_commit(&dir, "a.txt", "a\n", "a");
        let a_tip = git(&dir, &["rev-parse", "HEAD"]);
        git(&dir, &["checkout", "-q", "-b", "b"]);
        write_commit(&dir, "b.txt", "b\n", "b");
        let b_tip = git(&dir, &["rev-parse", "HEAD"]);
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main");
        git(&dir, &["checkout", "-q", "b"]);
        let out = repo.rebase("main", true).unwrap();
        assert!(!out.paused);
        assert_ne!(git(&dir, &["rev-parse", "refs/heads/a"]), a_tip, "a moved: {:?}", out.moved);
        repo.undo_git_action().unwrap();
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/b"]), b_tip);
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/a"]), a_tip, "undo restores the stacked branch");
        repo.redo_git_action().unwrap();
        assert_ne!(git(&dir, &["rev-parse", "refs/heads/a"]), a_tip);
    }

    #[test]
    fn amend_into_is_one_undo_entry_and_restores_stacked_branch() {
        let (repo, dir, _rm) = scratch("amend-into-undo");
        write_commit(&dir, "base.txt", "base\n", "c0");
        let c1 = write_commit(&dir, "a.txt", "a\n", "c1");
        let c2 = write_commit(&dir, "b.txt", "b\n", "c2");
        let c3 = write_commit(&dir, "c.txt", "c\n", "c3");
        git(&dir, &["branch", "stack-a", &c2]);
        std::fs::write(dir.join("a.txt"), "a\nplus\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        let staged_before = git(&dir, &["write-tree"]);
        let entries_before = repo.git_action_history().unwrap().undo.len();

        assert!(!repo.amend_into_commit(&c1).unwrap());
        assert_ne!(git(&dir, &["rev-parse", "HEAD"]), c3);
        let amended = view(&dir);
        let history = repo.git_action_history().unwrap();
        assert_eq!(
            history.undo.len(),
            entries_before + 1,
            "fixup commit and rebase are one entry"
        );
        if crate::history::git_supports_update_refs() {
            assert_ne!(git(&dir, &["rev-parse", "refs/heads/stack-a"]), c2);
        }

        repo.undo_git_action().unwrap();
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), c3);
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/stack-a"]), c2);
        assert_eq!(git(&dir, &["write-tree"]), staged_before, "staged change is back in the index");
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), amended);
    }

    #[test]
    fn rebase_undo_restores_pre_rebase_tip() {
        let (repo, dir, _rm) = scratch("rebase");
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feature.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main");
        git(&dir, &["checkout", "-q", "feature"]);
        let tip = git(&dir, &["rev-parse", "HEAD"]);
        let before = view(&dir);
        assert!(!repo.rebase("main", false).unwrap().paused);
        let rebased = view(&dir);
        assert_ne!(git(&dir, &["rev-parse", "refs/heads/feature"]), tip);
        repo.undo_git_action().unwrap();
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/feature"]), tip);
        assert_eq!(view(&dir), before);
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), rebased);
    }

    #[test]
    fn interactive_rebase_undo_restores_pre_rebase_tip() {
        let (repo, dir, _rm) = scratch("rebase-i");
        let base = write_commit(&dir, "a.txt", "a\n", "base");
        let keep = write_commit(&dir, "b.txt", "b\n", "keep");
        let drop = write_commit(&dir, "c.txt", "c\n", "drop");
        let before = view(&dir);
        assert!(!repo
            .interactive_rebase(
                Some(&base),
                &[
                    RebaseStep {
                        action: RebaseAction::Pick,
                        oid: keep,
                        message: None
                    },
                    RebaseStep {
                        action: RebaseAction::Drop,
                        oid: drop,
                        message: None
                    },
                ],
                false,
                false,
            )
            .unwrap()
            .paused);
        assert!(!dir.join("c.txt").exists());
        let rebased = view(&dir);
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);
        assert!(dir.join("c.txt").exists());
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), rebased);
        assert!(!dir.join("c.txt").exists());
    }

    #[test]
    fn cherry_pick_round_trip() {
        let (repo, dir, _rm) = scratch("pick");
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        let pick = write_commit(&dir, "only.txt", "x\n", "only");
        git(&dir, &["checkout", "-q", "main"]);
        let before = view(&dir);
        assert!(!repo.cherry_pick(&[pick], None).unwrap());
        let picked = view(&dir);
        assert!(dir.join("only.txt").exists());
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);
        assert!(!dir.join("only.txt").exists());
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), picked);
        assert!(dir.join("only.txt").exists());
    }

    #[test]
    fn undo_refuses_when_a_ref_moved_externally() {
        let (repo, dir, _rm) = scratch("external");
        write_commit(&dir, "a.txt", "a\n", "base");
        stage(&dir, "b.txt", "b\n");
        repo.commit("add b", None, false).unwrap();
        let recorded = git(&dir, &["rev-parse", "HEAD"]);
        git(&dir, &["commit", "--allow-empty", "-q", "-m", "external"]);
        let moved = git(&dir, &["rev-parse", "HEAD"]);
        assert_ne!(moved, recorded);
        let error = repo.undo_git_action().unwrap_err().to_string();
        assert!(error.contains("changed after this action"), "{error}");
        assert!(error.contains("refs/heads/main"), "{error}");
        assert_eq!(
            git(&dir, &["rev-parse", "HEAD"]),
            moved,
            "a refused undo does not move the ref"
        );
        assert_eq!(repo.git_action_history().unwrap().undo.len(), 1);
    }

    #[test]
    fn journal_survives_reopen_and_is_per_repo_and_worktree() {
        let (repo, dir, _rm) = scratch("persist");
        write_commit(&dir, "a.txt", "a\n", "base");
        stage(&dir, "b.txt", "b\n");
        let before = view(&dir);
        repo.commit("add b", None, false).unwrap();
        let journal = repo.git_dir().join("strand-journal.json");
        assert!(
            journal.is_file(),
            "journal is stored in the worktree git dir"
        );
        assert!(!dir.join("strand-journal.json").exists());
        drop(repo);
        let repo = Repo::discover(&dir).unwrap();
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before);

        let (other, other_dir, _other_rm) = scratch("other");
        write_commit(&other_dir, "z.txt", "z\n", "other");
        let other_head = git(&other_dir, &["rev-parse", "HEAD"]);
        other.commit("other commit", None, true).unwrap();
        repo.commit("main again", None, false).unwrap();
        repo.undo_git_action().unwrap();
        assert_ne!(
            git(&other_dir, &["rev-parse", "HEAD"]),
            other_head,
            "undo in one repo does not rewind the other"
        );

        let wt = std::env::temp_dir().join(format!(
            "strand-journal-wt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        git(
            &dir,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                wt.to_str().unwrap(),
            ],
        );
        let linked = Repo::discover(&wt).unwrap();
        stage(&wt, "w.txt", "w\n");
        let feature_before = view(&wt);
        linked.commit("worktree", None, false).unwrap();
        assert!(linked.git_dir().join("strand-journal.json").is_file());
        assert_ne!(linked.git_dir(), repo.git_dir());
        let main_head = git(&dir, &["rev-parse", "HEAD"]);
        linked.undo_git_action().unwrap();
        assert_eq!(view(&wt), feature_before);
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), main_head);
        drop(linked);
        let _ = std::fs::remove_dir_all(&wt);
        git(&dir, &["worktree", "prune"]);
    }

    #[test]
    fn multi_step_undo_redo_and_new_action_clears_redo() {
        let (repo, dir, _rm) = scratch("stack");
        write_commit(&dir, "a.txt", "a\n", "base");
        stage(&dir, "b.txt", "b\n");
        let before_second = view(&dir);
        repo.commit("second", None, false).unwrap();
        stage(&dir, "c.txt", "c\n");
        let before_third = view(&dir);
        repo.commit("third", None, false).unwrap();
        let after_third = view(&dir);
        let history = repo.git_action_history().unwrap();
        assert_eq!(history.undo[0].label, "Commit: third");
        assert_eq!(history.undo[1].label, "Commit: second");
        repo.undo_git_action().unwrap();
        assert_eq!(
            view(&dir),
            before_third,
            "undo of the latest commit restores its pre-op state"
        );
        repo.undo_git_action().unwrap();
        // A commit does not change the index, so the older undo only moves
        // HEAD. Files staged for the later commit stay staged.
        assert_eq!(head_oid(&dir), head_oid_of(&before_second));
        assert!(view(&dir).contains(index_line(&before_third).as_str()));
        assert!(repo.git_action_history().unwrap().undo.is_empty());
        assert_eq!(repo.git_action_history().unwrap().redo.len(), 2);
        repo.redo_git_action().unwrap();
        repo.redo_git_action().unwrap();
        assert_eq!(view(&dir), after_third);
        assert!(git(&dir, &["log", "--format=%s", "-2"]).contains("third"));
        repo.undo_git_action().unwrap();
        stage(&dir, "d.txt", "d\n");
        repo.commit("fourth", None, false).unwrap();
        let error = repo.redo_git_action().unwrap_err().to_string();
        assert!(error.contains("Nothing to redo"), "{error}");
    }

    #[test]
    fn push_is_not_journaled_and_undo_refuses_to_drop_pushed_commits() {
        let (repo, dir, _rm) = scratch("push");
        write_commit(&dir, "a.txt", "a\n", "base");
        let bare = std::env::temp_dir().join(format!(
            "strand-journal-bare-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&bare);
        git(
            &dir,
            &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()],
        );
        git(&dir, &["remote", "add", "origin", bare.to_str().unwrap()]);
        repo.push(PushMode::Default, |_| {}, None).unwrap();
        assert!(
            repo.git_action_history().unwrap().undo.is_empty(),
            "push is not an undo entry"
        );

        stage(&dir, "b.txt", "b\n");
        repo.commit("local only after push of base", None, false)
            .unwrap();
        repo.push(PushMode::Default, |_| {}, None).unwrap();
        let remote = git(&bare, &["rev-parse", "main"]);
        let local = git(&dir, &["rev-parse", "HEAD"]);
        assert_eq!(local, remote);
        let error = repo.undo_git_action().unwrap_err().to_string();
        assert!(error.contains("already pushed to origin/main"), "{error}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), local, "local branch unchanged");
        assert_eq!(git(&dir, &["rev-parse", "refs/remotes/origin/main"]), remote);
        assert_eq!(git(&bare, &["rev-parse", "main"]), remote, "remote unchanged");
        assert_eq!(repo.git_action_history().unwrap().undo.len(), 1, "entry kept");

        // A commit made after the push is still local and undoes normally.
        stage(&dir, "c.txt", "c\n");
        repo.commit("local only", None, false).unwrap();
        repo.undo_git_action().unwrap();
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), local);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn undo_refuses_a_branch_checked_out_in_another_worktree() {
        let (repo, dir, _rm) = scratch("other-wt");
        write_commit(&dir, "a.txt", "a\n", "base");
        repo.create_branch("feature", None, false).unwrap();
        let wt = std::env::temp_dir().join(format!(
            "strand-journal-linked-wt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "feature"]);
        let before = view(&dir);
        let error = repo.undo_git_action().unwrap_err().to_string();
        assert!(error.contains("checked out in worktree"), "{error}");
        assert_eq!(view(&dir), before, "nothing moved");
        assert!(git_ok(&dir, &["show-ref", "--verify", "--quiet", "refs/heads/feature"]));
        let _ = std::fs::remove_dir_all(&wt);
        git(&dir, &["worktree", "prune"]);
    }

    #[test]
    fn checkout_undo_keeps_a_carried_staged_change() {
        let (repo, dir, _rm) = scratch("staged-carry");
        write_commit(&dir, "a.txt", "a\n", "base");
        write_commit(&dir, "b.txt", "b\n", "second");
        git(&dir, &["branch", "older", "HEAD~1"]);
        stage(&dir, "a.txt", "staged\n");
        let before = view(&dir);
        repo.checkout_branch("older").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "staged\n");
        let outcome = repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before, "branch, HEAD, and staged index restored");
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "staged\n",
            "the staged change is back on disk too"
        );
        assert_eq!(git(&dir, &["diff", "--name-only"]), "", "worktree matches the index");
        let oid = outcome.snapshot_oid.expect("staged work triggers the safety snapshot");
        assert_eq!(git(&dir, &["show", &format!("{oid}:a.txt")]), "staged");
    }

    #[test]
    fn checkout_undo_restores_many_carried_staged_paths() {
        let (repo, dir, _rm) = scratch("staged-many");
        write_commit(&dir, "a.txt", "a\n", "base");
        write_commit(&dir, "b.txt", "b\n", "second");
        git(&dir, &["branch", "older", "HEAD~1"]);
        std::fs::create_dir_all(dir.join("many")).unwrap();
        let long = "n".repeat(180);
        for i in 0..2000 {
            std::fs::write(dir.join(format!("many/{long}-{i}.txt")), format!("{i}\n")).unwrap();
        }
        git(&dir, &["add", "--", "many"]);
        let before = view(&dir);
        repo.checkout_branch("older").unwrap();
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before, "branch, HEAD, and staged index restored");
        assert_eq!(git(&dir, &["status", "--porcelain", "--", "many"]).lines().count(), 2000);
        assert_eq!(git(&dir, &["diff", "--name-only"]), "", "worktree matches the index");
        assert_eq!(
            std::fs::read_to_string(dir.join(format!("many/{long}-1999.txt"))).unwrap(),
            "1999\n"
        );
    }

    #[test]
    fn checkout_undo_keeps_a_carried_staged_deletion_off_disk() {
        let (repo, dir, _rm) = scratch("staged-rm");
        write_commit(&dir, "a.txt", "a\n", "base");
        write_commit(&dir, "b.txt", "b\n", "second");
        git(&dir, &["branch", "older", "HEAD~1"]);
        git(&dir, &["rm", "-q", "--", "a.txt"]);
        let before = view(&dir);
        repo.checkout_branch("older").unwrap();
        assert!(!dir.join("a.txt").exists());
        repo.undo_git_action().unwrap();
        assert_eq!(view(&dir), before, "branch, HEAD, and staged deletion restored");
        assert!(!dir.join("a.txt").exists(), "no stray untracked copy after undo");
        assert_eq!(git(&dir, &["status", "--porcelain"]), "D  a.txt");
    }

    #[test]
    fn checkout_undo_keeps_the_file_of_a_cached_only_deletion() {
        let (repo, dir, _rm) = scratch("staged-rm-cached");
        write_commit(&dir, "a.txt", "a\n", "base");
        write_commit(&dir, "b.txt", "b\n", "second");
        git(&dir, &["branch", "older", "HEAD~1"]);
        git(&dir, &["rm", "-q", "--cached", "--", "a.txt"]);
        repo.checkout_branch("older").unwrap();
        let after = view(&dir);
        let error = repo.undo_git_action().unwrap_err().to_string();
        assert!(error.contains("untracked"), "{error}");
        assert_eq!(view(&dir), after, "the refused undo moved nothing");
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "a\n",
            "the untracked file `git rm --cached` left behind stays on disk"
        );
        assert_eq!(git(&dir, &["status", "--porcelain"]), "D  a.txt\n?? a.txt");
    }

    #[test]
    fn drop_git_action_removes_a_stale_top_entry_without_moving_anything() {
        let (repo, dir, _rm) = scratch("drop");
        write_commit(&dir, "a.txt", "a\n", "base");
        stage(&dir, "b.txt", "b\n");
        repo.commit("add b", None, false).unwrap();
        stage(&dir, "c.txt", "c\n");
        repo.commit("add c", None, false).unwrap();
        git(&dir, &["commit", "--allow-empty", "-q", "-m", "external"]);
        assert!(repo.undo_git_action().is_err(), "stale entry refuses");
        let current = view(&dir);
        let history = repo.drop_git_action(GitActionDirection::Undo).unwrap();
        assert_eq!(view(&dir), current);
        assert_eq!(history.undo.len(), 1);
        assert_eq!(history.undo[0].label, "Commit: add b");
        let history = repo.drop_git_action(GitActionDirection::Redo).unwrap();
        assert_eq!(history.undo.len(), 1, "an empty redo stack is a no-op");
    }

    #[test]
    fn concurrent_journal_writes_keep_every_entry() {
        let (repo, dir, _rm) = scratch("concurrent");
        write_commit(&dir, "a.txt", "a\n", "base");
        let checkpoint = capture(&repo).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let dir = dir.clone();
                let checkpoint = checkpoint.clone();
                std::thread::spawn(move || {
                    let repo = Repo::discover(&dir).unwrap();
                    for step in 0..5 {
                        push_entry(
                            &repo,
                            GitOp::BranchCreate,
                            format!("t{n}-{step}"),
                            false,
                            checkpoint.clone(),
                            checkpoint.clone(),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(repo.git_action_history().unwrap().undo.len(), 40);
        let leftovers: Vec<_> = std::fs::read_dir(repo.git_dir())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("strand-journal") && name != "strand-journal.json")
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn conflicted_merge_is_left_out_of_the_journal() {
        let (repo, dir, _rm) = scratch("conflict");
        write_commit(&dir, "f.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "f.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "f.txt", "main\n", "main");
        assert!(repo.merge("feature", MergeMode::Auto).unwrap());
        assert!(repo.git_action_history().unwrap().undo.is_empty());
        repo.abort_operation().unwrap();
        assert!(repo.git_action_history().unwrap().undo.is_empty());
    }
}
