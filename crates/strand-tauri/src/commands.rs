use serde::Serialize;
use strand_core::{log::Commit, repo::RepoMeta, status::FileStatus, Repo};
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
