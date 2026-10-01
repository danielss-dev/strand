import type { DiffStatus, FileDiff, FileStatus, StatusKind } from '../../../lib/types';
import type { RepositorySnapshot } from '../../capabilities';

export type RecapState = 'no-repository' | 'empty' | 'ready';

export type RecapFileKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface RecapFile {
  path: string;
  kind: RecapFileKind;
}

export interface RecapTodo {
  path: string;
  text: string;
}

export interface RecapModel {
  state: RecapState;
  repoName: string | null;
  branch: string | null;
  head: string | null;
  linkedWorktree: boolean;
  dirty: boolean;
  baselineShort: string | null;
  files: RecapFile[];
  risky: RecapFile[];
  todos: RecapTodo[];
  patchesScanned: number;
}

export interface RecapInput {
  repo: RepositorySnapshot | null;
  linkedWorktree: boolean;
  baselineShort: string | null;
  status: readonly FileStatus[];
  diffs: readonly FileDiff[];
}

export const RECAP_FILE_LIMIT = 64;
export const RECAP_RISKY_LIMIT = 16;
export const RECAP_TODO_LIMIT = 16;
/** Bound patch reads so Recap cannot become a background whole-tree loader. */
export const RECAP_PATCH_SCAN_LIMIT = 16;

const RISK_SEGMENT = /^(auth|oauth|jwt|crypto|passwd|password|secret|secrets|credential|credentials|payment|billing|permission|permissions|rbac|kms)$/;
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/i;

