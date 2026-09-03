import { useEffect, useMemo, useRef, useState } from 'react';
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
  dirty: number;
  lastSubject: string | null;
  lastTime: number | null;
  health: WorktreeHealth | null;
  fs: WorktreeStats | null;
}

const EMPTY_STATS: WtStats = {
  loading: true,
  dirty: 0,
  lastSubject: null,
  lastTime: null,
  health: null,
  fs: null,
};

/** Compact worktree switcher and state summary. */
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
  const refreshRefs = useRepo((s) => s.refreshRefs);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);

  const [stats, setStats] = useState<Record<string, WtStats>>({});
  const [focused, setFocused] = useState(0);
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
      || (stats[b.path]?.fs?.last_activity_unix ?? 0) - (stats[a.path]?.fs?.last_activity_unix ?? 0)
      || worktreeName(a).localeCompare(worktreeName(b)));
  }, [worktrees, stats]);

  useEffect(() => {
    setFocused((current) => Math.min(current, Math.max(0, orderedWorktrees.length - 1)));
  }, [orderedWorktrees.length]);

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
      if (w.is_main || w.is_current || !w.branch) return false;
      const st = stats[w.path];
      return !!st && !st.loading && st.dirty === 0 && !!st.health?.merged;
    }),
    [worktrees, stats],
  );

  // The palette action switches here, then asks this mounted view to open the
  // confirmation. Keep this listener even though cleanup has no pane control.
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (orderedWorktrees.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocused((current) => Math.min(current + 1, orderedWorktrees.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocused((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const worktree = orderedWorktrees[focused];
      if (worktree) void openWorktree(worktree.path);
    }
  };

  const repoName = repoFamilyName(meta);

  return (
    <div className="wt-view">
      <PaneHeader
        title={
          <span className="wt-breadcrumb">
            <span>{repoName}</span><span aria-hidden="true"> / </span><strong>Worktrees</strong>
          </span>
        }
        actions={
          <button type="button" className="btn primary" onClick={onCreateWorktree}>
            <Icon name="plus" size={13} stroke={2} />
            <span>New worktree</span>
          </button>
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
        <div className="wt-table" role="table" aria-label="Worktrees">
          <div className="wt-table-head" role="row">
            <span role="columnheader">Worktree</span>
            <span role="columnheader">Branch</span>
            <span role="columnheader">Changes</span>
            <span role="columnheader">Touched</span>
          </div>
          <div className="wt-table-body" role="rowgroup" tabIndex={0} onKeyDown={onKeyDown}>
            {orderedWorktrees.map((w, index) => {
              const st = stats[w.path] ?? EMPTY_STATS;
              const touched = st.fs?.last_activity_unix ?? st.lastTime;
              return (
                <div
                  key={w.path}
                  ref={index === focused ? focusedRowRef : undefined}
                  className={`wt-row${index === focused ? ' focused' : ''}${w.is_current ? ' current' : ''}`}
                  role="row"
                  aria-selected={index === focused}
                  aria-label={`${worktreeName(w)}, ${statusText(st)}, ${w.path}`}
                  title={w.path}
                  onClick={() => setFocused(index)}
                  onDoubleClick={() => void openWorktree(w.path)}
                >
                  <span className="wt-name" role="cell">{worktreeName(w)}</span>
                  <span className="wt-branch-cell" role="cell">
                    <span>{w.branch ?? 'detached'}</span>
                    {st.health?.merged && <span className="wt-merged">merged</span>}
                  </span>
                  <span className="wt-changes" role="cell"><Changes stats={st} /></span>
                  <span className="wt-touched" role="cell">{touched == null ? '—' : agoText(touched)}</span>
                </div>
              );
            })}
          </div>
        </div>
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
  if (stats.loading) return <>loading…</>;
  if (stats.dirty === 0) return <>{stats.lastSubject ? `clean · ${stats.lastSubject}` : 'clean'}</>;
  return (
    <>
      <span className="wt-add">+{stats.fs?.insertions ?? 0}</span>{' '}
      <span className="wt-del">−{stats.fs?.deletions ?? 0}</span>
      {` · ${stats.dirty} file${stats.dirty === 1 ? '' : 's'}`}
    </>
  );
}

function statusText(stats: WtStats): string {
  if (stats.loading) return 'loading';
  return stats.dirty > 0 ? `${stats.dirty} changed files` : 'clean';
}

function agoText(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
