import { plural } from './i18n';
import { pathKey } from './repoIdentity';
import type { BackgroundFetchOutcome, RepoActivityEntry } from './types';

/**
 * Background fetch interval. Daniels chose 10 minutes.
 * Change this one constant to change the default.
 */
export const DEFAULT_AUTO_FETCH_INTERVAL_MIN = 10;

export const AUTO_FETCH_INTERVALS = [0, 5, 10, 30] as const;
export type AutoFetchIntervalMin = (typeof AUTO_FETCH_INTERVALS)[number];

/** Gap between open repositories so one tick does not fetch them together. */
export const AUTO_FETCH_STAGGER_MS = 15_000;

/** After an auth failure, skip this repository instead of prompting every tick. */
export const AUTO_FETCH_AUTH_BACKOFF_MS = 60 * 60 * 1000;

export function normalizeAutoFetchInterval(value: unknown): AutoFetchIntervalMin {
  if (value === 0 || value === 5 || value === 10 || value === 30) return value;
  return DEFAULT_AUTO_FETCH_INTERVAL_MIN;
}

export interface AutoFetchRepo {
  path: string;
  active: boolean;
  optedOut: boolean;
  prune: boolean;
  /** A manual fetch, pull, or push is already running for this repository. */
  manualBusy: boolean;
}

/**
 * The repository a manual network op runs against: the one active when it
 * started. Switching tabs mid-op keeps it; the op ending clears it.
 */
export function manualOpPath(busy: boolean, remembered: string | null, activePath: string | null): string | null {
  if (!busy) return null;
  return remembered ?? activePath;
}

/** Whether `path` is the repository a running manual network op targets. */
export function isManualBusyRepo(path: string, manualPath: string | null): boolean {
  return !!manualPath && pathKey(manualPath) === pathKey(path);
}

export interface AutoFetchPlanInput {
  now: number;
  intervalMin: number;
  offline: boolean;
  repos: readonly AutoFetchRepo[];
  /** When the loop started. A repo with no prior fetch becomes due one interval later. */
  armedAt: number;
  lastStarted: ReadonlyMap<string, number>;
  backoffUntil: ReadonlyMap<string, number>;
  inFlight: ReadonlySet<string>;
  staggerMs?: number;
}

export interface AutoFetchPlan {
  /** At most one repository — the active one first, then the others. */
  start: AutoFetchRepo[];
  /** Absolute time of the next wake, or null when auto-fetch is off. */
  wakeAt: number | null;
}

export function planAutoFetch(input: AutoFetchPlanInput): AutoFetchPlan {
  const intervalMin = normalizeAutoFetchInterval(input.intervalMin);
  if (intervalMin === 0) return { start: [], wakeAt: null };

  const intervalMs = intervalMin * 60_000;
  const stagger = input.staggerMs ?? AUTO_FETCH_STAGGER_MS;
  if (input.offline) return { start: [], wakeAt: input.now + intervalMs };

  const ordered = [...input.repos].sort((a, b) => Number(b.active) - Number(a.active));
  const ready: AutoFetchRepo[] = [];
  let nextDue = Number.POSITIVE_INFINITY;
  let recheck = Number.POSITIVE_INFINITY;

  for (const repo of ordered) {
    if (repo.optedOut) continue;
    const dueAt = (input.lastStarted.get(repo.path) ?? input.armedAt) + intervalMs;
    if (input.now < dueAt) {
      nextDue = Math.min(nextDue, dueAt);
      continue;
    }
    const backoff = input.backoffUntil.get(repo.path) ?? 0;
    if (input.now < backoff) {
      recheck = Math.min(recheck, backoff);
      continue;
    }
    if (repo.manualBusy || input.inFlight.has(repo.path)) {
      recheck = Math.min(recheck, input.now + stagger);
      continue;
    }
    ready.push(repo);
  }

  const start: AutoFetchRepo[] = [];
  if (ready.length > 0) {
    start.push(ready[0]);
    if (ready.length > 1) recheck = Math.min(recheck, input.now + stagger);
  }

  const candidates = [nextDue, recheck].filter((at) => Number.isFinite(at));
  const wakeAt = candidates.length > 0 ? Math.min(...candidates) : input.now + intervalMs;
  return { start, wakeAt };
}

