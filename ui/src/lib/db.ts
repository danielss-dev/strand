import Database from '@tauri-apps/plugin-sql';

import type { DiffMode } from '../stores/settings';
import type {
  NetworkPreferences,
  PullMode,
  PullRequestReviewDraft,
  RecentRepo,
  RepoActivityEntry,
  RepoIcon,
  ReviewNote,
  Workspace,
  EmbeddedShellChoice,
} from './types';
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

  async remove(key: string): Promise<void> {
    if (!isTauri()) return;
    const d = await db();
    await d.execute('DELETE FROM settings WHERE key = $1', [key]);
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

/** Repository-scoped scratchpad content stored in Strand's app database. */
export const quickNotes = {
  get(repoPath: string): Promise<string | null> {
    return settings.get<string>(`quick-notes:${repoPath}`);
  },
  set(repoPath: string, note: string): Promise<void> {
    return settings.set(`quick-notes:${repoPath}`, note);
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

type ReviewNotes = Record<string, ReviewNote[]>;

/** Versioned envelope for notes from independent review comparisons. */
interface StoredReviewNotesV2 {
  version: 2;
  activeScope: string;
  scopes: Record<string, ReviewNotes>;
  /** Most-recent first; bounds abandoned review sessions in SQLite. */
  order: string[];
}

const MAX_REVIEW_NOTE_SCOPES = 12;

function isStoredReviewNotesV2(value: unknown): value is StoredReviewNotesV2 {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredReviewNotesV2>;
  return (
    candidate.version === 2 &&
    typeof candidate.activeScope === 'string' &&
    candidate.scopes != null &&
    typeof candidate.scopes === 'object' &&
    Array.isArray(candidate.order)
  );
}

/**
 * Read one comparison's notes from the persisted value. A pre-v2 plain map is
 * treated as belonging to the first scope opened after upgrade; the caller
 * then writes the returned migration so existing notes are preserved.
 */
export function readReviewNotesForScope(
  value: unknown,
  scope: string,
): { notes: ReviewNotes; migration: StoredReviewNotesV2 | null } {
  if (isStoredReviewNotesV2(value)) {
    return { notes: value.scopes[scope] ?? {}, migration: null };
  }
  const notes =
    value != null && typeof value === 'object' ? (value as ReviewNotes) : {};
  return {
    notes,
    migration: {
      version: 2,
      activeScope: scope,
      scopes: { [scope]: notes },
      order: [scope],
    },
  };
}

/** Replace one scope without disturbing notes saved for other comparisons. */
export function writeReviewNotesForScope(
  value: unknown,
  scope: string,
  notes: ReviewNotes,
): StoredReviewNotesV2 {
  const current = isStoredReviewNotesV2(value)
    ? value
    : readReviewNotesForScope(value, scope).migration!;
  const order = [scope, ...current.order.filter((key) => key !== scope)]
    .slice(0, MAX_REVIEW_NOTE_SCOPES);
  const scopes = { ...current.scopes, [scope]: notes };
  for (const key of Object.keys(scopes)) {
    if (!order.includes(key)) delete scopes[key];
  }
  return { version: 2, activeScope: scope, scopes, order };
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
  async getNotes(repoPath: string, scope?: string): Promise<ReviewNotes | null> {
    const key = `review-notes:${repoPath}`;
    const stored = await settings.get<unknown>(key);
    if (!scope) {
      if (isStoredReviewNotesV2(stored)) {
        return stored.scopes[stored.activeScope] ?? {};
      }
      return stored as ReviewNotes | null;
    }
    if (stored == null) return null;
    const { notes, migration } = readReviewNotesForScope(stored, scope);
    if (migration) await settings.set(key, migration);
    return notes;
  },
  async setNotes(repoPath: string, notes: ReviewNotes, scope?: string): Promise<void> {
    const key = `review-notes:${repoPath}`;
    const stored = await settings.get<unknown>(key);
    if (scope) {
      await settings.set(key, writeReviewNotesForScope(stored, scope, notes));
      return;
    }
    // Compatibility for callers not yet supplying a scope: once a v2 record
    // exists, update its active bucket instead of flattening it back to v1.
    if (isStoredReviewNotesV2(stored)) {
      await settings.set(
        key,
        writeReviewNotesForScope(stored, stored.activeScope, notes),
      );
      return;
    }
    await settings.set(key, notes);
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
 * Per-repo default pull integration strategy. `default` delegates to Git's
 * own configuration; an explicit value overrides it for the normal Pull
 * button, shortcut, and Sync flow. Explicit one-off menu actions do not write
 * this preference.
 */
export const repoPullMode = {
  get(repoPath: string): Promise<PullMode | null> {
    return settings.get<PullMode>(`pull-mode:${repoPath}`);
  },
  set(repoPath: string, mode: PullMode): Promise<void> {
    return settings.set(`pull-mode:${repoPath}`, mode);
  },
};

/** Local viewed-file state for a hosted pull request. Each stored value is a
 * head-SHA + file-patch fingerprint, so a provider update invalidates only
 * the files whose review evidence is stale. */
export const pullRequestReview = {
  getViewed(reviewKey: string): Promise<Record<string, string> | null> {
    return settings.get<Record<string, string>>(`pull-request-reviewed:${reviewKey}`);
  },
  setViewed(reviewKey: string, viewed: Record<string, string>): Promise<void> {
    return settings.set(`pull-request-reviewed:${reviewKey}`, viewed);
  },
  getDraft(reviewKey: string): Promise<PullRequestReviewDraft | null> {
    return settings.get<PullRequestReviewDraft>(`pull-request-draft:${reviewKey}`);
  },
  setDraft(reviewKey: string, draft: PullRequestReviewDraft): Promise<void> {
    return settings.set(`pull-request-draft:${reviewKey}`, draft);
  },
};

/** Explicit defaults for the active repository's Fetch and Pull actions. */
export const repoNetworkPreferences = {
  get(repoPath: string): Promise<NetworkPreferences | null> {
    return settings.get<NetworkPreferences>(`network-preferences:${repoPath}`);
  },
  set(repoPath: string, preferences: NetworkPreferences): Promise<void> {
    return settings.set(`network-preferences:${repoPath}`, preferences);
  },
};

/** Durable, bounded transcript of explicit repository housekeeping runs. */
export const repoActivity = {
  async list(repoPath: string): Promise<RepoActivityEntry[]> {
    return (await settings.get<RepoActivityEntry[]>(`repo-activity:${repoPath}`)) ?? [];
  },
  async append(repoPath: string, entry: RepoActivityEntry): Promise<RepoActivityEntry[]> {
    const existing = (await settings.get<RepoActivityEntry[]>(`repo-activity:${repoPath}`)) ?? [];
    // A pathological fsck can print megabytes. Preserve a useful transcript
    // without letting repeated checks bloat the settings database forever.
    const bounded = entry.output.length > 50_000
      ? { ...entry, output: `${entry.output.slice(0, 50_000)}\n\n[output truncated at 50,000 characters]` }
      : entry;
    const entries = [bounded, ...existing].slice(0, 50);
    await settings.set(`repo-activity:${repoPath}`, entries);
    return entries;
  },
};

/** Per-repository-family guidance for AI-generated commit and PR text. */
export const repoAiStyle = {
  get(commonDir: string): Promise<string | null> {
    return settings.get<string>(`ai-style:${commonDir}`);
  },
  set(commonDir: string, instruction: string): Promise<void> {
    return settings.set(`ai-style:${commonDir}`, instruction.slice(0, 1_000));
  },
};

/** Per-repository-family embedded shell override. Linked worktrees share it
 * through RepoMeta.common_dir; null means "Use global". */
export const repoEmbeddedShell = {
  get(commonDir: string): Promise<EmbeddedShellChoice | null> {
    return settings.get<EmbeddedShellChoice>(`embedded-shell:${commonDir}`);
  },
  set(commonDir: string, shell: EmbeddedShellChoice | null): Promise<void> {
    return settings.set(`embedded-shell:${commonDir}`, shell);
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
