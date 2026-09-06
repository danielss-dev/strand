//! Every command here is `#[tauri::command(async)]`: plain sync commands run
//! inline on the main thread (the Win32 message pump on Windows), so any
//! git/fs work — even a "fast" status walk — blocks window activation and
//! repaints, which reads as the whole app freezing on alt-tab. `(async)` on a
//! sync fn moves it to the runtime's pool with no signature change. The one
//! exception is `repo_cancel_op` (see its comment).
//!
//! Within that pool there are two tiers. Commands whose cost scales with repo
//! size (status/log/diff/tree/refs reads) or that wait on a subprocess route
//! their work through [`run_blocking`] onto tokio's *blocking* pool — a sync
//! body would otherwise occupy one of the runtime's few core workers for its
//! whole duration, so a fan-out of slow reads (a workspace refresh walking
//! several big repos) could head-of-line-block every other pending command.
//! Quick writes (stage, branch, tag, …) stay plain sync bodies.

use serde::{Deserialize, Serialize};
use std::path::Path;
use strand_azdo_protocol::ServerProfile;
use strand_core::{
    apply::ApplyTarget, blame::BlameLine, branch::CheckoutOutcome, commit::CommitOutcome,
    commit_metadata::CommitSignature,
    diff::FileDiff, file::{BlobSource, FileBlob, FileContent, FileHistoryEntry},
    gitconfig::{self, GlobalIdentity},
    init::{init_repository, InitOutcome},
    maintenance::{MaintenanceOutcome, MaintenanceTask},
    history::{MergeMode, RebaseEntry, RebaseStep}, log::{Commit, SearchMode},
    network::{clone as core_clone, CancelHandle, CloneOutcome, NetworkOutcome, Progress, PullMode, PushMode},
    reflog::ReflogEntry,
    refs::{BaseBranch, Refs}, repo::RepoMeta, reset::{ResetMode, ResetOutcome},
    snapshot::Snapshot, stash::{Stash, StashOutcome},
    status::FileStatus, submodule::Submodule, tree::WorkTreeEntry,
    worktree::{RestoredWorktree, Worktree, WorktreeArchive, WorktreeHealth, WorktreeStats}, Repo,
};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroize;

use crate::ai;
use crate::azdo_helper;
use crate::hosting;
use crate::heroi;
use crate::pull_requests::{self, PullRequestList};
use crate::state::{AppState, OperationCancelHandle};

