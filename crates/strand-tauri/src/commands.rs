use serde::Serialize;
use strand_core::{
    apply::ApplyTarget, blame::BlameLine, branch::CheckoutOutcome, commit::CommitOutcome,
    diff::FileDiff, file::{FileContent, FileHistoryEntry},
    history::{MergeMode, RebaseEntry, RebaseStep}, log::Commit,
    network::{clone as core_clone, CancelHandle, CloneOutcome, NetworkOutcome, Progress},
    reflog::ReflogEntry,
    refs::Refs, repo::RepoMeta, snapshot::Snapshot, stash::{Stash, StashOutcome},
    status::FileStatus, submodule::Submodule, tree::WorkTreeEntry, worktree::Worktree, Repo,
};
use tauri::ipc::Channel;
use tauri::{Emitter, State};

use crate::state::AppState;

/// Register / clear a cancellable op's handle under `op_id` so
/// `repo_cancel_op` can find it while the blocking task runs.
fn register_op(state: &AppState, op_id: &Option<String>, cancel: &CancelHandle) {
    if let (Some(id), Ok(mut ops)) = (op_id.as_deref(), state.ops.lock()) {
        ops.insert(id.to_string(), cancel.clone());
    }
}

fn deregister_op(state: &AppState, op_id: &Option<String>) {
    if let (Some(id), Ok(mut ops)) = (op_id.as_deref(), state.ops.lock()) {
        ops.remove(id);
    }
}

#[derive(Debug, Serialize)]
pub struct CmdError {
    pub message: String,
}

impl From<strand_core::Error> for CmdError {
    fn from(e: strand_core::Error) -> Self {
        Self { message: e.to_string() }
    }
}

type CmdResult<T> = std::result::Result<T, CmdError>;

#[tauri::command]
pub fn repo_open(path: String, state: State<'_, AppState>) -> CmdResult<RepoMeta> {
    let repo = Repo::discover(&path)?;
    let meta = repo.meta()?;
    if let Ok(mut paths) = state.open_paths.lock() {
        paths.insert(meta.path.clone());
    }
    Ok(meta)
}

#[tauri::command]
pub fn repo_meta(path: String) -> CmdResult<RepoMeta> {
    Ok(Repo::discover(&path)?.meta()?)
}

#[tauri::command]
pub fn repo_status(path: String) -> CmdResult<Vec<FileStatus>> {
    Ok(Repo::discover(&path)?.status()?)
}

/// One-call refresh bundle: meta + status + work tree + refs + submodules
/// from a single repo open and a single statuses walk. The frontend's
/// post-change refresh path calls this instead of five separate commands.
#[tauri::command]
pub fn repo_snapshot(path: String) -> CmdResult<Snapshot> {
    Ok(Repo::discover(&path)?.snapshot()?)
}

/// Start watching `path`'s working tree; emits a `repo://changed` event with
/// the repo path as payload after each (debounced) change burst. Idempotent —
/// re-watching an already-watched path keeps the existing watcher.
#[tauri::command]
pub fn repo_watch(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    {
        let watchers = state.watchers.lock().map_err(|_| CmdError {
            message: "watcher registry poisoned".into(),
        })?;
        if watchers.contains_key(&path) {
            return Ok(());
        }
    }
    let repo = Repo::discover(&path)?;
    let workdir = repo.path().to_path_buf();
    let git_dir = repo.git_dir().to_path_buf();
    let event_path = path.clone();
    let watcher = strand_core::watch::watch(
        &workdir,
        &git_dir,
        std::time::Duration::from_millis(400),
        move || {
            let _ = app.emit("repo://changed", &event_path);
        },
    )?;
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.insert(path, watcher);
    }
    Ok(())
}

/// Stop watching `path` (dropping the watcher ends its threads).
#[tauri::command]
pub fn repo_unwatch(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.remove(&path);
    }
    Ok(())
}

#[tauri::command]
pub fn repo_log(path: String, limit: Option<usize>) -> CmdResult<Vec<Commit>> {
    Ok(Repo::discover(&path)?.log(limit.unwrap_or(500))?)
}

