import { create } from 'zustand';

import {
  recents as recentsDb,
  remoteTagsCache,
  repoDiffMode,
  repoNetworkPreferences,
  repoPullMode,
  reviewSession,
  settings as settingsDb,
  type StoredBaseline,
} from '../lib/db';
import { hashPatch } from '../lib/patch';
import { logColdStart, timed } from '../lib/perf';
import { isPreviewablePath } from '../lib/preview';
import { pathKey, repoFamilyName } from '../lib/repoIdentity';
import { jsonEqual, stable } from '../lib/stable';
import { errMessage, tauri } from '../lib/tauri';
import { useSettings, type DiffMode } from './settings';
import type {
  Commit,
  BranchPushRequest,
  CommitSearchMode,
  FileDiff,
  FileStatus,
  FilesTreeMutation,
  FilesTreeMutationChange,
  MergeMode,
  Progress,
  PullMode,
  PushMode,
  RebaseEntry,
  RebaseStep,
  RecentRepo,
  Refs,
  ReflogEntry,
  RepoMeta,
  ReviewNote,
  ResetMode,
  ResetOutcome,
  Stash,
  StashOutcome,
  Submodule,
  WorkTreeEntry,
  Worktree,
} from '../lib/types';

interface PersistedSession {
  tabs: string[];
  activeTabPath: string | null;
}
const SESSION_KEY = 'session.tabs';

export type View =
  | 'work' | 'local' | 'commits' | 'file' | 'branch' | 'reflog' | 'review' | 'worktrees'
  | 'workspace-review' | 'pull-requests';

/** Active tab within the file view ('preview' only offered for renderable
 *  files — SVG / markdown). */
export type FileTab = 'content' | 'preview' | 'history' | 'compare' | 'blame';

/** One open repository in the topbar tab strip. */
export interface RepoTab {
  path: string;
  meta: RepoMeta;
}

/**
 * Which file is selected in the Local Changes pane, and whether the row
 * came from the staged or unstaged list. Drives which diff renders in
 * the middle pane.
 */
export interface LocalSelection {
  file: string;
  staged: boolean;
  /**
   * When true, the diff pane shows *every* file on this side (`staged`)
   * stacked, rather than the single `file` (which is ignored). This is the
   * default view when Local Changes opens, and is re-selectable from the
   * column header.
   */
  all?: boolean;
}

export interface RepoState {
  tabs: RepoTab[];
  activeTabPath: string | null;

  /**
   * Active tab mirror — kept in sync with the tab at `activeTabPath` so
   * existing selectors (`s.meta`, `s.status`, `s.commits`, `s.activePath`)
   * keep working without per-tab lookups in every component.
   */
  activePath: string | null;
  meta: RepoMeta | null;
  status: FileStatus[];
  commits: Commit[];
  /**
   * Results of the last full-history commit search ({@link RepoState.searchLog}).
   * Held in the store (not just the All Commits view) so {@link CommitDetail}
   * can render a commit the search surfaced that isn't in the loaded `commits`
   * window. Reset per tab.
   */
  commitSearchResults: Commit[];

  unstagedDiffs: FileDiff[];
  stagedDiffs: FileDiff[];
  localSelection: LocalSelection | null;
  /** Pierre multi-select per side, with selected folders expanded to their files. */
  localTreeSelection: { unstaged: string[]; staged: string[] };
  setLocalTreeSelection(staged: boolean, paths: string[]): void;

  /**
   * Review-session baseline for the active repo: "show me everything since
   * this commit". Pinned by the user (or restored from SQLite); drives the
   * Review view's session mode and {@link RepoState.baselineDiffs}. Without
   * a baseline the Review view falls back to the unstaged set (inbox mode).
   */
  baseline: StoredBaseline | null;
  /**
   * `diff_since_full(baseline)` result — committed + staged + unstaged
   * changes, with whole-file context so the Review view shows each change
   * inside the entire file.
   */
  baselineDiffs: FileDiff[];
  /**
   * Inbox-mode counterpart: the unstaged set with whole-file context
   * (`diff_unstaged_full`). Only refreshed while the Review view is open (or
   * on entry), so the regular `unstagedDiffs` hot path doesn't pay for it.
   */
  reviewUnstagedDiffs: FileDiff[];

  /**
   * File selected in the Review view's list, or `null` for "nothing yet" —
   * the view auto-selects the first pending file. Separate from
   * `localSelection` so flipping between Review and Local Changes doesn't
   * fight over one selection.
   */
  reviewSelection: string | null;
  selectReviewFile(path: string | null): void;

  /**
   * Reviewed-file map for the active repo: `path → hash of the reviewed
   * diff`. A file counts as reviewed only while its *current* diff hashes to
   * the recorded value, so an agent touching a reviewed file flips it back.
   * Persisted per-repo (see `reviewSession` in lib/db).
   */
  reviewed: Record<string, string>;

  /**
   * Reviewer notes for the active repo: `path → notes` in the order they were
   * added. Feed for the "copy feedback as prompt" export. Persisted per-repo
   * (see `reviewSession` in lib/db).
   */
  reviewNotes: Record<string, ReviewNote[]>;

  /**
   * Undo handle for the most recent *multi-file* discard: the safety
   * snapshot taken just before. Applying the stash restores everything the
   * bulk discard removed. Like `lastDiscard`, pinned to its repo path.
   */
  lastBulkDiscard: { oid: string; count: number; path: string } | null;

  /**
   * Single-undo handle for the most recent discard. Discarding a change
   * block reverse-applies a sliced patch to the working tree; this keeps
   * that exact slice around so {@link RepoState.undoDiscard} can
   * forward-apply it back. `path` pins it to the repo it came from — the
   * undo always applies there, never to whichever tab happens to be active
   * (Workspace Review discards can target a background member repo).
   * Cleared once the undo toast times out (see `clearUndo`) or after an
   * undo.
   */
  lastDiscard: { patch: string; label: string; path: string } | null;

  /**
   * Commit clicked in the All Commits graph. When non-null, the right-side
   * `<CommitDetail />` panel opens and `selectedCommitDiffs` is populated
   * from `repo_diff_commit`.
   */
  selectedCommit: string | null;
  selectedCommitDiffs: FileDiff[];
  selectedCommitDiffsLoading: boolean;

  /**
   * A commit the All Commits graph should scroll to and highlight, set by a
   * single-click on a sidebar branch/remote/tag row. Transient: the graph
   * consumes it (focuses the row) and calls {@link RepoState.clearReveal}.
   */
  revealCommit: string | null;

  /** Branches / remotes / tags for the active tab. */
  refs: Refs;

  /**
   * Short names of tags present on the default remote — `null` until the Tags
   * section is opened and {@link RepoState.refreshRemoteTags} runs (a network
   * `ls-remote`). Used to gray out "delete on remote" for tags the remote
   * doesn't have. `null` ⇒ unknown ⇒ don't gray (fail open).
   */
  remoteTags: string[] | null;

  /** Stash stack for the active tab, most-recent first. */
  stashes: Stash[];

  /** Base tracked/untracked working-tree listing. Loaded lazily for the
   * palette and kept fresh by every {@link RepoState.refreshSnapshot}; the
   * Files tab separately requests its ignored-inclusive listing on entry. */
  workTree: WorkTreeEntry[];
  /** Advances only after a successful path/ignore mutation so the Files tab
   * can refresh its ignored-inclusive cache without re-walking ignored
   * directories after ordinary status-only updates. */
  filesTreeRevision: number;
  filesTreeMutation: FilesTreeMutation | null;
  markFilesTreeChanged(repoPath: string, change: FilesTreeMutationChange): void;

  /** Submodules of the active repo (list + status), for the sidebar section. */
  submodules: Submodule[];

  /** Worktrees of the active repo (main + linked), for the sidebar section and
   * the Worktrees overview. */
  worktrees: Worktree[];

  /** HEAD reflog for the active tab, newest first. Lazy: only the Reflog view
   * triggers {@link RepoState.refreshReflog}. */
  reflog: ReflogEntry[];

  recents: RecentRepo[];

  view: View;
  /** Active tab in the file view; persists across a commit jump so Back can
   *  return you to the same tab. */
  fileTab: FileTab;
  /** When set, the file path to return to after a blame/history → commit jump
   *  (drives the "Back to file" bar in the commits view). Cleared by any normal
   *  navigation (selecting a file, opening a repo, switching tabs). */
  fileReturn: string | null;
  /** Exact Work document that initiated a History/Blame jump. Tab identity is
   * stable across path moves, unlike a path-only return target. */
  workFileReturn: { repoPath: string; tabId: string; path: string } | null;
  setWorkFileReturn(target: { repoPath: string; tabId: string; path: string } | null): void;
  selectedFile: string | null;
  /** The selected Files-tree path is a synthesized folder row, not a file. */
  selectedFileIsDirectory: boolean;
  /** Revision the selected file was opened from in the Files tree; `null`
   * means the mutable working-tree copy. */
  selectedFileRevision: string | null;
  selectedRef: string | null;

  /** Re-open the tabs the user had open last time (called once at app start). */
  restoreSession(): Promise<void>;

