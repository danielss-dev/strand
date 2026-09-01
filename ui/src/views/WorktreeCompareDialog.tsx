import { useEffect, useMemo, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { worktreeName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import type { Worktree } from '../lib/types';

/** One attempt column: a worktree's changes since its fork point. */
interface Attempt {
  worktree: Worktree;
  loading: boolean;
  error: string | null;
  /** Detected base branch + fork point the diff is measured against. */
  base: string | null;
  files: { path: string; adds: number; dels: number }[];
  adds: number;
  dels: number;
}

/**
 * Best-of-N comparison — the "ran the same task in three worktrees, which
 * attempt wins?" view. One column per selected worktree, each diffed against
 * its own fork point; files touched by more than one attempt are highlighted,
 * because that intersection is where the approaches actually differ (and
 * where the merge conflicts will be). Verdict actions per column: open the
 * full review, or pick the winner and go straight to Merge & clean up.
 */
export function WorktreeCompareDialog({
  worktrees,
  onClose,
  onReview,
  onPick,
}: {
  worktrees: Worktree[];
  onClose: () => void;
  /** Open the full review session for this attempt (closes the dialog). */
  onReview: (w: Worktree) => void;
  /** Winner chosen — hand off to Merge & clean up (closes the dialog). */
  onPick: (w: Worktree) => void;
}) {
  const [attempts, setAttempts] = useState<Attempt[]>(() =>
    worktrees.map((w) => ({
      worktree: w,
      loading: true,
      error: null,
      base: null,
      files: [],
      adds: 0,
      dels: 0,
    })),
  );
  useEffect(() => {
    let cancelled = false;
    worktrees.forEach((w, i) => {
      void (async () => {
        try {
          const target = w.branch ?? w.head;
          if (!target) throw new Error('detached worktree without a resolvable HEAD');
          const base = await tauri.repoDetectBaseBranch(w.path, target);
          if (!base) throw new Error('no base branch detectable');
          // Committed + uncommitted work since the fork point in one list.
          const diffs = await tauri.repoDiffSince(w.path, base.merge_base);
          if (cancelled) return;
          setAttempts((prev) =>
            prev.map((a, j) =>
              j === i
                ? {
                    ...a,
                    loading: false,
                    base: base.name,
                    files: diffs
                      .map((d) => ({ path: d.path, adds: d.adds, dels: d.dels }))
                      .sort((x, y) => x.path.localeCompare(y.path)),
                    adds: diffs.reduce((n, d) => n + d.adds, 0),
                    dels: diffs.reduce((n, d) => n + d.dels, 0),
                  }
                : a,
            ),
          );
        } catch (e) {
          if (cancelled) return;
          setAttempts((prev) =>
            prev.map((a, j) => (j === i ? { ...a, loading: false, error: errMessage(e) } : a)),
          );
        }
      })();
    });
    return () => { cancelled = true; };
    // Attempt set is fixed for the dialog's lifetime.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Paths touched by more than one attempt — the contested ground.
  const shared = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of attempts) {
      for (const f of a.files) counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p));
  }, [attempts]);

  return (
    <Dialog
      title={`Compare ${attempts.length} attempts`}
      icon="worktree"
      onClose={onClose}
      className="worktree-dialog wt-compare-dialog"
    >
        <div className="clone-body">
          <p className="stash-blurb">
            Each column is one worktree's changes since its fork point.
            {shared.size > 0 && (
              <> Files touched by more than one attempt are <mark className="wt-compare-mark">highlighted</mark> —
              that's where the approaches differ.</>
            )}
          </p>

          <div className="wt-compare-grid" style={{ gridTemplateColumns: `repeat(${attempts.length}, minmax(0, 1fr))` }}>
            {attempts.map((a) => {
              const name = worktreeName(a.worktree);
              return (
                <div key={a.worktree.path} className="wt-compare-col">
                  <div className="wt-compare-head" title={a.worktree.path}>
                    <span className="wt-branch">{name}</span>
                    {a.base && <span className="wt-dim">vs {a.base}</span>}
                  </div>
                  <div className="wt-compare-totals">
                    {a.loading ? (
                      <span className="wt-dim">Diffing…</span>
                    ) : a.error ? (
                      <span className="wt-compare-error">{a.error}</span>
                    ) : (
                      <>
                        <span>{a.files.length} file{a.files.length === 1 ? '' : 's'}</span>
                        {a.adds > 0 && <span className="drift-ahead">+{a.adds}</span>}
                        {a.dels > 0 && <span className="drift-behind">−{a.dels}</span>}
                      </>
                    )}
                  </div>
                  <ul className="wt-compare-files" aria-label={`Files changed in ${name}`}>
                    {a.files.map((f) => (
                      <li
                        key={f.path}
                        className={shared.has(f.path) ? 'shared' : undefined}
                        title={`${f.path} · +${f.adds} −${f.dels}${shared.has(f.path) ? ' · also touched by another attempt' : ''}`}
                      >
                        <span className="wt-compare-path">{f.path}</span>
                        <span className="wt-compare-counts">+{f.adds} −{f.dels}</span>
                      </li>
                    ))}
                    {!a.loading && !a.error && a.files.length === 0 && (
                      <li className="wt-dim">No changes since the fork point</li>
                    )}
                  </ul>
                  <div className="wt-compare-actions">
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => onReview(a.worktree)}
                      title={`Open the full review of ${name} vs its fork point`}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!a.base || !a.worktree.branch}
                      onClick={() => onPick(a.worktree)}
                      title={`This attempt wins — merge ${name} into ${a.base ?? 'its base'} (and clean up the losers from the overview)`}
                    >
                      Pick winner…
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
    </Dialog>
  );
}
