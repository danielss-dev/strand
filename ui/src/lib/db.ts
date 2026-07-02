import Database from '@tauri-apps/plugin-sql';

import type { DiffMode } from '../stores/settings';
import type { RecentRepo, RepoIcon, ReviewNote, Workspace } from './types';
import { isTauri } from './tauri';

const DB_URL = 'sqlite:strand.db';

let dbPromise: Promise<Database> | null = null;

function db(): Promise<Database> {
  if (!isTauri()) return Promise.reject(new Error('SQLite unavailable outside Tauri'));
  if (!dbPromise) dbPromise = Database.load(DB_URL);
  return dbPromise;
}

export const recents = {
  async list(limit = 20): Promise<RecentRepo[]> {
    if (!isTauri()) return [];
    const d = await db();
    return d.select<RecentRepo[]>(
      'SELECT path, name, last_opened FROM recent_repos ORDER BY last_opened DESC LIMIT $1',
      [limit],
    );
  },

  async touch(path: string, name: string): Promise<void> {
    if (!isTauri()) return;
    const d = await db();
    const now = Math.floor(Date.now() / 1000);
    await d.execute(
      `INSERT INTO recent_repos (path, name, last_opened) VALUES ($1, $2, $3)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened = excluded.last_opened`,
      [path, name, now],
    );
  },

  async forget(path: string): Promise<void> {
    if (!isTauri()) return;
    const d = await db();
    await d.execute('DELETE FROM recent_repos WHERE path = $1', [path]);
  },
};

// The `commit_messages` table (migration v2) once backed a "recent messages"
// dropdown on the commit form; the feature was removed 2026-07-02 (stale
// old messages made no sense next to AI suggestions). The migration stays —
// applied migrations are append-only (see docs/learnings.md) — the table is
// just no longer read or written.

/**
 * Generic JSON-valued key/value store backed by the `settings` SQLite table.
 * Use for things that should survive relaunch but aren't repo content —
 * open tabs, last-active tab, theme preference, etc.
 */
export const settings = {
  async get<T>(key: string): Promise<T | null> {
    if (!isTauri()) return null;
    const d = await db();
    const rows = await d.select<{ value: string }[]>(
      'SELECT value FROM settings WHERE key = $1',
      [key],
    );
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].value) as T;
    } catch {
      return null;
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    if (!isTauri()) return;
    const d = await db();
    await d.execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  },
};

/**
 * Per-repo cache of the tag names present on the default remote. Lets the
 * sidebar paint the "delete on remote" gray-out state instantly on open while
 * a fresh `ls-remote` revalidates in the background (stale-while-revalidate).
 * It's a cache, not source of truth — a miss just means we wait for the
 * network that once. Stored in the generic `settings` table, keyed by path.
 */
export const remoteTagsCache = {
  get(repoPath: string): Promise<string[] | null> {
    return settings.get<string[]>(`remote-tags:${repoPath}`);
  },
  set(repoPath: string, tags: string[]): Promise<void> {
    return settings.set(`remote-tags:${repoPath}`, tags);
  },
};

/** A pinned review baseline: "show me everything since this commit". */
export interface StoredBaseline {
  /** Full OID of the baseline commit. */
  oid: string;
  short: string;
  /** Unix ms when the baseline was pinned (drives the chip's time label). */
  setAt: number;
}

/**
 * Per-repo review session state: the pinned baseline and the reviewed-file
 * map (`path → hash of the reviewed diff`). Persisted so an app restart
 * mid-review doesn't lose your place. A file whose diff changes after being
 * marked reviewed naturally flips back — its stored hash no longer matches.
 */
export const reviewSession = {
  getBaseline(repoPath: string): Promise<StoredBaseline | null> {
    return settings.get<StoredBaseline>(`baseline:${repoPath}`);
  },
  setBaseline(repoPath: string, baseline: StoredBaseline | null): Promise<void> {
    return settings.set(`baseline:${repoPath}`, baseline);
  },
  getReviewed(repoPath: string): Promise<Record<string, string> | null> {
    return settings.get<Record<string, string>>(`reviewed:${repoPath}`);
  },
  setReviewed(repoPath: string, reviewed: Record<string, string>): Promise<void> {
    return settings.set(`reviewed:${repoPath}`, reviewed);
  },
  getNotes(repoPath: string): Promise<Record<string, ReviewNote[]> | null> {
    return settings.get<Record<string, ReviewNote[]>>(`review-notes:${repoPath}`);
  },
  setNotes(repoPath: string, notes: Record<string, ReviewNote[]>): Promise<void> {
    return settings.set(`review-notes:${repoPath}`, notes);
  },
};

/**
 * Per-repo rail tile customization (color / initials / emoji / image). A null
 * means the repo uses the derived defaults. Stored in the generic `settings`
 * table, keyed by repo path, so it survives relaunch and is shared by every
 * tab/worktree pointing at that path.
 */
export const repoIcon = {
  get(repoPath: string): Promise<RepoIcon | null> {
    return settings.get<RepoIcon>(`repo-icon:${repoPath}`);
  },
  set(repoPath: string, icon: RepoIcon | null): Promise<void> {
    return settings.set(`repo-icon:${repoPath}`, icon);
  },
};

/**
 * Per-repo diff layout (stacked / split). A null means the repo has no explicit
 * choice yet, in which case `useSettings.defaultDiffLayout` (Settings → Diff)
 * applies. Stored in the generic `settings` table, keyed by repo path. Only an
 * explicit toggle writes a row, so a repo follows the default until the user
 * picks a layout for it.
 */
export const repoDiffMode = {
  get(repoPath: string): Promise<DiffMode | null> {
    return settings.get<DiffMode>(`diff-mode:${repoPath}`);
  },
  set(repoPath: string, mode: DiffMode): Promise<void> {
    return settings.set(`diff-mode:${repoPath}`, mode);
  },
};

/**
 * Repo workspaces (named multi-repo groups). The whole list lives under one
 * `workspaces` key and the active-workspace id under `active-workspace`, both
 * in the generic `settings` table — no dedicated table/migration. Membership is
 * plumbed by canonical repo path; see {@link Workspace}.
 */
export const workspacesDb = {
  list(): Promise<Workspace[] | null> {
    return settings.get<Workspace[]>('workspaces');
  },
  save(list: Workspace[]): Promise<void> {
    return settings.set('workspaces', list);
  },
  getActive(): Promise<string | null> {
    return settings.get<string>('active-workspace');
  },
  setActive(id: string | null): Promise<void> {
    return settings.set('active-workspace', id);
  },
};
