import { afterEach, describe, expect, it } from 'vitest';

import type { BackgroundFetchOutcome } from './types';
import {
  AUTO_FETCH_AUTH_BACKOFF_MS,
  autoFetchActivity,
  autoFetchNotice,
  backgroundFetchInFlight,
  normalizeAutoFetchInterval,
  planAutoFetch,
  resetAutoFetchState,
  startAutoFetch,
  type AutoFetchRepo,
} from './autoFetch';

const unchanged: BackgroundFetchOutcome = {
  ok: true,
  auth_required: false,
  output: '',
  command: 'git fetch --no-prune',
  new_commits: 0,
  upstream: 'origin/main',
  behind: 0,
};

function repo(overrides: Partial<AutoFetchRepo> = {}): AutoFetchRepo {
  return {
    path: '/repo',
    active: true,
    optedOut: false,
    prune: true,
    manualBusy: false,
    ...overrides,
  };
}

afterEach(() => {
  resetAutoFetchState();
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('planAutoFetch', () => {
  it('fires at the interval and starts the active repository before the others', () => {
    const repos = [
      repo({ path: '/other', active: false }),
      repo({ path: '/active', active: true }),
    ];
    const idle = planAutoFetch({
      now: 0,
      intervalMin: 10,
      offline: false,
      repos,
      armedAt: 0,
      lastStarted: new Map(),
      backoffUntil: new Map(),
      inFlight: new Set(),
      staggerMs: 1_000,
    });
    expect(idle.start).toEqual([]);
    expect(idle.wakeAt).toBe(10 * 60_000);

    const first = planAutoFetch({
      now: 10 * 60_000,
      intervalMin: 10,
      offline: false,
      repos,
      armedAt: 0,
      lastStarted: new Map(),
      backoffUntil: new Map(),
      inFlight: new Set(),
      staggerMs: 1_000,
    });
    expect(first.start.map((item) => item.path)).toEqual(['/active']);
    expect(first.wakeAt).toBe(10 * 60_000 + 1_000);

    const second = planAutoFetch({
      now: 10 * 60_000 + 1_000,
      intervalMin: 10,
      offline: false,
      repos,
      armedAt: 0,
      lastStarted: new Map([['/active', 10 * 60_000]]),
      backoffUntil: new Map(),
      inFlight: new Set(),
      staggerMs: 1_000,
    });
    expect(second.start.map((item) => item.path)).toEqual(['/other']);
  });

  it('does not start a second fetch while one is in flight and skips a manual fetch', () => {
    const base = {
      now: 10 * 60_000,
      intervalMin: 10,
      offline: false,
      armedAt: 0,
      lastStarted: new Map<string, number>(),
      backoffUntil: new Map<string, number>(),
      staggerMs: 1_000,
    };
    const busy = planAutoFetch({
      ...base,
      repos: [repo()],
      inFlight: new Set(['/repo']),
    });
    expect(busy.start).toEqual([]);

    const manual = planAutoFetch({
      ...base,
      repos: [repo({ manualBusy: true })],
      inFlight: new Set(),
    });
    expect(manual.start).toEqual([]);
  });

  it('spawns nothing when the interval is off, the repo opted out, or the app is offline', () => {
    const shared = {
      now: 10 * 60_000,
      offline: false,
      repos: [repo()],
      armedAt: 0,
      lastStarted: new Map<string, number>(),
      backoffUntil: new Map<string, number>(),
      inFlight: new Set<string>(),
    };
    expect(planAutoFetch({ ...shared, intervalMin: 0 }).start).toEqual([]);
    expect(planAutoFetch({ ...shared, intervalMin: 0 }).wakeAt).toBeNull();
    expect(planAutoFetch({ ...shared, intervalMin: 10, repos: [repo({ optedOut: true })] }).start).toEqual([]);
    expect(planAutoFetch({ ...shared, intervalMin: 10, offline: true }).start).toEqual([]);
  });

  it('backs off after an auth failure instead of retrying the next tick', () => {
    const failedAt = 10 * 60_000;
    const during = planAutoFetch({
      now: failedAt + 10 * 60_000,
      intervalMin: 10,
      offline: false,
      repos: [repo()],
      armedAt: 0,
      lastStarted: new Map([['/repo', failedAt]]),
      backoffUntil: new Map([['/repo', failedAt + AUTO_FETCH_AUTH_BACKOFF_MS]]),
      inFlight: new Set(),
    });
    expect(during.start).toEqual([]);

    const after = planAutoFetch({
      now: failedAt + AUTO_FETCH_AUTH_BACKOFF_MS,
      intervalMin: 10,
      offline: false,
      repos: [repo()],
      armedAt: 0,
      lastStarted: new Map([['/repo', failedAt]]),
      backoffUntil: new Map([['/repo', failedAt + AUTO_FETCH_AUTH_BACKOFF_MS]]),
      inFlight: new Set(),
    });
    expect(after.start.map((item) => item.path)).toEqual(['/repo']);
  });
});

describe('startAutoFetch', () => {
  it('does not spawn a fetch until the interval, then surfaces a new-commit notice once', async () => {
    let now = 5_000;
    const queued: Array<{ at: number; run: () => void | Promise<void> }> = [];
    const fetched: Array<{ path: string; prune: boolean }> = [];
    const notices: string[] = [];
    const loop = startAutoFetch({
      now: () => now,
      schedule(fn, ms) {
        queued.push({ at: now + ms, run: fn });
        return queued.length;
      },
      clear() {},
      intervalMin: () => 10,
      offline: () => false,
      staggerMs: 1_000,
      repos: () => [
        repo({ path: '/active', active: true, prune: false }),
        repo({ path: '/other', active: false, prune: true }),
      ],
      fetch: async (item) => {
        fetched.push({ path: item.path, prune: item.prune });
        if (item.path === '/active') {
          return { ...unchanged, command: 'git fetch --no-prune', new_commits: 2, upstream: 'origin/main', behind: 2 };
        }
        return unchanged;
      },
      onResult: (_item, result) => {
        const notice = autoFetchNotice(result);
        if (notice) notices.push(notice);
      },
    });
    await loop.whenIdle();
    expect(fetched).toEqual([]);
    expect(queued[0].at - 5_000).toBe(10 * 60_000);

    now = queued[0].at;
    queued[0].run();
    await loop.whenIdle();
    await settle();
    expect(fetched).toEqual([{ path: '/active', prune: false }]);
    expect(notices).toEqual(['2 new commits on origin/main']);
    expect(autoFetchNotice({ new_commits: 1, upstream: 'origin/main' })).toBe('1 new commit on origin/main');
    expect(autoFetchNotice({ new_commits: 0, upstream: 'origin/main' })).toBeNull();
    loop.stop();
  });

  it('never runs two fetches for the same repo and skips a manual fetch or pull', async () => {
    let now = 0;
    const queued: Array<{ at: number; run: () => void | Promise<void> }> = [];
    const gate: { release: (() => void) | null } = { release: null };
    let calls = 0;
    let manual = false;
    const loop = startAutoFetch({
      now: () => now,
      schedule(fn, ms) {
        queued.push({ at: now + ms, run: fn });
        return queued.length;
      },
      clear() {},
      intervalMin: () => 10,
      offline: () => false,
      staggerMs: 1_000,
      repos: () => [repo({ manualBusy: manual })],
      fetch: () => new Promise((resolve) => {
        calls += 1;
        gate.release = () => resolve(unchanged);
      }),
      onResult() {},
    });
    await loop.whenIdle();
    now = 10 * 60_000;
    queued.at(-1)?.run();
    await loop.whenIdle();
    expect(calls).toBe(1);
    expect(backgroundFetchInFlight('/repo')).toBe(true);

    now = 20 * 60_000;
    const before = queued.length;
    queued.at(-1)?.run();
    await loop.whenIdle();
    expect(calls).toBe(1);
    expect(queued.length).toBeGreaterThan(before);

    gate.release?.();
    await Promise.resolve();
    manual = true;
    now = 30 * 60_000;
    queued.at(-1)?.run();
    await loop.whenIdle();
    expect(calls).toBe(1);
    loop.stop();
  });

  it('records one quiet auth failure and does not spawn again until backoff ends', async () => {
    let now = 0;
    const queued: Array<{ at: number; run: () => void | Promise<void> }> = [];
    const calls: number[] = [];
    const activities: string[] = [];
    const loop = startAutoFetch({
      now: () => now,
      schedule(fn, ms) {
        queued.push({ at: now + ms, run: fn });
        return queued.length;
      },
      clear() {},
      intervalMin: () => 10,
      offline: () => false,
      repos: () => [repo()],
      fetch: async () => {
        calls.push(now);
        return {
          ...unchanged,
          ok: false,
          auth_required: true,
          output: 'fatal: could not read Username: terminal prompts disabled',
        };
      },
      onResult: (item, result, startedAt, finishedAt) => {
        activities.push(autoFetchActivity(item.path, result, startedAt, finishedAt).output);
      },
    });
    await loop.whenIdle();
    now = 10 * 60_000;
    queued.at(-1)?.run();
    await loop.whenIdle();
    await settle();
    expect(calls).toEqual([10 * 60_000]);
    expect(activities).toEqual(['fatal: could not read Username: terminal prompts disabled']);

    now = 20 * 60_000;
    queued.at(-1)?.run();
    await loop.whenIdle();
    expect(calls).toEqual([10 * 60_000]);

    now = 10 * 60_000 + AUTO_FETCH_AUTH_BACKOFF_MS;
    queued.at(-1)?.run();
    await loop.whenIdle();
    await settle();
    expect(calls).toEqual([10 * 60_000, now]);
    loop.stop();
  });

  it('spawns no background fetch when the setting is off', async () => {
    const queued: unknown[] = [];
    let fetched = 0;
    const loop = startAutoFetch({
      now: () => 0,
      schedule(fn) {
        queued.push(fn);
        return queued.length;
      },
      clear() {},
      intervalMin: () => 0,
      offline: () => false,
      repos: () => [repo()],
      fetch: async () => {
        fetched += 1;
        return unchanged;
      },
      onResult() {},
    });
    await loop.whenIdle();
    expect(fetched).toBe(0);
    expect(queued).toEqual([]);
    loop.stop();
  });
});

describe('normalizeAutoFetchInterval', () => {
  it('keeps the chosen 10 minute default and rejects unknown values', () => {
    expect(normalizeAutoFetchInterval(undefined)).toBe(10);
    expect(normalizeAutoFetchInterval(10)).toBe(10);
    expect(normalizeAutoFetchInterval(7)).toBe(10);
    expect(normalizeAutoFetchInterval(0)).toBe(0);
  });
});
