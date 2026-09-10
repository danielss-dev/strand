import { useEffect } from 'react';
import { useRepo } from '../stores/repo';
import { diffLoaded } from './diffPages';

/** Mounted consumers also cover independently composed Workbench panes. */
export function useRepoDiffs(kind: 'local' | 'review'): void {
  const path = useRepo((state) => state.activePath);
  const baseline = useRepo((state) => kind === 'review' ? state.baseline?.oid : null);
  useEffect(() => {
    if (!path) return;
    const release = useRepo.getState().retainDiffs(path, kind);
    const state = useRepo.getState();
    void Promise.all([
      state.refreshDiffs(),
      ...(kind === 'review' ? [state.refreshReviewDiffs()] : []),
    ]).catch((error) => console.warn('diff load failed', error));
    return release;
  }, [path, kind, baseline]);
}

/** Search is an explicit complete traversal; never search summary placeholders. */
export function useCompleteDiffSearch(open: boolean, kind: 'local' | 'review'): string | null {
  const path = useRepo((state) => state.activePath);
  const tick = useRepo((state) => state.diffsTick);
  const baseline = useRepo((state) => state.baseline);
  const unstaged = useRepo((state) => state.unstagedDiffs);
  const staged = useRepo((state) => state.stagedDiffs);
  const review = useRepo((state) => state.baseline ? state.baselineDiffs : state.reviewUnstagedDiffs);
  const error = useRepo((state) => kind === 'review' ? state.reviewDiffsError : state.localDiffsError);
  const refreshing = useRepo((state) => kind === 'review' ? state.reviewDiffsLoading : state.localDiffsDirty);
  useEffect(() => {
    if (open && path && !refreshing) void useRepo.getState().ensureAllDiffs(kind).catch(() => {});
  }, [open, path, kind, tick, baseline, refreshing]);
  if (!open) return null;
  if (error) return 'Load failed — retry changes';
  const pool = kind === 'review' ? review : [...unstaged, ...staged];
  const loaded = pool.filter(diffLoaded).length;
  return loaded === pool.length ? null : `Loading ${loaded}/${pool.length} files…`;
}