#[tauri::command]
pub fn repo_refs(path: String) -> CmdResult<Refs> {
    Ok(Repo::discover(&path)?.refs()?)
}

#[tauri::command]
pub fn repo_diff_unstaged(path: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_unstaged()?)
}

#[tauri::command]
pub fn repo_diff_staged(path: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_staged()?)
}

#[tauri::command]
pub fn repo_diff_between(path: String, from: String, to: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_between(&from, &to)?)
}

#[tauri::command]
pub fn repo_diff_commit(path: String, oid: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_commit(&oid)?)
}

#[tauri::command]
pub fn repo_diff_commit_file(path: String, oid: String, file: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_commit_file(&oid, &file)?)
}

#[tauri::command]
pub fn repo_diff_workdir_file(path: String, file: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_workdir_file(&file)?)
}

/// Diff everything (committed + staged + unstaged) since a baseline
/// commit-ish — the "review since…" view for agent sessions.
#[tauri::command]
pub fn repo_diff_since(path: String, baseline: String) -> CmdResult<Vec<FileDiff>> {
    Ok(Repo::discover(&path)?.diff_since(&baseline)?)
}

// ── File view (Content / History / Blame tabs) ──

#[tauri::command]
pub fn repo_file_content(path: String, file: String, rev: Option<String>) -> CmdResult<FileContent> {
    Ok(Repo::discover(&path)?.file_content(&file, rev.as_deref())?)
}

#[tauri::command]
pub fn repo_file_history(
    path: String,
    file: String,
    limit: Option<usize>,
) -> CmdResult<Vec<FileHistoryEntry>> {
    Ok(Repo::discover(&path)?.file_history(&file, limit.unwrap_or(200))?)
}

#[tauri::command]
pub fn repo_blame(path: String, file: String) -> CmdResult<Vec<BlameLine>> {
    Ok(Repo::discover(&path)?.blame(&file)?)
}

#[tauri::command]
pub fn repo_reflog(
    path: String,
    selector: Option<String>,
    limit: Option<usize>,
) -> CmdResult<Vec<ReflogEntry>> {
    Ok(Repo::discover(&path)?.reflog(selector.as_deref().unwrap_or("HEAD"), limit.unwrap_or(500))?)
}

#[tauri::command]
pub fn repo_stage(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.stage_path(&file)?;
    Ok(())
}

#[tauri::command]
pub fn repo_unstage(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.unstage_path(&file)?;
    Ok(())
}

#[tauri::command]
pub fn repo_stage_many(path: String, files: Vec<String>) -> CmdResult<()> {
    Repo::discover(&path)?.stage_paths(&files)?;
    Ok(())
}

#[tauri::command]
pub fn repo_unstage_many(path: String, files: Vec<String>) -> CmdResult<()> {
    Repo::discover(&path)?.unstage_paths(&files)?;
    Ok(())
}

#[tauri::command]
pub fn repo_discard_many(path: String, files: Vec<String>) -> CmdResult<()> {
    Repo::discover(&path)?.discard_paths(&files)?;
    Ok(())
}

#[tauri::command]
pub fn repo_discard(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.discard_path(&file)?;
    Ok(())
}

#[tauri::command]
pub fn repo_apply_patch(path: String, patch: String, target: String) -> CmdResult<()> {
    let t = match target.as_str() {
        "index" => ApplyTarget::Index,
        "index_reverse" => ApplyTarget::IndexReverse,
        "workdir_reverse" => ApplyTarget::WorkdirReverse,
        "workdir" => ApplyTarget::Workdir,
        other => {
            return Err(CmdError {
                message: format!("repo_apply_patch: unknown target `{other}`"),
            })
        }
    };
    Repo::discover(&path)?.apply_patch(&patch, t)?;
    Ok(())
}

#[tauri::command]
pub fn repo_commit(
    path: String,
    subject: String,
    body: Option<String>,
    amend: bool,
) -> CmdResult<CommitOutcome> {
    Ok(Repo::discover(&path)?.commit(&subject, body.as_deref(), amend)?)
}

