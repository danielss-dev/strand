import Database from '@tauri-apps/plugin-sql';

import type { RecentRepo } from './types';
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

/** A stored commit message, newest first. */
export interface StoredMessage {
  subject: string;
  body: string;
}

/**
 * Per-repo commit message history, backing the "recent messages" dropdown on
 * the commit form. Recording de-dupes an identical message to the top rather
 * than piling up copies.
 */
export const commitMessages = {
  async list(repoPath: string, limit = 8): Promise<StoredMessage[]> {
    if (!isTauri()) return [];
    const d = await db();
    return d.select<StoredMessage[]>(
      `SELECT subject, body FROM commit_messages WHERE repo_path = $1
       ORDER BY committed_at DESC, id DESC LIMIT $2`,
      [repoPath, limit],
    );
  },

  async record(repoPath: string, subject: string, body: string): Promise<void> {
    if (!isTauri()) return;
    const d = await db();
    const now = Math.floor(Date.now() / 1000);
    // Drop a prior identical message so re-using one bubbles it to the top
    // instead of creating a duplicate row.
    await d.execute(
      'DELETE FROM commit_messages WHERE repo_path = $1 AND subject = $2 AND body = $3',
      [repoPath, subject, body],
    );
    await d.execute(
      `INSERT INTO commit_messages (repo_path, subject, body, committed_at)
       VALUES ($1, $2, $3, $4)`,
      [repoPath, subject, body, now],
    );
  },
};

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
