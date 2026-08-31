/**
 * Pure helpers that turn a Heroi assistant turn's activity rows into a
 * chat-first summary: file edits attributed to this turn, and a single
 * grouped tool-call block (instead of stacking every activity under the bubble).
 */

export type HeroiFileChangeKind = 'added' | 'changed' | 'deleted';

export interface HeroiFileChange {
  path: string;
  kind: HeroiFileChangeKind;
}

export interface HeroiActivityLike {
  id: string;
  label: string;
  detail?: string;
  state: 'running' | 'done' | 'stopped' | 'error';
}

const PATH_KEYS = new Set([
  'path',
  'file',
  'file_path',
  'filePath',
  'filepath',
  'target',
  'filename',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeKind(raw: string | undefined, fallback: HeroiFileChangeKind): HeroiFileChangeKind {
  const kind = (raw ?? '').toLowerCase();
  if (kind === 'add' || kind === 'added' || kind === 'create' || kind === 'created' || kind === 'new') {
    return 'added';
  }
  if (kind === 'delete' || kind === 'deleted' || kind === 'remove' || kind === 'removed') {
    return 'deleted';
  }
  if (kind === 'update' || kind === 'updated' || kind === 'modify' || kind === 'modified' || kind === 'edit' || kind === 'edited' || kind === 'change' || kind === 'changed') {
    return 'changed';
  }
  return fallback;
}

function kindFromLabel(label: string): HeroiFileChangeKind {
  const lower = label.toLowerCase();
  if (/\b(delete|remove|unlink)\b/.test(lower)) return 'deleted';
  if (/\b(write|create|add|new_file|new file)\b/.test(lower)) return 'added';
  return 'changed';
}

function looksLikePath(value: string): boolean {
  if (!value || value.length > 512) return false;
  if (/\s/.test(value) && !value.includes('/') && !value.includes('\\')) return false;
  if (/[\n\r\0]/.test(value)) return false;
  // Prefer repo-ish paths over bare commands / URLs.
  if (/^[a-z]+:\/\//i.test(value)) return false;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}$/.test(value);
}

export function relativizeRepoPath(path: string, projectPath: string): string {
  const normalized = path.replace(/\\/g, '/');
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return normalized.replace(/^\.\//, '');
  if (normalized === root) return normalized;
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized.replace(/^\.\//, '');
}

function mergeKinds(
  previous: HeroiFileChangeKind | undefined,
  next: HeroiFileChangeKind,
): HeroiFileChangeKind {
  if (!previous) return next;
  if (previous === next) return previous;
  // delete then recreate → changed; otherwise prefer the stronger signal.
  if (previous === 'deleted' || next === 'deleted') {
    return previous === 'deleted' && next === 'added' ? 'changed' : 'deleted';
  }
  if (previous === 'added' || next === 'added') return 'added';
  return 'changed';
}

function pushChange(
  out: Map<string, HeroiFileChangeKind>,
  path: string,
  kind: HeroiFileChangeKind,
  projectPath: string,
): void {
  const relative = relativizeRepoPath(path.trim(), projectPath);
  if (!relative || !looksLikePath(relative)) return;
  out.set(relative, mergeKinds(out.get(relative), kind));
}

function collectFromUnknown(
  value: unknown,
  out: Map<string, HeroiFileChangeKind>,
  projectPath: string,
  fallbackKind: HeroiFileChangeKind,
  depth = 0,
): void {
  if (value == null || depth > 6) return;
  if (typeof value === 'string') {
    if (looksLikePath(value)) pushChange(out, value, fallbackKind, projectPath);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFromUnknown(entry, out, projectPath, fallbackKind, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;

  // Codex file_change: { changes: [{ path, kind }] }
  if (Array.isArray(record.changes)) {
    for (const entry of record.changes) {
      const change = asRecord(entry);
      if (!change) continue;
      const path = typeof change.path === 'string'
        ? change.path
        : typeof change.file_path === 'string'
          ? change.file_path
          : null;
      if (!path) continue;
      const kind = normalizeKind(
        typeof change.kind === 'string'
          ? change.kind
          : typeof change.type === 'string'
            ? change.type
            : undefined,
        fallbackKind,
      );
      pushChange(out, path, kind, projectPath);
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (PATH_KEYS.has(key) && typeof nested === 'string') {
      pushChange(out, nested, fallbackKind, projectPath);
      continue;
    }
    // Cursor / nested tool envelopes: writeToolCall / editToolCall / ...
    if (/write|edit|delete|file/i.test(key)) {
      const nestedKind = /delete|remove/i.test(key)
        ? 'deleted'
        : /write|create/i.test(key)
          ? 'added'
          : fallbackKind;
      collectFromUnknown(nested, out, projectPath, nestedKind, depth + 1);
      continue;
    }
    if (key === 'changes') continue;
    if (typeof nested === 'object') {
      collectFromUnknown(nested, out, projectPath, fallbackKind, depth + 1);
    }
  }
}

function parseDetailJson(detail: string): unknown | null {
  const trimmed = detail.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Fall through — some providers stream pretty JSON then append output.
    }
  }
  // Detail may be "pretty-json\n\noutput"; try the first JSON object/array.
  const start = trimmed.search(/[{\[]/);
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const slice = trimmed.slice(start, end).trimEnd();
    if (!(slice.endsWith('}') || slice.endsWith(']'))) continue;
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      // keep shrinking
    }
  }
  return null;
}

function isMutatingActivity(activity: HeroiActivityLike): boolean {
  const label = activity.label.toLowerCase();
  // Codex/Cursor use "Editing files"; Claude uses "Using Write" / "Using Edit" / …
  if (label.includes('editing files')) return true;
  if (/\b(write|edit|multiedit|delete|remove|notebookedit|apply.?patch|create)\b/.test(label)) {
    return true;
  }
  // Codex pretty-prints a changes[] array into detail for file_change items.
  if (activity.detail && /"kind"\s*:\s*"(add|delete|update)"/.test(activity.detail)) {
    return true;
  }
  return false;
}

/** Paths the agent mutated during this turn, derived from tool/activity payloads. */
export function fileChangesFromActivities(
  activities: readonly HeroiActivityLike[],
  projectPath = '',
): HeroiFileChange[] {
  const byPath = new Map<string, HeroiFileChangeKind>();
  for (const activity of activities) {
    if (!activity.detail || !isMutatingActivity(activity)) continue;
    const fallback = kindFromLabel(activity.label);
    const parsed = parseDetailJson(activity.detail);
    if (parsed != null) {
      collectFromUnknown(parsed, byPath, projectPath, fallback);
      continue;
    }
    for (const line of activity.detail.split('\n')) {
      const candidate = line.trim().replace(/^["']|["']$/g, '');
      if (looksLikePath(candidate)) pushChange(byPath, candidate, fallback, projectPath);
    }
  }
  const order: HeroiFileChangeKind[] = ['added', 'changed', 'deleted'];
  return [...byPath.entries()]
    .map(([path, kind]) => ({ path, kind }))
    .sort((a, b) => {
      const kindDelta = order.indexOf(a.kind) - order.indexOf(b.kind);
      return kindDelta !== 0 ? kindDelta : a.path.localeCompare(b.path);
    });
}

export function groupFileChanges(changes: readonly HeroiFileChange[]): {
  added: string[];
  changed: string[];
  deleted: string[];
} {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const change of changes) {
    if (change.kind === 'added') added.push(change.path);
    else if (change.kind === 'changed') changed.push(change.path);
    else deleted.push(change.path);
  }
  return { added, changed, deleted };
}

export function toolCallSummary(activities: readonly HeroiActivityLike[]): {
  total: number;
  running: number;
  failed: number;
} {
  let running = 0;
  let failed = 0;
  for (const activity of activities) {
    if (activity.state === 'running') running += 1;
    if (activity.state === 'error') failed += 1;
  }
  return { total: activities.length, running, failed };
}
