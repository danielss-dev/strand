import { useRepo } from '../stores/repo';

/**
 * Segmented [Graph | Reflog] control shared by the two history lenses. The
 * commit graph (reachable history) and the reflog (local, chronological, incl.
 * orphaned commits) are two views of the same surface, so the toggle lives in
 * each one's toolbar in the same spot — switching feels like flipping a lens,
 * not navigating away. Self-contained: reads/writes `view` directly. Lives in
 * the All Commits header actions (`.seg` segmented-control style).
 */
export function HistoryModeToggle() {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);

  const go = (next: 'commits' | 'reflog') => {
    if (view === next) return;
    setView(next);
    selectFile(null);
  };

  return (
    <div className="seg" role="group" aria-label="History view">
      <button
        type="button"
        className={view === 'commits' ? 'on' : ''}
        aria-pressed={view === 'commits'}
        onClick={() => go('commits')}
      >
        Graph
      </button>
      <button
        type="button"
        className={view === 'reflog' ? 'on' : ''}
        aria-pressed={view === 'reflog'}
        onClick={() => go('reflog')}
      >
        Reflog
      </button>
    </div>
  );
}
