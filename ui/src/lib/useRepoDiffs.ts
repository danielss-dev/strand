import { useEffect } from 'react';
import { useRepo } from '../stores/repo';

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
