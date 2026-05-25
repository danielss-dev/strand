import { create } from 'zustand';

import { tauri } from '../lib/tauri';
import type { Commit, FileStatus, RepoMeta } from '../lib/types';

export type View = 'local' | 'commits' | 'file' | 'branch';

export interface RepoState {
  activePath: string | null;
  meta: RepoMeta | null;
  status: FileStatus[];
  commits: Commit[];

  view: View;
  selectedFile: string | null;
  selectedRef: string | null;

  openRepo(path: string): Promise<void>;
  refreshStatus(): Promise<void>;
  refreshLog(limit?: number): Promise<void>;

  setView(view: View): void;
  selectFile(path: string | null): void;
  selectRef(ref: string | null): void;
}

export const useRepo = create<RepoState>((set, get) => ({
  activePath: null,
  meta: null,
  status: [],
  commits: [],

  view: 'local',
  selectedFile: null,
  selectedRef: null,

  async openRepo(path) {
    const meta = await tauri.repoOpen(path);
    set({ activePath: meta.path, meta, status: [], commits: [] });
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

  setView: (view) => set({ view }),
  selectFile: (selectedFile) => set({ selectedFile, view: selectedFile ? 'file' : get().view }),
  selectRef: (selectedRef) => set({ selectedRef }),
}));