export function statusKindToRecap(kind: StatusKind): RecapFileKind {
  switch (kind) {
    case 'ADDED':
      return 'added';
    case 'MODIFIED':
      return 'modified';
    case 'DELETED':
      return 'deleted';
    case 'RENAMED':
      return 'renamed';
    case 'UNTRACKED':
      return 'untracked';
    case 'CONFLICTED':
      return 'conflicted';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function diffStatusToRecap(status: DiffStatus): RecapFileKind {
  switch (status) {
    case 'added':
      return 'added';
    case 'modified':
      return 'modified';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'modified';
    case 'typechange':
      return 'modified';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Path heuristics only — not a secret sniffer and not Risk Radar. */
export function classifyRiskyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const base = normalized.split('/').pop() ?? normalized;
  if (/^\.env(\.|$)/.test(base)) return true;
  if (/\.(pem|p12|pfx|key)$/.test(base)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.|$)/.test(base)) return true;
  if (/(^|\/)(\.ssh|secrets?|credentials?)(\/|$)/.test(normalized)) return true;
  const segments = normalized.split('/');
  if (segments.some((segment) => RISK_SEGMENT.test(segment))) return true;
  if (segments.includes('migrations') || segments.includes('migrate')) return true;
  return false;
}

export function extractTodosFromPatch(path: string, patch: string): RecapTodo[] {
  if (!patch) return [];
  const todos: RecapTodo[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const match = TODO_RE.exec(line.slice(1));
    if (!match) continue;
    const marker = match[1].toUpperCase();
    const detail = match[2].trim();
    todos.push({ path, text: detail ? `${marker}: ${detail}` : marker });
  }
  return todos;
}

function patchIsLoaded(diff: FileDiff): boolean {
  return diff.patchLoaded !== false;
}

/** One row per path. A loaded patch wins over a later summary (`patchLoaded: false`). */
export function uniqueDiffs(...pools: readonly (readonly FileDiff[])[]): FileDiff[] {
  const byPath = new Map<string, FileDiff>();
  for (const pool of pools) {
    for (const diff of pool) {
      const previous = byPath.get(diff.path);
      if (!previous) {
        byPath.set(diff.path, diff);
        continue;
      }
      if (patchIsLoaded(diff) && !patchIsLoaded(previous)) byPath.set(diff.path, diff);
    }
  }
  return [...byPath.values()];
}

/** Every pool row, including both sides of a partial stage. */
export function unionDiffs(...pools: readonly (readonly FileDiff[])[]): FileDiff[] {
  const rows: FileDiff[] = [];
  for (const pool of pools) {
    for (const diff of pool) rows.push(diff);
  }
  return rows;
}

function unloadedPaths(pool: readonly FileDiff[], limit: number): string[] {
  const paths: string[] = [];
  for (const diff of pool) {
    if (diff.patchLoaded !== false) continue;
    paths.push(diff.path);
    if (paths.length >= limit) break;
  }
  return paths;
}

/** Per-pool missing patches so a loaded staged side cannot hide an unloaded unstaged side. */
export function recapMissingPatchPaths(
  unstaged: readonly FileDiff[],
  staged: readonly FileDiff[],
  review: readonly FileDiff[],
  limit = RECAP_PATCH_SCAN_LIMIT,
): { unstaged: string[]; staged: string[]; review: string[] } {
  return {
    unstaged: unloadedPaths(unstaged, limit),
    staged: unloadedPaths(staged, limit),
    review: unloadedPaths(review, limit),
  };
}

/** Effect dep: changes when an unloaded path appears or a loaded path is reset. */
export function recapUnloadedPatchKey(
  unstaged: readonly FileDiff[],
  staged: readonly FileDiff[],
  review: readonly FileDiff[],
): string {
  const parts: string[] = [];
  const push = (kind: string, pool: readonly FileDiff[]) => {
    for (const diff of pool) {
      if (diff.patchLoaded === false) parts.push(`${kind}:${diff.path}`);
    }
  };
  push('unstaged', unstaged);
  push('staged', staged);
  push('review', review);
  return parts.sort().join('\0');
}

function mergeFile(previous: RecapFile | undefined, next: RecapFile): RecapFile {
  if (!previous) return next;
  if (previous.kind === 'conflicted' || next.kind === 'conflicted') {
    return { path: next.path, kind: 'conflicted' };
  }
  if (previous.kind === 'untracked') return next;
  return previous;
}

export function buildAgentSessionRecap(input: RecapInput): RecapModel {
  if (!input.repo) {
    return {
      state: 'no-repository',
      repoName: null,
      branch: null,
      head: null,
      linkedWorktree: false,
      dirty: false,
      baselineShort: null,
      files: [],
      risky: [],
      todos: [],
      patchesScanned: 0,
    };
  }

  const byPath = new Map<string, RecapFile>();
  for (const row of input.status) {
    byPath.set(row.path, mergeFile(byPath.get(row.path), {
      path: row.path,
      kind: statusKindToRecap(row.kind),
    }));
  }
  for (const diff of input.diffs) {
    byPath.set(diff.path, mergeFile(byPath.get(diff.path), {
      path: diff.path,
      kind: diffStatusToRecap(diff.status),
    }));
  }

  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const risky = files.filter((file) => classifyRiskyPath(file.path)).slice(0, RECAP_RISKY_LIMIT);
  const todos: RecapTodo[] = [];
  let patchesScanned = 0;
  for (const diff of input.diffs) {
    if (diff.patchLoaded === false || !diff.patch) continue;
    patchesScanned += 1;
    if (todos.length >= RECAP_TODO_LIMIT) continue;
    for (const todo of extractTodosFromPatch(diff.path, diff.patch)) {
      if (todos.length >= RECAP_TODO_LIMIT) break;
      todos.push(todo);
    }
  }

  return {
    state: files.length === 0 ? 'empty' : 'ready',
    repoName: input.repo.name,
    branch: input.repo.branch,
    head: input.repo.head,
    linkedWorktree: input.linkedWorktree,
    dirty: input.repo.dirty || input.status.length > 0,
    baselineShort: input.baselineShort,
    files: files.slice(0, RECAP_FILE_LIMIT),
    risky,
    todos,
    patchesScanned,
  };
}

export function recapKindLabel(kind: RecapFileKind): string {
  switch (kind) {
    case 'added':
      return 'added';
    case 'modified':
      return 'modified';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'untracked':
      return 'untracked';
    case 'conflicted':
      return 'conflicted';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