// Network commands run on a blocking thread (they shell out to `git`, which
// can take a while) and stream progress back over an IPC `Channel`. They're
// `async` so Tauri schedules them off the main thread; the actual blocking
// work lives in `spawn_blocking`.

#[tauri::command]
pub async fn repo_fetch(
    path: String,
    remote: Option<String>,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, &cancel);
    let result = tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.fetch(
            remote.as_deref(),
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("fetch task failed: {e}") });
    deregister_op(&state, &op_id);
    result?
}

#[tauri::command]
pub async fn repo_pull(
    path: String,
    rebase: bool,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, &cancel);
    let result = tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.pull(
            rebase,
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("pull task failed: {e}") });
    deregister_op(&state, &op_id);
    result?
}

#[tauri::command]
pub async fn repo_push(
    path: String,
    force_with_lease: bool,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, &cancel);
    let result = tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.push(
            force_with_lease,
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("push task failed: {e}") });
    deregister_op(&state, &op_id);
    result?
}

#[tauri::command]
pub async fn repo_clone(
    url: String,
    dest: String,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<CloneOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, &cancel);
    let result = tokio::task::spawn_blocking(move || -> CmdResult<CloneOutcome> {
        core_clone(
            &url,
            &dest,
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("clone task failed: {e}") });
    deregister_op(&state, &op_id);
    result?
}

/// Kill the in-flight cancellable op registered under `op_id`. A no-op when
/// the op already finished (its handle is gone from the registry).
#[tauri::command]
pub fn repo_cancel_op(op_id: String, state: State<'_, AppState>) -> CmdResult<()> {
    if let Ok(ops) = state.ops.lock() {
        if let Some(handle) = ops.get(&op_id) {
            handle.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn repo_checkout(path: String, branch: String) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.checkout_branch(&branch)?)
}

#[tauri::command]
pub fn repo_checkout_commit(path: String, rev: String) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.checkout_commit(&rev)?)
}

#[tauri::command]
pub fn repo_tree(path: String) -> CmdResult<Vec<WorkTreeEntry>> {
    Ok(Repo::discover(&path)?.work_tree()?)
}

#[tauri::command]
pub fn repo_submodules(path: String) -> CmdResult<Vec<Submodule>> {
    Ok(Repo::discover(&path)?.submodules()?)
}

// `git submodule update` can clone/fetch, so it runs off the IPC thread and
// streams progress like the other network ops.
#[tauri::command]
pub async fn repo_submodule_update(
    path: String,
    paths: Vec<String>,
    init: bool,
    recursive: bool,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.submodule_update(&paths, init, recursive, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("submodule update task failed: {e}") })?
}

#[tauri::command]
pub fn repo_worktrees(path: String) -> CmdResult<Vec<Worktree>> {
    Ok(Repo::discover(&path)?.worktrees()?)
}

#[tauri::command]
pub fn repo_worktree_add(
    path: String,
    dest: String,
    branch: String,
    new_branch: bool,
) -> CmdResult<()> {
    Ok(Repo::discover(&path)?.add_worktree(&dest, &branch, new_branch)?)
}

#[tauri::command]
pub fn repo_worktree_remove(path: String, dest: String, force: bool) -> CmdResult<()> {
    Ok(Repo::discover(&path)?.remove_worktree(&dest, force)?)
}

#[tauri::command]
pub fn repo_worktree_prune(path: String) -> CmdResult<()> {
    Ok(Repo::discover(&path)?.prune_worktrees()?)
}

#[tauri::command]
pub fn repo_branch_create(
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.create_branch(&name, start_point.as_deref(), checkout)?)
}

#[tauri::command]
pub fn repo_branch_delete(path: String, name: String, force: bool) -> CmdResult<()> {
    Repo::discover(&path)?.delete_branch(&name, force)?;
    Ok(())
}

#[tauri::command]
pub fn repo_tag_create(
    path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
    force: bool,
) -> CmdResult<()> {
    Repo::discover(&path)?.create_tag(&name, target.as_deref(), message.as_deref(), force)?;
    Ok(())
}

#[tauri::command]
pub fn repo_tag_delete(path: String, name: String) -> CmdResult<()> {
    Repo::discover(&path)?.delete_tag(&name)?;
    Ok(())
}

