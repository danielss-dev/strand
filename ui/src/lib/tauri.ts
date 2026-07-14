import { Channel, invoke } from '@tauri-apps/api/core';

import type {
  AiProvider,
  AiProviderStatus,
  AiGenerationOutcome,
  AiGenerationRequest,
  BaseBranch,
  BlameLine,
  CheckoutOutcome,
  CloneOutcome,
  Commit,
  CommitMessageSuggestion,
  CommitSearchMode,
  CommitOutcome,
  CrashCheck,
  FileBlob,
  FileContent,
  FileDiff,
  FileHistoryEntry,
  FileStatus,
  GlobalIdentity,
  MergeMode,
  NetworkOutcome,
  Progress,
  PullRequest,
  PullRequestActivitySnapshot,
  PullRequestBranchMatch,
  PullRequestComment,
  PullRequestCreateOutcome,
  PullRequestList,
  PullRequestMergeStrategy,
  PullRequestReviewThreadUpdate,
  PullRequestSuggestion,
  RebaseEntry,
  RebaseStep,
  Refs,
  ReflogEntry,
  RepoMeta,
  ResetMode,
  ResetOutcome,
  RestoredWorktree,
  Snapshot,
  Stash,
  StashOutcome,
  Submodule,
  WorkTreeEntry,
  Worktree,
  WorktreeArchive,
  WorktreeHealth,
  WorktreeStats,
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

/** Prefix returned when a vendor CLI is installed but not signed in. */
export const AI_AUTH_REQUIRED = 'AI_AUTH_REQUIRED:';

/**
 * Pull a human message out of a caught value. Tauri command rejections come
 * back as the serialized `CmdError` — a plain `{ message }` object, *not* an
 * `Error` — so `String(e)` on them yields "[object Object]". Handle Error,
 * string, and `{ message }` shapes; fall back to JSON.
 */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
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
  repoSnapshot: (path: string) => invoke<Snapshot>('repo_snapshot', { path }),
  repoWatch: (path: string) => invoke<void>('repo_watch', { path }),
  repoUnwatch: (path: string) => invoke<void>('repo_unwatch', { path }),
  repoCancelOp: (opId: string) => invoke<void>('repo_cancel_op', { opId }),
  // `headOnly` walks HEAD's ancestry instead of every ref — for per-worktree
  // "last commit" answers (worktrees share the family's refs).
  repoLog: (path: string, limit?: number, headOnly?: boolean) =>
    invoke<Commit[]>('repo_log', { path, limit, headOnly }),
  // Full-history search by message / author / diff content — the backend reach
  // the client-side loaded-window highlight can't cover.
  repoSearchLog: (path: string, query: string, mode: CommitSearchMode, limit?: number) =>
    invoke<Commit[]>('repo_search_log', { path, query, mode, limit }),
  repoRefs: (path: string) => invoke<Refs>('repo_refs', { path }),
  repoPullRequests: (path: string) => invoke<PullRequestList>('repo_pull_requests', { path }),
  repoPullRequestForBranch: (path: string, branch: string) =>
    invoke<PullRequestBranchMatch | null>('repo_pull_request_for_branch', { path, branch }),
  repoPullRequestCreate: (
    path: string,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    description: string,
    isDraft: boolean,
  ) => invoke<PullRequestCreateOutcome>('repo_pull_request_create', {
    path, sourceBranch, targetBranch, title, description, isDraft,
  }),
  repoSuggestPullRequest: (
    path: string,
    targetBranch: string,
    provider: AiProvider,
    request: AiGenerationRequest,
    openaiCli?: string | null,
    anthropicCli?: string | null,
  ) => invoke<AiGenerationOutcome<PullRequestSuggestion>>('repo_suggest_pull_request', {
    path,
    targetBranch,
    provider,
    openaiCli: openaiCli ?? null,
    anthropicCli: anthropicCli ?? null,
    request,
  }),
  repoPullRequestActivity: (path: string, id: number) =>
    invoke<PullRequestActivitySnapshot>('repo_pull_request_activity', { path, id }),
  repoPullRequest: (path: string, id: number) => invoke<PullRequest>('repo_pull_request', { path, id }),
  repoPullRequestDiff: (path: string, id: number) =>
    invoke<string>('repo_pull_request_diff', { path, id }),
  repoPullRequestComment: (path: string, id: number, body: string) =>
    invoke<void>('repo_pull_request_comment', { path, id, body }),
  repoPullRequestInlineComment: (
    path: string,
    id: number,
    body: string,
    filePath: string,
    startLine: number,
    endLine: number,
    side: 'deletions' | 'additions',
    expectedHead: string,
  ) => invoke<void>('repo_pull_request_inline_comment', {
    path, id, body, filePath, startLine, endLine, side, expectedHead,
  }),
  repoPullRequestThreadReply: (path: string, threadId: string, body: string) =>
    invoke<PullRequestComment>('repo_pull_request_thread_reply', { path, threadId, body }),
  repoPullRequestThreadResolve: (path: string, threadId: string, resolved: boolean) =>
    invoke<PullRequestReviewThreadUpdate>('repo_pull_request_thread_resolve', {
      path, threadId, resolved,
    }),
  repoPullRequestMerge: (
    path: string,
    id: number,
    strategy: PullRequestMergeStrategy,
    expectedHead: string,
  ) => invoke<void>('repo_pull_request_merge', { path, id, strategy, expectedHead }),
  repoDiffUnstaged: (path: string) => invoke<FileDiff[]>('repo_diff_unstaged', { path }),
  repoDiffStaged: (path: string) => invoke<FileDiff[]>('repo_diff_staged', { path }),
  repoDiffBetween: (path: string, from: string, to: string) =>
    invoke<FileDiff[]>('repo_diff_between', { path, from, to }),
  repoDiffCommit: (path: string, oid: string) =>
    invoke<FileDiff[]>('repo_diff_commit', { path, oid }),
  repoDiffCommitFile: (path: string, oid: string, file: string) =>
    invoke<FileDiff[]>('repo_diff_commit_file', { path, oid, file }),
  repoDiffWorkdirFile: (path: string, file: string) =>
    invoke<FileDiff[]>('repo_diff_workdir_file', { path, file }),
  repoDiffSince: (path: string, baseline: string) =>
    invoke<FileDiff[]>('repo_diff_since', { path, baseline }),
  // Whole-file-context variants for the Review view: each patch carries the
  // entire file, so an agent's changes read in full context.
  repoDiffUnstagedFull: (path: string) =>
    invoke<FileDiff[]>('repo_diff_unstaged_full', { path }),
  repoDiffSinceFull: (path: string, baseline: string) =>
    invoke<FileDiff[]>('repo_diff_since_full', { path, baseline }),
  repoMergeBase: (path: string, a: string, b: string) =>
    invoke<string>('repo_merge_base', { path, a, b }),
  // Which branch `target` forked from + the fork point — the worktree Review
  // flow's baseline (review vs the actual parent, not the main branch).
  repoDetectBaseBranch: (path: string, target: string) =>
    invoke<BaseBranch | null>('repo_detect_base_branch', { path, target }),
  repoFileContent: (path: string, file: string, rev: string | null) =>
    invoke<FileContent>('repo_file_content', { path, file, rev }),
  repoFileBlob: (path: string, file: string, rev: string | null, index: boolean) =>
    invoke<FileBlob>('repo_file_blob', { path, file, rev, index }),
  repoFileHistory: (path: string, file: string, limit?: number) =>
    invoke<FileHistoryEntry[]>('repo_file_history', { path, file, limit }),
  repoBlame: (path: string, file: string) => invoke<BlameLine[]>('repo_blame', { path, file }),
  repoReflog: (path: string, selector?: string, limit?: number) =>
    invoke<ReflogEntry[]>('repo_reflog', { path, selector, limit }),
  repoStage: (path: string, file: string) => invoke<void>('repo_stage', { path, file }),
  repoUnstage: (path: string, file: string) => invoke<void>('repo_unstage', { path, file }),
  repoStageMany: (path: string, files: string[]) =>
    invoke<void>('repo_stage_many', { path, files }),
  repoUnstageMany: (path: string, files: string[]) =>
    invoke<void>('repo_unstage_many', { path, files }),
  repoDiscardMany: (path: string, files: string[]) =>
    invoke<void>('repo_discard_many', { path, files }),
  repoDiscard: (path: string, file: string) => invoke<void>('repo_discard', { path, file }),
  repoGitignoreAdd: (path: string, pattern: string) =>
    invoke<void>('repo_gitignore_add', { path, pattern }),
  repoMovePath: (path: string, from: string, to: string) =>
    invoke<void>('repo_move_path', { path, from, to }),
  repoApplyPatch: (
    path: string,
    patch: string,
    target: 'index' | 'index_reverse' | 'workdir_reverse' | 'workdir',
  ) => invoke<void>('repo_apply_patch', { path, patch, target }),
  repoCommit: (path: string, subject: string, body: string | null, amend: boolean) =>
    invoke<CommitOutcome>('repo_commit', { path, subject, body, amend }),
  repoFetch: (
    path: string,
    remote: string | null,
    onProgress?: (p: Progress) => void,
    opId?: string,
  ) =>
    invoke<NetworkOutcome>('repo_fetch', {
      path,
      remote,
      opId,
      onEvent: progressChannel(onProgress),
    }),
  repoPull: (path: string, rebase: boolean, onProgress?: (p: Progress) => void, opId?: string) =>
    invoke<NetworkOutcome>('repo_pull', {
      path,
      rebase,
      opId,
      onEvent: progressChannel(onProgress),
    }),
  repoPush: (
    path: string,
    forceWithLease: boolean,
    onProgress?: (p: Progress) => void,
    opId?: string,
  ) =>
    invoke<NetworkOutcome>('repo_push', {
      path,
      forceWithLease,
      opId,
      onEvent: progressChannel(onProgress),
    }),
  repoClone: (url: string, dest: string, onProgress?: (p: Progress) => void, opId?: string) =>
    invoke<CloneOutcome>('repo_clone', { url, dest, opId, onEvent: progressChannel(onProgress) }),
  repoCheckout: (path: string, branch: string) =>
    invoke<CheckoutOutcome>('repo_checkout', { path, branch }),
  repoCheckoutCommit: (path: string, rev: string) =>
    invoke<CheckoutOutcome>('repo_checkout_commit', { path, rev }),
  repoTree: (path: string) => invoke<WorkTreeEntry[]>('repo_tree', { path }),
  repoSubmodules: (path: string) => invoke<Submodule[]>('repo_submodules', { path }),
  repoSubmoduleUpdate: (
    path: string,
    paths: string[],
    init: boolean,
    recursive: boolean,
    onProgress?: (p: Progress) => void,
  ) =>
    invoke<NetworkOutcome>('repo_submodule_update', {
      path,
      paths,
      init,
      recursive,
      onEvent: progressChannel(onProgress),
    }),
  repoWorktrees: (path: string) => invoke<Worktree[]>('repo_worktrees', { path }),
  // `startPoint` (branch/tag/commit; null = HEAD) and `track` (set upstream to
  // a remote start point) only apply when `newBranch` is set.
  repoWorktreeAdd: (
    path: string,
    dest: string,
    branch: string,
    newBranch: boolean,
    startPoint?: string | null,
    track?: boolean,
  ) =>
    invoke<void>('repo_worktree_add', {
      path,
      dest,
      branch,
      newBranch,
      startPoint: startPoint ?? null,
      track: track ?? false,
    }),
  repoWorktreeLock: (path: string, dest: string, reason: string | null) =>
    invoke<void>('repo_worktree_lock', { path, dest, reason }),
  repoWorktreeUnlock: (path: string, dest: string) =>
    invoke<void>('repo_worktree_unlock', { path, dest }),
  // Disk size / last activity / ±lines for the worktree at `path` — lazy
  // per-row fetch (the directory walk can be slow on huge trees).
  repoWorktreeStats: (path: string) => invoke<WorktreeStats>('repo_worktree_stats', { path }),
  // `.worktreeinclude` patterns at the workdir root (empty when absent).
  repoWorktreeIncludePatterns: (path: string) =>
    invoke<string[]>('repo_worktree_include_patterns', { path }),
  // Copy gitignored files matching `.worktreeinclude` from `path` into the
  // fresh worktree at `dest`; returns the copied relative paths.
  repoWorktreeCopyInclude: (path: string, dest: string) =>
    invoke<string[]>('repo_worktree_copy_include', { path, dest }),
  repoWorktreeRemove: (path: string, dest: string, force: boolean) =>
    invoke<void>('repo_worktree_remove', { path, dest, force }),
  repoWorktreePrune: (path: string) => invoke<void>('repo_worktree_prune', { path }),
  // Registry-aware directory move for a linked worktree; `force` overrides
  // git's locked-worktree refusal.
  repoWorktreeMove: (path: string, dest: string, newPath: string, force: boolean) =>
    invoke<void>('repo_worktree_move', { path, dest, newPath, force }),
  // Repair worktree admin links — pass the new directories of manually-moved
  // worktrees, or nothing after the repo itself moved.
  repoWorktreeRepair: (path: string, paths: string[]) =>
    invoke<void>('repo_worktree_repair', { path, paths }),
  // Ref-level health of a worktree's branch: merged into its base? unpushed
  // work? fast-forwardable? Powers the overview badges + merge dialog.
  repoWorktreeHealth: (path: string, target: string) =>
    invoke<WorktreeHealth>('repo_worktree_health', { path, target }),
  // Merge a worktree branch into its base ("ff" | "merge" | "squash").
  repoWorktreeIntegrate: (path: string, branch: string, base: string, mode: string) =>
    invoke<string>('repo_worktree_integrate', { path, branch, base, mode }),
  // Snapshot the worktree at `path` into an archive ref (safety net before
  // removal); returns the created ref name.
  repoWorktreeArchive: (path: string) => invoke<string>('repo_worktree_archive', { path }),
  repoWorktreeArchives: (path: string) =>
    invoke<WorktreeArchive[]>('repo_worktree_archives', { path }),
  // `dest` is only the fallback — restore prefers the snapshot's recorded
  // original directory and re-attaches its branch when both are free.
  repoWorktreeArchiveRestore: (path: string, refName: string, dest: string) =>
    invoke<RestoredWorktree>('repo_worktree_archive_restore', { path, refName, dest }),
  repoWorktreeArchiveDelete: (path: string, refName: string) =>
    invoke<void>('repo_worktree_archive_delete', { path, refName }),
  repoBranchCreate: (
    path: string,
    name: string,
    startPoint: string | null,
    checkout: boolean,
  ) => invoke<CheckoutOutcome>('repo_branch_create', { path, name, startPoint, checkout }),
  repoBranchDelete: (path: string, name: string, force: boolean) =>
    invoke<void>('repo_branch_delete', { path, name, force }),
  repoBranchRename: (path: string, oldName: string, newName: string) =>
    invoke<void>('repo_branch_rename', { path, oldName, newName }),
  repoBranchDeleteRemote: (
    path: string,
    remote: string,
    branch: string,
    onProgress?: (p: Progress) => void,
  ) =>
    invoke<NetworkOutcome>('repo_branch_delete_remote', {
      path,
      remote,
      branch,
      onEvent: progressChannel(onProgress),
    }),
  repoRemoteAdd: (path: string, name: string, url: string) =>
    invoke<void>('repo_remote_add', { path, name, url }),
  repoRemoteRemove: (path: string, name: string) =>
    invoke<void>('repo_remote_remove', { path, name }),
  // Resolves to the refspecs git could not rewrite ("problems") — the rename
  // has already happened by then; empty means a clean rename.
  repoRemoteRename: (path: string, oldName: string, newName: string) =>
    invoke<string[]>('repo_remote_rename', { path, oldName, newName }),
  repoRemoteSetUrl: (path: string, name: string, url: string) =>
    invoke<void>('repo_remote_set_url', { path, name, url }),
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
  // Hard resets of a dirty tree stash a safety snapshot first; the outcome's
  // `snapshot_oid` reports it so the UI can point at the stash stack.
  repoReset: (path: string, target: string, mode: ResetMode) =>
    invoke<ResetOutcome>('repo_reset', { path, target, mode }),
  repoAbortOperation: (path: string) => invoke<void>('repo_abort_operation', { path }),
  // Resume a paused merge/rebase/cherry-pick/revert after resolving conflicts
  // (`--continue`, not a commit). `true` = paused again on a fresh conflict.
  repoContinueOperation: (path: string) => invoke<boolean>('repo_continue_operation', { path }),
  // The editable commit range for an interactive rebase (oldest→newest);
  // `base` null = rebase from the root.
  repoRebaseTodo: (path: string, base: string | null) =>
    invoke<RebaseEntry[]>('repo_rebase_todo', { path, base }),
  repoInteractiveRebase: (path: string, base: string | null, steps: RebaseStep[]) =>
    invoke<boolean>('repo_interactive_rebase', { path, base, steps }),
  repoReadConflictFile: (path: string, file: string) =>
    invoke<string>('repo_read_conflict_file', { path, file }),
  repoResolveConflict: (path: string, file: string, contents: string) =>
    invoke<void>('repo_resolve_conflict', { path, file, contents }),
  /** Blocks until the external merge tool exits. */
  repoOpenMergetool: (path: string, file: string) =>
    invoke<void>('repo_open_mergetool', { path, file }),
  /** Detached spawn of the configured editor — `file: null` opens the repo
   * directory. `template` comes from Settings → Integrations. */
  repoOpenInEditor: (path: string, file: string | null, line: number | null, template: string) =>
    invoke<void>('repo_open_in_editor', { path, file, line, template }),
  repoOpenInTerminal: (path: string, template: string) =>
    invoke<void>('repo_open_in_terminal', { path, template }),
  gitGlobalIdentity: () => invoke<GlobalIdentity>('git_global_identity'),
  gitSetGlobalIdentity: (name: string, email: string) =>
    invoke<void>('git_set_global_identity', { name, email }),
  /** Raw text of a `.code-workspace` file (extension + 1 MB gated backend-side). */
  workspaceFileRead: (path: string) => invoke<string>('workspace_file_read', { path }),
  /** Local crash-log check — `since` is the persisted acknowledged byte
   * offset; a purely local read, nothing leaves the machine. */
  crashReportCheck: (since: number) => invoke<CrashCheck>('crash_report_check', { since }),
  repoStashList: (path: string) => invoke<Stash[]>('repo_stash_list', { path }),
  repoStashSave: (
    path: string,
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
  ) => invoke<StashOutcome>('repo_stash_save', { path, message, includeUntracked, keepIndex }),
  repoStashSnapshot: (path: string, message: string | null, includeUntracked: boolean) =>
    invoke<StashOutcome>('repo_stash_snapshot', { path, message, includeUntracked }),
  repoStashPushPaths: (
    path: string,
    paths: string[],
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
    snapshot: boolean,
  ) =>
    invoke<StashOutcome>('repo_stash_push_paths', {
      path,
      paths,
      message,
      includeUntracked,
      keepIndex,
      snapshot,
    }),
  repoStashApply: (path: string, index: number) =>
    invoke<void>('repo_stash_apply', { path, index }),
  repoStashPop: (path: string, index: number) => invoke<void>('repo_stash_pop', { path, index }),
  repoStashDrop: (path: string, index: number) => invoke<void>('repo_stash_drop', { path, index }),

  aiProviderStatus: (
    provider: AiProvider,
    openaiCli?: string | null,
    anthropicCli?: string | null,
  ) =>
    invoke<AiProviderStatus>('ai_provider_status', {
      provider,
      openaiCli: openaiCli ?? null,
      anthropicCli: anthropicCli ?? null,
    }),
  aiProviderLogin: (
    provider: AiProvider,
    openaiCli?: string | null,
    anthropicCli?: string | null,
  ) =>
    invoke<void>('ai_provider_login', {
      provider,
      openaiCli: openaiCli ?? null,
      anthropicCli: anthropicCli ?? null,
    }),
  aiProviderLogout: (
    provider: AiProvider,
    openaiCli?: string | null,
    anthropicCli?: string | null,
  ) =>
    invoke<void>('ai_provider_logout', {
      provider,
      openaiCli: openaiCli ?? null,
      anthropicCli: anthropicCli ?? null,
    }),
  repoSuggestCommitMessage: (
    path: string,
    provider: AiProvider,
    request: AiGenerationRequest,
    openaiCli?: string | null,
    anthropicCli?: string | null,
  ) =>
    invoke<AiGenerationOutcome<CommitMessageSuggestion>>('repo_suggest_commit_message', {
      path,
      provider,
      openaiCli: openaiCli ?? null,
      anthropicCli: anthropicCli ?? null,
      request,
    }),
};

/** True when a rejected op was user-cancelled (`Error::Cancelled`) — show it
 * quietly instead of as an error toast. */
export const isCancelled = (e: unknown): boolean => errMessage(e) === 'cancelled';

/**
 * `errMessage` plus a plain-language hint for the failure modes users hit in
 * the wild. The big one: a stale `.git/index.lock` (an interrupted git
 * process — common when agents run git) blocks every index write, which
 * otherwise reads as "staging mysteriously does nothing".
 */
export function gitErrorHint(e: unknown): string {
  const msg = errMessage(e);
  if (/index\.lock|failed to lock/i.test(msg)) {
    return `${msg} — another git process is using this repo, or a crashed one left .git/index.lock behind (safe to delete when no git command is running).`;
  }
  return msg;
}

/** True when running inside the Tauri webview (vs. plain `vite dev`). */
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;
