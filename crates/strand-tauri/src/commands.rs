use serde::Serialize;
use strand_core::{
    apply::ApplyTarget, branch::CheckoutOutcome, commit::CommitOutcome, diff::FileDiff,
    log::Commit, network::NetworkOutcome, refs::Refs, repo::RepoMeta, status::FileStatus, Repo,
};
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

#[tauri::command]
pub fn repo_fetch(path: String, remote: Option<String>) -> CmdResult<NetworkOutcome> {
    Ok(Repo::discover(&path)?.fetch(remote.as_deref())?)
}

#[tauri::command]
pub fn repo_pull(path: String, rebase: bool) -> CmdResult<NetworkOutcome> {
    Ok(Repo::discover(&path)?.pull(rebase)?)
}

#[tauri::command]
pub fn repo_push(path: String, force_with_lease: bool) -> CmdResult<NetworkOutcome> {
    Ok(Repo::discover(&path)?.push(force_with_lease)?)
}

#[tauri::command]
pub fn repo_checkout(path: String, branch: String) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.checkout_branch(&branch)?)
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