  openRepo(path: string): Promise<void>;
  /**
   * Open a repository as a tab *without* focusing it: no active-tab reset, no
   * refreshes, no recents touch — just the `repo_open` round-trip, the tab
   * entry, and the file watcher. Data loads when the tab is activated
   * (`setActiveTab` refreshes everything). Dedupes against open tabs; resolves
   * to the canonical path. Used by session restore and workspace switching,
   * where N full focused opens would flicker and crawl.
   */
  openRepoBackground(path: string): Promise<string>;
  closeTab(path: string): void;
  setActiveTab(path: string): Promise<void>;
  /** Clear the active tab without closing anything — the empty state shown when
   *  the active workspace has no visible repos (tabs stay open, just hidden). */
  deactivateTab(): void;
  refreshStatus(): Promise<void>;
  refreshLog(limit?: number): Promise<void>;
  refreshDiffs(): Promise<void>;
  refreshRefs(): Promise<void>;
  /** Re-read the working-tree file listing (Files tab). */
  refreshTree(): Promise<void>;
  /** Re-read the submodule list + status for the active tab. */
  refreshSubmodules(): Promise<void>;
  /** Re-read the HEAD reflog for the active tab (Reflog view). */
  refreshReflog(): Promise<void>;
  /**
   * Run `git submodule update` for `paths` (empty ⇒ all), optionally
   * initializing (`--init`) and recursing. Streams progress; refreshes the
   * submodule list + working tree afterward. Returns git's output.
   */
  submoduleUpdate(
    paths: string[],
    init: boolean,
    recursive: boolean,
    onProgress?: (p: Progress) => void,
  ): Promise<string>;
  /** Re-read the worktree registry for the active tab. */
  refreshWorktrees(): Promise<void>;
  /**
   * Create a worktree at `dest`. `newBranch` ⇒ create + check out a new branch
   * `branch` at `startPoint` (HEAD when omitted; `track` sets its upstream to
   * a remote start point); otherwise check out the existing `branch`.
   * Refreshes the worktree list and refs (a new branch may appear).
   */
  addWorktree(
    dest: string,
    branch: string,
    newBranch: boolean,
    startPoint?: string | null,
    track?: boolean,
  ): Promise<void>;
  /** Remove the worktree at `dest` (force past local changes when `force`). */
  removeWorktree(dest: string, force: boolean): Promise<void>;
  /** Prune registry entries whose directories are gone. */
  pruneWorktrees(): Promise<void>;
  /** Open a worktree's directory as its own repo tab (a worktree path is a
   * valid repo path — this is just {@link RepoState.openRepo}). */
  openWorktree(path: string): Promise<void>;
  /**
   * Open a worktree for review: detect the branch it forked from, open its
   * tab, pin the review baseline at the fork point, and land on Review
   * (Local Changes when no baseline is derivable — the main worktree, or
   * detection failure). Returns the detected base name and any detection
   * error; the caller owns the toast copy.
   */
  reviewWorktree(w: Worktree): Promise<{ base: string | null; detectError: string | null }>;

  /** Refresh status + diffs together — what every write op runs afterward. */
  refreshLocalChanges(): Promise<void>;

  /**
   * One-call refresh of meta + status + work tree + refs + submodules from
   * `repo_snapshot` — one repo open, one statuses walk, one IPC round-trip.
   * The post-change and watcher-driven refresh paths use this instead of
   * five separate commands.
   */
  refreshSnapshot(): Promise<void>;

  /**
   * Entry point for the file watcher's `repo://changed` event: refresh
   * everything the on-disk change could have moved (snapshot, diffs, log,
   * baseline diff). Ignores events for repos that aren't the active tab.
   */
  handleExternalChange(path: string): Promise<void>;

  /** Pin the review baseline at `oid` (default: the current HEAD). */
  setBaseline(oid?: string): Promise<void>;
  /** Clear the review baseline (and its persisted record). */
  clearBaseline(): Promise<void>;
  /**
   * Refresh the Review view's diff pool (whole-file context): with a baseline
   * → `diff_since_full` into {@link RepoState.baselineDiffs}; without →
   * `diff_unstaged_full` into {@link RepoState.reviewUnstagedDiffs}.
   */
  refreshReviewDiffs(): Promise<void>;
  /** Load the persisted baseline + reviewed map when a repo becomes active. */
  loadReviewSession(): Promise<void>;
  /**
   * Toggle a file's reviewed mark. `hash` is the current diff's
   * {@link hashPatch} value — recorded on mark, compared on render.
   */
  toggleReviewed(file: string, hash: string): void;
  /** Attach a note to `file` (`line` = anchor line, null = whole file;
   * `side` = which diff side the line counts on, default `'new'` — a
   * deletion-only block anchors old-side). Empty text is ignored. */
  addReviewNote(file: string, text: string, line: number | null, side?: 'new' | 'old'): void;
  /** Remove one note from `file` by id. */
  removeReviewNote(file: string, id: string): void;
  /** Drop every note for the active repo (after a feedback export, usually). */
  clearReviewNotes(): void;
  /** Stage every unstaged file whose reviewed mark matches its current diff. */
  stageReviewed(): Promise<void>;
  /** Re-apply the safety snapshot from the last bulk discard. */
  undoBulkDiscard(): Promise<void>;
  /** Drop the bulk-discard undo handle (toast timeout). */
  clearBulkUndo(): void;

  stage(file: string): Promise<void>;
  unstage(file: string): Promise<void>;
  discard(file: string): Promise<void>;
  /** Stage / unstage / discard a specific set of files with a single refresh. */
  stageMany(files: string[]): Promise<void>;
  unstageMany(files: string[]): Promise<void>;
  discardMany(files: string[]): Promise<void>;
  /** Append `pattern` to the workdir root `.gitignore` — the "Add to
   * .gitignore" quick action on untracked files. */
  gitignoreAdd(pattern: string): Promise<void>;
  /**
   * Rename / move working-tree entries (files or folders) — drag-and-drop
   * and "Rename / move…" in the Files tree. Each move's `to` is the full new
   * path. Runs sequentially with a single refresh at the end, and returns
   * per-entry failure messages instead of throwing so one collision doesn't
   * hide the moves that succeeded.
   */
  moveEntries(moves: Array<{ from: string; to: string }>): Promise<string[]>;
  /**
   * Apply a unified-diff patch (typically a single hunk sliced out of a
   * file's full patch) to either the index or the working tree in reverse.
   * Powers per-hunk Accept / Reject in the unstaged diff.
   */
  applyPatch(
    patch: string,
    target: 'index' | 'index_reverse' | 'workdir_reverse' | 'workdir',
  ): Promise<void>;
  /**
   * Discard a single sliced patch from the working tree and record it as
   * the {@link RepoState.lastDiscard} undo handle. `slice` must be the
   * forward-oriented patch (same one fed to `applyPatch(_, 'workdir_reverse')`).
   */
  discardPatch(slice: string, label: string): Promise<void>;
  /** Re-apply the last discarded slice to the working tree of the repo the
   * handle is pinned to (not necessarily the active tab), then clear it. */
  undoDiscard(): Promise<void>;
  /** Drop the undo handle without re-applying (called when the toast times out). */
  clearUndo(): void;
  /**
   * Set the diff layout for the active repo: applies it live (via
   * `useSettings.diffMode`) and persists it per-repo so the choice is restored
   * the next time this repo is the active tab.
   */
  setDiffMode(mode: DiffMode): void;
  /**
   * Apply the active repo's saved diff layout to `useSettings.diffMode`, if it
   * has one. A repo with no saved choice keeps the current (last-used) layout.
   * Called when a repo becomes the active tab.
   */
  loadRepoDiffMode(): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  commit(subject: string, body: string | null, amend: boolean): Promise<void>;

  /** Re-read RepoMeta (branch, ahead/behind) for the active tab. */
  refreshMeta(): Promise<void>;
  /** Default strategy used by the primary Pull action for this repository. */
  pullMode: PullMode;
  setPullMode(mode: PullMode): void;
  loadRepoPullMode(): Promise<void>;
  /** Whether normal Fetch prunes stale remote-tracking refs. */
  fetchPrune: boolean;
  /** Whether normal Pull safely stashes and restores local changes. */
  pullAutostash: boolean;
  setFetchPrune(prune: boolean): void;
  setPullAutostash(autostash: boolean): void;
  loadRepoNetworkPreferences(): Promise<void>;
  /** `opId` (when given) registers the op as cancellable via `repoCancelOp`. */
  fetch(prune?: boolean, onProgress?: (p: Progress) => void, opId?: string): Promise<string>;
  pull(mode?: PullMode, autostash?: boolean, onProgress?: (p: Progress) => void, opId?: string): Promise<string>;
  push(mode?: PushMode, onProgress?: (p: Progress) => void, opId?: string): Promise<string>;
  fetchBranch(remote: string, branch: string, onProgress?: (p: Progress) => void, opId?: string): Promise<string>;
  pullBranch(remote: string, branch: string, mode?: PullMode, autostash?: boolean, onProgress?: (p: Progress) => void, opId?: string): Promise<string>;
  pushBranch(request: BranchPushRequest, onProgress?: (p: Progress) => void, opId?: string): Promise<string>;

  checkout(branch: string): Promise<void>;
  /** Check out an arbitrary commit as a detached HEAD. */
  checkoutCommit(rev: string): Promise<void>;
  createBranch(name: string, startPoint: string | null, checkout: boolean): Promise<void>;
  deleteBranch(name: string, force: boolean): Promise<void>;
  /**
   * Delete a branch on its remote (`git push <remote> --delete`). The push also
   * drops the local remote-tracking ref, so refs refresh afterward. Returns
   * git's output.
   */
  deleteRemoteBranch(remote: string, branch: string, onProgress?: (p: Progress) => void): Promise<string>;
  /** Rename a local branch; its upstream config moves along, HEAD follows. */
  renameBranch(oldName: string, newName: string): Promise<void>;
  /** Set/change (`origin/main`) or unset (`null`) a local branch upstream. */
  setBranchUpstream(branch: string, upstream: string | null): Promise<void>;

