import { Channel, invoke } from '@tauri-apps/api/core';

import type {
  CheckoutOutcome,
  CloneOutcome,
  Commit,
  CommitOutcome,
  FileDiff,
  FileStatus,
  MergeMode,
  NetworkOutcome,
  Progress,
  Refs,
  RepoMeta,
  Stash,
  StashOutcome,
  WorkTreeEntry,
} from './types';

/**
 * Build the IPC `Channel` the Rust network commands stream progress over.
 * Kept here so callers pass a plain `(p: Progress) => void` and never touch
 * the Channel primitive directly.
 */
function progressChannel(onProgress?: (p: Progress) => void): Channel<Progress> {
  const channel = new Channel<Progress>();
  if (onProgress) channel.onmessage = onProgress;
  return channel;
}

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
  repoDiffCommit: (path: string, oid: string) =>
    invoke<FileDiff[]>('repo_diff_commit', { path, oid }),
  repoStage: (path: string, file: string) => invoke<void>('repo_stage', { path, file }),
  repoUnstage: (path: string, file: string) => invoke<void>('repo_unstage', { path, file }),
  repoStageMany: (path: string, files: string[]) =>
    invoke<void>('repo_stage_many', { path, files }),
  repoUnstageMany: (path: string, files: string[]) =>
    invoke<void>('repo_unstage_many', { path, files }),
  repoDiscardMany: (path: string, files: string[]) =>
    invoke<void>('repo_discard_many', { path, files }),
  repoDiscard: (path: string, file: string) => invoke<void>('repo_discard', { path, file }),
  repoApplyPatch: (
    path: string,
    patch: string,
    target: 'index' | 'index_reverse' | 'workdir_reverse' | 'workdir',
  ) => invoke<void>('repo_apply_patch', { path, patch, target }),
  repoCommit: (path: string, subject: string, body: string | null, amend: boolean) =>
    invoke<CommitOutcome>('repo_commit', { path, subject, body, amend }),
  repoFetch: (path: string, remote: string | null, onProgress?: (p: Progress) => void) =>
    invoke<NetworkOutcome>('repo_fetch', { path, remote, onEvent: progressChannel(onProgress) }),
  repoPull: (path: string, rebase: boolean, onProgress?: (p: Progress) => void) =>
    invoke<NetworkOutcome>('repo_pull', { path, rebase, onEvent: progressChannel(onProgress) }),
  repoPush: (path: string, forceWithLease: boolean, onProgress?: (p: Progress) => void) =>
    invoke<NetworkOutcome>('repo_push', {
      path,
      forceWithLease,
      onEvent: progressChannel(onProgress),
    }),
  repoClone: (url: string, dest: string, onProgress?: (p: Progress) => void) =>
    invoke<CloneOutcome>('repo_clone', { url, dest, onEvent: progressChannel(onProgress) }),
  repoCheckout: (path: string, branch: string) =>
    invoke<CheckoutOutcome>('repo_checkout', { path, branch }),
  repoCheckoutCommit: (path: string, rev: string) =>
    invoke<CheckoutOutcome>('repo_checkout_commit', { path, rev }),
  repoTree: (path: string) => invoke<WorkTreeEntry[]>('repo_tree', { path }),
  repoBranchCreate: (
    path: string,
    name: string,
    startPoint: string | null,
    checkout: boolean,
  ) => invoke<CheckoutOutcome>('repo_branch_create', { path, name, startPoint, checkout }),
  repoBranchDelete: (path: string, name: string, force: boolean) =>
    invoke<void>('repo_branch_delete', { path, name, force }),
  repoTagCreate: (
    path: string,
    name: string,
    target: string | null,
    message: string | null,
    force: boolean,
  ) => invoke<void>('repo_tag_create', { path, name, target, message, force }),
  repoTagDelete: (path: string, name: string) =>
    invoke<void>('repo_tag_delete', { path, name }),
  repoTagPush: (
    path: string,
    tag: string,
    remote: string,
    del: boolean,
    onProgress?: (p: Progress) => void,
  ) =>
    invoke<NetworkOutcome>('repo_tag_push', {
      path,
      tag,
      remote,
      delete: del,
      onEvent: progressChannel(onProgress),
    }),
  repoTagPushAll: (path: string, remote: string, onProgress?: (p: Progress) => void) =>
    invoke<NetworkOutcome>('repo_tag_push_all', {
      path,
      remote,
      onEvent: progressChannel(onProgress),
    }),
  repoRemoteTags: (path: string, remote: string) =>
    invoke<string[]>('repo_remote_tags', { path, remote }),
  // Return `true` when the op stopped on conflicts (left in progress), `false`
  // when it completed cleanly; reject only on a real failure.
  repoCherryPick: (path: string, commits: string[]) =>
    invoke<boolean>('repo_cherry_pick', { path, commits }),
  repoRevert: (path: string, commits: string[]) =>
    invoke<boolean>('repo_revert', { path, commits }),
  repoMerge: (path: string, refname: string, mode: MergeMode) =>
    invoke<boolean>('repo_merge', { path, refname, mode }),
  repoRebase: (path: string, onto: string) => invoke<boolean>('repo_rebase', { path, onto }),
  repoAbortOperation: (path: string) => invoke<void>('repo_abort_operation', { path }),
  repoReadConflictFile: (path: string, file: string) =>
    invoke<string>('repo_read_conflict_file', { path, file }),
  repoResolveConflict: (path: string, file: string, contents: string) =>
    invoke<void>('repo_resolve_conflict', { path, file, contents }),
  repoStashList: (path: string) => invoke<Stash[]>('repo_stash_list', { path }),
  repoStashSave: (
    path: string,
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
  ) => invoke<StashOutcome>('repo_stash_save', { path, message, includeUntracked, keepIndex }),
  repoStashSnapshot: (path: string, message: string | null, includeUntracked: boolean) =>
    invoke<StashOutcome>('repo_stash_snapshot', { path, message, includeUntracked }),
  repoStashApply: (path: string, index: number) =>
    invoke<void>('repo_stash_apply', { path, index }),
  repoStashPop: (path: string, index: number) => invoke<void>('repo_stash_pop', { path, index }),
  repoStashDrop: (path: string, index: number) => invoke<void>('repo_stash_drop', { path, index }),
};

/** True when running inside the Tauri webview (vs. plain `vite dev`). */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;
