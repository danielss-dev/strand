import { useMemo } from 'react';

import { activeWorkspaceMembers } from '../lib/workspaceReview';
import { useRepo } from '../stores/repo';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';

/**
 * Segmented [Repository | Workspace] control shared by the two review lenses
 * (mirrors `HistoryModeToggle`, the Graph|Reflog precedent). The single-repo
 * Review and the aggregated Workspace Review are two views of the same review
 * state, so they share one sidebar destination and this toggle flips the
 * lens in place. Renders nothing until the active workspace actually has
 * something to aggregate (≥ 2 member repos) — with one member the two lenses
 * are the same set of files.
 */
export function ReviewModeToggle() {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);

  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaces((s) => s.activeWorkspaceId);
  const tabs = useRepo((s) => s.tabs);
  const memberCount = useMemo(
    () => activeWorkspaceMembers(workspaces, activeWorkspaceId, tabs, DEFAULT_WORKSPACE_ID).length,
    [workspaces, activeWorkspaceId, tabs],
  );
  if (memberCount < 2) return null;

  const go = (next: 'review' | 'workspace-review') => {
    if (view === next) return;
    setView(next);
    selectFile(null);
  };

  return (
    <div className="seg" role="group" aria-label="Review scope">
      <button
        type="button"
        className={view === 'review' ? 'on' : ''}
        aria-pressed={view === 'review'}
        onClick={() => go('review')}
      >
        Repository
      </button>
      <button
        type="button"
        className={view === 'workspace-review' ? 'on' : ''}
        aria-pressed={view === 'workspace-review'}
        onClick={() => go('workspace-review')}
      >
        Workspace
      </button>
    </div>
  );
}
