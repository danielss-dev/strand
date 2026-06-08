import { create } from 'zustand';

import {
  commitMessages as commitMessagesDb,
  recents as recentsDb,
  remoteTagsCache,
  repoDiffMode,
  settings as settingsDb,
  type StoredMessage,
} from '../lib/db';
import { tauri } from '../lib/tauri';
import { useSettings, type DiffMode } from './settings';
import type {
  Commit,
  FileDiff,
  FileStatus,
  MergeMode,
  Progress,
  RecentRepo,
  Refs,
  ReflogEntry,
  RepoMeta,
  Stash,
  StashOutcome,
  Submodule,
  WorkTreeEntry,
} from '../lib/types';

interface PersistedSession {
  tabs: string[];
  activeTabPath: string | null;
}
const SESSION_KEY = 'session.tabs';

export type View = 'local' | 'commits' | 'file' | 'branch' | 'reflog';

/** Active tab within the 4-tab file view. */
export type FileTab = 'content' | 'history' | 'compare' | 'blame';

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

  unstagedDiffs: FileDiff[];
  stagedDiffs: FileDiff[];
  localSelection: LocalSelection | null;

  /**
   * Single-undo handle for the most recent discard. Discarding a change
   * block reverse-applies a sliced patch to the working tree; this keeps
   * that exact slice around so {@link RepoState.undoDiscard} can
   * forward-apply it back. `path` pins it to the repo it came from so a
   * stale handle can't be replayed against a different tab. Cleared once
   * the undo toast times out (see `clearUndo`) or after an undo.
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

  /** Working-tree file listing for the Files sidebar tab (lazy: only the
   * Files tab triggers {@link RepoState.refreshTree}). */
  workTree: WorkTreeEntry[];

  /** Submodules of the active repo (list + status), for the sidebar section. */
  submodules: Submodule[];

  /** HEAD reflog for the active tab, newest first. Lazy: only the Reflog view
   * triggers {@link RepoState.refreshReflog}. */
  reflog: ReflogEntry[];

  /** Recent commit messages for the active repo, newest first. Powers the
   * dropdown on the commit subject field. */
  recentMessages: StoredMessage[];

  recents: RecentRepo[];

  view: View;
  /** Active tab in the file view; persists across a commit jump so Back can
   *  return you to the same tab. */
  fileTab: FileTab;
  /** When set, the file path to return to after a blame/history → commit jump
   *  (drives the "Back to file" bar in the commits view). Cleared by any normal
   *  navigation (selecting a file, opening a repo, switching tabs). */
  fileReturn: string | null;
  selectedFile: string | null;
  selectedRef: string | null;

  /** Re-open the tabs the user had open last time (called once at app start). */
  restoreSession(): Promise<void>;

  openRepo(path: string): Promise<void>;
  closeTab(path: string): void;
  setActiveTab(path: string): Promise<void>;
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
  /** Re-read the recent commit messages for the active repo. */
  refreshRecentMessages(): Promise<void>;

  /** Refresh status + diffs together — what every write op runs afterward. */
  refreshLocalChanges(): Promise<void>;

  stage(file: string): Promise<void>;
  unstage(file: string): Promise<void>;
  discard(file: string): Promise<void>;
  /** Stage / unstage / discard a specific set of files with a single refresh. */
  stageMany(files: string[]): Promise<void>;
  unstageMany(files: string[]): Promise<void>;
  discardMany(files: string[]): Promise<void>;
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
  /** Re-apply the last discarded slice to the working tree, then clear the handle. */
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
  fetch(onProgress?: (p: Progress) => void): Promise<string>;
  pull(rebase?: boolean, onProgress?: (p: Progress) => void): Promise<string>;
  push(forceWithLease?: boolean, onProgress?: (p: Progress) => void): Promise<string>;

  checkout(branch: string): Promise<void>;
  /** Check out an arbitrary commit as a detached HEAD. */
  checkoutCommit(rev: string): Promise<void>;
  createBranch(name: string, startPoint: string | null, checkout: boolean): Promise<void>;
  deleteBranch(name: string, force: boolean): Promise<void>;

  /**
   * History ops — all shell out to `git`. Each resolves to `true` when it
   * stopped on **conflicts** (an expected outcome: the repo is left
   * mid-operation and the view switches to Local Changes for resolution) and
   * `false` when it completed cleanly; the promise rejects only on a real
   * failure (dirty tree, bad ref). {@link RepoState.abortOperation} backs out,
   * and `meta.operation` reports the in-progress state. Callers toast based on
   * the returned flag.
   */
  cherryPick(commits: string[]): Promise<boolean>;
  revert(commits: string[]): Promise<boolean>;
  merge(refname: string, mode: MergeMode): Promise<boolean>;
  rebase(onto: string): Promise<boolean>;
  /** Abort the merge/rebase/cherry-pick/revert currently in progress. */
  abortOperation(): Promise<void>;
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
  /** Apply a stash by index, leaving it on the stack. */
  stashApply(index: number): Promise<void>;
  /** Apply a stash by index and drop it on success. */
  stashPop(index: number): Promise<void>;
  /** Drop a stash by index without applying it. Destructive. */
  stashDrop(index: number): Promise<void>;

  selectLocalFile(sel: LocalSelection | null): void;
  /** Open the commit-detail panel for `hash`, or close it when null. */
  selectCommit(hash: string | null): Promise<void>;

  /** Switch to the All Commits graph and reveal (scroll to + highlight)
   * `hash` — the tip of a sidebar branch/remote/tag row. */
  revealInGraph(hash: string): void;
  /** Clear the pending {@link RepoState.revealCommit} once the graph has
   * consumed it. */
  clearReveal(): void;

  refreshRecents(): Promise<void>;
  forgetRecent(path: string): Promise<void>;

  setView(view: View): void;
  selectFile(path: string | null): void;
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