  /** Add a remote (`git remote add`). */
  addRemote(name: string, url: string, pushUrl: string | null): Promise<void>;
  /** Remove a remote and its remote-tracking refs. */
  removeRemote(name: string): Promise<void>;
  /**
   * Rename a remote (config section + remote-tracking refs move along).
   * Resolves to the refspecs git could not rewrite ("problems") — the rename
   * has already happened by then; empty means a clean rename.
   */
  renameRemote(oldName: string, newName: string): Promise<string[]>;
  /** Change a remote's fetch URL and optional push-only URL. */
  setRemoteUrls(name: string, url: string, pushUrl: string | null): Promise<void>;
  /** Set Git's repository-local `remote.pushDefault`. */
  setDefaultRemote(name: string): Promise<void>;
  /**
   * Fetch a specific remote by name (the sidebar remote-row action — how a
   * just-added remote gets its first refs). The topbar Fetch with its progress
   * pill stays App-owned; this is the lightweight no-progress path.
   */
  fetchRemote(name: string, prune?: boolean): Promise<void>;
  /**
   * Reset HEAD (the current branch, or HEAD itself when detached) to `target`.
   * A hard reset of a dirty tree stashes a safety snapshot first — returned in
   * the outcome's `snapshot_oid` so callers can toast about it.
   */
  reset(target: string, mode: ResetMode): Promise<ResetOutcome>;

  /**
   * History ops — all shell out to `git`. Each resolves to `true` when Git
   * remains paused (a conflict or interactive-rebase `edit`) and the view
   * switches to Local Changes; `false` means completion. The promise rejects
   * only on a real failure (dirty tree, bad ref). `meta.operation` reports the
   * in-progress state.
   */
  cherryPick(commits: string[], mainline?: number): Promise<boolean>;
  revert(commits: string[], mainline?: number): Promise<boolean>;
  merge(refname: string, mode: MergeMode): Promise<boolean>;
  rebase(onto: string): Promise<boolean>;
  /**
   * Load the editable commit range (oldest→newest) an interactive rebase over
   * `base..HEAD` would offer. `base` null = from the root. Read-only — does not
   * touch the repo.
   */
  loadRebaseTodo(base: string | null): Promise<RebaseEntry[]>;
  /**
   * Run an interactive rebase from a `steps` plan the editor built. When
   * `preserveMerges` is true, the plan keeps Git's generated merge topology.
   */
  interactiveRebase(
    base: string | null,
    steps: RebaseStep[],
    preserveMerges: boolean,
  ): Promise<boolean>;
  /** Abort the merge/rebase/cherry-pick/revert currently in progress. */
  abortOperation(): Promise<void>;
  /**
   * Resume a paused merge/rebase/cherry-pick/revert. `true` means Git paused
   * again on another conflict or `edit` step.
   */
  continueOperation(): Promise<boolean>;
  /**
   * Write a conflicted file's resolved contents back and stage it (marks it
   * resolved). The op stays in progress until the user commits — refresh
   * status/diffs so the file leaves the Conflicts list.
   */
  resolveConflict(file: string, contents: string): Promise<void>;

  /**
   * Create a tag at `target` (any revspec; null ⇒ HEAD). A non-empty
   * `message` makes it an annotated tag, otherwise lightweight.
   */
  createTag(name: string, target: string | null, message: string | null): Promise<void>;
  /** Delete a tag by short name. */
  deleteTag(name: string): Promise<void>;
  /**
   * Push a tag to the default remote (HEAD's upstream remote, else `origin`,
   * else the only/first remote). Throws if no remote is configured. Returns
   * git's output.
   */
  pushTag(tag: string, onProgress?: (p: Progress) => void): Promise<string>;
  /** Delete a tag on the default remote. Returns git's output. */
  deleteRemoteTag(tag: string, onProgress?: (p: Progress) => void): Promise<string>;
  /** Push every local tag to the default remote. Returns git's output. */
  pushAllTags(onProgress?: (p: Progress) => void): Promise<string>;
  /** Load (via `git ls-remote --tags`) which tags the default remote has. */
  refreshRemoteTags(): Promise<void>;

  /** Re-read the stash stack for the active tab. */
  refreshStashes(): Promise<void>;
  /**
   * Stash the working-tree + index changes. Returns the outcome so callers
   * can distinguish a real stash from a clean-tree no-op (`oid === null`).
   */
  stashSave(
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
  ): Promise<StashOutcome>;
  /**
   * Save a snapshot: record the changes onto the stash stack but keep them in
   * the working directory. Returns the outcome (`oid === null` ⇒ clean tree).
   */
  stashSnapshot(message: string | null, includeUntracked: boolean): Promise<StashOutcome>;
  /**
   * Stash only the given paths. When `snapshot` is true the working tree is
   * left unchanged after recording the stash entry.
   */
  stashPushPaths(
    paths: string[],
    message: string | null,
    includeUntracked: boolean,
    keepIndex: boolean,
    snapshot: boolean,
  ): Promise<StashOutcome>;
  /** Apply a stash by index, leaving it on the stack. */
  stashApply(index: number): Promise<void>;
  /** Apply a stash by index and drop it on success. */
  stashPop(index: number): Promise<void>;
  /** Create and check out a branch from a stash, dropping it on clean apply. */
  stashBranch(index: number, branch: string): Promise<void>;
  /** Drop a stash by index without applying it. Destructive. */
  stashDrop(index: number): Promise<void>;

  selectLocalFile(sel: LocalSelection | null): void;
  /** Open the commit-detail panel for `hash`, or close it when null. */
  selectCommit(hash: string | null): Promise<void>;

  /**
   * Run a full-history commit search (message / author / diff content) and
   * stash the matches in {@link RepoState.commitSearchResults}. Returns the
   * matches so the caller can drive its own UI (count, dropdown). A blank query
   * clears the results and returns `[]`.
   */
  searchLog(query: string, mode: CommitSearchMode): Promise<Commit[]>;

  /** Switch to the All Commits graph and reveal (scroll to + highlight)
   * `hash` — the tip of a sidebar branch/remote/tag row. */
  revealInGraph(hash: string): void;
  /** Clear the pending {@link RepoState.revealCommit} once the graph has
   * consumed it. */
  clearReveal(): void;

  /**
   * One-shot signal: the command palette's "Search commits…" action asks the
   * All Commits view to focus its search field. Consumed + cleared by the
   * graph once it mounts (mirrors {@link RepoState.revealCommit}).
   */
  commitSearchFocus: boolean;
  /**
   * Field the search field should switch to when the focus signal is consumed —
   * lets "Search file contents…" jump straight into Content mode. `null` leaves
   * the current field. Cleared alongside {@link RepoState.commitSearchFocus}.
   */
  commitSearchMode: CommitSearchMode | null;
  requestCommitSearch(mode?: CommitSearchMode): void;
  clearCommitSearchFocus(): void;

  /**
   * One-shot signal: the palette's "Search in diff…" action asks the mounted
   * diff view (Local Changes or Review) to open its ⌘F in-diff search bar.
   * Consumed + cleared by the view (mirrors {@link RepoState.commitSearchFocus});
   * the palette action switches the view itself when neither is showing.
   */
  diffSearchSignal: boolean;
  /** One-shot: CommitBar should run AI suggest (command palette / shortcut). */
  suggestCommitSignal: boolean;
  requestSuggestCommitMessage(): void;
  clearSuggestCommitMessage(): void;
  /** One-shot: open the stash dialog (e.g. from Local Changes context menu). */
  stashDialogRequest: { snapshot: boolean; keepIndex: boolean } | null;
  requestStashDialog(opts?: { snapshot?: boolean; keepIndex?: boolean }): void;
  clearStashDialogRequest(): void;
  requestDiffSearch(): void;
  clearDiffSearch(): void;

  /**
   * The "Add ignore pattern…" dialog's draft pattern, or `null` when closed.
   * Opened from the Local Changes / Files-tab context menus (prefilled with
   * the picked file's path); App renders the single shared dialog.
   */
  ignoreDraft: string | null;
  openIgnoreDialog(initial: string): void;
  closeIgnoreDialog(): void;

  /**
   * Bumped on every diff refresh (local + review). Consumers showing
   * *worktree/index-derived* content outside the diff arrays (the image
   * preview's blob fetches) re-validate on it — the FileDiff for a binary
   * file is otherwise indistinguishable across content changes.
   */
  diffsTick: number;

  /**
   * One-shot signal: select every commit since the review baseline in the
   * All Commits graph (an agent session's commits, pairing with
   * {@link RepoState.baselineDiffs}). Consumed + cleared by the graph once
   * the log is loaded (mirrors {@link RepoState.commitSearchFocus}).
   */
  selectSinceBaseline: boolean;
  requestSelectSinceBaseline(): void;
  clearSelectSinceBaseline(): void;

  refreshRecents(): Promise<void>;
  forgetRecent(path: string): Promise<void>;

  setView(view: View): void;
  selectFile(path: string | null, revision?: string | null, isDirectory?: boolean): void;
  selectRef(ref: string | null): void;
  /** Set the active file-view tab. */
  setFileTab(tab: FileTab): void;
  /** Jump from the file view to `hash` in the graph, remembering the current
   *  file so {@link RepoState.returnToFile} can come back to it (same tab). */
  jumpFromFile(hash: string): void;
  /** Return to the file recorded by {@link RepoState.jumpFromFile}. No-op when
   *  there's nothing to return to. */
  returnToFile(): void;
}

const EMPTY_REFS: Refs = {
  branches: [],
  primary_branch: null,
  remotes: [],
  remote_branches: [],
  tags: [],
};

/**
 * Whether two filesystem paths point at the same directory, tolerating
 * separator (`\` vs `/`), trailing-slash, and Windows verbatim-prefix
 * differences (see {@link pathKey}). Git-sourced paths (worktree porcelain,
 * common dirs) and gix workdirs spell the same directory differently on
 * Windows — every tab-identity comparison must go through this, or the same
 * repo opens twice.
 */