export function autoFetchNotice(result: Pick<BackgroundFetchOutcome, 'new_commits' | 'upstream'>): string | null {
  if (!result.upstream || result.new_commits <= 0) return null;
  return plural(
    result.new_commits,
    { one: 'git.notice.one', other: 'git.notice.other' },
    { upstream: result.upstream },
    'en-US',
  );
}

/** A successful fetch that git reported nothing for: no ref moved or was pruned. */
export function autoFetchIsNoop(result: Pick<BackgroundFetchOutcome, 'ok' | 'output' | 'new_commits'>): boolean {
  return result.ok && result.new_commits <= 0 && result.output.trim() === '';
}

export function autoFetchActivity(
  path: string,
  result: BackgroundFetchOutcome,
  startedAt: number,
  finishedAt: number,
): RepoActivityEntry {
  return {
    id: `background-fetch-${path}-${startedAt}`,
    task: 'background-fetch',
    started_at: startedAt,
    command: result.command,
    output: result.ok ? (autoFetchNotice(result) ?? '') : result.output,
    success: result.ok,
    duration_ms: Math.max(0, finishedAt - startedAt),
  };
}

const inFlight = new Set<string>();
const lastStarted = new Map<string, number>();
const backoffUntil = new Map<string, number>();

export function resetAutoFetchState(): void {
  inFlight.clear();
  lastStarted.clear();
  backoffUntil.clear();
}

export function backgroundFetchInFlight(path: string | null): boolean {
  if (!path) return false;
  const key = pathKey(path);
  for (const running of inFlight) {
    if (pathKey(running) === key) return true;
  }
  return false;
}

export interface AutoFetchLoopDeps {
  now: () => number;
  schedule: (fn: () => void | Promise<void>, ms: number) => number;
  clear: (id: number) => void;
  intervalMin: () => number;
  offline: () => boolean;
  repos: () => AutoFetchRepo[] | Promise<AutoFetchRepo[]>;
  fetch: (repo: AutoFetchRepo) => Promise<BackgroundFetchOutcome>;
  onResult: (repo: AutoFetchRepo, result: BackgroundFetchOutcome, startedAt: number, finishedAt: number) => void;
  staggerMs?: number;
}

export function startAutoFetch(deps: AutoFetchLoopDeps): { stop: () => void; whenIdle: () => Promise<void> } {
  let stopped = false;
  let timer: number | null = null;
  let idle: Promise<void> = Promise.resolve();
  const armedAt = deps.now();

  async function run(): Promise<void> {
    if (stopped) return;
    const now = deps.now();
    const repos = await deps.repos();
    if (stopped) return;
    const plan = planAutoFetch({
      now,
      intervalMin: deps.intervalMin(),
      offline: deps.offline(),
      repos,
      armedAt,
      lastStarted,
      backoffUntil,
      inFlight,
      staggerMs: deps.staggerMs,
    });
    for (const repo of plan.start) {
      inFlight.add(repo.path);
      lastStarted.set(repo.path, now);
      const startedAt = now;
      void deps.fetch(repo).then(
        (result) => {
          const finishedAt = deps.now();
          if (result.auth_required) backoffUntil.set(repo.path, finishedAt + AUTO_FETCH_AUTH_BACKOFF_MS);
          if (!stopped) deps.onResult(repo, result, startedAt, finishedAt);
        },
        (error: unknown) => {
          const finishedAt = deps.now();
          if (stopped) return;
          const message = error instanceof Error ? error.message : String(error);
          deps.onResult(repo, {
            ok: false,
            auth_required: false,
            output: message,
            command: repo.prune ? 'git fetch --prune' : 'git fetch --no-prune',
            new_commits: 0,
            upstream: null,
            behind: 0,
          }, startedAt, finishedAt);
        },
      ).finally(() => {
        inFlight.delete(repo.path);
      });
    }
    arm(plan.wakeAt);
  }

  function kick(): Promise<void> {
    const job = run();
    idle = job;
    return job;
  }

  function arm(wakeAt: number | null) {
    if (timer != null) deps.clear(timer);
    timer = null;
    if (wakeAt == null || stopped) return;
    const delay = Math.max(0, wakeAt - deps.now());
    timer = deps.schedule(() => { void kick(); }, delay);
  }

  void kick();
  return {
    stop() {
      stopped = true;
      if (timer != null) deps.clear(timer);
      timer = null;
    },
    whenIdle: () => idle,
  };
}
