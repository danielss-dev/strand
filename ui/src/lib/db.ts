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
