import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Icon } from '../components/Icon';
import { pathLeaf, repoFamilyName, worktreeName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { Worktree } from '../lib/types';

interface WtStats {
  loading: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  lastSubject: string | null;
  lastTime: number | null;
}

const EMPTY_STATS: WtStats = {
  loading: true,
  dirty: 0,
  ahead: 0,
  behind: 0,
  lastSubject: null,
  lastTime: null,
};

/**
 * Worktrees overview — the triage surface for "what is each agent doing?".
 *
 * Row stats are fetched only while this view is mounted, reusing existing
 * status/meta/log commands against each worktree path. That keeps the normal
 * snapshot refresh hot path free of worktree bookkeeping.
 */
export function Worktrees({
  onCreateWorktree,
  onToast,
}: {
  onCreateWorktree: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const meta = useRepo((s) => s.meta);
  const activePath = useRepo((s) => s.activePath);
  const worktrees = useRepo((s) => s.worktrees);
  const refreshWorktrees = useRepo((s) => s.refreshWorktrees);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const setBaseline = useRepo((s) => s.setBaseline);
  const setView = useRepo((s) => s.setView);

  const [stats, setStats] = useState<Record<string, WtStats>>({});
  // Worktree path whose plain remove git refused (dirty/locked); its row
  // swaps the trash button for an explicit Force remove / Cancel pair.
  const [forcePath, setForcePath] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const focusedRowRef = useRef<HTMLDivElement>(null);

  const repoName = repoFamilyName(meta);
  const mainBranch = worktrees.find((w) => w.is_main)?.branch ?? null;
  const pathsKey = JSON.stringify(worktrees.map((w) => w.path));

  useEffect(() => {
    void refreshWorktrees();
  }, [activePath, refreshWorktrees]);

  useEffect(() => {
    let cancelled = false;
    setStats((prev) => {
      const live = new Set(worktrees.map((w) => w.path));
      const next: Record<string, WtStats> = {};
      for (const [path, st] of Object.entries(prev)) {
        if (live.has(path)) next[path] = st;
      }
      return next;
    });

    for (const w of worktrees) {
      void (async () => {
        try {
          const [status, m, log] = await Promise.all([
            tauri.repoStatus(w.path),
            tauri.repoMeta(w.path),
            tauri.repoLog(w.path, 1),
          ]);
          if (cancelled) return;
          setStats((s) => ({
            ...s,
            [w.path]: {
              loading: false,
              dirty: status.length,
              ahead: m.ahead,
              behind: m.behind,
              lastSubject: log[0]?.subject ?? null,
              lastTime: log[0]?.time_unix ?? null,
            },
          }));
        } catch {
          if (!cancelled) {
            setStats((s) => ({ ...s, [w.path]: { ...EMPTY_STATS, loading: false } }));
          }
        }
      })();
    }

    return () => { cancelled = true; };
  }, [pathsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderedWorktrees = useMemo(() => {
    const rank = (w: Worktree): number => {
      if (w.is_current) return 0;
      if (w.is_main) return 1;
      const st = stats[w.path];
      if (st && !st.loading && st.dirty > 0) return 2;
      if (w.is_locked || w.is_prunable) return 4;
      return 3;
    };

    return [...worktrees].sort((a, b) =>
      rank(a) - rank(b)
      || worktreeName(a).localeCompare(worktreeName(b))
      || a.path.localeCompare(b.path));
  }, [worktrees, stats]);

  useEffect(() => {
    setFocused((f) => Math.min(f, Math.max(0, orderedWorktrees.length - 1)));
  }, [orderedWorktrees.length]);

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  const dirtyWorktrees = orderedWorktrees.filter((w) => (stats[w.path]?.dirty ?? 0) > 0).length;
  const lockedWorktrees = orderedWorktrees.filter((w) => w.is_locked).length;

  const review = (w: Worktree) => {
    void (async () => {
      const main = worktrees.find((x) => x.is_main);
      const base = !w.is_main ? (main?.branch ?? main?.head ?? null) : null;
      const target = w.branch ?? w.head;
      let baselineOid: string | null = null;

      if (base && target && base !== target) {
        try {
          baselineOid = await tauri.repoMergeBase(w.path, target, base);
        } catch (e) {
          onToast(`Can't compare with ${base}: ${errMessage(e)}`, 'error');
        }
      }

      const nextView = baselineOid ? 'review' : 'local';
      setView(nextView);
      await openWorktree(w.path);
      if (baselineOid) {
        await setBaseline(baselineOid);
      }
      setView(nextView);
    })();
  };

  const remove = (w: Worktree, force: boolean) => {
    void (async () => {
      try {
        await removeWorktree(w.path, force);
        setForcePath(null);
        onToast(`Removed worktree ${worktreeName(w)}`);
      } catch (e) {
        const msg = errMessage(e);
        // git refuses dirty/locked worktrees without --force; surface the
        // reason and arm the row's Force remove instead of dead-ending.
        if (!force && /--force|modified or untracked|locked working tree/i.test(msg)) {
          setForcePath(w.path);
        }
        onToast(`Remove failed: ${msg}`, 'error');
      }
    })();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (orderedWorktrees.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocused((f) => Math.min(f + 1, orderedWorktrees.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const w = orderedWorktrees[focused];
      if (w) review(w);
    }
  };

  return (
    <div className="wt-view">
      <div className="wt-hero">
        <div className="wt-hero-copy">
          <span className="wt-kicker">Agent workspaces</span>
          <h2>{repoName}</h2>
          <p>
            Keep one AI task per worktree, then review each branch against its fork
            point without disturbing your main checkout.
          </p>
        </div>
        <div className="wt-hero-stats" aria-label="Worktree summary">
          <Metric value={orderedWorktrees.length} label="total" />
          <Metric value={dirtyWorktrees} label="dirty" />
          <Metric value={lockedWorktrees} label="locked" />
        </div>
        <button type="button" className="btn primary" onClick={onCreateWorktree}>
          <Icon name="plus" size={13} stroke={2} />
          <span>New worktree</span>
        </button>
      </div>

      {orderedWorktrees.length === 0 ? (
        <div className="wt-empty">
          <Icon name="worktree" size={22} />
          <p>No worktrees yet.</p>
          <span>
            Start a feature or bugfix branch in its own directory so an agent can
            work there while your main tree stays review-ready.
          </span>
          <button type="button" className="btn primary" onClick={onCreateWorktree}>
            Create your first worktree
          </button>
        </div>
      ) : (
        <div
          className="wt-list"
          role="listbox"
          tabIndex={0}
          aria-label="Worktrees"
          aria-activedescendant={`wt-row-${focused}`}
          onKeyDown={onKeyDown}
        >
          {orderedWorktrees.map((w, i) => {
            const st = stats[w.path] ?? EMPTY_STATS;
            const name = worktreeName(w);
            const detail = w.is_main ? 'Main checkout' : pathLeaf(w.path);
            return (
              <div
                key={w.path}
                id={`wt-row-${i}`}
                ref={i === focused ? focusedRowRef : undefined}
                role="option"
                aria-selected={i === focused}
                aria-label={`${name}, ${statusText(st)}, ${w.path}`}
                className={'wt-card' + (i === focused ? ' focused' : '') + (w.is_current ? ' current' : '')}
                onClick={() => setFocused(i)}
                onDoubleClick={() => review(w)}
                title={w.path}
              >
                <div className="wt-card-icon">
                  <Icon name={w.is_current ? 'check' : 'worktree'} size={15} />
                </div>

                <div className="wt-card-main">
                  <div className="wt-card-top">
                    <span className="wt-branch">{name}</span>
                    <span className="wt-detail">{detail}</span>
                    <Tags worktree={w} />
                    <Drift ahead={st.ahead} behind={st.behind} />
                  </div>
                  <div className="wt-card-sub">
                    {st.loading ? (
                      <span className="wt-dim">Loading state...</span>
                    ) : (
                      <>
                        <span className={st.dirty > 0 ? 'wt-dirty' : 'wt-clean'}>
                          {st.dirty > 0 ? `${st.dirty} file${st.dirty === 1 ? '' : 's'} changed` : 'clean'}
                        </span>
                        {st.lastTime != null && <span className="wt-dim">· {relTime(st.lastTime)}</span>}
                        {st.lastSubject && <span className="wt-msg">· {st.lastSubject}</span>}
                      </>
                    )}
                  </div>
                  <div className="wt-path">{w.path}</div>
                </div>

                <div className="wt-card-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={(e) => { e.stopPropagation(); review(w); }}
                    title={
                      !w.is_main && mainBranch
                        ? `Review changes since this worktree diverged from ${mainBranch}`
                        : 'Open this worktree on Local Changes'
                    }
                  >
                    {w.is_main ? 'Open' : 'Review'}
                  </button>
                  {!w.is_current && (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={(e) => { e.stopPropagation(); void openWorktree(w.path); }}
                      title="Open this worktree tab"
                    >
                      Open tab
                    </button>
                  )}
                  {!w.is_main && !w.is_current && (forcePath === w.path ? (
                    <>
                      <button
                        type="button"
                        className="btn ghost danger"
                        onClick={(e) => { e.stopPropagation(); remove(w, true); }}
                        title="Discard its local changes and remove the worktree"
                        aria-label={`Force remove worktree ${name}`}
                      >
                        Force remove
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={(e) => { e.stopPropagation(); setForcePath(null); }}
                        aria-label="Cancel force remove"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost danger"
                      onClick={(e) => { e.stopPropagation(); remove(w, false); }}
                      title="Remove this worktree"
                      aria-label={`Remove worktree ${name}`}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="wt-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Tags({ worktree }: { worktree: Worktree }) {
  return (
    <>
      {worktree.is_current && <span className="wt-tag current">current</span>}
      {worktree.is_main && <span className="wt-tag">main</span>}
      {worktree.is_locked && <span className="wt-tag"><Icon name="lock" size={10} /> locked</span>}
      {worktree.is_detached && <span className="wt-tag">detached</span>}
      {worktree.is_prunable && <span className="wt-tag">stale</span>}
    </>
  );
}

function Drift({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return null;
  return (
    <span className="wt-drift">
      {ahead > 0 && <span className="drift-ahead">{ahead}↑</span>}
      {behind > 0 && <span className="drift-behind">{behind}↓</span>}
    </span>
  );
}

function statusText(stats: WtStats): string {
  if (stats.loading) return 'loading';
  return stats.dirty > 0 ? `${stats.dirty} changed files` : 'clean';
}

function relTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
