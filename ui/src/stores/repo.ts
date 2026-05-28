import { create } from 'zustand';

import { recents as recentsDb, settings as settingsDb } from '../lib/db';
import { tauri } from '../lib/tauri';
import type { Commit, FileDiff, FileStatus, RecentRepo, Refs, RepoMeta } from '../lib/types';

interface PersistedSession {
  tabs: string[];
  activeTabPath: string | null;
}
const SESSION_KEY = 'session.tabs';

export type View = 'local' | 'commits' | 'file' | 'branch';

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
   * Commit clicked in the All Commits graph. When non-null, the right-side
   * `<CommitDetail />` panel opens and `selectedCommitDiffs` is populated
   * from `repo_diff_commit`.
   */
  selectedCommit: string | null;
  selectedCommitDiffs: FileDiff[];
  selectedCommitDiffsLoading: boolean;

  /** Branches / remotes / tags for the active tab. */
  refs: Refs;

  recents: RecentRepo[];

  view: View;
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

  /** Refresh status + diffs together — what every write op runs afterward. */
  refreshLocalChanges(): Promise<void>;

  stage(file: string): Promise<void>;
  unstage(file: string): Promise<void>;
  discard(file: string): Promise<void>;
  /**
   * Apply a unified-diff patch (typically a single hunk sliced out of a
   * file's full patch) to either the index or the working tree in reverse.
   * Powers per-hunk Accept / Reject in the unstaged diff.
   */
  applyPatch(patch: string, target: 'index' | 'workdir_reverse'): Promise<void>;
  stageAll(): Promise<void>;
  unstageAll(): Promise<void>;
  commit(subject: string, body: string | null, amend: boolean): Promise<void>;

  /** Re-read RepoMeta (branch, ahead/behind) for the active tab. */
  refreshMeta(): Promise<void>;
  fetch(): Promise<string>;
  pull(rebase?: boolean): Promise<string>;
  push(forceWithLease?: boolean): Promise<string>;

  checkout(branch: string): Promise<void>;
  createBranch(name: string, startPoint: string | null, checkout: boolean): Promise<void>;
  deleteBranch(name: string, force: boolean): Promise<void>;

  selectLocalFile(sel: LocalSelection | null): void;
  /** Open the commit-detail panel for `hash`, or close it when null. */
  selectCommit(hash: string | null): Promise<void>;

  refreshRecents(): Promise<void>;
  forgetRecent(path: string): Promise<void>;

  setView(view: View): void;
  selectFile(path: string | null): void;
  selectRef(ref: string | null): void;
}

const EMPTY_REFS: Refs = { branches: [], remotes: [], remote_branches: [], tags: [] };

const EMPTY_ACTIVE = {
  activePath: null as string | null,
  meta: null as RepoMeta | null,
  status: [] as FileStatus[],
  commits: [] as Commit[],
  unstagedDiffs: [] as FileDiff[],
  stagedDiffs: [] as FileDiff[],
  localSelection: null as LocalSelection | null,
  selectedFile: null as string | null,
  selectedCommit: null as string | null,
  selectedCommitDiffs: [] as FileDiff[],
  selectedCommitDiffsLoading: false,
  refs: EMPTY_REFS,
};

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
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
      refs: EMPTY_REFS,
    }));

    try {
      await recentsDb.touch(meta.path, meta.name);
      await get().refreshRecents();
    } catch (e) {
      console.warn('recents.touch failed', e);
    }
    void persistSession(get());
    await Promise.all([get().refreshLocalChanges(), get().refreshLog(), get().refreshRefs()]);
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
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
      refs: EMPTY_REFS,
    });
    void persistSession(get());
    if (neighbor) {
      void Promise.all([get().refreshLocalChanges(), get().refreshLog(), get().refreshRefs()]);
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
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
      refs: EMPTY_REFS,
    });
    void persistSession(get());
    await Promise.all([get().refreshLocalChanges(), get().refreshLog(), get().refreshRefs()]);
  },

  async refreshStatus() {
    const path = get().activePath;
    if (!path) return;
    set({ status: await tauri.repoStatus(path) });
  },
  async refreshLog(limit) {
    const path = get().activePath;
    if (!path) return;
    set({ commits: await tauri.repoLog(path, limit ?? 500) });
  },
  async refreshDiffs() {
    const path = get().activePath;
    if (!path) return;
    const [unstaged, staged] = await Promise.all([
      tauri.repoDiffUnstaged(path),
      tauri.repoDiffStaged(path),
    ]);
    set({ unstagedDiffs: unstaged, stagedDiffs: staged });

    // If the selected file is no longer present (it was just staged in full,
    // for example) move the selection to a sibling so the middle pane keeps
    // showing something useful.
    const sel = get().localSelection;
    if (sel) {
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
      set({ refs: await tauri.repoRefs(path) });
    } catch (e) {
      console.warn('repoRefs failed', e);
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
  async applyPatch(patch, target) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoApplyPatch(path, patch, target);
    await get().refreshLocalChanges();
  },
  async stageAll() {
    const path = get().activePath;
    if (!path) return;
    const files = get().unstagedDiffs.map((d) => d.path);
    for (const f of files) await tauri.repoStage(path, f);
    await get().refreshLocalChanges();
  },
  async unstageAll() {
    const path = get().activePath;
    if (!path) return;
    const files = get().stagedDiffs.map((d) => d.path);
    for (const f of files) await tauri.repoUnstage(path, f);
    await get().refreshLocalChanges();
  },
  async commit(subject, body, amend) {
    const path = get().activePath;
    if (!path) return;
    await tauri.repoCommit(path, subject, body, amend);
    await Promise.all([
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshMeta(),
      get().refreshRefs(),
    ]);
  },

  async refreshMeta() {
    const path = get().activePath;
    if (!path) return;
    const meta = await tauri.repoMeta(path);
    set((s) => ({
      meta,
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, meta } : t)),
    }));
  },
  async fetch() {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoFetch(path, null);
    await Promise.all([get().refreshMeta(), get().refreshRefs()]);
    return res.output;
  },
  async pull(rebase = false) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoPull(path, rebase);
    await Promise.all([
      get().refreshMeta(),
      get().refreshLocalChanges(),
      get().refreshLog(),
      get().refreshRefs(),
    ]);
    return res.output;
  },
  async push(forceWithLease = false) {
    const path = get().activePath;
    if (!path) throw new Error('no repo open');
    const res = await tauri.repoPush(path, forceWithLease);
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
  selectFile: (selectedFile) => set({ selectedFile, view: selectedFile ? 'file' : get().view }),
  selectRef: (selectedRef) => set({ selectedRef }),
}));
