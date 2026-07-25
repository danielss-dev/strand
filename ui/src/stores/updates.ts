import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';

import { UPDATES_MANAGED_BY_STORE } from '../lib/distribution';

/**
 * App-update state (Settings → Updates + the launch auto-check). One store so
 * the section and App's auto-check effect share a single in-flight update.
 *
 * The endpoint may simply not be reachable yet (it ships before the server
 * goes live), so a failed check is a soft 'error' state, never a crash.
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'upToDate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

interface UpdatesState {
  status: UpdateStatus;
  /** Version of the available/downloaded update, when known. */
  version: string | null;
  /** Release notes for the available update, if the manifest carries any. */
  notes: string | null;
  error: string | null;
  received: number;
  total: number | null;
  check(): Promise<void>;
  downloadAndInstall(): Promise<void>;
  restart(): Promise<void>;
}

// The Update handle isn't serializable state — keep it module-level.
let pending: Update | null = null;

export const useUpdates = create<UpdatesState>()((set, get) => ({
  status: 'idle',
  version: null,
  notes: null,
  error: null,
  received: 0,
  total: null,

  async check() {
    if (UPDATES_MANAGED_BY_STORE) {
      pending = null;
      set({ status: 'upToDate', version: null, notes: null, error: null });
      return;
    }
    const { status } = get();
    if (status === 'checking' || status === 'downloading' || status === 'ready') return;
    set({ status: 'checking', error: null });
    try {
      const update = await check({ timeout: 10_000 });
      pending = update;
      if (update) {
        set({ status: 'available', version: update.version, notes: update.body ?? null });
      } else {
        set({ status: 'upToDate', version: null, notes: null });
      }
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },

  async downloadAndInstall() {
    if (UPDATES_MANAGED_BY_STORE) return;
    if (!pending || get().status !== 'available') return;
    set({ status: 'downloading', received: 0, total: null, error: null });
    try {
      await pending.downloadAndInstall((event) => {
        if (event.event === 'Started') set({ total: event.data.contentLength ?? null });
        else if (event.event === 'Progress')
          set({ received: get().received + event.data.chunkLength });
      });
      set({ status: 'ready' });
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },

  async restart() {
    await relaunch();
  },
}));