function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * The remote tag pushes target by default: `remote.pushDefault`, the current
 * branch's upstream remote, `origin`, or the first configured remote. Tags
 * have no per-tag upstream of their own, so this mirrors the repository's
 * normal push destination.
 */
export function defaultRemote(refs: Refs): string | null {
  const configured = refs.remotes.find((remote) => remote.is_default);
  if (configured) return configured.name;
  const head = refs.branches.find((b) => b.is_head);
  if (head?.upstream?.remote) return head.upstream.remote;
  if (refs.remotes.some((r) => r.name === 'origin')) return 'origin';
  return refs.remotes[0]?.name ?? null;
}

/**
 * Repo paths whose remote tags we've already revalidated over the network this
 * session. After the first `ls-remote`, later opens of the same repo paint
 * from the persisted cache instead of hitting the network again — our own
 * pushes/deletes keep the cache fresh, and a relaunch revalidates anew.
 */
const revalidatedRemoteTags = new Set<string>();

/**
 * Apply `fn` to the known remote-tag set for `path` after a push/delete:
 * update the in-memory slice when that repo is active (instant UI), and
 * read-modify-write the persisted cache regardless of the active tab so the
 * gray-out stays correct on the next open. `fn` must be idempotent — it's
 * applied independently to memory and cache. No-op where the set is absent
 * (unloaded memory / cache miss); the next open revalidates.
 */
function setRemoteTags(
  get: () => RepoState,
  set: (partial: Partial<RepoState>) => void,
  path: string,
  fn: (cur: string[]) => string[],
): void {
  if (get().activePath === path) {
    const cur = get().remoteTags;
    if (cur) set({ remoteTags: fn(cur) });
  }
  void (async () => {
    try {
      const cached = await remoteTagsCache.get(path);
      if (cached) await remoteTagsCache.set(path, fn(cached));
    } catch (e) {
      console.warn('remoteTagsCache update failed', e);
    }
  })();
}

/** Review-note id: a UUID when the webview provides one, else a
 * timestamp-plus-counter string (still unique within a session). */
