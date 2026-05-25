import { create } from 'zustand';

import { recents as recentsDb } from '../lib/db';
import { tauri } from '../lib/tauri';
import type { Commit, FileStatus, RecentRepo, RepoMeta } from '../lib/types';

export type View = 'local' | 'commits' | 'file' | 'branch';

/** One open repository in the topbar tab strip. */
export interface RepoTab {
  path: string;
  meta: RepoMeta;
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

  recents: RecentRepo[];

  view: View;
  selectedFile: string | null;
  selectedRef: string | null;

  openRepo(path: string): Promise<void>;
  closeTab(path: string): void;
  setActiveTab(path: string): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshLog(limit?: number): Promise<void>;

  refreshRecents(): Promise<void>;
  forgetRecent(path: string): Promise<void>;

  setView(view: View): void;
  selectFile(path: string | null): void;
  selectRef(ref: string | null): void;
}

const EMPTY_ACTIVE = {
  activePath: null as string | null,
  meta: null as RepoMeta | null,
  status: [] as FileStatus[],
  commits: [] as Commit[],
  selectedFile: null as string | null,
};

export const useRepo = create<RepoState>((set, get) => ({
  tabs: [],
  activeTabPath: null,

  ...EMPTY_ACTIVE,
  recents: [],

  view: 'local',
  selectedRef: null,

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
      selectedFile: null,
    }));

    try {
      await recentsDb.touch(meta.path, meta.name);
      await get().refreshRecents();
    } catch (e) {
      console.warn('recents.touch failed', e);
    }
    await Promise.all([get().refreshStatus(), get().refreshLog()]);
  },

  closeTab(path) {
    const { tabs, activeTabPath } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const nextTabs = tabs.filter((t) => t.path !== path);

    if (activeTabPath !== path) {
      set({ tabs: nextTabs });
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
      selectedFile: null,
    });
    if (neighbor) {
      void Promise.all([get().refreshStatus(), get().refreshLog()]);
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
      selectedFile: null,
    });
    await Promise.all([get().refreshStatus(), get().refreshLog()]);
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