/// Register / clear a cancellable op's handle under `op_id` so
/// `repo_cancel_op` can find it while the blocking task runs.
fn register_op(state: &AppState, op_id: &Option<String>, cancel: OperationCancelHandle) {
    if let (Some(id), Ok(mut ops)) = (op_id.as_deref(), state.ops.lock()) {
        ops.insert(id.to_string(), cancel);
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

pub(crate) type CmdResult<T> = std::result::Result<T, CmdError>;

#[tauri::command]
pub async fn repo_advanced_refs(
    path: String,
    notes_ref: String,
) -> CmdResult<strand_core::advanced_refs::AdvancedRefs> {
    run_blocking("inspect advanced refs", move || {
        Repo::discover(path)?
            .advanced_refs(&notes_ref)
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_git_note(
    path: String,
    notes_ref: String,
    revision: String,
) -> CmdResult<strand_core::advanced_refs::GitNote> {
    run_blocking("read Git note", move || {
        Repo::discover(path)?
            .git_note(&notes_ref, &revision)
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_git_note_write(
    path: String,
    notes_ref: String,
    object: String,
    expected: Option<String>,
    message: Option<String>,
) -> CmdResult<()> {
    run_blocking("write Git note", move || {
        Repo::discover(path)?
            .write_git_note(&notes_ref, &object, expected.as_deref(), message.as_deref())
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_replace_review(
    path: String,
    original: String,
    replacement: String,
) -> CmdResult<strand_core::advanced_refs::ReplaceReview> {
    run_blocking("review replacement", move || {
        Repo::discover(path)?
            .review_replacement(&original, &replacement)
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_replace_write(
    path: String,
    original: String,
    replacement: Option<String>,
    expected: Option<String>,
) -> CmdResult<()> {
    run_blocking("write replacement", move || {
        Repo::discover(path)?
            .write_replacement(&original, replacement.as_deref(), expected.as_deref())
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_tag_edit_review(
    path: String,
    name: String,
    target: String,
) -> CmdResult<strand_core::advanced_refs::TagEditReview> {
    run_blocking("review tag edit", move || {
        Repo::discover(path)?
            .review_tag_edit(&name, &target)
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_tag_edit(
    path: String,
    name: String,
    target: String,
    expected: String,
    kind: strand_core::advanced_refs::TagEditKind,
    message: Option<String>,
) -> CmdResult<()> {
    run_blocking("edit tag", move || {
        Repo::discover(path)?
            .edit_tag(&name, &target, &expected, kind, message.as_deref())
            .map_err(Into::into)
    })
    .await
}
#[tauri::command]
pub async fn repo_tag_published(
    path: String,
    remote: String,
    name: String,
) -> CmdResult<strand_core::advanced_refs::PublishedTag> {
    run_blocking("check published tag", move || {
        Repo::discover(path)?
            .published_tag(&remote, &name)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn repo_bisect_state(path: String) -> CmdResult<strand_core::bisect::BisectState> {
    run_blocking("bisect state", move || Repo::discover(path)?.bisect_state().map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_bisect_start(path: String, good: String, bad: String, token: String) -> CmdResult<strand_core::bisect::BisectOutcome> {
    run_blocking("start bisect", move || Repo::discover(path)?.bisect_start(&good, &bad, &token).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_bisect_action(path: String, action: strand_core::bisect::BisectAction, token: String) -> CmdResult<strand_core::bisect::BisectOutcome> {
    run_blocking("bisect action", move || Repo::discover(path)?.bisect_action(action, &token).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_patch_preview(path: String, source: String, target: strand_core::interchange::PatchTarget) -> CmdResult<strand_core::interchange::PatchPreview> {
    run_blocking("preview patch", move || Repo::discover(path)?.preview_patch_import(Path::new(&source), target).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_patch_import(path: String, source: String, target: strand_core::interchange::PatchTarget, token: String) -> CmdResult<strand_core::interchange::InterchangeOutcome> {
    run_blocking("import patch", move || Repo::discover(path)?.import_patch(Path::new(&source), target, &token).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_mailbox_state(path: String) -> CmdResult<Option<strand_core::interchange::MailboxState>> {
    run_blocking("mailbox state", move || Repo::discover(path)?.mailbox_state().map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_mailbox_action(path: String, action: strand_core::interchange::MailboxAction, token: String) -> CmdResult<strand_core::interchange::InterchangeOutcome> {
    run_blocking("mailbox action", move || Repo::discover(path)?.mailbox_action(action, &token).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_bundle_preview(path: String, source: String) -> CmdResult<strand_core::interchange::BundlePreview> {
    run_blocking("verify bundle", move || Repo::discover(path)?.preview_bundle(Path::new(&source)).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_bundle_import(path: String, source: String, token: String, source_ref: String, branch: String) -> CmdResult<strand_core::interchange::InterchangeOutcome> {
    run_blocking("import bundle", move || Repo::discover(path)?.import_bundle(Path::new(&source), &token, &source_ref, &branch).map_err(Into::into)).await
}

#[tauri::command]
pub async fn repo_bundle_export(path: String, destination: String, refname: String, prerequisite: Option<String>) -> CmdResult<strand_core::interchange::BundlePreview> {
    run_blocking("export bundle", move || Repo::discover(path)?.export_bundle(Path::new(&destination), &refname, prerequisite.as_deref()).map_err(Into::into)).await
}

#[tauri::command(async)]
pub fn repo_terminal_create(
    path: String,
    shell: crate::terminal::EmbeddedShellChoice,
    cols: u16,
    rows: u16,
    on_event: Channel<crate::terminal::TerminalEvent>,
    state: State<'_, AppState>,
) -> CmdResult<crate::terminal::TerminalHandle> {
    let is_open = state
        .open_paths
        .lock()
        .map_err(|_| CmdError { message: "open repository registry poisoned".into() })?
        .contains(&path);
    if !is_open {
        return Err(CmdError { message: "embedded terminals require an open repository".into() });
    }
    state.terminals.create(path, shell, cols, rows, on_event)
}

#[tauri::command(async)]
pub fn terminal_write(id: String, data: String, state: State<'_, AppState>) -> CmdResult<()> {
    state.terminals.write(&id, &data)
}

#[tauri::command(async)]
pub fn terminal_resize(id: String, cols: u16, rows: u16, state: State<'_, AppState>) -> CmdResult<()> {
    state.terminals.resize(&id, cols, rows)
}

#[tauri::command(async)]
pub fn terminal_close(id: String, state: State<'_, AppState>) -> CmdResult<()> {
    state.terminals.close(&id)
}

#[tauri::command(async)]
pub fn repo_terminal_close_all(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    state.terminals.close_all(Some(&path));
    Ok(())
}

#[tauri::command(async)]
pub fn repo_terminal_count(path: String, state: State<'_, AppState>) -> usize {
    state.terminals.count(&path)
}

#[tauri::command(async)]
pub fn terminal_shell_check(shell: crate::terminal::EmbeddedShellChoice) -> crate::terminal::ShellCheck {
    crate::terminal::shell_check(shell)
}

#[tauri::command(async)]
pub fn terminal_wsl_distributions() -> Vec<String> {
    crate::terminal::wsl_distributions()
}

/// Run CPU/disk-bound work on tokio's blocking pool (see the module comment
/// for why repo-size-scaled reads don't stay sync). `label` names the op in
/// the error if the task itself dies.
async fn run_blocking<T: Send + 'static>(
    label: &'static str,
    work: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| CmdError { message: format!("{label} task failed: {e}") })?
}

#[tauri::command(async)]
pub async fn repo_open(path: String, state: State<'_, AppState>) -> CmdResult<RepoMeta> {
    let meta = run_blocking("open", move || Ok(Repo::discover(&path)?.meta()?)).await?;
    if let Ok(mut paths) = state.open_paths.lock() {
        paths.insert(meta.path.clone());
    }
    Ok(meta)
}

#[tauri::command(async)]
pub async fn microsoft_store_update_available() -> CmdResult<bool> {
    run_blocking("Microsoft Store update check", || {
        crate::microsoft_store::update_available().map_err(|message| CmdError { message })
    })
    .await
}

#[tauri::command(async)]
pub async fn microsoft_store_open_product() -> CmdResult<()> {
    run_blocking("open Microsoft Store", || {
        crate::microsoft_store::open_product().map_err(|message| CmdError { message })
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_meta(path: String) -> CmdResult<RepoMeta> {
    run_blocking("meta", move || Ok(Repo::discover(&path)?.meta()?)).await
}

#[tauri::command(async)]
pub async fn repo_status(path: String) -> CmdResult<Vec<FileStatus>> {
    run_blocking("status", move || Ok(Repo::discover(&path)?.status()?)).await
}

/// One-call refresh bundle: meta + status + work tree + refs + submodules
/// from a single repo open and a single statuses walk. The frontend's
/// post-change refresh path calls this instead of five separate commands.
#[tauri::command(async)]
pub async fn repo_snapshot(path: String) -> CmdResult<Snapshot> {
    run_blocking("snapshot", move || Ok(Repo::discover(&path)?.snapshot()?)).await
}

/// Start watching `path`'s working tree; emits a `repo://changed` event with
/// the repo path as payload after each (debounced) change burst. Idempotent —
/// re-watching an already-watched path keeps the existing watcher.
#[tauri::command(async)]
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
        move |files_changed| {
            let _ = app.emit("repo://changed", &event_path);
            if files_changed {
                let _ = app.emit("repo://files-changed", &event_path);
            }
        },
    )?;
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.insert(path, watcher);
    }
    Ok(())
}

/// Stop watching `path` (dropping the watcher ends its threads).
#[tauri::command(async)]
pub fn repo_unwatch(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.remove(&path);
    }
    if let Ok(mut paths) = state.open_paths.lock() {
        paths.remove(&path);
    }
    Ok(())
}

/// `head_only` walks HEAD's ancestry instead of every ref — what a
/// per-worktree "last commit" wants, since worktrees share the family's refs.
#[tauri::command(async)]
pub async fn repo_log(
    path: String,
    limit: Option<usize>,
    head_only: Option<bool>,
) -> CmdResult<Vec<Commit>> {
    run_blocking("log", move || {
        let repo = Repo::discover(&path)?;
        let limit = limit.unwrap_or(500);
        Ok(if head_only.unwrap_or(false) { repo.log_head(limit)? } else { repo.log(limit)? })
    })
    .await
}

/// Full-history commit search (message / author / diff content) — the backend
/// reach the client-side, loaded-window highlight can't cover. `mode` is one of
/// `"message"` / `"author"` / `"content"`.
#[tauri::command(async)]
pub async fn repo_search_log(
    path: String,
    query: String,
    mode: SearchMode,
    limit: Option<usize>,
) -> CmdResult<Vec<Commit>> {
    run_blocking("search", move || {
        Ok(Repo::discover(&path)?.search_log(&query, mode, limit.unwrap_or(200))?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_commit_signature(path: String, oid: String) -> CmdResult<CommitSignature> {
    run_blocking("commit signature", move || {
        Ok(Repo::discover(&path)?.commit_signature(&oid)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_commit_export_patch(
    path: String,
    oids: Vec<String>,
    destination: String,
) -> CmdResult<u64> {
    run_blocking("export commit patch", move || {
        Ok(Repo::discover(&path)?
            .export_commit_patches(&oids, std::path::Path::new(&destination))?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_refs(path: String) -> CmdResult<Refs> {
    run_blocking("refs", move || Ok(Repo::discover(&path)?.refs()?)).await
}

#[tauri::command(async)]
pub async fn azdo_helper_status(app: AppHandle) -> CmdResult<azdo_helper::HelperStatus> {
    run_blocking("Azure DevOps Server helper status", move || Ok(azdo_helper::status(&app))).await
}

#[tauri::command(async)]
pub async fn repo_init(
    path: String,
    initial_branch: String,
    gitignore: Option<String>,
    create_initial_commit: bool,
) -> CmdResult<InitOutcome> {
    run_blocking("initialize repository", move || {
        Ok(init_repository(
            &path,
            &initial_branch,
            gitignore.as_deref(),
            create_initial_commit,
        )?)
    })
    .await
}

#[tauri::command(async)]
pub async fn hosting_connection_status() -> CmdResult<hosting::HostingConnectionStatus> {
    run_blocking("hosting connection status", move || Ok(hosting::status())).await
}

#[tauri::command(async)]
pub async fn azdo_helper_enable(app: AppHandle) -> CmdResult<azdo_helper::HelperStatus> {
    run_blocking("install Azure DevOps Server helper", move || {
        azdo_helper::install(&app).and_then(|_| azdo_helper::enable(&app))
            .map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_helper_disable(app: AppHandle) -> CmdResult<azdo_helper::HelperStatus> {
    run_blocking("disable Azure DevOps Server helper", move || {
        azdo_helper::disable(&app).map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_helper_remove(app: AppHandle) -> CmdResult<()> {
    run_blocking("remove Azure DevOps Server helper", move || {
        azdo_helper::remove_all(&app).map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_profile_upsert(app: AppHandle, profile: ServerProfile) -> CmdResult<ServerProfile> {
    run_blocking("save Azure DevOps Server profile", move || {
        azdo_helper::upsert_profile(&app, &profile).map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_profile_import_ca(app: AppHandle, id: uuid::Uuid, path: String) -> CmdResult<ServerProfile> {
    run_blocking("import Azure DevOps Server CA", move || {
        azdo_helper::import_ca(&app, id, &path).map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_profile_remove(app: AppHandle, id: uuid::Uuid) -> CmdResult<()> {
    run_blocking("remove Azure DevOps Server profile", move || {
        azdo_helper::remove_profile(&app, id).map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_profile_set_pat(app: AppHandle, id: uuid::Uuid, mut pat: String) -> CmdResult<()> {
    run_blocking("store Azure DevOps Server PAT", move || {
        let result = azdo_helper::set_pat(&app, id, &pat).map_err(|message| CmdError { message });
        pat.zeroize();
        result
    }).await
}

#[tauri::command(async)]
pub async fn azdo_profile_clear_pat(app: AppHandle, id: uuid::Uuid) -> CmdResult<()> {
    run_blocking("clear Azure DevOps Server PAT", move || {
        azdo_helper::clear_pat(&app, id).map_err(|message| CmdError { message })
    }).await
}

#[tauri::command(async)]
pub async fn azdo_profile_test(app: AppHandle, id: uuid::Uuid) -> CmdResult<serde_json::Value> {
    run_blocking("test Azure DevOps Server profile", move || {
        azdo_helper::test_profile(&app, id).map_err(|message| CmdError { message })
    }).await
}

/// Pull requests for the first supported remote (`origin` wins). Cloud auth is
/// inherited from provider CLIs; Server PATs remain in the native vault.
#[tauri::command(async)]
pub async fn repo_pull_requests(path: String) -> CmdResult<PullRequestList> {
    run_blocking("pull requests", move || {
        pull_requests::list(&path).map_err(|message| CmdError { message })
    })
    .await
}

/// Active pull request for one checked-out branch. This targeted query lets
/// automatic following work without loading the full hosted-PR workspace.
#[tauri::command(async)]
pub async fn repo_pull_request_for_branch(
    path: String,
    branch: String,
) -> CmdResult<Option<pull_requests::PullRequestBranchMatch>> {
    run_blocking("pull request for branch", move || {
        pull_requests::for_branch(&path, &branch).map_err(|message| CmdError { message })
    })
    .await
}

/// Create a pull request for an existing remote branch through the signed-in
/// provider CLI. Strand deliberately does not push as part of this action.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub async fn repo_pull_request_create(
    path: String,
    source_branch: String,
    target_branch: String,
    title: String,
    description: String,
    is_draft: bool,
) -> CmdResult<pull_requests::PullRequestCreateOutcome> {
    run_blocking("create pull request", move || {
        pull_requests::create(
            &path,
            &source_branch,
            &target_branch,
            &title,
            &description,
            is_draft,
        )
        .map_err(|message| CmdError { message })
    })
    .await
}

/// Small, patch-free snapshot used by the followed-PR monitor.
#[tauri::command(async)]
pub async fn repo_pull_request_activity(
    path: String,
    id: u64,
) -> CmdResult<pull_requests::PullRequestActivitySnapshot> {
    run_blocking("pull request activity", move || {
        pull_requests::activity(&path, id).map_err(|message| CmdError { message })
    })
    .await
}

/// Rich fields for one selected pull request. Kept separate from the list so
/// GitHub never expands every PR's nested GraphQL connections in one query.
#[tauri::command(async)]
pub async fn repo_pull_request(path: String, id: u64) -> CmdResult<pull_requests::PullRequest> {
    run_blocking("pull request", move || {
        pull_requests::detail(&path, id).map_err(|message| CmdError { message })
    })
    .await
}

/// Unified patch for one hosted pull request. This stays lazy because provider
/// diffs can be much larger than the overview metadata.
#[tauri::command(async)]
pub async fn repo_pull_request_diff(path: String, id: u64) -> CmdResult<String> {
    run_blocking("pull request diff", move || {
        pull_requests::diff(&path, id).map_err(|message| CmdError { message })
    })
    .await
}

/// Add a top-level provider discussion comment. The comment body is sent
/// through stdin/temp input, never interpolated into a shell command.
#[tauri::command(async)]
pub async fn repo_pull_request_comment(path: String, id: u64, body: String) -> CmdResult<()> {
    run_blocking("pull request comment", move || {
        pull_requests::add_comment(&path, id, &body).map_err(|message| CmdError { message })
    })
    .await
}

/// Add a provider review thread anchored to an exact file line range.
/// `expected_head` prevents a delayed editor from commenting on a newer diff.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub async fn repo_pull_request_inline_comment(
    path: String,
    id: u64,
    body: String,
    file_path: String,
    start_line: u32,
    end_line: u32,
    side: pull_requests::PullRequestDiffSide,
    expected_head: String,
) -> CmdResult<()> {
    run_blocking("pull request inline comment", move || {
        pull_requests::add_inline_comment(
            &path,
            id,
            &body,
            &file_path,
            start_line,
            end_line,
            side,
            &expected_head,
        )
        .map_err(|message| CmdError { message })
    })
    .await
}

/// Submit one exact-head review, including any pending inline comments.
#[tauri::command(async)]
pub async fn repo_pull_request_submit_review(
    path: String,
    id: u64,
    event: pull_requests::PullRequestReviewEvent,
    body: String,
    comments: Vec<pull_requests::PullRequestPendingComment>,
    expected_head: String,
) -> CmdResult<()> {
    run_blocking("submit pull request review", move || {
        pull_requests::submit_review(&path, id, event, &body, &comments, &expected_head)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Update the body of an existing provider review when the signed-in viewer
/// owns it and the provider reports that it remains editable.
#[tauri::command(async)]
pub async fn repo_pull_request_update_review(
    path: String,
    id: u64,
    review_id: String,
    body: String,
) -> CmdResult<()> {
    run_blocking("update pull request review", move || {
        pull_requests::update_review(&path, id, &review_id, &body)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Dismiss an existing GitHub review, or reset the signed-in viewer's Azure
/// DevOps vote, after the provider confirms the operation is allowed.
#[tauri::command(async)]
pub async fn repo_pull_request_dismiss_review(
    path: String,
    id: u64,
    review_id: String,
    message: String,
) -> CmdResult<()> {
    run_blocking("dismiss pull request review", move || {
        pull_requests::dismiss_review(&path, id, &review_id, &message)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Reply to an existing provider review thread. The provider thread ID is a
/// stable target, so this write does not depend on diff coordinates or head SHA.
#[tauri::command(async)]
pub async fn repo_pull_request_thread_reply(
    path: String,
    thread_id: String,
    body: String,
) -> CmdResult<pull_requests::PullRequestComment> {
    run_blocking("pull request thread reply", move || {
        pull_requests::reply_to_thread(&path, &thread_id, &body)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Resolve or reopen an existing provider review thread.
#[tauri::command(async)]
pub async fn repo_pull_request_thread_resolve(
    path: String,
    thread_id: String,
    resolved: bool,
) -> CmdResult<pull_requests::PullRequestReviewThreadUpdate> {
    run_blocking("pull request thread resolution", move || {
        pull_requests::set_thread_resolved(&path, &thread_id, resolved)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Merge a hosted pull request through its provider. The expected source
/// commit prevents merging unseen updates; provider policies remain enforced.
#[tauri::command(async)]
pub async fn repo_pull_request_merge(
    path: String,
    id: u64,
    strategy: pull_requests::PullRequestMergeStrategy,
    expected_head: String,
) -> CmdResult<()> {
    run_blocking("pull request merge", move || {
        pull_requests::merge(&path, id, strategy, &expected_head)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Move a draft pull request into review through the signed-in provider.
/// Provider permissions remain authoritative; the detail capability only
/// controls whether Strand presents the action.
#[tauri::command(async)]
pub async fn repo_pull_request_ready(path: String, id: u64) -> CmdResult<()> {
    run_blocking("mark pull request ready", move || {
        pull_requests::mark_ready(&path, id).map_err(|message| CmdError { message })
    })
    .await
}

/// Close or reopen a hosted pull request through its provider. Completed PRs
/// are never offered this action by the UI; provider permissions stay final.
#[tauri::command(async)]
pub async fn repo_pull_request_lifecycle(
    path: String,
    id: u64,
    action: pull_requests::PullRequestLifecycleAction,
) -> CmdResult<()> {
    run_blocking("pull request lifecycle", move || {
        pull_requests::set_lifecycle(&path, id, action)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Ask the host to merge the target branch into the exact PR head Strand has
/// displayed. GitHub provides this as a guarded provider operation.
#[tauri::command(async)]
pub async fn repo_pull_request_update_branch(
    path: String,
    id: u64,
    expected_head: String,
) -> CmdResult<()> {
    run_blocking("update pull request branch", move || {
        pull_requests::update_branch(&path, id, &expected_head)
            .map_err(|message| CmdError { message })
    })
    .await
}

/// Fetch the exact provider head without moving local refs, then return the
/// immutable commit and suggested local branch for WorktreeDialog.
#[tauri::command(async)]
pub async fn repo_pull_request_prepare_checkout(
    path: String,
    id: u64,
    expected_head: String,
) -> CmdResult<pull_requests::PullRequestCheckoutPreparation> {
    run_blocking("prepare pull request worktree", move || {
        pull_requests::prepare_checkout(&path, id, &expected_head)
            .map_err(|message| CmdError { message })
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_diff_unstaged(path: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_unstaged()?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_unstaged_paths(path: String) -> CmdResult<Vec<strand_core::diff::DiffPath>> {
    run_blocking("unstaged paths", move || Ok(Repo::discover(&path)?.diff_unstaged_paths()?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_staged(path: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_staged()?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_between(path: String, from: String, to: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_between(&from, &to)?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_commit(path: String, oid: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_commit(&oid)?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_commit_file(path: String, oid: String, file: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_commit_file(&oid, &file)?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_workdir_file(path: String, file: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_workdir_file(&file)?)).await
}

/// Diff everything (committed + staged + unstaged) since a baseline
/// commit-ish — the "review since…" view for agent sessions.
#[tauri::command(async)]
pub async fn repo_diff_since(path: String, baseline: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_since(&baseline)?)).await
}

/// Whole-file-context variants of `repo_diff_unstaged` / `repo_diff_since`:
/// each patch carries the entire file, not just hunks. The Review view uses
/// these so an agent's edits read in the context of the full file.
#[tauri::command(async)]
pub async fn repo_diff_unstaged_full(path: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_unstaged_full()?)).await
}

#[tauri::command(async)]
pub async fn repo_diff_since_full(path: String, baseline: String) -> CmdResult<Vec<FileDiff>> {
    run_blocking("diff", move || Ok(Repo::discover(&path)?.diff_since_full(&baseline)?)).await
}

/// Best common ancestor of two commit-ishes. Pairs with `repo_diff_since` to
/// review a worktree against the branch it forked from.
#[tauri::command(async)]
pub async fn repo_merge_base(path: String, a: String, b: String) -> CmdResult<String> {
    run_blocking("merge base", move || Ok(Repo::discover(&path)?.merge_base(&a, &b)?)).await
}

/// Detect the branch `target` was forked from and the fork point — powers the
/// worktree Review flow's baseline, so a branch cut from `portal30` reviews
/// against `portal30`, not the repo's main branch (DAN-14).
#[tauri::command(async)]
pub async fn repo_detect_base_branch(path: String, target: String) -> CmdResult<Option<BaseBranch>> {
    run_blocking("detect base branch", move || {
        Ok(Repo::discover(&path)?.detect_base_branch(&target)?)
    })
    .await
}

// ── File view (Content / History / Blame tabs) ──

#[tauri::command(async)]
pub async fn repo_file_content(path: String, file: String, rev: Option<String>) -> CmdResult<FileContent> {
    run_blocking("file content", move || {
        Ok(Repo::discover(&path)?.file_content(&file, rev.as_deref())?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_file_write(
    path: String,
    file: String,
    expected: String,
    content: String,
) -> CmdResult<FileContent> {
    run_blocking("write file content", move || {
        Ok(Repo::discover(&path)?.write_file_content(&file, &expected, &content)?)
    })
    .await
}

/// Raw file bytes (base64) for the image diff preview. `index = true` reads
/// the staged copy; otherwise `rev = None` reads the working tree and
/// `rev = Some(spec)` the blob at that revision.
#[tauri::command(async)]
pub async fn repo_file_blob(
    path: String,
    file: String,
    rev: Option<String>,
    index: bool,
) -> CmdResult<FileBlob> {
    run_blocking("file blob", move || {
        let source = if index {
            BlobSource::Index
        } else {
            match rev.as_deref() {
                Some(spec) => BlobSource::Rev(spec),
                None => BlobSource::Worktree,
            }
        };
        Ok(Repo::discover(&path)?.file_blob(&file, source)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_file_history(
    path: String,
    file: String,
    limit: Option<usize>,
) -> CmdResult<Vec<FileHistoryEntry>> {
    run_blocking("file history", move || {
        Ok(Repo::discover(&path)?.file_history(&file, limit.unwrap_or(200))?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_blame(path: String, file: String) -> CmdResult<Vec<BlameLine>> {
    run_blocking("blame", move || Ok(Repo::discover(&path)?.blame(&file)?)).await
}

#[tauri::command(async)]
pub fn repo_file_create(path: String, file: String, directory: bool) -> CmdResult<()> {
    Repo::discover(&path)?.create_worktree_entry(&file, directory)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn repo_file_delete(path: String, files: Vec<String>) -> CmdResult<()> {
    run_blocking("delete working-tree entries", move || {
        Repo::discover(&path)?
            .delete_worktree_entries(&files)
            .map_err(CmdError::from)
    })
    .await
}

#[tauri::command(async)]
pub fn repo_file_absolute_paths(path: String, files: Vec<String>) -> CmdResult<Vec<String>> {
    Ok(Repo::discover(&path)?.absolute_worktree_paths(&files)?)
}

#[tauri::command(async)]
pub fn repo_file_reveal(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.reveal_in_file_manager(&file)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn repo_reflog(
    path: String,
    selector: Option<String>,
    limit: Option<usize>,
) -> CmdResult<Vec<ReflogEntry>> {
    run_blocking("reflog", move || {
        Ok(Repo::discover(&path)?
            .reflog(selector.as_deref().unwrap_or("HEAD"), limit.unwrap_or(500))?)
    })
    .await
}

#[tauri::command(async)]
pub fn repo_stage(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.stage_path(&file)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_unstage(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.unstage_path(&file)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_stage_many(path: String, files: Vec<String>) -> CmdResult<()> {
    Repo::discover(&path)?.stage_paths(&files)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_unstage_many(path: String, files: Vec<String>) -> CmdResult<()> {
    Repo::discover(&path)?.unstage_paths(&files)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_discard_many(path: String, files: Vec<String>) -> CmdResult<()> {
    Repo::discover(&path)?.discard_paths(&files)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_discard(path: String, file: String) -> CmdResult<()> {
    Repo::discover(&path)?.discard_path(&file)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_gitignore_add(path: String, pattern: String) -> CmdResult<()> {
    Repo::discover(&path)?.gitignore_add(&pattern)?;
    Ok(())
}

/// Rename / move a working-tree entry (file or directory). `to` is the full
/// destination path, not a directory to move into. A quick index/fs write —
/// stays a plain sync body like the other fast writes.
#[tauri::command(async)]
pub fn repo_move_path(path: String, from: String, to: String) -> CmdResult<()> {
    Repo::discover(&path)?.move_path(&from, &to)?;
    Ok(())
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub async fn repo_fetch(
    path: String,
    remote: Option<String>,
    prune: bool,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("fetch", move || {
        let repo = Repo::discover(&path)?;
        repo.fetch(
            remote.as_deref(),
            prune,
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
pub async fn repo_pull(
    path: String,
    mode: PullMode,
    autostash: bool,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("pull", move || {
        let repo = Repo::discover(&path)?;
        repo.pull(
            mode,
            autostash,
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
pub async fn repo_push(
    path: String,
    mode: PushMode,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("push", move || {
        let repo = Repo::discover(&path)?;
        repo.push(
            mode,
            |p| {
                let _ = on_event.send(p);
            },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPushRequest {
    branch: String,
    remote: String,
    remote_branch: String,
    mode: PushMode,
    set_upstream: bool,
}

#[tauri::command(async)]
pub async fn repo_branch_push(
    path: String,
    request: BranchPushRequest,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("branch push", move || {
        let repo = Repo::discover(&path)?;
        repo.push_branch(
            &request.branch,
            &request.remote,
            &request.remote_branch,
            request.mode,
            request.set_upstream,
            |p| { let _ = on_event.send(p); },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
pub async fn repo_branch_fetch(
    path: String,
    remote: String,
    branch: String,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("branch fetch", move || {
        let repo = Repo::discover(&path)?;
        repo.fetch_branch(
            &remote,
            &branch,
            |p| { let _ = on_event.send(p); },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Tauri IPC parameters intentionally stay flat and named.
pub async fn repo_branch_pull(
    path: String,
    remote: String,
    branch: String,
    mode: PullMode,
    autostash: bool,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<NetworkOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("branch pull", move || {
        let repo = Repo::discover(&path)?;
        repo.pull_branch(
            &remote,
            &branch,
            mode,
            autostash,
            |p| { let _ = on_event.send(p); },
            Some(&cancel),
        )
        .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
pub async fn repo_clone(
    url: String,
    dest: String,
    op_id: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, AppState>,
) -> CmdResult<CloneOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("clone", move || {
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
    .await;
    deregister_op(&state, &op_id);
    result
}

/// Kill the in-flight cancellable op registered under `op_id`. A no-op when
/// the op already finished (its handle is gone from the registry).
/// Deliberately NOT `(async)`: cancellation is a lock + kill signal and must
/// run on the instant (main-thread) path, never queued on the worker pool
/// behind the very op it's trying to kill.
#[tauri::command]
pub fn repo_cancel_op(op_id: String, state: State<'_, AppState>) -> CmdResult<()> {
    if let Ok(ops) = state.ops.lock() {
        if let Some(handle) = ops.get(&op_id) {
            handle.cancel();
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn repo_checkout(path: String, branch: String) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.checkout_branch(&branch)?)
}

#[tauri::command(async)]
pub fn repo_checkout_commit(path: String, rev: String) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.checkout_commit(&rev)?)
}

#[tauri::command(async)]
pub async fn repo_tree(
    path: String,
    include_ignored: Option<bool>,
) -> CmdResult<Vec<WorkTreeEntry>> {
    run_blocking("tree", move || {
        Ok(Repo::discover(&path)?.work_tree_with_ignored(include_ignored.unwrap_or(false))?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_tree_ignored_children(
    path: String,
    directory: String,
) -> CmdResult<Vec<WorkTreeEntry>> {
    run_blocking("ignored directory", move || {
        Ok(Repo::discover(&path)?.ignored_directory_children(&directory)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_tree_at(path: String, rev: String) -> CmdResult<Vec<WorkTreeEntry>> {
    run_blocking("tree at revision", move || {
        Ok(Repo::discover(&path)?.tree_at(&rev)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_submodules(path: String) -> CmdResult<Vec<Submodule>> {
    run_blocking("submodules", move || Ok(Repo::discover(&path)?.submodules()?)).await
}

// `git submodule update` can clone/fetch, so it runs off the IPC thread and
// streams progress like the other network ops.
#[tauri::command(async)]
pub async fn repo_submodule_update(
    path: String,
    paths: Vec<String>,
    init: bool,
    recursive: bool,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    run_blocking("submodule update", move || {
        let repo = Repo::discover(&path)?;
        repo.submodule_update(&paths, init, recursive, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_worktrees(path: String) -> CmdResult<Vec<Worktree>> {
    run_blocking("worktrees", move || Ok(Repo::discover(&path)?.worktrees()?)).await
}

// The worktree lifecycle commands all wait on `git` subprocesses (add even
// runs a full checkout + the user's post-checkout hook), so they route
// through `run_blocking` like the other subprocess-backed commands.
#[tauri::command(async)]
pub async fn repo_worktree_add(
    path: String,
    dest: String,
    branch: String,
    new_branch: bool,
    start_point: Option<String>,
    track: Option<bool>,
) -> CmdResult<()> {
    run_blocking("worktree add", move || {
        Ok(Repo::discover(&path)?.add_worktree(
            &dest,
            &branch,
            new_branch,
            start_point.as_deref(),
            track.unwrap_or(false),
        )?)
    })
    .await
}

/// Lock / unlock a worktree against removal and pruning (`reason` shows in
/// `worktree list` and the overview badge).
#[tauri::command(async)]
pub async fn repo_worktree_lock(
    path: String,
    dest: String,
    reason: Option<String>,
) -> CmdResult<()> {
    run_blocking("worktree lock", move || {
        Ok(Repo::discover(&path)?.lock_worktree(&dest, reason.as_deref())?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_worktree_unlock(path: String, dest: String) -> CmdResult<()> {
    run_blocking("worktree unlock", move || {
        Ok(Repo::discover(&path)?.unlock_worktree(&dest)?)
    })
    .await
}

/// Disk size / last-activity / ±line stats for the worktree at `path` — the
/// overview fetches this lazily per row (the walk can be slow on huge trees).
#[tauri::command(async)]
pub async fn repo_worktree_stats(path: String) -> CmdResult<WorktreeStats> {
    run_blocking("worktree stats", move || Ok(Repo::discover(&path)?.worktree_stats()?)).await
}

/// Patterns from `.worktreeinclude` at the workdir root (empty when absent) —
/// lets the create dialog offer the copy step only when it would do something.
#[tauri::command(async)]
pub async fn repo_worktree_include_patterns(path: String) -> CmdResult<Vec<String>> {
    run_blocking("worktree include patterns", move || {
        Ok(Repo::discover(&path)?.worktree_include_patterns()?)
    })
    .await
}

/// Copy gitignored files matching `.worktreeinclude` from the worktree at
/// `path` into the fresh worktree at `dest`; returns the copied paths.
#[tauri::command(async)]
pub async fn repo_worktree_copy_include(path: String, dest: String) -> CmdResult<Vec<String>> {
    run_blocking("worktree copy include", move || {
        Ok(Repo::discover(&path)?.copy_worktree_include(&dest)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_worktree_remove(path: String, dest: String, force: bool) -> CmdResult<()> {
    run_blocking("worktree remove", move || {
        Ok(Repo::discover(&path)?.remove_worktree(&dest, force)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_worktree_prune(path: String) -> CmdResult<()> {
    run_blocking("worktree prune", move || Ok(Repo::discover(&path)?.prune_worktrees()?)).await
}

/// Move a linked worktree's directory, registry-aware — a manual rename
/// leaves a dangling entry that `repair` has to fix.
#[tauri::command(async)]
pub async fn repo_worktree_move(
    path: String,
    dest: String,
    new_path: String,
    force: bool,
) -> CmdResult<()> {
    run_blocking("worktree move", move || {
        Ok(Repo::discover(&path)?.move_worktree(&dest, &new_path, force)?)
    })
    .await
}

/// Repair worktree admin links: no `paths` fixes worktree→repo pointers after
/// the repo moved; the new directories of manually-moved worktrees fix the
/// repo→worktree side.
#[tauri::command(async)]
pub async fn repo_worktree_repair(path: String, paths: Vec<String>) -> CmdResult<()> {
    run_blocking("worktree repair", move || {
        Ok(Repo::discover(&path)?.repair_worktrees(&paths)?)
    })
    .await
}

/// Ref-level health of a worktree's branch (merged into base? unpushed?
/// fast-forwardable?) — the overview's badge + cleanup data.
#[tauri::command(async)]
pub async fn repo_worktree_health(path: String, target: String) -> CmdResult<WorktreeHealth> {
    run_blocking("worktree health", move || {
        Ok(Repo::discover(&path)?.worktree_health(&target)?)
    })
    .await
}

/// Merge a worktree's branch into its base (`mode`: "ff" | "merge" |
/// "squash") — the "merge & clean up" flow's integration step.
#[tauri::command(async)]
pub async fn repo_worktree_integrate(
    path: String,
    branch: String,
    base: String,
    mode: String,
) -> CmdResult<String> {
    run_blocking("worktree integrate", move || {
        Ok(Repo::discover(&path)?.integrate_worktree_branch(&branch, &base, &mode)?)
    })
    .await
}

/// Snapshot the worktree at `path` (HEAD + staged + unstaged + untracked)
/// into an archive ref; the safety net taken before any worktree removal.
#[tauri::command(async)]
pub async fn repo_worktree_archive(path: String) -> CmdResult<String> {
    run_blocking("worktree archive", move || {
        Ok(Repo::discover(&path)?.archive_worktree_state()?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_worktree_archives(path: String) -> CmdResult<Vec<WorktreeArchive>> {
    run_blocking("worktree archives", move || Ok(Repo::discover(&path)?.worktree_archives()?)).await
}

/// Restore an archived snapshot as a worktree — original directory + branch
/// when they're free, `dest`/detached as fallbacks; archived changes come
/// back as uncommitted workdir state.
#[tauri::command(async)]
pub async fn repo_worktree_archive_restore(
    path: String,
    ref_name: String,
    dest: String,
) -> CmdResult<RestoredWorktree> {
    run_blocking("worktree restore", move || {
        Ok(Repo::discover(&path)?.restore_worktree_archive(&ref_name, &dest)?)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_worktree_archive_delete(path: String, ref_name: String) -> CmdResult<()> {
    run_blocking("worktree archive delete", move || {
        Ok(Repo::discover(&path)?.delete_worktree_archive(&ref_name)?)
    })
    .await
}

#[tauri::command(async)]
pub fn repo_branch_create(
    path: String,
    name: String,
    start_point: Option<String>,
    checkout: bool,
) -> CmdResult<CheckoutOutcome> {
    Ok(Repo::discover(&path)?.create_branch(&name, start_point.as_deref(), checkout)?)
}

#[tauri::command(async)]
pub fn repo_branch_delete(path: String, name: String, force: bool) -> CmdResult<()> {
    Repo::discover(&path)?.delete_branch(&name, force)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_branch_delete_at(
    path: String,
    name: String,
    expected_target: String,
) -> CmdResult<()> {
    Repo::discover(&path)?.delete_branch_at(&name, &expected_target)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_branch_rename(path: String, old_name: String, new_name: String) -> CmdResult<()> {
    Repo::discover(&path)?.rename_branch(&old_name, &new_name)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_branch_set_upstream(
    path: String,
    branch: String,
    upstream: Option<String>,
) -> CmdResult<()> {
    Repo::discover(&path)?.set_branch_upstream(&branch, upstream.as_deref())?;
    Ok(())
}

#[tauri::command(async)]
pub async fn repo_branch_delete_remote(
    path: String,
    remote: String,
    branch: String,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    run_blocking("branch delete", move || {
        let repo = Repo::discover(&path)?;
        repo.delete_remote_branch(&remote, &branch, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
}

#[tauri::command(async)]
pub fn repo_remote_add(
    path: String,
    name: String,
    url: String,
    push_url: Option<String>,
) -> CmdResult<()> {
    Repo::discover(&path)?.add_remote(&name, &url, push_url.as_deref())?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_remote_remove(path: String, name: String) -> CmdResult<()> {
    Repo::discover(&path)?.remove_remote(&name)?;
    Ok(())
}

/// Returns the refspecs git2 could not rewrite ("problems") — the rename has
/// already happened by then, so the UI warns instead of erroring; empty means
/// a clean rename.
#[tauri::command(async)]
pub fn repo_remote_rename(path: String, old_name: String, new_name: String) -> CmdResult<Vec<String>> {
    Ok(Repo::discover(&path)?.rename_remote(&old_name, &new_name)?)
}

#[tauri::command(async)]
pub fn repo_remote_set_urls(
    path: String,
    name: String,
    url: String,
    push_url: Option<String>,
) -> CmdResult<()> {
    Repo::discover(&path)?.set_remote_urls(&name, &url, push_url.as_deref())?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_remote_set_default(path: String, name: String) -> CmdResult<()> {
    Repo::discover(&path)?.set_default_remote(&name)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn repo_maintenance(
    path: String,
    task: MaintenanceTask,
    op_id: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<MaintenanceOutcome> {
    let cancel = CancelHandle::new();
    register_op(&state, &op_id, OperationCancelHandle::Network(cancel.clone()));
    let result = run_blocking("repository maintenance", move || {
        Repo::discover(&path)?
            .run_maintenance(task, Some(&cancel))
            .map_err(CmdError::from)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn repo_tag_delete(path: String, name: String) -> CmdResult<()> {
    Repo::discover(&path)?.delete_tag(&name)?;
    Ok(())
}

#[tauri::command(async)]
pub async fn repo_remote_tags(path: String, remote: String) -> CmdResult<Vec<String>> {
    run_blocking("remote tags", move || {
        Repo::discover(&path)?.remote_tags(&remote).map_err(CmdError::from)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_tag_push(
    path: String,
    tag: String,
    remote: String,
    delete: bool,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    run_blocking("tag push", move || {
        let repo = Repo::discover(&path)?;
        repo.push_tag(&tag, &remote, delete, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_tag_push_all(
    path: String,
    remote: String,
    on_event: Channel<Progress>,
) -> CmdResult<NetworkOutcome> {
    run_blocking("tag push", move || {
        let repo = Repo::discover(&path)?;
        repo.push_all_tags(&remote, |p| {
            let _ = on_event.send(p);
        })
        .map_err(CmdError::from)
    })
    .await
}

// These return `true` when the op stopped on conflicts (left in progress for
// resolution) and `false` when it completed cleanly; `Err` is a real failure.

#[tauri::command(async)]
pub fn repo_cherry_pick(
    path: String,
    commits: Vec<String>,
    mainline: Option<u32>,
) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.cherry_pick(&commits, mainline)?)
}

#[tauri::command(async)]
pub fn repo_revert(
    path: String,
    commits: Vec<String>,
    mainline: Option<u32>,
) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.revert(&commits, mainline)?)
}

#[tauri::command(async)]
pub fn repo_merge(path: String, refname: String, mode: String) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.merge(&refname, MergeMode::from_wire(&mode)?)?)
}

#[tauri::command(async)]
pub fn repo_rebase(path: String, onto: String) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.rebase(&onto)?)
}

#[tauri::command(async)]
pub fn repo_reset(path: String, target: String, mode: ResetMode) -> CmdResult<ResetOutcome> {
    Ok(Repo::discover(&path)?.reset(&target, mode)?)
}

#[tauri::command(async)]
pub fn repo_abort_operation(path: String) -> CmdResult<()> {
    Repo::discover(&path)?.abort_operation()?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_continue_operation(path: String) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.continue_operation()?)
}

#[tauri::command(async)]
pub fn repo_rebase_todo(path: String, base: Option<String>) -> CmdResult<Vec<RebaseEntry>> {
    Ok(Repo::discover(&path)?.rebase_todo(base.as_deref())?)
}

#[tauri::command(async)]
pub fn repo_interactive_rebase(
    path: String,
    base: Option<String>,
    steps: Vec<RebaseStep>,
    preserve_merges: bool,
) -> CmdResult<bool> {
    Ok(Repo::discover(&path)?.interactive_rebase(
        base.as_deref(),
        &steps,
        preserve_merges,
    )?)
}

#[tauri::command(async)]
pub fn repo_read_conflict_file(path: String, file: String) -> CmdResult<String> {
    Ok(Repo::discover(&path)?.read_conflict_file(&file)?)
}

#[tauri::command(async)]
pub fn repo_resolve_conflict(path: String, file: String, contents: String) -> CmdResult<()> {
    Repo::discover(&path)?.resolve_conflict(&file, &contents)?;
    Ok(())
}

// Blocks until the external tool exits, so it runs off the IPC thread.
#[tauri::command(async)]
pub async fn repo_open_mergetool(path: String, file: String) -> CmdResult<()> {
    run_blocking("mergetool", move || {
        Repo::discover(&path)?.open_mergetool(&file).map_err(CmdError::from)
    })
    .await
}

// Detached spawns — they return as soon as the app launches, so no
// spawn_blocking needed (Settings → Integrations supplies the template).
#[tauri::command(async)]
pub fn repo_open_in_editor(
    path: String,
    file: Option<String>,
    line: Option<u32>,
    template: String,
) -> CmdResult<()> {
    Ok(Repo::discover(&path)?.open_in_editor(file.as_deref(), line, &template)?)
}

#[tauri::command(async)]
pub fn repo_open_in_terminal(path: String, template: String) -> CmdResult<()> {
    Ok(Repo::discover(&path)?.open_in_terminal(&template)?)
}

#[tauri::command(async)]
pub fn git_global_identity() -> CmdResult<GlobalIdentity> {
    Ok(gitconfig::global_identity()?)
}

#[tauri::command(async)]
pub fn git_set_global_identity(name: String, email: String) -> CmdResult<()> {
    Ok(gitconfig::set_global_identity(&name, &email)?)
}

/// Read a VS Code `.code-workspace` file for the workspace importer. This is
/// the one IPC path that reads an arbitrary user-picked file, so it's gated
/// hard: the name must end in `.code-workspace` and the file must be small
/// (they're hand-sized JSON documents) — it can't be repurposed as a generic
/// file reader from the webview.
#[tauri::command(async)]
pub fn workspace_file_read(path: String) -> CmdResult<String> {
    const MAX_LEN: u64 = 1024 * 1024;
    let p = std::path::Path::new(&path);
    let ext_ok = p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_ascii_lowercase().ends_with(".code-workspace"));
    if !ext_ok {
        return Err(CmdError { message: "not a .code-workspace file".into() });
    }
    let meta = std::fs::metadata(p).map_err(|e| CmdError { message: e.to_string() })?;
    if meta.len() > MAX_LEN {
        return Err(CmdError { message: "workspace file too large (max 1 MB)".into() });
    }
    std::fs::read_to_string(p).map_err(|e| CmdError { message: e.to_string() })
}

/// The local crash log's state, plus the newest panic entry when the log has
/// grown past the frontend's acknowledged byte offset.
#[derive(Debug, Serialize)]
pub struct CrashCheck {
    /// Absolute path of `crash.log` (shown in Settings so the user knows
    /// where the local record lives).
    pub path: String,
    /// Current byte length of the log — the frontend persists this as its
    /// acknowledgement offset after prompting.
    pub len: u64,
    /// The last panic entry appended after `since`, or `None` when nothing
    /// new happened (or the log shrank / doesn't exist).
    pub entry: Option<String>,
}

/// Pull the last `=== panic at …` block out of the unacknowledged log tail,
/// bounded so a pathological backtrace can't balloon the IPC payload. The
/// head of the entry (panic message + top frames) is what matters, so
/// truncation keeps the front.
fn last_panic_entry(tail: &str) -> String {
    const MAX: usize = 8 * 1024;
    let start = tail.rfind("=== panic at ").unwrap_or(0);
    let mut entry = tail[start..].trim().to_string();
    if entry.len() > MAX {
        let mut cut = MAX;
        while !entry.is_char_boundary(cut) {
            cut -= 1;
        }
        entry.truncate(cut);
        entry.push_str("\n… (truncated — full entry in crash.log)");
    }
    entry
}

/// Check the local crash log (written by `install_crash_log` in main.rs) for
/// panics newer than `since`, the byte offset the frontend last acknowledged.
/// Purely a local read — reporting stays user-mediated (the frontend opens a
/// prefilled GitHub issue the user reviews in the browser); nothing is ever
/// uploaded automatically (PRD §10).
#[tauri::command(async)]
pub fn crash_report_check(since: u64, app: tauri::AppHandle) -> CmdResult<CrashCheck> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| CmdError { message: e.to_string() })?;
    let path = dir.join("crash.log");
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let entry = if len > since {
        std::fs::read(&path).ok().map(|bytes| {
            let start = usize::try_from(since).unwrap_or(usize::MAX).min(bytes.len());
            last_panic_entry(&String::from_utf8_lossy(&bytes[start..]))
        })
    } else {
        None
    };
    Ok(CrashCheck { path: path.to_string_lossy().into_owned(), len, entry })
}

#[tauri::command(async)]
pub async fn repo_stash_list(path: String) -> CmdResult<Vec<Stash>> {
    run_blocking("stash list", move || Ok(Repo::discover(&path)?.stash_list()?)).await
}

#[tauri::command(async)]
pub fn repo_stash_save(
    path: String,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
) -> CmdResult<StashOutcome> {
    Ok(Repo::discover(&path)?.stash_save(message.as_deref(), include_untracked, keep_index)?)
}

#[tauri::command(async)]
pub fn repo_stash_snapshot(
    path: String,
    message: Option<String>,
    include_untracked: bool,
) -> CmdResult<StashOutcome> {
    Ok(Repo::discover(&path)?.stash_snapshot(message.as_deref(), include_untracked)?)
}

#[tauri::command(async)]
pub fn repo_stash_push_paths(
    path: String,
    paths: Vec<String>,
    message: Option<String>,
    include_untracked: bool,
    keep_index: bool,
    snapshot: bool,
) -> CmdResult<StashOutcome> {
    Ok(Repo::discover(&path)?.stash_push_paths(
        &paths,
        message.as_deref(),
        include_untracked,
        keep_index,
        snapshot,
    )?)
}

#[tauri::command(async)]
pub fn repo_stash_apply(path: String, index: usize) -> CmdResult<()> {
    Repo::discover(&path)?.stash_apply(index)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_stash_pop(path: String, index: usize) -> CmdResult<()> {
    Repo::discover(&path)?.stash_pop(index)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_stash_branch(path: String, index: usize, branch: String) -> CmdResult<()> {
    Repo::discover(&path)?.stash_branch(index, &branch)?;
    Ok(())
}

#[tauri::command(async)]
pub fn repo_stash_drop(path: String, index: usize) -> CmdResult<()> {
    Repo::discover(&path)?.stash_drop(index)?;
    Ok(())
}

// ─── AI writing suggestions ────────────────────────────────────────────────

#[tauri::command(async)]
pub async fn heroi_agent_send(
    run_id: String,
    mut request: heroi::HeroiAgentRequest,
    on_event: Channel<heroi::HeroiAgentEvent>,
    state: State<'_, AppState>,
) -> CmdResult<heroi::HeroiAgentOutcome> {
    let canonical_path = Repo::discover(&request.path)?.meta()?.path;
    let is_open = state
        .open_paths
        .lock()
        .map_err(|_| CmdError::from_msg("open repository registry poisoned".into()))?
        .contains(&canonical_path);
    if !is_open {
        return Err(CmdError::from_msg(
            "Heroi can only run against an open Strand repository.".into(),
        ));
    }
    request.path = canonical_path;
    let cancel = ai::bin::AiCancelHandle::new();
    let op_id = Some(run_id);
    register_op(&state, &op_id, OperationCancelHandle::Ai(cancel.clone()));
    let result = run_blocking("Heroi agent", move || {
        heroi::run_agent(request, &cancel, on_event).map_err(CmdError::from_msg)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
pub async fn heroi_provider_models(
    provider: heroi::HeroiProvider,
    cli_path: Option<String>,
) -> CmdResult<heroi::HeroiModelCatalog> {
    run_blocking("Heroi models", move || {
        Ok(heroi::list_models(provider, cli_path.as_deref()))
    })
    .await
}

#[tauri::command(async)]
pub async fn heroi_skills(
    path: String,
    provider: heroi::HeroiProvider,
    state: State<'_, AppState>,
) -> CmdResult<Vec<heroi::HeroiSkill>> {
    let canonical_path = Repo::discover(&path)?.meta()?.path;
    let is_open = state
        .open_paths
        .lock()
        .map_err(|_| CmdError::from_msg("open repository registry poisoned".into()))?
        .contains(&canonical_path);
    if !is_open {
        return Err(CmdError::from_msg("Heroi can only inspect an open Strand repository.".into()));
    }
    run_blocking("Heroi skills", move || Ok(heroi::list_skills(Path::new(&canonical_path), provider))).await
}

fn ai_cli_override(provider: ai::AiProvider, openai: Option<String>, anthropic: Option<String>) -> Option<String> {
    match provider {
        ai::AiProvider::Openai => openai,
        ai::AiProvider::Anthropic => anthropic,
    }
}

// The AI commands wait on the provider's CLI subprocess — `login` can sit for
// minutes on an interactive auth flow and `suggest` on a model response — so
// they run on the blocking pool like the network ops.

#[tauri::command(async)]
pub async fn ai_provider_status(
    provider: ai::AiProvider,
    openai_cli: Option<String>,
    anthropic_cli: Option<String>,
) -> CmdResult<ai::AiProviderStatus> {
    run_blocking("ai status", move || {
        let override_path = ai_cli_override(provider, openai_cli, anthropic_cli);
        Ok(ai::provider_status(provider, override_path.as_deref()))
    })
    .await
}

#[tauri::command(async)]
pub async fn ai_provider_login(
    provider: ai::AiProvider,
    openai_cli: Option<String>,
    anthropic_cli: Option<String>,
) -> CmdResult<()> {
    run_blocking("ai login", move || {
        let override_path = ai_cli_override(provider, openai_cli, anthropic_cli);
        ai::provider_login(provider, override_path.as_deref()).map_err(CmdError::from_msg)
    })
    .await
}

#[tauri::command(async)]
pub async fn ai_provider_logout(
    provider: ai::AiProvider,
    openai_cli: Option<String>,
    anthropic_cli: Option<String>,
) -> CmdResult<()> {
    run_blocking("ai logout", move || {
        let override_path = ai_cli_override(provider, openai_cli, anthropic_cli);
        ai::provider_logout(provider, override_path.as_deref()).map_err(CmdError::from_msg)
    })
    .await
}

#[tauri::command(async)]
pub async fn repo_suggest_commit_message(
    path: String,
    provider: ai::AiProvider,
    model: Option<String>,
    openai_cli: Option<String>,
    anthropic_cli: Option<String>,
    request: ai::AiGenerationRequest,
    state: State<'_, AppState>,
) -> CmdResult<ai::AiGenerationOutcome<ai::CommitMessageSuggestion>> {
    let cancel = ai::bin::AiCancelHandle::new();
    let op_id = Some(request.op_id.clone());
    register_op(&state, &op_id, OperationCancelHandle::Ai(cancel.clone()));
    let result = run_blocking("ai suggest", move || {
        let repo = Repo::discover(&path)?;
        // A commit must use staged changes, but a suggestion is useful before
        // the user has staged anything. Prefer the exact staged set whenever
        // it exists; otherwise describe the whole working-tree delta.
        let staged_diffs = repo.diff_staged()?;
        let (diffs, scope) = if staged_diffs.is_empty() {
            (repo.diff_unstaged()?, ai::AiInputScope::Unstaged)
        } else {
            (staged_diffs, ai::AiInputScope::Staged)
        };
        let recent_subjects = repo
            .log_head(8)?
            .into_iter()
            .map(|commit| ai::truncate_utf8(&commit.subject, 120).to_string())
            .collect::<Vec<_>>();
        let override_path = ai_cli_override(provider, openai_cli, anthropic_cli);
        ai::suggest_commit_message_with_request(
            provider,
            repo.path(),
            &diffs,
            model.as_deref(),
            override_path.as_deref(),
            Some(&cancel),
            &request.sensitive_decision,
            scope,
            &recent_subjects,
            request.style_instruction.as_deref(),
        )
        .map_err(CmdError::from_msg)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub async fn repo_suggest_pull_request(
    path: String,
    target_branch: String,
    provider: ai::AiProvider,
    model: Option<String>,
    openai_cli: Option<String>,
    anthropic_cli: Option<String>,
    request: ai::AiGenerationRequest,
    state: State<'_, AppState>,
) -> CmdResult<ai::AiGenerationOutcome<ai::PullRequestSuggestion>> {
    let cancel = ai::bin::AiCancelHandle::new();
    let op_id = Some(request.op_id.clone());
    register_op(&state, &op_id, OperationCancelHandle::Ai(cancel.clone()));
    let result = run_blocking("ai suggest pull request", move || {
        let target_branch = target_branch.trim().to_string();
        if target_branch.is_empty() || target_branch.contains(['\r', '\n', '\0']) {
            return Err(CmdError::from_msg("Target branch is invalid".into()));
        }
        let repo = Repo::discover(&path)?;
        let meta = repo.meta()?;
        if meta.detached {
            return Err(CmdError::from_msg(
                "Check out a branch before generating pull request content.".into(),
            ));
        }
        let refs = repo.refs()?;
        let target_ref = refs
            .branches
            .iter()
            .find(|branch| branch.name == target_branch)
            .map(|branch| branch.full_name.clone())
            .or_else(|| {
                refs.remote_branches
                    .iter()
                    .find(|branch| branch.name == target_branch)
                    .map(|branch| branch.full_name.clone())
            })
            .or_else(|| {
                refs.remote_branches
                    .iter()
                    .filter(|branch| branch.branch == target_branch)
                    .min_by_key(|branch| (branch.remote != "origin", branch.name.clone()))
                    .map(|branch| branch.full_name.clone())
            })
            .unwrap_or_else(|| target_branch.clone());
        let merge_base = repo.merge_base(&target_ref, "HEAD")?;
        let diffs = repo.diff_between(&merge_base, "HEAD")?;
        let recent_subjects = repo
            .log_head(8)?
            .into_iter()
            .map(|commit| ai::truncate_utf8(&commit.subject, 120).to_string())
            .collect::<Vec<_>>();
        let override_path = ai_cli_override(provider, openai_cli, anthropic_cli);
        ai::suggest_pull_request_with_request(
            provider,
            repo.path(),
            &meta.branch,
            &target_branch,
            &diffs,
            model.as_deref(),
            override_path.as_deref(),
            Some(&cancel),
            &request.sensitive_decision,
            &recent_subjects,
            request.style_instruction.as_deref(),
        )
        .map_err(CmdError::from_msg)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub async fn repo_review_changes(
    path: String,
    baseline: Option<String>,
    provider: ai::AiProvider,
    model: Option<String>,
    openai_cli: Option<String>,
    anthropic_cli: Option<String>,
    request: ai::AiGenerationRequest,
    state: State<'_, AppState>,
) -> CmdResult<ai::AiGenerationOutcome<ai::CodeReviewSuggestion>> {
    let cancel = ai::bin::AiCancelHandle::new();
    let op_id = Some(request.op_id.clone());
    register_op(&state, &op_id, OperationCancelHandle::Ai(cancel.clone()));
    let result = run_blocking("ai review changes", move || {
        let repo = Repo::discover(&path)?;
        let diffs = match baseline.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            Some(baseline) => repo.diff_since(baseline)?,
            // Review inbox is HEAD → index + worktree, so staged files stay
            // in scope and the provider sees exactly what the UI shows.
            None => repo.diff_since("HEAD")?,
        };
        let override_path = ai_cli_override(provider, openai_cli, anthropic_cli);
        ai::review_changes_with_request(
            provider,
            repo.path(),
            &diffs,
            model.as_deref(),
            override_path.as_deref(),
            Some(&cancel),
            &request.sensitive_decision,
        )
        .map_err(CmdError::from_msg)
    })
    .await;
    deregister_op(&state, &op_id);
    result
}

impl CmdError {
    fn from_msg(message: String) -> Self {
        Self { message }
    }
}

#[cfg(test)]
mod tests {
    use super::last_panic_entry;
    use super::workspace_file_read;

    #[test]
    fn last_panic_entry_picks_newest_and_bounds_size() {
        // Two entries in the unacked tail → only the newest comes back.
        let tail = "=== panic at unix:1 (strand 0.8.0)\nfirst\n\n=== panic at unix:2 (strand 0.8.0)\nsecond\nbacktrace line\n\n";
        let entry = last_panic_entry(tail);
        assert!(entry.starts_with("=== panic at unix:2"));
        assert!(entry.contains("second"));
        assert!(!entry.contains("first"));

        // A tail cut mid-entry (ack offset landed inside it) still returns text.
        assert_eq!(last_panic_entry("orphan tail, no marker"), "orphan tail, no marker");

        // Oversized entries truncate at a char boundary, keeping the head.
        let big = format!("=== panic at unix:3 (strand 0.8.0)\nmsg\n{}", "é".repeat(9000));
        let entry = last_panic_entry(&big);
        assert!(entry.len() < 9000);
        assert!(entry.starts_with("=== panic at unix:3"));
        assert!(entry.ends_with("(truncated — full entry in crash.log)"));
    }

    #[test]
    fn workspace_file_read_gates_extension_and_size() {
        let dir = std::env::temp_dir().join(format!("strand-wsread-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Wrong extension refused, even if the content would parse.
        let json = dir.join("workspace.json");
        std::fs::write(&json, "{\"folders\":[]}").unwrap();
        assert!(workspace_file_read(json.to_string_lossy().into_owned()).is_err());

        // Right extension (case-insensitive) reads back verbatim.
        let ws = dir.join("Acme.Code-Workspace");
        std::fs::write(&ws, "{\"folders\":[{\"path\":\"api\"}]}").unwrap();
        let text = workspace_file_read(ws.to_string_lossy().into_owned()).unwrap();
        assert_eq!(text, "{\"folders\":[{\"path\":\"api\"}]}");

        // Oversized file refused before reading.
        let big = dir.join("big.code-workspace");
        std::fs::write(&big, vec![b' '; 1024 * 1024 + 1]).unwrap();
        let err = workspace_file_read(big.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.message.contains("too large"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
