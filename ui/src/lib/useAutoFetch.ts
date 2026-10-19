import { useEffect, useRef } from 'react';

import { repoActivity, repoAutoFetch, repoNetworkPreferences } from './db';
import { pathKey } from './repoIdentity';
import { isTauri, tauri } from './tauri';
import type { AutoFetchIntervalMin } from './autoFetch';
import {
  autoFetchActivity,
  autoFetchIsNoop,
  autoFetchNotice,
  startAutoFetch,
} from './autoFetch';
import { useRepo } from '../stores/repo';

/**
 * Fetch open repositories on the Settings → Git interval. Active repo first,
 * others one stagger later. Manual network ops and in-flight fetches skip
 * that repository. Auth failures are one quiet activity entry plus a backoff.
 */
export function useAutoFetch(options: {
  intervalMin: AutoFetchIntervalMin;
  manualBusy: boolean;
  manualPath: string | null;
  notify: (message: string) => void;
}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const intervalMin = options.intervalMin;

  useEffect(() => {
    if (!isTauri()) return;
    const loop = startAutoFetch({
      now: () => Date.now(),
      schedule: (fn, ms) => window.setTimeout(() => { void fn(); }, ms),
      clear: (id) => window.clearTimeout(id),
      intervalMin: () => optionsRef.current.intervalMin,
      offline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
      staggerMs: undefined,
      repos: async () => {
        const { tabs, activePath } = useRepo.getState();
        const manualPath = optionsRef.current.manualBusy ? optionsRef.current.manualPath : null;
        return Promise.all(tabs.map(async (tab) => {
          let prune = true;
          let optedOut = false;
          try {
            const [prefs, enabled] = await Promise.all([
              repoNetworkPreferences.get(tab.path),
              repoAutoFetch.get(tab.path),
            ]);
            if (typeof prefs?.fetchPrune === 'boolean') prune = prefs.fetchPrune;
            optedOut = enabled === false;
          } catch {
            // A settings read failure must not turn into a fetch storm.
          }
          return {
            path: tab.path,
            active: !!activePath && pathKey(activePath) === pathKey(tab.path),
            optedOut,
            prune,
            manualBusy: !!manualPath && pathKey(manualPath) === pathKey(tab.path),
          };
        }));
      },
      fetch: (repo) => tauri.repoBackgroundFetch(repo.path, repo.prune),
      onResult: (repo, result, startedAt, finishedAt) => {
        const notice = autoFetchNotice(result);
        if (notice) optionsRef.current.notify(notice);
        // A fetch that changed nothing is not worth an activity row every tick.
        if (autoFetchIsNoop(result)) return;
        const entry = autoFetchActivity(repo.path, result, startedAt, finishedAt);
        void repoActivity.append(repo.path, entry).catch(() => {});
        if (!result.ok) return;
        void useRepo.getState().refreshUpstream(repo.path);
      },
    });
    return () => loop.stop();
  }, [intervalMin]);
}