const EMPTY_REFS: Refs = { branches: [], remotes: [], remote_branches: [], tags: [] };

/**
 * The remote tag pushes target by default: the current branch's upstream
 * remote, else `origin`, else the only/first configured remote, else null
 * (no remote — callers surface that to the user). Tags have no per-tag
 * upstream of their own, so this mirrors what `git push <remote> <tag>` needs.
 */
export function defaultRemote(refs: Refs): string | null {
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

const EMPTY_ACTIVE = {
  activePath: null as string | null,
  meta: null as RepoMeta | null,
  status: [] as FileStatus[],
  commits: [] as Commit[],
  unstagedDiffs: [] as FileDiff[],
  stagedDiffs: [] as FileDiff[],
  localSelection: null as LocalSelection | null,
  lastDiscard: null as { patch: string; label: string; path: string } | null,
  selectedFile: null as string | null,
  fileReturn: null as string | null,
  selectedCommit: null as string | null,
  selectedCommitDiffs: [] as FileDiff[],
  selectedCommitDiffsLoading: false,
  revealCommit: null as string | null,
  refs: EMPTY_REFS,
  remoteTags: null as string[] | null,
  stashes: [] as Stash[],
  workTree: [] as WorkTreeEntry[],
  submodules: [] as Submodule[],
  reflog: [] as ReflogEntry[],
  recentMessages: [] as StoredMessage[],
};

/**
 * The refresh every history op (cherry-pick / revert / merge / rebase /
 * abort) runs once git returns: meta (branch + `operation` banner state),
 * local changes (staged squash result or conflict markers), the log (new or
 * rewritten commits), and refs (tips moved). Both the success tail and a
 * post-abort cleanup share it.
 */
async function refreshAfterHistoryOp(get: () => RepoState): Promise<void> {
  await Promise.all([
    get().refreshMeta(),
    get().refreshLocalChanges(),
    get().refreshLog(),
    get().refreshRefs(),
  ]);
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

  view: 'local',
  fileTab: 'content',
  selectedRef: null,

  async restoreSession() {
    let saved: PersistedSession | null = null;
    try {
      saved = await settingsDb.get<PersistedSession>(SESSION_KEY);
    } catch (e) {
      console.warn('session load failed', e);
    }
    if (!saved || saved.tabs.length === 0) return;

    // Open each saved tab; openRepo handles dedupe and tolerates failures
    // (a repo may have moved or been deleted since last launch).
    for (const path of saved.tabs) {
      try {
        await get().openRepo(path);
      } catch (e) {
        console.warn(`restoreSession: failed to open ${path}`, e);
      }
    }
    if (saved.activeTabPath) {
      const stillOpen = get().tabs.some((t) => t.path === saved!.activeTabPath);
      if (stillOpen && get().activeTabPath !== saved.activeTabPath) {
        await get().setActiveTab(saved.activeTabPath);
      }
    }
  },

  async openRepo(path) {
    // If this path is already open, just focus it.
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      await get().setActiveTab(existing.path);
      return;
    }

    const meta = await tauri.repoOpen(path);

    // Rust may canonicalize the path; re-check against the canonical form.
    const already = get().tabs.find((t) => t.path === meta.path);
    if (already) {
      await get().setActiveTab(already.path);
      return;
    }

    const tab: RepoTab = { path: meta.path, meta };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabPath: meta.path,
      activePath: meta.path,
      meta,
      status: [],
      commits: [],
      unstagedDiffs: [],
      stagedDiffs: [],
      localSelection: null,
      selectedFile: null,
      fileReturn: null,
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
      refs: EMPTY_REFS,
      remoteTags: null,
      stashes: [],
      workTree: [],
      submodules: [],
      reflog: [],
      recentMessages: [],
    }));

    try {
      await recentsDb.touch(meta.path, meta.name);
      await get().refreshRecents();
    } catch (e) {
      console.warn('recents.touch failed', e);
    }
    void persistSession(get());
    void get().loadRepoDiffMode();
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshRefs(),
      get().refreshStashes(),
      get().refreshSubmodules(),
      get().refreshRecentMessages(),
    ]);
  },

  closeTab(path) {
    const { tabs, activeTabPath } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const nextTabs = tabs.filter((t) => t.path !== path);

    if (activeTabPath !== path) {
      set({ tabs: nextTabs });
      void persistSession(get());
      return;
    }

    // Closed the active tab — pick a neighbor, or fall back to empty state.
    const neighbor = nextTabs[idx] ?? nextTabs[idx - 1] ?? null;
    set({
      tabs: nextTabs,
      activeTabPath: neighbor?.path ?? null,
      activePath: neighbor?.path ?? null,
      meta: neighbor?.meta ?? null,
      status: [],
      commits: [],
      unstagedDiffs: [],
      stagedDiffs: [],
      localSelection: null,
      selectedFile: null,
      fileReturn: null,
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
      refs: EMPTY_REFS,
      remoteTags: null,
      stashes: [],
      workTree: [],
      submodules: [],
      reflog: [],
      recentMessages: [],
    });
    void persistSession(get());
    if (neighbor) {
      void Promise.all([
        get().refreshLocalChanges(),
        get().refreshLog(),
        get().refreshRefs(),
        get().refreshRecentMessages(),
      ]);
    }
  },

  async setActiveTab(path) {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || get().activeTabPath === path) return;
    set({
      activeTabPath: path,
      activePath: path,
      meta: tab.meta,
      status: [],
      commits: [],
      unstagedDiffs: [],
      stagedDiffs: [],
      localSelection: null,
      selectedFile: null,
      fileReturn: null,
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
      refs: EMPTY_REFS,
      remoteTags: null,
      stashes: [],
      workTree: [],
      submodules: [],
      reflog: [],
      recentMessages: [],
    });
    void persistSession(get());
    void get().loadRepoDiffMode();
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshRefs(),
      get().refreshStashes(),
      get().refreshSubmodules(),
      get().refreshRecentMessages(),
    ]);
  },

  async refreshStatus() {
    const path = get().activePath;
    if (!path) return;
    const status = await tauri.repoStatus(path);
    // Bail if the active repo changed while the request was in flight, or we'd
    // paint another tab's status into this one (see refreshTree).
    if (get().activePath !== path) return;
    set({ status });
  },
  async refreshLog(limit) {
    const path = get().activePath;
    if (!path) return;
    const commits = await tauri.repoLog(path, limit ?? 500);
    if (get().activePath !== path) return;
    set({ commits });
  },
  async refreshDiffs() {
    const path = get().activePath;
    if (!path) return;
    const [unstaged, staged] = await Promise.all([
      tauri.repoDiffUnstaged(path),
      tauri.repoDiffStaged(path),
    ]);
    if (get().activePath !== path) return;
    set({ unstagedDiffs: unstaged, stagedDiffs: staged });

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

  async refreshLocalChanges() {
    await Promise.all([get().refreshStatus(), get().refreshDiffs()]);
  },

  async refreshRefs() {
    const path = get().activePath;
    if (!path) return;
    try {
      const refs = await tauri.repoRefs(path);
      if (get().activePath !== path) return;
      set({ refs });
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
      set({ workTree: tree });
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
      set({ submodules });
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

  async refreshRecentMessages() {
    const path = get().activePath;
    if (!path) return;
    try {
      const messages = await commitMessagesDb.list(path, 8);
      if (get().activePath !== path) return;
      set({ recentMessages: messages });
    } catch (e) {
      console.warn('commitMessages.list failed', e);
    }
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
    await tauri.repoStageMany(path, files);
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
    await tauri.repoDiscardMany(path, files);
    await get().refreshLocalChanges();
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
    const path = get().activePath;
    // Guard the handle against the active repo: a discard recorded in one
    // tab must not be replayed into another. A mismatch just drops it.
    if (!last || !path || last.path !== path) {
      set({ lastDiscard: null });
      return;
    }
    set({ lastDiscard: null });
    await tauri.repoApplyPatch(path, last.patch, 'workdir');
    await get().refreshLocalChanges();
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
    if (mode && get().activePath === path) useSettings.getState().set('diffMode', mode);
  },
  async stageAll() {
    const path = get().activePath;
    if (!path) return;
    const files = get().unstagedDiffs.map((d) => d.path);
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
    // Stash the message for the recent-messages dropdown (best-effort — a
    // history miss must never block the commit flow).
    try {
      await commitMessagesDb.record(path, subject, body ?? '');
    } catch (e) {
      console.warn('commitMessages.record failed', e);
    }
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshMeta(),
      get().refreshRefs(),
      get().refreshStashes(),
      get().refreshRecentMessages(),
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
  async fetch(onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoFetch(path, null, onProgress);
    await Promise.all([get().refreshMeta(), get().refreshRefs()]);
    return res.output;
  },
  async pull(rebase = false, onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoPull(path, rebase, onProgress);
    await Promise.all([
      get().refreshMeta(),
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshRefs(),
    ]);
    return res.output;
  },
  async push(forceWithLease = false, onProgress) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoPush(path, forceWithLease, onProgress);
    await Promise.all([get().refreshMeta(), get().refreshRefs()]);
    return res.output;
  },

  async checkout(branch) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoCheckout(path, branch);
    await Promise.all([
      get().refreshMeta(),
      get().refreshRefs(),
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshSubmodules(),
    ]);
  },
  async checkoutCommit(rev) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoCheckoutCommit(path, rev);
    await Promise.all([
      get().refreshMeta(),
      get().refreshRefs(),
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshSubmodules(),
    ]);
  },
  async createBranch(name, startPoint, checkout) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoBranchCreate(path, name, startPoint, checkout);
    await Promise.all([
      get().refreshMeta(),
      get().refreshRefs(),
      ...(checkout ? [get().refreshLocalChanges(), get().refreshLog()] : []),
    ]);
  },
  async deleteBranch(name, force) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoBranchDelete(path, name, force);
    await get().refreshRefs();
  },

  // History ops change HEAD, the working tree, the log and refs — refresh all
  // four afterward (in `finally`, so a real failure still re-syncs). On a
  // conflict the op resolves `true`: jump to Local Changes and clear the
  // selection so the conflict bar opens the first conflicted file.
  async cherryPick(commits) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoCherryPick(path, commits);
    });
  },
  async revert(commits) {
    return runHistoryOp(get, set, () => {
      const path = get().activePath;
      if (!path) throw new Error('no repo open');
      return tauri.repoRevert(path, commits);
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
  async abortOperation() {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    try {
      await tauri.repoAbortOperation(path);
    } finally {
      await refreshAfterHistoryOp(get);
    }
  },
  async resolveConflict(file, contents) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoResolveConflict(path, file, contents);
    // Status drives the Conflicts list; diffs/meta keep the rest in sync.
    await Promise.all([get().refreshStatus(), get().refreshDiffs(), get().refreshMeta()]);
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
  async stashDrop(index) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    await tauri.repoStashDrop(path, index);
    await get().refreshStashes();
  },

  selectLocalFile: (sel) => set({ localSelection: sel }),

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

  async refreshRecents() {
    try {
      set({ recents: await recentsDb.list() });
    } catch (e) {
      console.warn('recents.list failed', e);
    }
  },
  async forgetRecent(path) {
    await recentsDb.forget(path);
    await get().refreshRecents();
  },

  setView: (view) => set({ view }),
  revealInGraph: (hash) => set({ view: 'commits', revealCommit: hash }),
  clearReveal: () => set({ revealCommit: null }),
  // Opening a file resets the file-view tab to Content and drops any stale
  // back-target; closing (null) just drops the back-target.
  selectFile: (selectedFile) =>
    set({
      selectedFile,
      view: selectedFile ? 'file' : get().view,
      fileReturn: null,
      ...(selectedFile ? { fileTab: 'content' as FileTab } : {}),
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
