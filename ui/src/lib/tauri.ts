import { invoke } from '@tauri-apps/api/core';

import type { Commit, FileStatus, RepoMeta } from './types';

/**
 * Typed wrappers around the Rust `tauri::command` handlers in
 * `crates/strand-tauri/src/commands.rs`. Add new wrappers here so the
 * frontend never calls `invoke` with a string literal.
 */
export const tauri = {
  repoOpen: (path: string) => invoke<RepoMeta>('repo_open', { path }),
  repoMeta: (path: string) => invoke<RepoMeta>('repo_meta', { path }),
  repoStatus: (path: string) => invoke<FileStatus[]>('repo_status', { path }),
  repoLog: (path: string, limit?: number) => invoke<Commit[]>('repo_log', { path, limit }),
};

/** True when running inside the Tauri webview (vs. plain `vite dev`). */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;
