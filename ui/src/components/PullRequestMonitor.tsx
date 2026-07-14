import { useEffect, useRef } from 'react';

import { isTauri, tauri } from '../lib/tauri';
import { usePullRequests } from '../stores/pullRequests';
import { useRepo } from '../stores/repo';
import { Icon } from './Icon';

const POLL_MS = 60_000;

/** Global followed-PR lifecycle. It stays mounted when the PR view is not. */
export function PullRequestMonitor() {
  const path = useRepo((state) => state.activePath);
  const branch = useRepo((state) => state.meta && !state.meta.detached ? state.meta.branch : null);
  const hydrated = usePullRequests((state) => state.hydrated);
  const hydrate = usePullRequests((state) => state.hydrate);
  const pollAll = usePullRequests((state) => state.pollAll);
  const followBranchMatch = usePullRequests((state) => state.followBranchMatch);
  const permission = usePullRequests((state) => state.permission);
  const followedCount = usePullRequests((state) => Object.keys(state.followed).length);
  const branchGeneration = useRef(0);

  useEffect(() => {
    if (isTauri()) void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || !isTauri()) return;
    void pollAll();
    const timer = window.setInterval(() => { void pollAll(); }, POLL_MS);
    const onFocus = () => { void pollAll(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [hydrated, pollAll]);

  useEffect(() => {
    if (!hydrated || !path || !branch || !isTauri()) return;
    const generation = ++branchGeneration.current;
    void tauri.repoPullRequestForBranch(path, branch).then((match) => {
      if (branchGeneration.current === generation && match) {
        void followBranchMatch(path, match).catch(() => {});
      }
    }).catch(() => {
      // Unsupported remotes, missing CLIs, and auth failures are surfaced when
      // the user opens Pull Requests; automatic discovery stays quiet.
    });
    return () => { branchGeneration.current += 1; };
  }, [branch, followBranchMatch, hydrated, path]);

  if (permission !== 'denied' || followedCount === 0) return null;
  return (
    <div className="pr-notification-banner" role="status">
      <Icon name="bell" size={13} />
      <span>Following {followedCount} pull request{followedCount === 1 ? '' : 's'}, but desktop notifications are blocked. Allow Strand in system settings.</span>
    </div>
  );
}
