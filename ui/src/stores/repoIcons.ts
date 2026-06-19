import { create } from 'zustand';

import { repoIcon as repoIconDb } from '../lib/db';
import type { RepoIcon } from '../lib/types';

interface RepoIconsState {
  /** path → custom icon config. Absent ⇒ not loaded or no customization. */
  icons: Record<string, RepoIcon>;
  /** Paths whose config has been read from the DB (so a known-empty config
   *  doesn't get re-fetched on every render). */
  loaded: Set<string>;

  /** Read `path`'s saved icon into the store (once). Idempotent — concurrent
   *  ensures for the same path coalesce. */
  ensure(path: string): void;
  /**
   * Merge `patch` into `path`'s icon, persist it, and apply live. A field set
   * to null/empty is dropped so it falls back to the derived default; when the
   * whole config empties it's removed entirely.
   */
  setIcon(path: string, patch: RepoIcon): Promise<void>;
  /** Reset `path` to the derived defaults (clears the saved config). */
  clearIcon(path: string): Promise<void>;
}

/** Drop null/empty fields so an "unset" field falls back to its default. */
function clean(icon: RepoIcon): RepoIcon {
  const out: RepoIcon = {};
  if (icon.letter && icon.letter.trim()) out.letter = icon.letter.trim().slice(0, 2);
  if (icon.color) out.color = icon.color;
  if (icon.emoji && icon.emoji.trim()) out.emoji = icon.emoji.trim();
  if (icon.image) out.image = icon.image;
  return out;
}

const inFlight = new Set<string>();

export const useRepoIcons = create<RepoIconsState>((set, get) => ({
  icons: {},
  loaded: new Set<string>(),

  ensure(path) {
    if (get().loaded.has(path) || inFlight.has(path)) return;
    inFlight.add(path);
    void (async () => {
      try {
        const icon = await repoIconDb.get(path);
        set((s) => ({
          icons: icon ? { ...s.icons, [path]: icon } : s.icons,
          loaded: new Set(s.loaded).add(path),
        }));
      } catch (e) {
        console.warn('repoIcon load failed', e);
        set((s) => ({ loaded: new Set(s.loaded).add(path) }));
      } finally {
        inFlight.delete(path);
      }
    })();
  },

  async setIcon(path, patch) {
    const next = clean({ ...get().icons[path], ...patch });
    const empty = Object.keys(next).length === 0;
    set((s) => {
      const icons = { ...s.icons };
      if (empty) delete icons[path];
      else icons[path] = next;
      return { icons, loaded: new Set(s.loaded).add(path) };
    });
    try {
      await repoIconDb.set(path, empty ? null : next);
    } catch (e) {
      console.warn('repoIcon persist failed', e);
    }
  },

  async clearIcon(path) {
    set((s) => {
      const icons = { ...s.icons };
      delete icons[path];
      return { icons, loaded: new Set(s.loaded).add(path) };
    });
    try {
      await repoIconDb.set(path, null);
    } catch (e) {
      console.warn('repoIcon clear failed', e);
    }
  },
}));
