import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Icon } from '../components/Icon';
import { pathLeaf, repoFamilyName, worktreeName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { Worktree, WorktreeArchive, WorktreeHealth } from '../lib/types';
import { WorktreeMergeDialog } from './WorktreeMergeDialog';

interface WtStats {
  loading: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  lastSubject: string | null;
  lastTime: number | null;
  /** Ref-level health vs the detected base; `null` for main/detached rows. */
  health: WorktreeHealth | null;
}

const EMPTY_STATS: WtStats = {
  loading: true,
  dirty: 0,
  ahead: 0,
  behind: 0,
  lastSubject: null,
  lastTime: null,
  health: null,
};

/** Snapshot of the row a merge dialog was opened for — kept stable while the
 *  underlying lists refresh mid-flow. */
interface MergeTarget {
  worktree: Worktree;
  health: WorktreeHealth;
  dirty: number;
}

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
  const refreshRefs = useRepo((s) => s.refreshRefs);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const pruneWorktrees = useRepo((s) => s.pruneWorktrees);
  const setBaseline = useRepo((s) => s.setBaseline);
  const setView = useRepo((s) => s.setView);

  const [stats, setStats] = useState<Record<string, WtStats>>({});
  // Worktree path whose plain remove git refused (dirty/locked); its row
  // swaps the trash button for an explicit Force remove / Cancel pair.
  const [forcePath, setForcePath] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const [showCleanup, setShowCleanup] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [archives, setArchives] = useState<WorktreeArchive[]>([]);
  const [archivesOpen, setArchivesOpen] = useState(false);
  // Archive ref pending delete; its row shows an explicit confirm pair.
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
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
          const [status, m, log, health] = await Promise.all([
            tauri.repoStatus(w.path),
            tauri.repoMeta(w.path),
            tauri.repoLog(w.path, 1),
            // Health only means something for a linked worktree on a branch.
            !w.is_main && w.branch
              ? tauri.repoWorktreeHealth(w.path, w.branch).catch(() => null)
              : Promise.resolve(null),
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
              health,
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

  const refreshArchives = useCallback(async () => {
    const path = activePath;
    if (!path) return;
    try {
      const list = await tauri.repoWorktreeArchives(path);
      setArchives(list);
    } catch {
      // Non-fatal: the section just stays as-is.
    }
  }, [activePath]);

  // Every removal archives first, so re-list whenever the worktree set moves.
  useEffect(() => {
    void refreshArchives();
  }, [refreshArchives, pathsKey]);

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

  useEffect(() => {
    if (!showCleanup) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !cleanupBusy) setShowCleanup(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showCleanup, cleanupBusy]);

  const dirtyWorktrees = orderedWorktrees.filter((w) => (stats[w.path]?.dirty ?? 0) > 0).length;
  const mergedWorktrees = orderedWorktrees.filter((w) => stats[w.path]?.health?.merged).length;

  // Safe to retire without losing anything: clean, on a branch, and every
  // commit already lives in the base.
  const cleanupCandidates = useMemo(
    () =>
      worktrees.filter((w) => {
        if (w.is_main || w.is_current || !w.branch) return false;
        const st = stats[w.path];
        return !!st && !st.loading && st.dirty === 0 && !!st.health?.merged;
      }),
    [worktrees, stats],
  );

  const review = (w: Worktree) => {
    void (async () => {
      const target = w.branch ?? w.head;
      let baselineOid: string | null = null;

      // Review against the branch this worktree actually forked from, not
      // the main worktree's branch — a worktree cut from `portal30` must
      // baseline at merge-base(HEAD, portal30), or the diff swallows all of
      // portal30's own work (DAN-14).
      if (!w.is_main && target) {
        try {
          const base = await tauri.repoDetectBaseBranch(w.path, target);
          if (base) {
            baselineOid = base.merge_base;
            onToast(`Reviewing ${w.branch ?? worktreeName(w)} vs ${base.name}`);
          }
        } catch (e) {
          onToast(`Can't detect base branch: ${errMessage(e)}`, 'error');
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
        void refreshArchives();
        onToast(`Removed worktree ${worktreeName(w)} — snapshot archived`);
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

  const prune = () => {
    void (async () => {
      try {
        await pruneWorktrees();
        onToast('Pruned stale worktree entries');
      } catch (e) {
        onToast(`Prune failed: ${errMessage(e)}`, 'error');
      }
    })();
  };

  const runCleanup = () => {
    const path = activePath;
    if (!path) return;
    void (async () => {
      setCleanupBusy(true);
      let removed = 0;
      const errors: string[] = [];
      for (const w of cleanupCandidates) {
        try {
          // removeWorktree archives the full state first (safety net).
          await removeWorktree(w.path, true);
          if (w.branch) await tauri.repoBranchDelete(path, w.branch, true);
          removed += 1;
        } catch (e) {
          errors.push(`${worktreeName(w)}: ${errMessage(e)}`);
        }
      }
      await Promise.all([refreshWorktrees(), refreshRefs()]);
      void refreshArchives();
      setCleanupBusy(false);
      setShowCleanup(false);
      if (errors.length > 0) {
        onToast(`Cleaned up ${removed}, but: ${errors[0]}`, 'error');
      } else {
        onToast(`Cleaned up ${removed} worktree${removed === 1 ? '' : 's'} — snapshots archived`);
      }
    })();
  };

  const restoreArchive = (a: WorktreeArchive) => {
    const path = activePath;
    if (!path) return;
    void (async () => {
      // Fallback only — restore prefers the snapshot's original directory
      // and re-attaches its branch when both are free.
      const mainPath = worktrees.find((w) => w.is_main)?.path ?? path;
      const parent = mainPath.replace(/[\\/][^\\/]*$/, '');
      const dest = `${parent}/${repoFamilyName(meta)}.worktrees/${a.name.replace(/\//g, '-')}`;
      try {
        const res = await tauri.repoWorktreeArchiveRestore(path, a.ref_name, dest);
        await Promise.all([refreshWorktrees(), refreshRefs()]);
        onToast(
          res.branch
            ? `Restored ${a.name} on ${res.branch} at ${res.path}`
            : `Restored ${a.name} (detached) at ${res.path}`,
        );
        void openWorktree(res.path);
      } catch (e) {
        onToast(`Restore failed: ${errMessage(e)}`, 'error');
      }
    })();
  };

  const deleteArchive = (a: WorktreeArchive) => {
    const path = activePath;
    if (!path) return;
    void (async () => {
      try {
        await tauri.repoWorktreeArchiveDelete(path, a.ref_name);
        setArchives((s) => s.filter((x) => x.ref_name !== a.ref_name));
        setArchiveConfirm(null);
        onToast('Snapshot deleted');
      } catch (e) {
        onToast(`Delete failed: ${errMessage(e)}`, 'error');
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
          <Metric value={mergedWorktrees} label="merged" />
        </div>
        <div className="wt-hero-actions">
          <button type="button" className="btn primary" onClick={onCreateWorktree}>
            <Icon name="plus" size={13} stroke={2} />
            <span>New worktree</span>
          </button>
          {cleanupCandidates.length > 0 && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setShowCleanup(true)}
              title="Remove worktrees that are clean and fully merged into their base (snapshots archived first)"
            >
              <Icon name="trash" size={12} />
              <span>Clean up ({cleanupCandidates.length})</span>
            </button>
          )}
          {worktrees.some((w) => w.is_prunable) && (
            <button
              type="button"
              className="btn ghost"
              onClick={prune}
              title="Drop registry entries whose directories are gone"
            >
              <Icon name="sync" size={12} />
              <span>Prune stale</span>
            </button>
          )}
        </div>
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
            const baseName = st.health?.base_branch ?? mainBranch;
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
                    <Tags worktree={w} health={st.health} />
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
                      !w.is_main && baseName
                        ? `Review changes since this worktree diverged from ${baseName}`
                        : 'Open this worktree on Local Changes'
                    }
                  >
                    {w.is_main ? 'Open' : 'Review'}
                  </button>
                  {!w.is_main && w.branch && st.health?.base_branch && !st.health.merged && (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMergeTarget({ worktree: w, health: st.health!, dirty: st.dirty });
                      }}
                      title={`Merge ${w.branch} into ${st.health.base_branch}, then optionally remove the worktree`}
                    >
                      Merge…
                    </button>
                  )}
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
                        title="Remove the worktree; its state is archived to a snapshot first"
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
                      title="Remove this worktree (a snapshot is archived first)"
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

      {archives.length > 0 && (
        <div className="wt-archives">
          <button
            type="button"
            className="wt-archives-head"
            onClick={() => setArchivesOpen((o) => !o)}
            aria-expanded={archivesOpen}
          >
            <span className="wt-archives-caret">{archivesOpen ? '▾' : '▸'}</span>
            <span>Archived snapshots</span>
            <span className="wt-archives-count">{archives.length}</span>
            <span className="wt-dim">taken automatically before each worktree removal</span>
          </button>
          {archivesOpen && (
            <div className="wt-archives-list">
              {archives.map((a) => (
                <div key={a.ref_name} className="wt-archive-row">
                  <Icon name="worktree" size={12} />
                  <span className="wt-archive-name">{a.name}</span>
                  <span className="wt-dim">{relTime(a.time_unix)} · {a.oid.slice(0, 7)}</span>
                  <div className="wt-archive-actions">
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => restoreArchive(a)}
                      title="Recreate a worktree with this snapshot's exact state (including uncommitted changes)"
                    >
                      Restore
                    </button>
                    {archiveConfirm === a.ref_name ? (
                      <>
                        <button type="button" className="btn ghost danger" onClick={() => deleteArchive(a)}>
                          Delete snapshot
                        </button>
                        <button type="button" className="btn ghost" onClick={() => setArchiveConfirm(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost danger"
                        onClick={() => setArchiveConfirm(a.ref_name)}
                        title="Delete this snapshot"
                        aria-label={`Delete snapshot ${a.name}`}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mergeTarget && (
        <WorktreeMergeDialog
          worktree={mergeTarget.worktree}
          health={mergeTarget.health}
          dirty={mergeTarget.dirty}
          onClose={() => setMergeTarget(null)}
          onToast={onToast}
        />
      )}

      {showCleanup && (
        <div
          className="palette-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !cleanupBusy) setShowCleanup(false);
          }}
        >
          <div className="clone-dialog worktree-dialog" role="dialog" aria-modal="true" aria-label="Clean up worktrees">
            <div className="clone-head">
              <Icon name="trash" size={15} />
              <span className="title">Clean up merged worktrees</span>
              <button
                type="button"
                className="cd-close"
                aria-label="Close"
                disabled={cleanupBusy}
                onClick={() => setShowCleanup(false)}
              >
                ×
              </button>
            </div>
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
            <div className="clone-foot">
              <button type="button" className="btn" disabled={cleanupBusy} onClick={() => setShowCleanup(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={cleanupBusy || cleanupCandidates.length === 0}
                onClick={runCleanup}
              >
                {cleanupBusy
                  ? 'Cleaning…'
                  : `Remove ${cleanupCandidates.length} worktree${cleanupCandidates.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
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

function Tags({ worktree, health }: { worktree: Worktree; health: WorktreeHealth | null }) {
  // Work that exists only in this worktree: unmerged commits with no
  // upstream, or an upstream that hasn't seen them yet.
  const atRisk =
    !!health &&
    !health.merged &&
    (health.has_upstream ? health.unpushed > 0 : health.ahead_of_base > 0);
  return (
    <>
      {worktree.is_current && <span className="wt-tag current">current</span>}
      {worktree.is_main && <span className="wt-tag">main</span>}
      {health?.merged && (
        <span
          className="wt-tag merged"
          title={`No commits of its own — everything is in ${health.merged_into ?? health.base_branch}`}
        >
          merged
        </span>
      )}
      {atRisk && health && (
        <span
          className="wt-tag warn"
          title={
            `${health.ahead_of_base} commit${health.ahead_of_base === 1 ? '' : 's'} not in ${health.base_branch}` +
            (health.has_upstream
              ? ` and not pushed (${health.unpushed})`
              : ' and no upstream — this work exists only here')
          }
        >
          {health.has_upstream ? 'unpushed' : 'unmerged'}
        </span>
      )}
      {worktree.is_locked && (
        <span className="wt-tag" title={worktree.lock_reason ?? undefined}>
          <Icon name="lock" size={10} /> locked
        </span>
      )}
      {worktree.is_detached && <span className="wt-tag">detached</span>}
      {worktree.is_prunable && (
        <span className="wt-tag" title={worktree.prune_reason ?? undefined}>stale</span>
      )}
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
