import { invoke } from '@tauri-apps/api/core';

import type {
  CheckoutOutcome,
  Commit,
  CommitOutcome,
  FileDiff,
  FileStatus,
  NetworkOutcome,
  Refs,
  RepoMeta,
} from './types';

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
  repoRefs: (path: string) => invoke<Refs>('repo_refs', { path }),
  repoDiffUnstaged: (path: string) => invoke<FileDiff[]>('repo_diff_unstaged', { path }),
  repoDiffStaged: (path: string) => invoke<FileDiff[]>('repo_diff_staged', { path }),
  repoDiffBetween: (path: string, from: string, to: string) =>
    invoke<FileDiff[]>('repo_diff_between', { path, from, to }),
  repoStage: (path: string, file: string) => invoke<void>('repo_stage', { path, file }),
  repoUnstage: (path: string, file: string) => invoke<void>('repo_unstage', { path, file }),
  repoDiscard: (path: string, file: string) => invoke<void>('repo_discard', { path, file }),
  repoApplyPatch: (path: string, patch: string, target: 'index' | 'workdir_reverse') =>
    invoke<void>('repo_apply_patch', { path, patch, target }),
  repoCommit: (path: string, subject: string, body: string | null, amend: boolean) =>
    invoke<CommitOutcome>('repo_commit', { path, subject, body, amend }),
  repoFetch: (path: string, remote: string | null) =>
    invoke<NetworkOutcome>('repo_fetch', { path, remote }),
  repoPull: (path: string, rebase: boolean) =>
    invoke<NetworkOutcome>('repo_pull', { path, rebase }),
  repoPush: (path: string, forceWithLease: boolean) =>
    invoke<NetworkOutcome>('repo_push', { path, forceWithLease }),
  repoCheckout: (path: string, branch: string) =>
    invoke<CheckoutOutcome>('repo_checkout', { path, branch }),
  repoBranchCreate: (
    path: string,
    name: string,
    startPoint: string | null,
    checkout: boolean,
  ) => invoke<CheckoutOutcome>('repo_branch_create', { path, name, startPoint, checkout }),
  repoBranchDelete: (path: string, name: string, force: boolean) =>
    invoke<void>('repo_branch_delete', { path, name, force }),
};

/** True when running inside the Tauri webview (vs. plain `vite dev`). */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;
