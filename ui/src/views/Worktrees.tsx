import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { PaneHeader } from '../components/PaneHeader';
import { repoFamilyName, worktreeName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import type { WorktreeHealth, WorktreeStats } from '../lib/types';
import { useRepo } from '../stores/repo';

interface WtStats {
  loading: boolean;
  dirty: number | null;
  lastSubject: string | null;
  lastTime: number | null;
  health: WorktreeHealth | null;
  fs: WorktreeStats | null;
}

const EMPTY_STATS: WtStats = {
  loading: true,
  dirty: null,
  lastSubject: null,
  lastTime: null,
  health: null,
  fs: null,
};

/** Compact worktree switcher and state summary. */
export function Worktrees({
  onCreateWorktree,
  onReviewWorktree,
  onToast,
}: {
  onCreateWorktree: () => void;
  onReviewWorktree: (path: string) => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const meta = useRepo((s) => s.meta);
  const activePath = useRepo((s) => s.activePath);
  const worktrees = useRepo((s) => s.worktrees);
  const refreshWorktrees = useRepo((s) => s.refreshWorktrees);
  const refreshRefs = useRepo((s) => s.refreshRefs);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);

  const [stats, setStats] = useState<Record<string, WtStats>>({});
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const rowId = useId();
  const tableRef = useRef<HTMLDivElement>(null);
  const [showCleanup, setShowCleanup] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const focusedRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshWorktrees();
  }, [activePath, refreshWorktrees]);

  useEffect(() => {
    let cancelled = false;
    setStats((prev) => {
      const live = new Set(worktrees.map((w) => w.path));
      return Object.fromEntries(Object.entries(prev).filter(([path]) => live.has(path)));
    });

    for (const w of worktrees) {
      void (async () => {
        try {
          const [status, log, health] = await Promise.all([
            tauri.repoStatus(w.path),
            tauri.repoLog(w.path, 1, true),
            !w.is_main && w.branch
              ? tauri.repoWorktreeHealth(w.path, w.branch).catch(() => null)
              : Promise.resolve(null),
          ]);
          if (cancelled) return;
          setStats((current) => ({
            ...current,
            [w.path]: {
              ...(current[w.path] ?? EMPTY_STATS),
              loading: false,
              dirty: status.length,
              lastSubject: log[0]?.subject ?? null,
              lastTime: log[0]?.time_unix ?? null,
              health,
            },
          }));
        } catch {
          if (!cancelled) {
            setStats((current) => ({ ...current, [w.path]: { ...EMPTY_STATS, loading: false } }));
          }
        }
      })();

      void tauri.repoWorktreeStats(w.path).then((fs) => {
        if (cancelled) return;
        setStats((current) => ({
          ...current,
          [w.path]: { ...(current[w.path] ?? EMPTY_STATS), fs },
        }));
      }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [worktrees]);

  const orderedWorktrees = useMemo(() => {
    const rank = (isCurrent: boolean, isMain: boolean) => isCurrent ? 0 : isMain ? 1 : 2;
    return [...worktrees].sort((a, b) =>
      rank(a.is_current, a.is_main) - rank(b.is_current, b.is_main)
      || worktreeName(a).localeCompare(worktreeName(b)));
  }, [worktrees]);

  const focused = Math.max(0, orderedWorktrees.findIndex((w) => w.path === focusedPath));
  const selectedWorktree = orderedWorktrees[focused];

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
    const path = orderedWorktrees[focused]?.path ?? null;
    window.dispatchEvent(new CustomEvent('strand:worktree-focus', { detail: path }));
  }, [focused, orderedWorktrees]);

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('strand:worktree-focus', { detail: null }));
  }, []);

  const cleanupCandidates = useMemo(
    () => worktrees.filter((w) => {
      if (w.is_main || w.is_current || w.is_locked || w.is_prunable || !w.branch) return false;
      const st = stats[w.path];
      return !!st && !st.loading && st.dirty === 0 && !!st.health?.merged;
    }),
    [worktrees, stats],
  );

  // The palette action switches here, then asks this mounted view to open the
  // confirmation. The header button opens the same dialog.
  useEffect(() => {
    const onCleanupRequest = () => setShowCleanup(true);
    window.addEventListener('strand:worktrees-cleanup', onCleanupRequest);
    return () => window.removeEventListener('strand:worktrees-cleanup', onCleanupRequest);
  }, []);

  useEffect(() => {
    if (!showCleanup) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !cleanupBusy) setShowCleanup(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showCleanup, cleanupBusy]);

  const runCleanup = () => {
    const path = activePath;
    if (!path) return;
    void (async () => {
      setCleanupBusy(true);
      let removed = 0;
      const errors: string[] = [];
      for (const w of cleanupCandidates) {
        try {
          await removeWorktree(w.path, true);
          if (w.branch) await tauri.repoBranchDelete(path, w.branch, true);
          removed += 1;
        } catch (error) {
          errors.push(`${worktreeName(w)}: ${errMessage(error)}`);
        }
      }
      await Promise.all([refreshWorktrees(), refreshRefs()]);
      setCleanupBusy(false);
      setShowCleanup(false);
      if (errors.length > 0) onToast(`Cleaned up ${removed}, but: ${errors[0]}`, 'error');
      else onToast(`Cleaned up ${removed} worktree${removed === 1 ? '' : 's'} — snapshots archived`);
    })();
  };

  const openSelected = (path: string) => {
    void openWorktree(path).catch((error) => onToast(`Could not open worktree: ${errMessage(error)}`, 'error'));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (orderedWorktrees.length === 0) return;
    let next = focused;
    if (event.key === 'ArrowDown') next = Math.min(focused + 1, orderedWorktrees.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(focused - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = orderedWorktrees.length - 1;
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (selectedWorktree && !selectedWorktree.is_prunable && !selectedWorktree.is_bare) openSelected(selectedWorktree.path);
      return;
    } else return;
    event.preventDefault();
    setFocusedPath(orderedWorktrees[next].path);
  };

  const repoName = repoFamilyName(meta);

  return (
    <div className="wt-view">
      <PaneHeader
        title={
          <span className="wt-breadcrumb">
            {repoName} / <strong>Worktrees</strong>
          </span>
        }
        actions={
          <>
            <button type="button" className="btn" onClick={() => setShowCleanup(true)}>
              Clean up…
            </button>
            <button type="button" className="btn primary" onClick={onCreateWorktree}>
              <Icon name="plus" size={13} stroke={2} />
              <span>New worktree</span>
            </button>
          </>
        }
      />

      {orderedWorktrees.length === 0 ? (
        <EmptyState
          icon="worktree"
          title="No worktrees yet."
          hint="Create a worktree to keep another branch checked out in its own directory."
          action={<button type="button" className="btn primary" onClick={onCreateWorktree}>New worktree</button>}
        />
      ) : (
        <>
          <div className="wt-table" role="grid" aria-label="Worktrees" aria-readonly="true"
            aria-activedescendant={`${rowId}-${focused}`} tabIndex={0} ref={tableRef} onKeyDown={onKeyDown}>
            <div className="wt-table-head" role="row">
              <span role="columnheader">Worktree <span className="wt-dim">{orderedWorktrees.length}</span></span>
              <span role="columnheader">Working changes</span>
              <span role="columnheader" className="wt-commit">Latest commit</span>
            </div>
            <div className="wt-table-body" role="rowgroup">
              {orderedWorktrees.map((w, index) => {
                const st = stats[w.path] ?? EMPTY_STATS;
                return (
                  <div
                    key={w.path}
                    id={`${rowId}-${index}`}
                    ref={index === focused ? focusedRowRef : undefined}
                    className={`wt-row${index === focused ? ' selected' : ''}${w.is_current ? ' current' : ''}`}
                    role="row"
                    aria-selected={index === focused}
                    aria-label={`${worktreeName(w)}${w.is_current ? ', current checkout' : ''}, ${statusText(st)}, ${w.path}`}
                    onClick={() => { setFocusedPath(w.path); tableRef.current?.focus({ preventScroll: true }); }}
                    onDoubleClick={() => { if (!w.is_prunable && !w.is_bare) openSelected(w.path); }}
                  >
                    <div className="wt-identity" role="gridcell">
                      <Icon name={w.is_main ? 'folder' : 'worktree'} size={16} />
                      <div className="wt-cell-lines">
                        <div className="wt-name-line">
                          <span className="wt-name" title={worktreeName(w)}>{worktreeName(w)}</span>
                          {w.is_current && <span className="wt-current-label">Current</span>}
                          {w.is_locked && <span title={w.lock_reason ?? 'Locked'} aria-label="Locked"><Icon name="lock" size={12} /></span>}
                        </div>
                        <span className="wt-path" title={w.path}>{w.is_main ? 'Main checkout · ' : ''}{w.path}</span>
                      </div>
                    </div>
                    <div className="wt-cell-lines wt-changes" role="gridcell">
                      {w.is_prunable ? <span className="wt-dim">Directory missing</span> : <Changes stats={st} />}
                    </div>
                    <div className="wt-cell-lines wt-commit" role="gridcell">
                      <span className="wt-subject" title={st.lastSubject ?? undefined}>{st.lastSubject ?? (st.loading ? 'Loading…' : '—')}</span>
                      <span className="wt-detail">
                        {st.lastTime == null ? '—' : agoText(st.lastTime)}
                        {st.health?.merged && <span className="wt-merged"> · Merged{st.health.merged_into ? ` into ${st.health.merged_into}` : ''}</span>}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {selectedWorktree && (
            <div className="wt-selection-bar">
              <span className="wt-selection-copy"><span className="wt-name">{worktreeName(selectedWorktree)}</span><span className="wt-dim">↑ ↓ to select · Enter to open</span></span>
              <div className="wt-selection-actions">
                {!selectedWorktree.is_main && !selectedWorktree.is_prunable && !selectedWorktree.is_bare && (
                  <button type="button" className="btn" onClick={() => onReviewWorktree(selectedWorktree.path)}>
                    <Icon name="eye" size={13} />Review vs base
                  </button>
                )}
                <button type="button" className="btn" disabled={selectedWorktree.is_prunable || selectedWorktree.is_bare}
                  onClick={() => openSelected(selectedWorktree.path)}>
                  Open worktree<Icon name="chev-right" size={13} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {showCleanup && (
        <Dialog
          title="Clean up merged worktrees"
          icon="trash"
          className="worktree-dialog"
          busy={cleanupBusy}
          onClose={() => setShowCleanup(false)}
          footer={
            <>
              <button
                type="button"
                className="btn"
                disabled={cleanupBusy}
                onClick={() => setShowCleanup(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={cleanupBusy || cleanupCandidates.length === 0}
                onClick={runCleanup}
              >
                {cleanupBusy ? 'Cleaning…' : `Remove ${cleanupCandidates.length} worktree${cleanupCandidates.length === 1 ? '' : 's'}`}
              </button>
            </>
          }
        >
          <div className="clone-body">
            <p className="stash-blurb">
              These worktrees are clean and every commit is already in their base
              branch. Each one is snapshotted to the archive before its directory
              and branch are removed.
            </p>
            {cleanupCandidates.length === 0 && <p className="wt-dim">No worktrees are ready to clean up. Current and locked checkouts are kept.</p>}
            <ul className="wt-cleanup-list">
              {cleanupCandidates.map((w) => {
                const h = stats[w.path]?.health;
                return (
                  <li key={w.path}>
                    <strong>{w.branch}</strong>
                    <span className="wt-dim"> — in {h?.merged_into ?? h?.base_branch} · {w.path}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Changes({ stats }: { stats: WtStats }) {
  if (stats.loading) return <span className="wt-dim">Loading…</span>;
  if (stats.dirty == null) return <span className="wt-dim">Status unavailable</span>;
  if (stats.dirty === 0) return <span className="wt-dim">Clean</span>;
  return (
    <>
      <span>{stats.dirty} changed file{stats.dirty === 1 ? '' : 's'}</span>
      <span className="wt-detail">
        {stats.fs && <><span className="wt-add">+{stats.fs.insertions}</span>{' '}<span className="wt-del">−{stats.fs.deletions}</span></>}
        {stats.fs?.last_activity_unix != null && <span className="wt-dim"> · active {agoText(stats.fs.last_activity_unix)}</span>}
      </span>
    </>
  );
}

function statusText(stats: WtStats): string {
  if (stats.loading) return 'loading';
  if (stats.dirty == null) return 'status unavailable';
  return stats.dirty > 0 ? `${stats.dirty} changed files` : 'clean';
}

function agoText(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
