import {
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { create } from 'zustand';

import { settings as settingsDb } from '../lib/db';
import { isDesktopNotificationPermissionGranted } from '../lib/notifications';
import {
  isTerminalPullRequest,
  pullRequestActivityChanged,
  pullRequestActivityEvents,
  pullRequestFollowKey,
  pullRequestNotificationBody,
} from '../lib/pullRequestActivity';
import {
  activityErrorRecord,
  applyPullRequestFollow,
  applyPullRequestUnfollow,
} from '../lib/pullRequestFollows';
import { errMessage, isTauri, tauri } from '../lib/tauri';
import type {
  PullRequest,
  PullRequestActivitySnapshot,
  PullRequestBranchMatch,
  PullRequestRepository,
} from '../lib/types';

const STORAGE_KEY = 'followed-pull-requests:v1';

export interface FollowedPullRequest {
  key: string;
  repoPath: string;
  repository: PullRequestRepository;
  id: number;
  title: string;
  url: string;
  sourceBranch: string;
  followedAt: number;
  lastCheckedAt: number | null;
  snapshot: PullRequestActivitySnapshot | null;
  error: string | null;
}

interface StoredFollowState {
  version: 1;
  followed: FollowedPullRequest[];
  muted: string[];
}

interface ActivePullRequest {
  key: string;
  repoPath: string;
  repository: PullRequestRepository;
  pr: Pick<PullRequest, 'id' | 'title' | 'url' | 'source_branch' | 'state'>;
}

type NotificationPermission = 'unknown' | 'granted' | 'denied';

interface PullRequestMonitorState {
  hydrated: boolean;
  followed: Record<string, FollowedPullRequest>;
  muted: string[];
  permission: NotificationPermission;
  permissionRequested: boolean;
  activityRevision: Record<string, number>;
  active: ActivePullRequest | null;
  hydrate(): Promise<void>;
  follow(
    repoPath: string,
    repository: PullRequestRepository,
    pr: Pick<PullRequest, 'id' | 'title' | 'url' | 'source_branch'>,
    manual: boolean,
  ): Promise<string>;
  followBranchMatch(repoPath: string, match: PullRequestBranchMatch): Promise<string | null>;
  unfollow(key: string, mute: boolean): Promise<void>;
  pollAll(): Promise<void>;
  activity(path: string, id: number): Promise<PullRequestActivitySnapshot>;
  seed(snapshot: PullRequestActivitySnapshot, repoPath: string): Promise<void>;
  seedAfterProviderWrite(path: string, id: number): Promise<void>;
  setActive(
    repoPath: string,
    repository: PullRequestRepository,
    pr: Pick<PullRequest, 'id' | 'title' | 'url' | 'source_branch' | 'state'>,
  ): void;
  clearActive(key: string): void;
  toggleActive(): Promise<void>;
}

const activityRequests = new Map<string, Promise<PullRequestActivitySnapshot>>();
const activityQueue: Array<() => void> = [];
let activeActivityRequests = 0;
let polling = false;

function queuedActivityRequest(path: string, id: number): Promise<PullRequestActivitySnapshot> {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeActivityRequests += 1;
      void tauri.repoPullRequestActivity(path, id).then(resolve, reject).finally(() => {
        activeActivityRequests -= 1;
        activityQueue.shift()?.();
      });
    };
    if (activeActivityRequests < 2) start();
    else activityQueue.push(start);
  });
}

function activityRequest(path: string, id: number): Promise<PullRequestActivitySnapshot> {
  const key = `${path}\0${id}`;
  const existing = activityRequests.get(key);
  if (existing) return existing;
  const request = queuedActivityRequest(path, id).finally(() => {
    if (activityRequests.get(key) === request) activityRequests.delete(key);
  });
  activityRequests.set(key, request);
  return request;
}

async function persist(state: Pick<PullRequestMonitorState, 'followed' | 'muted'>): Promise<void> {
  const payload: StoredFollowState = {
    version: 1,
    followed: Object.values(state.followed),
    muted: state.muted,
  };
  await settingsDb.set(STORAGE_KEY, payload);
}

function summaryFromSnapshot(snapshot: PullRequestActivitySnapshot): Pick<FollowedPullRequest, 'title' | 'url' | 'sourceBranch'> {
  return {
    title: snapshot.title,
    url: snapshot.url,
    sourceBranch: snapshot.source_branch,
  };
}