let noteSeq = 0;
function noteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${++noteSeq}`;
}

/**
 * Build a {@link ReviewNote} from editor input, or `null` when the trimmed
 * text is empty. Shared with the workspace review store so notes taken in
 * either lens are shaped identically (same id scheme, same side omission).
 */
export function makeReviewNote(
  text: string,
  line: number | null,
  side?: 'new' | 'old',
): ReviewNote | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    id: noteId(),
    text: trimmed,
    line,
    ...(side === 'old' ? { side } : {}),
    createdAt: Date.now(),
  };
}

const EMPTY_ACTIVE = {
  activePath: null as string | null,
  meta: null as RepoMeta | null,
  pullMode: 'default' as PullMode,
  fetchPrune: true,
  pullAutostash: false,
  status: [] as FileStatus[],
  commits: [] as Commit[],
  commitSearchResults: [] as Commit[],
  unstagedDiffs: [] as FileDiff[],
  stagedDiffs: [] as FileDiff[],
  localSelection: null as LocalSelection | null,
  localTreeSelection: { unstaged: [] as string[], staged: [] as string[] },
  baseline: null as StoredBaseline | null,
  baselineDiffs: [] as FileDiff[],
  reviewUnstagedDiffs: [] as FileDiff[],
  reviewSelection: null as string | null,
  reviewed: {} as Record<string, string>,
  reviewNotes: {} as Record<string, ReviewNote[]>,
  lastBulkDiscard: null as { oid: string; count: number; path: string } | null,
  lastDiscard: null as { patch: string; label: string; path: string } | null,
  selectedFile: null as string | null,
  selectedFileIsDirectory: false,
  selectedFileRevision: null as string | null,
  fileReturn: null as string | null,
  workFileReturn: null as { repoPath: string; tabId: string; path: string } | null,
  selectedCommit: null as string | null,
  selectedCommitDiffs: [] as FileDiff[],
  selectedCommitDiffsLoading: false,
  revealCommit: null as string | null,
  refs: EMPTY_REFS,
  remoteTags: null as string[] | null,
  stashes: [] as Stash[],
  workTree: [] as WorkTreeEntry[],
  filesTreeRevision: 0,
  filesTreeMutation: null as FilesTreeMutation | null,
  submodules: [] as Submodule[],
  worktrees: [] as Worktree[],
  reflog: [] as ReflogEntry[],
};

/**
 * The refresh every history op (cherry-pick / revert / merge / rebase /
 * abort) runs once git returns: meta (branch + `operation` banner state),
 * local changes (staged squash result or conflict markers), the log (new or
 * rewritten commits), and refs (tips moved). Both the success tail and a
 * post-abort cleanup share it.
 */
async function refreshAfterHistoryOp(get: () => RepoState): Promise<void> {
  // refreshLocalChanges is snapshot-based, so meta (the `operation` banner)
  // and refs (moved tips) ride along with status + diffs.
  await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
}

/**
 * Run a history op (`op` returns the `conflicted` flag) with the shared tail:
 * always refresh afterward (even on a thrown failure), and on a conflict route
 * to Local Changes with a cleared selection so the conflict bar opens the first
 * conflicted file. Returns the `conflicted` flag for the caller's toast.
 */
async function runHistoryOp(
  get: () => RepoState,
  set: (partial: Partial<RepoState>) => void,
  op: () => Promise<boolean>,
): Promise<boolean> {
  let conflicted = false;
  try {
    conflicted = await op();
    return conflicted;
  } finally {
    await refreshAfterHistoryOp(get);
    if (conflicted) set({ view: 'local', localSelection: null });
  }
}

async function persistSession(state: RepoState): Promise<void> {
  try {
    const payload: PersistedSession = {
      tabs: state.tabs.map((t) => t.path),
      activeTabPath: state.activeTabPath,
    };
    await settingsDb.set(SESSION_KEY, payload);
  } catch (e) {
    console.warn('session persist failed', e);
  }
}

export const useRepo = create<RepoState>((set, get) => ({
  tabs: [],
  activeTabPath: null,

  ...EMPTY_ACTIVE,
  recents: [],

  view: useSettings.getState().startupSpace,
  fileTab: 'content',
  selectedRef: null,
  commitSearchFocus: false,
  commitSearchMode: null,
  diffSearchSignal: false,
  suggestCommitSignal: false,
  stashDialogRequest: null as { snapshot: boolean; keepIndex: boolean } | null,
  selectSinceBaseline: false,
  diffsTick: 0,
  ignoreDraft: null,

  markFilesTreeChanged: (repoPath, change) => set((state) => {
    const revision = state.filesTreeRevision + 1;
    return {
      filesTreeRevision: revision,
      filesTreeMutation: { ...change, repoPath, revision } as FilesTreeMutation,
    };
  }),

  async restoreSession() {
    let saved: PersistedSession | null = null;
    try {
      saved = await settingsDb.get<PersistedSession>(SESSION_KEY);
    } catch (e) {
      console.warn('session load failed', e);
    }
    if (!saved || saved.tabs.length === 0) return;

    // Open each saved tab in the background (sequentially, to keep the saved
    // order), tolerating failures — a repo may have moved or been deleted
    // since last launch. Only the tab that ends up active pays for a full
    // refresh, instead of every tab doing one as it opens.
    for (const path of saved.tabs) {
      try {
        await get().openRepoBackground(path);
      } catch (e) {
        console.warn(`restoreSession: failed to open ${path}`, e);
      }
    }
    const tabs = get().tabs;
    if (tabs.length === 0) return;
    const savedActive = saved.activeTabPath
      ? tabs.find((t) => samePath(t.path, saved!.activeTabPath!))?.path
      : undefined;
    await get().setActiveTab(savedActive ?? tabs[tabs.length - 1].path);
  },

  async openRepo(path) {
    // If this directory is already open — under any spelling — just focus it.
    const existing = get().tabs.find((t) => samePath(t.path, path));
    if (existing) {
      await get().setActiveTab(existing.path);
      return;
    }

    const meta = await tauri.repoOpen(path);

    // Re-check against the resolved workdir: discovery may land on a
    // different directory than the input (a subfolder pick), and its spelling
    // follows the input, not the existing tab's.
    const already = get().tabs.find((t) => samePath(t.path, meta.path));
    if (already) {
      await get().setActiveTab(already.path);
      return;
    }

    const tab: RepoTab = { path: meta.path, meta };
    set((s) => ({
      ...EMPTY_ACTIVE,
      tabs: [...s.tabs, tab],
      activeTabPath: meta.path,
      activePath: meta.path,
      meta,
    }));

    try {
      await recentsDb.touch(meta.path, repoFamilyName(meta));
      await get().refreshRecents();
    } catch (e) {
      console.warn('recents.touch failed', e);
    }
    void persistSession(get());
    void get().loadRepoDiffMode();
    void get().loadRepoPullMode();
    void get().loadRepoNetworkPreferences();
    // Start the working-tree watcher so agent/CLI writes refresh the view
    // without waiting for window focus. Best-effort — a watcher failure
    // (e.g. exotic filesystem) degrades to focus-refresh, not an error.
    tauri.repoWatch(meta.path).catch((e) => console.warn('repoWatch failed', e));
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshStashes(),
      // refreshLocalChanges is snapshot-based (covers meta/refs/submodules);
      // worktrees aren't in the snapshot, so refresh them explicitly.
      get().refreshWorktrees(),
      get().loadReviewSession(),
    ]);
  },

  async openRepoBackground(path) {
    const existing = get().tabs.find((t) => samePath(t.path, path));
    if (existing) return existing.path;

    const meta = await tauri.repoOpen(path);

    // Re-check against the resolved workdir (see openRepo).
    const already = get().tabs.find((t) => samePath(t.path, meta.path));
    if (already) return already.path;

    set((s) => ({ tabs: [...s.tabs, { path: meta.path, meta }] }));
    void persistSession(get());
    // Watch even unfocused tabs so external changes are picked up the moment
    // the tab is activated (same best-effort contract as openRepo).
    tauri.repoWatch(meta.path).catch((e) => console.warn('repoWatch failed', e));
    return meta.path;
  },

  closeTab(path) {
    const { tabs, activeTabPath } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const nextTabs = tabs.filter((t) => t.path !== path);

    // Stop the closed tab's watcher (best-effort).
    tauri.repoUnwatch(path).catch((e) => console.warn('repoUnwatch failed', e));

    if (activeTabPath !== path) {
      set({ tabs: nextTabs });
      void persistSession(get());
      return;
    }

    // Closed the active tab — pick a neighbor, or fall back to empty state.
    const neighbor = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
    set({
      ...EMPTY_ACTIVE,
      tabs: nextTabs,
      activeTabPath: neighbor?.path ?? null,
      activePath: neighbor?.path ?? null,
      meta: neighbor?.meta ?? null,
    });
    void persistSession(get());
    if (neighbor) {
      void get().loadRepoPullMode();
      void get().loadRepoNetworkPreferences();
      void Promise.all([
        get().refreshLocalChanges(),
        get().refreshLog(),
        get().loadReviewSession(),
      ]);
    }
  },

  async setActiveTab(path) {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || get().activeTabPath === path) return;
    set({
      ...EMPTY_ACTIVE,
      activeTabPath: path,
      activePath: path,
      meta: tab.meta,
    });
    void persistSession(get());
    void get().loadRepoDiffMode();
    void get().loadRepoPullMode();
    void get().loadRepoNetworkPreferences();
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshStashes(),
      get().refreshWorktrees(),
      get().loadReviewSession(),
    ]);
  },

  deactivateTab() {
    if (get().activeTabPath == null) return;
    set({ ...EMPTY_ACTIVE, activeTabPath: null });
    void persistSession(get());
  },

  async refreshStatus() {
    const path = get().activePath;
    if (!path) return;
    const status = await tauri.repoStatus(path);
    // Bail if the active repo changed while the request was in flight, or we'd
    // paint another tab's status into this one (see refreshTree).
    if (get().activePath !== path) return;
    set({ status: stable(get().status, status) });
  },
  async refreshLog(limit) {
    const path = get().activePath;
    if (!path) return;
    const commits = await timed('log', () => tauri.repoLog(path, limit ?? 500));
    if (get().activePath !== path) return;
    set({ commits });
  },
  async refreshDiffs() {
    const path = get().activePath;
    if (!path) return;
    const [unstaged, staged] = await timed('diffs', () =>
      Promise.all([tauri.repoDiffUnstaged(path), tauri.repoDiffStaged(path)]),
    );
    if (get().activePath !== path) return;
    set({ unstagedDiffs: unstaged, stagedDiffs: staged, diffsTick: get().diffsTick + 1 });

    // If the selected file is no longer present (it was just staged in full,
    // for example) move the selection to a sibling so the middle pane keeps
    // showing something useful.
    const sel = get().localSelection;
    if (sel?.all) {
      // A "show all" selection stays valid as long as its side has files;
      // if the side emptied, drop it so the view re-defaults (see LocalChanges).
      if ((sel.staged ? staged : unstaged).length === 0) set({ localSelection: null });
    } else if (sel) {
      const stillThere = (sel.staged ? staged : unstaged).some((f) => f.path === sel.file);
      if (!stillThere) {
        const alt = (sel.staged ? unstaged : staged).find((f) => f.path === sel.file);
        set({ localSelection: alt ? { file: alt.path, staged: !sel.staged } : null });
      }
    }
  },

  // Snapshot-based: one statuses walk covers status + work tree + meta +
  // refs + submodules, so every write op's refresh also keeps the topbar
  // (ahead/behind), sidebar, and Files tab in sync for free.
  async refreshLocalChanges() {
    // The review pool follows along live while a session baseline is pinned,
    // or while the Review view itself is on screen (inbox mode). Otherwise
    // skip it — full-context diffs are strictly review-view payload.
    const reviewLive = get().baseline != null || get().view === 'review';
    await Promise.all([
      get().refreshSnapshot(),
      get().refreshDiffs(),
      ...(reviewLive ? [get().refreshReviewDiffs()] : []),
    ]);
  },

  async refreshSnapshot() {
    const path = get().activePath;
    if (!path) return;
    try {
      const snap = await timed('snapshot', () => tauri.repoSnapshot(path));
      logColdStart();
      if (get().activePath !== path) {
        // Tab switched mid-flight — still patch the per-tab meta.
        set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, meta: snap.meta } : t)) }));
        return;
      }
      // Keep-if-equal per slice: a refresh where a slice didn't change keeps
      // that slice's previous reference, so downstream memos and selector
      // subscribers (sidebar ref trees, palette index, Files tree) don't
      // rebuild or re-render for identical data. A stage toggle only really
      // changes `status`/`workTree`; `refs`/`submodules`/`meta` stay put.
      set((s) => ({
        meta: stable(s.meta, snap.meta),
        status: stable(s.status, snap.status),
        workTree: stable(s.workTree, snap.work_tree),
        refs: stable(s.refs, snap.refs),
        submodules: stable(s.submodules, snap.submodules),
        tabs: s.tabs.some((t) => t.path === path && !jsonEqual(t.meta, snap.meta))
          ? s.tabs.map((t) => (t.path === path ? { ...t, meta: snap.meta } : t))
          : s.tabs,
      }));
    } catch (e) {
      console.warn('repoSnapshot failed', e);
    }
  },

  async handleExternalChange(path) {
    // Only the active tab repaints; a background tab catches up when
    // activated (setActiveTab refreshes everything anyway).
    if (get().activePath !== path) return;
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
  },

  async setBaseline(at) {
    const path = get().activePath;
    const oid = at ?? get().meta?.head_oid;
    if (!path || !oid) return;
    const baseline: StoredBaseline = { oid, short: oid.slice(0, 7), setAt: Date.now() };
    set({ baseline });
    void reviewSession.setBaseline(path, baseline).catch((e) =>
      console.warn('baseline persist failed', e));
    await get().refreshReviewDiffs();
  },

  async clearBaseline() {
    const path = get().activePath;
    set({ baseline: null, baselineDiffs: [] });
    if (path) {
      void reviewSession.setBaseline(path, null).catch((e) =>
        console.warn('baseline clear failed', e));
    }
  },

  selectReviewFile: (reviewSelection) => set({ reviewSelection }),

  async refreshReviewDiffs() {
    const path = get().activePath;
    if (!path) return;
    const baseline = get().baseline;
    if (baseline) {
      try {
        const diffs = await tauri.repoDiffSinceFull(path, baseline.oid);
        if (get().activePath !== path || get().baseline?.oid !== baseline.oid) return;
        set({ baselineDiffs: diffs, diffsTick: get().diffsTick + 1 });
      } catch (e) {
        // Typical cause: the baseline commit was rebased/gc'd away. Surface by
        // clearing — the chip disappears rather than showing stale data.
        console.warn('repoDiffSinceFull failed', e);
        if (get().activePath === path) void get().clearBaseline();
      }
      return;
    }
    try {
      const diffs = await tauri.repoDiffUnstagedFull(path);
      if (get().activePath !== path || get().baseline != null) return;
      set({ reviewUnstagedDiffs: diffs, diffsTick: get().diffsTick + 1 });
    } catch (e) {
      console.warn('repoDiffUnstagedFull failed', e);
    }
  },

  async loadReviewSession() {
    const path = get().activePath;
    if (!path) return;
    try {
      const [baseline, reviewed, notes] = await Promise.all([
        reviewSession.getBaseline(path),
        reviewSession.getReviewed(path),
        reviewSession.getNotes(path),
      ]);
      if (get().activePath !== path) return;
      set({ baseline: baseline ?? null, reviewed: reviewed ?? {}, reviewNotes: notes ?? {} });
      if (baseline) await get().refreshReviewDiffs();
    } catch (e) {
      console.warn('review session load failed', e);
    }
  },

  toggleReviewed(file, hash) {
    const path = get().activePath;
    if (!path) return;
    const cur = get().reviewed;
    const next = { ...cur };
    // Marked with a matching hash → unmark; anything else → (re)mark at the
    // current hash (covers both "not reviewed" and "stale review").
    if (next[file] === hash) delete next[file];
    else next[file] = hash;
    set({ reviewed: next });
    void reviewSession.setReviewed(path, next).catch((e) =>
      console.warn('reviewed persist failed', e));
  },

  addReviewNote(file, text, line, side) {
    const path = get().activePath;
    const note = makeReviewNote(text, line, side);
    if (!path || !note) return;
    const cur = get().reviewNotes;
    const next = { ...cur, [file]: [...(cur[file] ?? []), note] };
    set({ reviewNotes: next });
    void reviewSession.setNotes(path, next).catch((e) =>
      console.warn('review notes persist failed', e));
  },

  removeReviewNote(file, id) {
    const path = get().activePath;
    if (!path) return;
    const cur = get().reviewNotes;
    if (!cur[file]) return;
    const remaining = cur[file].filter((n) => n.id !== id);
    const next = { ...cur };
    if (remaining.length === 0) delete next[file];
    else next[file] = remaining;
    set({ reviewNotes: next });
    void reviewSession.setNotes(path, next).catch((e) =>
      console.warn('review notes persist failed', e));
  },

  clearReviewNotes() {
    const path = get().activePath;
    if (!path) return;
    set({ reviewNotes: {} });
    void reviewSession.setNotes(path, {}).catch((e) =>
      console.warn('review notes persist failed', e));
  },

  async stageReviewed() {
    const path = get().activePath;
    if (!path) return;
    const reviewed = get().reviewed;
    // Marks hash the review pool's whole-file patches; stage the matching
    // files that are actually unstaged right now.
    const pool = get().baseline ? get().baselineDiffs : get().reviewUnstagedDiffs;
    const unstaged = new Set(get().unstagedDiffs.map((d) => d.path));
    const files = pool
      .filter((d) => unstaged.has(d.path) && reviewed[d.path] === hashPatch(d.patch))
      .map((d) => d.path);
    if (files.length === 0) return;
    await tauri.repoStageMany(path, files);
    await get().refreshLocalChanges();
  },

  async undoBulkDiscard() {
    const last = get().lastBulkDiscard;
    const path = get().activePath;
    if (!last || !path || last.path !== path) {
      set({ lastBulkDiscard: null });
      return;
    }
    set({ lastBulkDiscard: null });
    // Find the safety snapshot on the (fresh) stash stack and apply it.
    await get().refreshStashes();
    const entry = get().stashes.find((s) => s.oid === last.oid);
    if (!entry) throw new Error('Safety snapshot is no longer on the stash stack');
    await tauri.repoStashApply(path, entry.index);
    await Promise.all([get().refreshLocalChanges(), get().refreshStashes()]);
  },

  clearBulkUndo: () => set({ lastBulkDiscard: null }),

  async refreshRefs() {
    const path = get().activePath;
    if (!path) return;
    try {
      const refs = await tauri.repoRefs(path);
      if (get().activePath !== path) return;
      set({ refs: stable(get().refs, refs) });
    } catch (e) {
      console.warn('repoRefs failed', e);
    }
  },

  async refreshTree() {
    const path = get().activePath;
    if (!path) return;
    try {
      const tree = await tauri.repoTree(path);
      // Bail if the active repo changed while the listing was in flight.
      if (get().activePath !== path) return;
      set({ workTree: stable(get().workTree, tree) });
    } catch (e) {
      console.warn('repoTree failed', e);
    }
  },

  async refreshSubmodules() {
    const path = get().activePath;
    if (!path) return;
    try {
      const submodules = await tauri.repoSubmodules(path);
      // Bail if the active repo changed while the listing was in flight.
      if (get().activePath !== path) return;
      set({ submodules: stable(get().submodules, submodules) });
    } catch (e) {
      console.warn('repoSubmodules failed', e);
    }
  },

  async refreshReflog() {
    const path = get().activePath;
    if (!path) return;
    try {
      const reflog = await tauri.repoReflog(path);
      // Bail if the active repo changed while the read was in flight.
      if (get().activePath !== path) return;
      set({ reflog });
    } catch (e) {
      console.warn('repoReflog failed', e);
    }
  },

  async submoduleUpdate(paths, init, recursive, onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoSubmoduleUpdate(path, paths, init, recursive, onProgress);
    // An update can move pointers + populate working trees — refresh the
    // submodule list and the superproject's status.
    await Promise.all([get().refreshSubmodules(), get().refreshLocalChanges()]);
    return res.output;
  },

  async refreshWorktrees() {
    const path = get().activePath;
    if (!path) return;
    try {
      const worktrees = await tauri.repoWorktrees(path);
      // Bail if the active repo changed while the listing was in flight.
      if (get().activePath !== path) return;
      set({ worktrees });
    } catch (e) {
      console.warn('repoWorktrees failed', e);
    }
  },
  async addWorktree(dest, branch, newBranch, startPoint, track) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoWorktreeAdd(path, dest, branch, newBranch, startPoint ?? null, track ?? false);
    // A new branch may have been created — refresh refs alongside the list.
    await Promise.all([get().refreshWorktrees(), get().refreshRefs()]);
  },
  async removeWorktree(dest, force) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    // Safety net: snapshot the worktree's full state (HEAD + uncommitted +
    // untracked) into an archive ref before the directory goes away — a
    // force-remove is then always recoverable from the Worktrees overview.
    // Best-effort: a prunable entry has no directory to archive, and git's
    // own dirty guard still protects the non-force path.
    try {
      await tauri.repoWorktreeArchive(dest);
    } catch (e) {
      console.warn('worktree archive before remove failed', e);
    }
    await tauri.repoWorktreeRemove(path, dest, force);
    // The worktree's directory is gone now — close its tab if it was open, so a
    // dead tab doesn't linger pointing at a removed worktree.
    const tab = get().tabs.find((t) => samePath(t.path, dest));
    if (tab) get().closeTab(tab.path);
    await get().refreshWorktrees();
  },
  async pruneWorktrees() {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoWorktreePrune(path);
    await get().refreshWorktrees();
    // Prune drops registry entries whose directories are gone; close any open
    // tabs that no longer correspond to a live worktree of this repo.
    const live = get().worktrees;
    for (const t of get().tabs) {
      if (
        t.meta.is_linked_worktree &&
        t.meta.common_dir === get().meta?.common_dir &&
        !live.some((w) => samePath(w.path, t.path))
      ) {
        get().closeTab(t.path);
      }
    }
  },
  async openWorktree(path) {
    // A worktree directory is a valid repo path; opening it reuses the normal
    // tab flow (dedupe + canonicalize handled there).
    await get().openRepo(path);
  },
  async reviewWorktree(w) {
    const target = w.branch ?? w.head;
    let baselineOid: string | null = null;
    let base: string | null = null;
    let detectError: string | null = null;

    // Review against the branch this worktree actually forked from, not the
    // main worktree's branch — a worktree cut from `portal30` must baseline
    // at merge-base(HEAD, portal30), or the diff swallows all of portal30's
    // own work (DAN-14).
    if (!w.is_main && target) {
      try {
        const hit = await tauri.repoDetectBaseBranch(w.path, target);
        if (hit) {
          baselineOid = hit.merge_base;
          base = hit.name;
        }
      } catch (e) {
        detectError = errMessage(e);
      }
    }

    const nextView = baselineOid ? 'review' : 'local';
    get().setView(nextView);
    await get().openWorktree(w.path);
    if (baselineOid) {
      await get().setBaseline(baselineOid);
    }
    get().setView(nextView);
    return { base, detectError };
  },

  async stage(file) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoStage(path, file);
    await get().refreshLocalChanges();
  },
  async unstage(file) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoUnstage(path, file);
    await get().refreshLocalChanges();
  },
  async discard(file) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoDiscard(path, file);
    await get().refreshLocalChanges();
  },
  async stageMany(files) {
    const path = get().activePath;
    if (!path || files.length === 0) return;
    // A renamed file's diff carries old_path; staging only the new path
    // records the add but leaves the old path's deletion unstaged (and it
    // was invisible — rename detection had folded it into the R row).
    // Stage both halves so the rename lands atomically.
    const expand = new Set(files);
    for (const d of get().unstagedDiffs) {
      if (d.old_path && expand.has(d.path)) expand.add(d.old_path);
    }
    await tauri.repoStageMany(path, [...expand]);
    await get().refreshLocalChanges();
  },
  async unstageMany(files) {
    const path = get().activePath;
    if (!path || files.length === 0) return;
    await tauri.repoUnstageMany(path, files);
    await get().refreshLocalChanges();
  },
  async discardMany(files) {
    const path = get().activePath;
    if (!path || files.length === 0) return;
    // Discard straight through — no automatic safety stash, even for bulk
    // discards. Users asked not to have a snapshot spawned on every
    // multi-file delete; the per-hunk/-file undo path covers single edits.
    await tauri.repoDiscardMany(path, files);
    await get().refreshLocalChanges();
  },
  async gitignoreAdd(pattern) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoGitignoreAdd(path, pattern);
    // The ignored file drops out of untracked and .gitignore itself shows up
    // as modified/untracked — both ride the snapshot refresh.
    await get().refreshLocalChanges();
    get().markFilesTreeChanged(path, { kind: 'refresh' });
  },
  async moveEntries(moves) {
    const path = get().activePath;
    if (!path || moves.length === 0) return [];
    const failures: string[] = [];
    const done: Array<{ from: string; to: string }> = [];
    for (const m of moves) {
      try {
        await tauri.repoMovePath(path, m.from, m.to);
        done.push(m);
      } catch (e) {
        failures.push(`${m.from}: ${errMessage(e)}`);
      }
    }
    if (done.length) {
      // Keep an open file view pointed at the file's new location — including
      // a file carried along by its folder's move. Only while the file view is
      // showing: selectFile switches the view, and a background selection
      // isn't worth yanking the user out of another view for.
      const sel = get().selectedFile;
      if (sel && get().view === 'file') {
        for (const m of done) {
          if (sel === m.from) {
            get().selectFile(m.to, null, get().selectedFileIsDirectory);
            break;
          }
          if (sel.startsWith(m.from + '/')) {
            get().selectFile(
              m.to + sel.slice(m.from.length),
              null,
              get().selectedFileIsDirectory,
            );
            break;
          }
        }
      }
      await get().refreshLocalChanges();
      get().markFilesTreeChanged(path, { kind: 'move', moves: done });
    }
    return failures;
  },
  async applyPatch(patch, target) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoApplyPatch(path, patch, target);
    await get().refreshLocalChanges();
  },
  async discardPatch(slice, label) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoApplyPatch(path, slice, 'workdir_reverse');
    // Record the exact slice so undoDiscard can forward-apply it back.
    // Replaces any prior handle — single-undo only ever recovers the
    // most recent discard.
    set({ lastDiscard: { patch: slice, label, path } });
    await get().refreshLocalChanges();
  },
  async undoDiscard() {
    const last = get().lastDiscard;
    if (!last) return;
    set({ lastDiscard: null });
    // Apply to the repo the handle is pinned to — not the active tab. A
    // Workspace Review discard can come from a background member repo, and
    // replaying into the wrong repo stays impossible because the path rides
    // the handle. Background members repaint via their watcher; only the
    // active tab needs the explicit refresh.
    await tauri.repoApplyPatch(last.path, last.patch, 'workdir');
    const active = get().activePath;
    if (active && samePath(active, last.path)) await get().refreshLocalChanges();
  },
  clearUndo: () => set({ lastDiscard: null }),
  setDiffMode(mode) {
    useSettings.getState().set('diffMode', mode);
    const path = get().activePath;
    if (path) void repoDiffMode.set(path, mode);
  },
  async loadRepoDiffMode() {
    const path = get().activePath;
    if (!path) return;
    const mode = await repoDiffMode.get(path);
    // Guard against a tab switch landing mid-read (e.g. several repos opening
    // during session restore): only the still-active repo's layout may win.
    // No per-repo override → the configured default (Settings → Diff) applies.
    if (get().activePath !== path) return;
    const settings = useSettings.getState();
    settings.set('diffMode', mode ?? settings.defaultDiffLayout);
  },
  async stageAll() {
    const path = get().activePath;
    if (!path) return;
    // Include rename sources (see stageMany).
    const files = get().unstagedDiffs.flatMap((d) =>
      d.old_path ? [d.path, d.old_path] : [d.path],
    );
    if (files.length === 0) return;
    await tauri.repoStageMany(path, files);
    await get().refreshLocalChanges();
  },
  async unstageAll() {
    const path = get().activePath;
    if (!path) return;
    const files = get().stagedDiffs.map((d) => d.path);
    if (files.length === 0) return;
    await tauri.repoUnstageMany(path, files);
    await get().refreshLocalChanges();
  },
  async commit(subject, body, amend) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoCommit(path, subject, body, amend);
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshStashes(),
    ]);
  },

  async refreshMeta() {
    const path = get().activePath;
    if (!path) return;
    const meta = await tauri.repoMeta(path);
    // fetch/pull/push call this after a seconds-long round-trip; if the user
    // switched tabs meanwhile, still patch the per-tab meta but don't clobber
    // the active mirror (which now reflects a different repo).
    if (get().activePath !== path) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, meta } : t)) }));
      return;
    }
    set((s) => ({
      meta,
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, meta } : t)),
    }));
  },
  setPullMode(mode) {
    set({ pullMode: mode });
    const path = get().activePath;
    if (path) void repoPullMode.set(path, mode);
  },
  async loadRepoPullMode() {
    const path = get().activePath;
    if (!path) return;
    const saved = await repoPullMode.get(path);
    if (get().activePath !== path) return;
    const mode = saved && ['default', 'merge', 'rebase', 'fast-forward-only'].includes(saved)
      ? saved
      : 'default';
    set({ pullMode: mode });
  },
  setFetchPrune(prune) {
    set({ fetchPrune: prune });
    const path = get().activePath;
    if (path) void repoNetworkPreferences.set(path, {
      fetchPrune: prune,
      pullAutostash: get().pullAutostash,
    });
  },
  setPullAutostash(autostash) {
    set({ pullAutostash: autostash });
    const path = get().activePath;
    if (path) void repoNetworkPreferences.set(path, {
      fetchPrune: get().fetchPrune,
      pullAutostash: autostash,
    });
  },
  async loadRepoNetworkPreferences() {
    const path = get().activePath;
    if (!path) return;
    const saved = await repoNetworkPreferences.get(path);
    if (get().activePath !== path) return;
    set({
      fetchPrune: typeof saved?.fetchPrune === 'boolean' ? saved.fetchPrune : true,
      pullAutostash: typeof saved?.pullAutostash === 'boolean' ? saved.pullAutostash : false,
    });
  },
  async fetch(prune, onProgress, opId) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoFetch(path, null, prune ?? get().fetchPrune, onProgress, opId);
    await get().refreshSnapshot();
    return res.output;
  },
  async pull(mode, autostash, onProgress, opId) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoPull(
      path,
      mode ?? get().pullMode,
      autostash ?? get().pullAutostash,
      onProgress,
      opId,
    );
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
    return res.output;
  },
  async push(mode = 'default', onProgress, opId) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoPush(path, mode, onProgress, opId);
    await get().refreshSnapshot();
    return res.output;
  },
  async fetchBranch(remote, branch, onProgress, opId) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoBranchFetch(path, remote, branch, onProgress, opId);
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
    return res.output;
  },
  async pullBranch(remote, branch, mode, autostash, onProgress, opId) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoBranchPull(
      path,
      remote,
      branch,
      mode ?? get().pullMode,
      autostash ?? get().pullAutostash,
      onProgress,
      opId,
    );
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
    return res.output;
  },
  async pushBranch(request, onProgress, opId) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoBranchPush(path, request, onProgress, opId);
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
    return res.output;
  },

  async checkout(branch) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoCheckout(path, branch);
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
  },
  async checkoutCommit(rev) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoCheckoutCommit(path, rev);
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
  },
  async createBranch(name, startPoint, checkout) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoBranchCreate(path, name, startPoint, checkout);
    await Promise.all([
      get().refreshSnapshot(),
      ...(checkout ? [get().refreshDiffs(), get().refreshLog()] : []),
    ]);
  },
  async deleteBranch(name, force) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoBranchDelete(path, name, force);
    await get().refreshRefs();
  },
  async deleteRemoteBranch(remote, branch, onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoBranchDeleteRemote(path, remote, branch, onProgress);
    // The push removes the local remote-tracking ref too, so the sidebar row
    // disappears once refs reload.
    await get().refreshRefs();
    return res.output;
  },
  async renameBranch(oldName, newName) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoBranchRename(path, oldName, newName);
    // Refs ride along in the snapshot; the graph's ref chips read the log.
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
  },
  async setBranchUpstream(branch, upstream) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoBranchSetUpstream(path, branch, upstream);
    await get().refreshLocalChanges();
  },
  async addRemote(name, url, pushUrl) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoRemoteAdd(path, name, url, pushUrl);
    await get().refreshLocalChanges();
  },
  async removeRemote(name) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoRemoteRemove(path, name);
    await get().refreshLocalChanges();
  },
  async renameRemote(oldName, newName) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const problems = await tauri.repoRemoteRename(path, oldName, newName);
    await get().refreshLocalChanges();
    return problems;
  },
  async setRemoteUrls(name, url, pushUrl) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoRemoteSetUrls(path, name, url, pushUrl);
    await get().refreshLocalChanges();
  },
  async setDefaultRemote(name) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoRemoteSetDefault(path, name);
    await get().refreshLocalChanges();
  },
  async fetchRemote(name, prune) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoFetch(path, name, prune ?? get().fetchPrune);
    await Promise.all([get().refreshLocalChanges(), get().refreshLog()]);
  },
  async reset(target, mode) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const outcome = await tauri.repoReset(path, target, mode);
    // A reset moves HEAD/refs and rewrites local changes; the reflog records
    // the move (it's the recovery path back), and a hard-reset snapshot adds
    // a stash entry.
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshReflog(),
      ...(outcome.snapshot_oid ? [get().refreshStashes()] : []),
    ]);
    return outcome;
  },

  // History ops change HEAD, the working tree, the log and refs — refresh all
  // four afterward (in `finally`, so a real failure still re-syncs). On a
  // conflict the op resolves `true`: jump to Local Changes and clear the
  // selection so the conflict bar opens the first conflicted file.
  async cherryPick(commits, mainline) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoCherryPick(path, commits, mainline);
    });
  },
  async revert(commits, mainline) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoRevert(path, commits, mainline);
    });
  },
  async merge(refname, mode) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoMerge(path, refname, mode);
    });
  },
  async rebase(onto) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoRebase(path, onto);
    });
  },
  async loadRebaseTodo(base) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    return tauri.repoRebaseTodo(path, base);
  },
  async interactiveRebase(base, steps, preserveMerges) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoInteractiveRebase(path, base, steps, preserveMerges);
    });
  },
  async abortOperation() {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    try {
      await tauri.repoAbortOperation(path);
    } finally {
      await refreshAfterHistoryOp(get);
    }
  },
  async continueOperation() {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoContinueOperation(path);
    });
  },
  async resolveConflict(file, contents) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoResolveConflict(path, file, contents);
    // Status drives the Conflicts list; the snapshot inside also re-reads
    // meta (`operation`) so the banner clears as soon as all are resolved.
    await get().refreshLocalChanges();
  },

  async createTag(name, target, message) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoTagCreate(path, name, target, message, false);
    // Refresh refs (sidebar list) and the log (graph chips read from refs).
    await Promise.all([get().refreshRefs(), get().refreshLog()]);
  },
  async deleteTag(name) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoTagDelete(path, name);
    await get().refreshRefs();
  },
  async pushTag(tag, onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const remote = defaultRemote(get().refs);
    if (!remote) throw new Error('No remote configured');
    const res = await tauri.repoTagPush(path, tag, remote, false, onProgress);
    // Optimistically mark the tag present on the remote (memory + cache), so
    // the gray-out stays correct without a re-fetch.
    setRemoteTags(get, set, path, (cur) => (cur.includes(tag) ? cur : [...cur, tag]));
    return res.output;
  },
  async deleteRemoteTag(tag, onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const remote = defaultRemote(get().refs);
    if (!remote) throw new Error('No remote configured');
    const res = await tauri.repoTagPush(path, tag, remote, true, onProgress);
    setRemoteTags(get, set, path, (cur) => cur.filter((t) => t !== tag));
    return res.output;
  },
  async pushAllTags(onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const remote = defaultRemote(get().refs);
    if (!remote) throw new Error('No remote configured');
    const res = await tauri.repoTagPushAll(path, remote, onProgress);
    // Every local tag is now on the remote — fold them into the known set.
    const local = get().refs.tags.map((t) => t.name);
    setRemoteTags(get, set, path, (cur) => Array.from(new Set([...cur, ...local])));
    return res.output;
  },
  async refreshRemoteTags() {
    const path = get().activePath;
    if (!path) return;
    const remote = defaultRemote(get().refs);
    if (!remote) {
      set({ remoteTags: [] });
      return;
    }

    // Stale-while-revalidate: paint the persisted cache instantly (if we have
    // nothing yet) so the gray-out appears without waiting on the network.
    if (get().remoteTags === null) {
      try {
        const cached = await remoteTagsCache.get(path);
        if (cached && get().activePath === path && get().remoteTags === null) {
          set({ remoteTags: cached });
        }
      } catch (e) {
        console.warn('remoteTagsCache.get failed', e);
      }
    }

    // Revalidate over the network at most once per repo per session; refresh
    // the cache so the next launch starts warm.
    if (revalidatedRemoteTags.has(path)) return;
    try {
      const tags = await tauri.repoRemoteTags(path, remote);
      revalidatedRemoteTags.add(path);
      void remoteTagsCache.set(path, tags);
      if (get().activePath === path) set({ remoteTags: tags });
    } catch (e) {
      // Leave whatever we have (cached value, or null = unknown = don't gray);
      // git reports the real error if a delete is attempted. Retry next open.
      console.warn('repoRemoteTags failed', e);
    }
  },

  async refreshStashes() {
    const path = get().activePath;
    if (!path) return;
    try {
      const stashes = await tauri.repoStashList(path);
      // Bail if the active repo changed while the list was in flight.
      if (get().activePath !== path) return;
      set({ stashes });
    } catch (e) {
      console.warn('repoStashList failed', e);
    }
  },
  async stashSave(message, includeUntracked, keepIndex) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const outcome = await tauri.repoStashSave(path, message, includeUntracked, keepIndex);
    // Only the working tree changed if something was actually stashed; refresh
    // regardless so the stash list reflects the new (or unchanged) stack.
    await Promise.all([
      get().refreshStashes(),
      get().refreshLocalChanges(),
      get().refreshLog(),
    ]);
    return outcome;
  },
  async stashSnapshot(message, includeUntracked) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const outcome = await tauri.repoStashSnapshot(path, message, includeUntracked);
    // The snapshot leaves the working tree as-is, but a new stash entry exists —
    // refresh the stack (and the log, which lists stash commits).
    await Promise.all([get().refreshStashes(), get().refreshLog()]);
    return outcome;
  },
  async stashPushPaths(paths, message, includeUntracked, keepIndex, snapshot) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const outcome = await tauri.repoStashPushPaths(
      path,
      paths,
      message,
      includeUntracked,
      keepIndex,
      snapshot,
    );
    await Promise.all([
      get().refreshStashes(),
      get().refreshLocalChanges(),
      get().refreshLog(),
    ]);
    return outcome;
  },
  async stashApply(index) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoStashApply(path, index);
    await Promise.all([get().refreshStashes(), get().refreshLocalChanges(), get().refreshLog()]);
  },
  async stashPop(index) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoStashPop(path, index);
    await Promise.all([get().refreshStashes(), get().refreshLocalChanges(), get().refreshLog()]);
  },
  async stashBranch(index, branch) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoStashBranch(path, index, branch);
    await Promise.all([get().refreshStashes(), get().refreshLocalChanges(), get().refreshLog()]);
  },
  async stashDrop(index) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoStashDrop(path, index);
    await get().refreshStashes();
  },

  selectLocalFile: (sel) => set({ localSelection: sel }),

  setLocalTreeSelection: (staged, paths) =>
    set((s) => ({
      localTreeSelection: staged
        ? { ...s.localTreeSelection, staged: paths }
        : { ...s.localTreeSelection, unstaged: paths },
    })),

  async selectCommit(hash) {
    if (hash === null) {
      set({ selectedCommit: null, selectedCommitDiffs: [], selectedCommitDiffsLoading: false });
      return;
    }
    const path = get().activePath;
    if (!path) return;
    set({ selectedCommit: hash, selectedCommitDiffs: [], selectedCommitDiffsLoading: true });
    try {
      const diffs = await tauri.repoDiffCommit(path, hash);
      // Bail out if the selection moved while we were fetching.
      if (get().selectedCommit !== hash) return;
      set({ selectedCommitDiffs: diffs, selectedCommitDiffsLoading: false });
    } catch (e) {
      console.warn('repoDiffCommit failed', e);
      if (get().selectedCommit !== hash) return;
      set({ selectedCommitDiffs: [], selectedCommitDiffsLoading: false });
    }
  },

  async searchLog(query, mode) {
    const path = get().activePath;
    if (!path) return [];
    const q = query.trim();
    if (!q) {
      set({ commitSearchResults: [] });
      return [];
    }
    const results = await tauri.repoSearchLog(path, q, mode);
    // Bail if the active repo changed mid-flight (mirrors refreshLog).
    if (get().activePath !== path) return [];
    set({ commitSearchResults: results });
    return results;
  },

  async refreshRecents() {
    try {
      const list = await recentsDb.list();
      // Heal separator-drift duplicates (the same directory recorded under
      // two spellings, e.g. `D:/x` and `D:\x`): keep one row per path key —
      // preferring the spelling of an open tab — and drop the shadowed rows
      // from the DB so they don't come back.
      const tabs = get().tabs;
      const byKey = new Map<string, RecentRepo>();
      const dupes: string[] = [];
      for (const r of list) {
        const key = pathKey(r.path);
        const kept = byKey.get(key);
        if (!kept) {
          byKey.set(key, r);
          continue;
        }
        const tabPath = tabs.find((t) => pathKey(t.path) === key)?.path;
        const preferR =
          (tabPath && r.path === tabPath && kept.path !== tabPath) ||
          // No tab to defer to (e.g. before session restore): prefer the
          // native backslash spelling over git's forward-slash output.
          (!tabPath && /^[A-Za-z]:\//.test(kept.path) && !/^[A-Za-z]:\//.test(r.path));
        if (preferR) {
          dupes.push(kept.path);
          byKey.set(key, r); // Map.set keeps the original position
        } else {
          dupes.push(r.path);
        }
      }
      for (const p of dupes) void recentsDb.forget(p).catch(() => {});
      set({ recents: [...byKey.values()] });
    } catch (e) {
      console.warn('recents.list failed', e);
    }
  },
  async forgetRecent(path) {
    await recentsDb.forget(path);
    await get().refreshRecents();
  },

  setView: (view) => set({ view, ...(view === 'commits' ? {} : { workFileReturn: null }) }),
  setWorkFileReturn: (workFileReturn) => set({ workFileReturn }),
  revealInGraph: (hash) => set({ view: 'commits', revealCommit: hash }),
  clearReveal: () => set({ revealCommit: null }),
  requestCommitSearch: (mode) =>
    set({ view: 'commits', commitSearchFocus: true, commitSearchMode: mode ?? null }),
  clearCommitSearchFocus: () => set({ commitSearchFocus: false, commitSearchMode: null }),
  requestDiffSearch: () => set({ diffSearchSignal: true }),
  clearDiffSearch: () => set({ diffSearchSignal: false }),
  requestSuggestCommitMessage: () => set({ view: 'local', suggestCommitSignal: true }),
  clearSuggestCommitMessage: () => set({ suggestCommitSignal: false }),
  requestStashDialog: (opts) =>
    set({
      stashDialogRequest: {
        snapshot: opts?.snapshot ?? false,
        keepIndex: opts?.keepIndex ?? false,
      },
    }),
  clearStashDialogRequest: () => set({ stashDialogRequest: null }),
  openIgnoreDialog: (initial) => set({ ignoreDraft: initial }),
  closeIgnoreDialog: () => set({ ignoreDraft: null }),
  requestSelectSinceBaseline: () => set({ view: 'commits', selectSinceBaseline: true }),
  clearSelectSinceBaseline: () => set({ selectSinceBaseline: false }),
  // Opening a file resets the file-view tab — Preview for renderable files
  // when the `fileOpenTab` setting says so, Content otherwise — and drops any
  // stale back-target; closing (null) just drops the back-target.
  selectFile: (selectedFile, revision = null, isDirectory = false) =>
    set({
      selectedFile,
      selectedFileIsDirectory: selectedFile ? isDirectory : false,
      selectedFileRevision: selectedFile ? revision : null,
      view: selectedFile ? 'file' : get().view,
      fileReturn: null,
      ...(selectedFile
        ? {
            fileTab: (useSettings.getState().fileOpenTab === 'preview' &&
            isPreviewablePath(selectedFile)
              ? 'preview'
              : 'content') as FileTab,
          }
        : {}),
    }),
  selectRef: (selectedRef) => set({ selectedRef }),
  setFileTab: (fileTab) => set({ fileTab }),
  jumpFromFile: (hash) => {
    if (!hash) return;
    // Remember where we came from, then reveal + open the commit. We don't call
    // selectFile (which would clear fileReturn) — selectedFile stays set so the
    // back bar can restore the file view at its current tab.
    set({ fileReturn: get().selectedFile, view: 'commits', revealCommit: hash });
    void get().selectCommit(hash);
  },
  returnToFile: () => {
    const target = get().fileReturn;
    if (!target) return;
    set({ selectedFile: target, view: 'file', fileReturn: null });
  },
}));