#[tauri::command]
pub async fn repo_remote_tags(path: String, remote: String) -> CmdResult<Vec<String>> {
    tokio::task::spawn_blocking(move || -> CmdResult<Vec<String>> {
        Repo::discover(&path)?.remote_tags(&remote).map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("remote tags task failed: {e}") })?
}

#[tauri::command]
pub async fn repo_tag_push(
    path: String,
    tag: String,
    remote: String,
    delete: bool,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.push_tag(&tag, &remote, delete, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("tag push task failed: {e}") })?
}

#[tauri::command]
pub async fn repo_tag_push_all(
    path: String,
    remote: String,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.push_all_tags(&remote, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("tag push task failed: {e}") })?
}

// These return `true` when the op stopped on conflicts (left in progress for
// resolution) and `false` when it completed cleanly; `Err` is a real failure.

#[tauri::command]
pub fn repo_cherry_pick(path: String, commits: Vec<String>) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.cherry_pick(&commits)?)
}

#[tauri::command]
pub fn repo_revert(path: String, commits: Vec<String>) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.revert(&commits)?)
}

#[tauri::command]
pub fn repo_merge(path: String, refname: String, mode: String) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.merge(&refname, MergeMode::from_wire(&mode)?)?)
}

#[tauri::command]
pub fn repo_rebase(path: String, onto: String) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.rebase(&onto)?)
}

#[tauri::command]
pub fn repo_abort_operation(path: String) -> CmdResult<()> {
    Repo::discover(&path)?.abort_operation()?;
    Ok(())
}

#[tauri::command]
pub fn repo_continue_operation(path: String) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.continue_operation()?)
}

#[tauri::command]
pub fn repo_rebase_todo(path: String, base: Option<String>) -> CmdResult<Vec<RebaseEntry>> {
    Ok(Repo::discover(&path)?.rebase_todo(base.as_deref())?)
}

#[tauri::command]
pub fn repo_interactive_rebase(
    path: String,
    base: Option<String>,
    steps: Vec<RebaseStep>,
) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.interactive_rebase(base.as_deref(), &steps)?)
}

#[tauri::command]
pub fn repo_read_conflict_file(path: String, file: String) -> CmdResult<String> {
    Ok(Repo::discover(&path)?.read_conflict_file(&file)?)
}

#[tauri::command]
pub fn repo_resolve_conflict(path: String, file: String, contents: String) -> CmdResult<()> {
    Repo::discover(&path)?.resolve_conflict(&file, &contents)?;
    Ok(())
}

// Blocks until the external tool exits, so it runs off the IPC thread.
#[tauri::command]
pub async fn repo_open_mergetool(path: String, file: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        Repo::discover(&path)?.open_mergetool(&file).map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("mergetool task failed: {e}") })?
}

#[tauri::command]
pub fn repo_stash_list(path: String) -> CmdResult<Vec<Stash>> {
    Ok(Repo::discover(&path)?.stash_list()?)
}

#[tauri::command]
pub fn repo_stash_save(
    path: String,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> CmdResult<StashOutcome> {
    Ok(Repo::discover(&path)?.stash_save(message.as_deref(), include_untracked, keep_index)?)
}

#[tauri::command]
pub fn repo_stash_snapshot(
    path: String,
    message: Option<String>,
    include_untracked: bool,
) -> CmdResult<StashOutcome> {
    Ok(Repo::discover(&path)?.stash_snapshot(message.as_deref(), include_untracked)?)
}

#[tauri::command]
pub fn repo_stash_apply(path: String, index: usize) -> CmdResult<()> {
    Repo::discover(&path)?.stash_apply(index)?;
    Ok(())
}

#[tauri::command]
pub fn repo_stash_pop(path: String, index: usize) -> CmdResult<()> {
    Repo::discover(&path)?.stash_pop(index)?;
    Ok(())
}

#[tauri::command]
pub fn repo_stash_drop(path: String, index: usize) -> CmdResult<()> {
    Repo::discover(&path)?.stash_drop(index)?;
    Ok(())
}
