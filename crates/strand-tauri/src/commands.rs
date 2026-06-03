use serde::Serialize;
use strand_core::{
    apply::ApplyTarget, branch::CheckoutOutcome, commit::CommitOutcome, diff::FileDiff,
    history::MergeMode, log::Commit,
    network::{clone as core_clone, CloneOutcome, NetworkOutcome, Progress},
    refs::Refs, repo::RepoMeta, stash::{Stash, StashOutcome}, status::FileStatus,
    tree::WorkTreeEntry, Repo,
};
use tauri::ipc::Channel;
use tauri::State;

use crate::state::AppState;

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
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.fetch(remote.as_deref(), |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("fetch task failed: {e}") })?
}

#[tauri::command]
pub async fn repo_pull(
    path: String,
    rebase: bool,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.pull(rebase, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("pull task failed: {e}") })?
}

#[tauri::command]
pub async fn repo_push(
    path: String,
    force_with_lease: bool,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<NetworkOutcome> {
        let repo = Repo::discover(&path)?;
        repo.push(force_with_lease, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("push task failed: {e}") })?
}

#[tauri::command]
pub async fn repo_clone(
    url: String,
    dest: String,
    on_event: Channel<Progress>,
) -> CmdResult<CloneOutcome> {
    tokio::task::spawn_blocking(move || -> CmdResult<CloneOutcome> {
        core_clone(&url, &dest, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError { message: format!("clone task failed: {e}") })?
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
pub fn repo_read_conflict_file(path: String, file: String) -> CmdResult<String> {
    Ok(Repo::discover(&path)?.read_conflict_file(&file)?)
}

#[tauri::command]
pub fn repo_resolve_conflict(path: String, file: String, contents: String) -> CmdResult<()> {
    Repo::discover(&path)?.resolve_conflict(&file, &contents)?;
    Ok(())
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