export const usePullRequests = create<PullRequestMonitorState>((set, get) => ({
  hydrated: false,
  followed: {},
  muted: [],
  permission: 'unknown',
  permissionRequested: false,
  activityRevision: {},
  active: null,

  async hydrate() {
    if (get().hydrated) return;
    let stored: StoredFollowState | null = null;
    try {
      stored = await settingsDb.get<StoredFollowState>(STORAGE_KEY);
    } catch {
      // Persistence failure must not prevent the app from starting.
    }
    let permission: NotificationPermission = 'unknown';
    if (isTauri()) {
      try {
        permission = await isDesktopNotificationPermissionGranted() ? 'granted' : 'denied';
      } catch {
        permission = 'denied';
      }
    }
    const followed = Object.fromEntries(
      (stored?.version === 1 ? stored.followed : []).map((entry) => [entry.key, entry]),
    );
    set({
      hydrated: true,
      followed,
      muted: stored?.version === 1 ? stored.muted : [],
      permission,
    });
  },

  async follow(repoPath, repository, pr, manual) {
    const key = pullRequestFollowKey(repository, pr.id);
    const current = get().followed[key];
    const intent = applyPullRequestFollow(get().muted, key, manual);
    if (!intent.allowed) return key;
    const muted = intent.muted;
    if (current) {
      set({
        followed: {
          ...get().followed,
          [key]: { ...current, repoPath, repository, title: pr.title, url: pr.url, sourceBranch: pr.source_branch },
        },
        muted,
      });
      await persist(get());
      return key;
    }

    const record: FollowedPullRequest = {
      key,
      repoPath,
      repository,
      id: pr.id,
      title: pr.title,
      url: pr.url,
      sourceBranch: pr.source_branch,
      followedAt: Date.now(),
      lastCheckedAt: null,
      snapshot: null,
      error: null,
    };
    set({ followed: { ...get().followed, [key]: record }, muted });
    await persist(get());

    if (isTauri() && get().permission !== 'granted' && (manual || !get().permissionRequested)) {
      set({ permissionRequested: true });
      try {
        const result = await requestPermission();
        set({ permission: result === 'granted' ? 'granted' : 'denied' });
      } catch {
        set({ permission: 'denied' });
      }
    }

    try {
      const snapshot = await activityRequest(repoPath, pr.id);
      await get().seed(snapshot, repoPath);
    } catch (caught) {
      const latest = get().followed[key];
      if (latest) {
        set({ followed: { ...get().followed, [key]: { ...latest, error: errMessage(caught) } } });
        await persist(get());
      }
    }
    return key;
  },

  async followBranchMatch(repoPath, match) {
    const key = pullRequestFollowKey(match.repository, match.pull_request.id);
    if (!applyPullRequestFollow(get().muted, key, false).allowed) return null;
    return get().follow(repoPath, match.repository, match.pull_request, false);
  },

  async unfollow(key, mute) {
    const followed = { ...get().followed };
    delete followed[key];
    const muted = applyPullRequestUnfollow(get().muted, key, mute);
    set({ followed, muted });
    await persist(get());
  },

  activity(path, id) {
    return activityRequest(path, id);
  },

  async seed(snapshot, repoPath) {
    const key = pullRequestFollowKey(snapshot.repository, snapshot.id);
    const current = get().followed[key];
    if (!current) return;
    set({
      followed: {
        ...get().followed,
        [key]: {
          ...current,
          ...summaryFromSnapshot(snapshot),
          repoPath,
          repository: snapshot.repository,
          lastCheckedAt: Date.now(),
          snapshot,
          error: null,
        },
      },
    });
    await persist(get());
  },

  async seedAfterProviderWrite(path, id) {
    const requestKey = `${path}\0${id}`;
    const inFlight = activityRequests.get(requestKey);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // A fresh request below is authoritative after the provider write.
      }
    }
    const snapshot = await activityRequest(path, id);
    await get().seed(snapshot, path);
  },

  async pollAll() {
    if (polling || !get().hydrated) return;
    polling = true;
    try {
      const keys = Object.keys(get().followed);
      let cursor = 0;
      const worker = async () => {
        while (cursor < keys.length) {
          const key = keys[cursor++];
          const current = get().followed[key];
          if (!current) continue;
          try {
            const snapshot = await activityRequest(current.repoPath, current.id);
            const latest = get().followed[key];
            if (!latest) continue;
            const events = pullRequestActivityEvents(latest.snapshot, snapshot);
            const changed = latest.snapshot ? pullRequestActivityChanged(latest.snapshot, snapshot) : false;
            const nextRecord: FollowedPullRequest = {
              ...latest,
              ...summaryFromSnapshot(snapshot),
              repository: snapshot.repository,
              snapshot,
              lastCheckedAt: Date.now(),
              error: null,
            };
            set({
              followed: { ...get().followed, [key]: nextRecord },
              activityRevision: changed
                ? { ...get().activityRevision, [key]: (get().activityRevision[key] ?? 0) + 1 }
                : get().activityRevision,
            });

            const body = pullRequestNotificationBody(events);
            if (body && get().permission === 'granted') {
              try {
                sendNotification({
                  title: `PR #${snapshot.id} · ${snapshot.repository.label}`,
                  body,
                  group: key,
                });
              } catch {
                // Following and refresh remain useful even if the OS rejects a notification.
              }
            }
            if (isTerminalPullRequest(snapshot)) {
              const followed = { ...get().followed };
              delete followed[key];
              set({ followed });
            }
          } catch (caught) {
            const latest = get().followed[key];
            if (latest) {
              set({
                followed: {
                  ...get().followed,
                  [key]: activityErrorRecord(latest, errMessage(caught)),
                },
              });
            }
          }
        }
      };
      await Promise.all([worker(), worker()]);
      await persist(get());
    } finally {
      polling = false;
    }
  },

  setActive(repoPath, repository, pr) {
    set({ active: { key: pullRequestFollowKey(repository, pr.id), repoPath, repository, pr } });
  },

  clearActive(key) {
    if (get().active?.key === key) set({ active: null });
  },

  async toggleActive() {
    const active = get().active;
    if (!active) return;
    if (get().followed[active.key]) await get().unfollow(active.key, true);
    else await get().follow(active.repoPath, active.repository, active.pr, true);
  },
}));
