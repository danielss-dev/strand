import { invoke } from '@tauri-apps/api/core';
/**
 * Typed wrappers around the Rust `tauri::command` handlers in
 * `crates/strand-tauri/src/commands.rs`. Add new wrappers here so the
 * frontend never calls `invoke` with a string literal.
 */
export const tauri = {
    repoOpen: (path) => invoke('repo_open', { path }),
    repoMeta: (path) => invoke('repo_meta', { path }),
    repoStatus: (path) => invoke('repo_status', { path }),
    repoLog: (path, limit) => invoke('repo_log', { path, limit }),
    repoDiffUnstaged: (path) => invoke('repo_diff_unstaged', { path }),
    repoDiffStaged: (path) => invoke('repo_diff_staged', { path }),
    repoDiffBetween: (path, from, to) => invoke('repo_diff_between', { path, from, to }),
    repoStage: (path, file) => invoke('repo_stage', { path, file }),
    repoUnstage: (path, file) => invoke('repo_unstage', { path, file }),
    repoDiscard: (path, file) => invoke('repo_discard', { path, file }),
    repoCommit: (path, subject, body, amend) => invoke('repo_commit', { path, subject, body, amend }),
    repoFetch: (path, remote) => invoke('repo_fetch', { path, remote }),
    repoPull: (path, rebase) => invoke('repo_pull', { path, rebase }),
    repoPush: (path, forceWithLease) => invoke('repo_push', { path, forceWithLease }),
};
/** True when running inside the Tauri webview (vs. plain `vite dev`). */
export const isTauri = () => '__TAURI_INTERNALS__' in window;
