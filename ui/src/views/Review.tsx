import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { Diff } from '../components/Diff';
import { Icon } from '../components/Icon';
import { hashPatch } from '../lib/patch';
import { gitErrorHint } from '../lib/tauri';
import type { FileDiff } from '../lib/types';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import { HunkAnnotatedDiff, stepChangeBlock } from './LocalChanges';

/**
 * The Review view — the surface for reviewing an AI agent's changes, built
 * around a verdict loop instead of a staging loop (PRD-adjacent; see
 * docs/improvements.md §1).
 *
 * Two modes, decided by whether a baseline is pinned:
 *
 * - **Inbox** (no baseline): the review set is the *unstaged* changes.
 *   Accepting (staging) a file removes it from the inbox; diffs keep their
 *   per-hunk Stage / Discard actions.
 * - **Session** (baseline pinned at a commit): the review set is everything
 *   since that commit — committed + staged + unstaged — so an agent that
 *   commits as it goes can't slip work past the review. Diffs render
 *   read-only (the changes may already be committed; stage/discard don't
 *   apply uniformly), with file-level actions where they do.
 *
 * One file at a time on the right, the queue on the left: `j`/`k` walk it,
 * Space marks reviewed *and advances to the next pending file*, `s` stages,
 * `d`-`d` discards, `n`/`p` step change blocks, `c` jumps to the commit form.
 */
export function Review() {
  const baseline = useRepo((s) => s.baseline);
  const baselineDiffs = useRepo((s) => s.baselineDiffs);
  const unstagedDiffs = useRepo((s) => s.unstagedDiffs);
  const reviewed = useRepo((s) => s.reviewed);
  const toggleReviewed = useRepo((s) => s.toggleReviewed);
  const setBaseline = useRepo((s) => s.setBaseline);
  const clearBaseline = useRepo((s) => s.clearBaseline);
  const refreshBaselineDiffs = useRepo((s) => s.refreshBaselineDiffs);
  const stageReviewed = useRepo((s) => s.stageReviewed);
  const stageMany = useRepo((s) => s.stageMany);
  const unstageMany = useRepo((s) => s.unstageMany);
  const discardMany = useRepo((s) => s.discardMany);
  const selected = useRepo((s) => s.reviewSelection);
  const selectReviewFile = useRepo((s) => s.selectReviewFile);
  const setView = useRepo((s) => s.setView);
  const stagedDiffs = useRepo((s) => s.stagedDiffs);
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  // Session mode's diff set can be stale when the view opens (it only
  // auto-refreshes while a baseline is pinned) — pull it on entry.
  useEffect(() => {
    if (baseline) void refreshBaselineDiffs();
  }, [baseline, refreshBaselineDiffs]);

  const sessionMode = baseline != null;
  const pool: FileDiff[] = sessionMode ? baselineDiffs : unstagedDiffs;

  // Review state per file, derived once per pool/marks change.
  type Verdict = 'pending' | 'reviewed' | 'stale';
  const verdicts = useMemo(() => {
    const m = new Map<string, { hash: string; verdict: Verdict }>();
    for (const d of pool) {
      const hash = hashPatch(d.patch);
      const mark = reviewed[d.path];
      m.set(d.path, {
        hash,
        verdict: mark === hash ? 'reviewed' : mark !== undefined ? 'stale' : 'pending',
      });
    }
    return m;
  }, [pool, reviewed]);
  const pendingCount = useMemo(
    () => pool.filter((d) => verdicts.get(d.path)?.verdict !== 'reviewed').length,
    [pool, verdicts],
  );

  const stagedSet = useMemo(() => new Set(stagedDiffs.map((d) => d.path)), [stagedDiffs]);
  const unstagedSet = useMemo(() => new Set(unstagedDiffs.map((d) => d.path)), [unstagedDiffs]);

  // Keep the selection valid: default to the first pending file, fall back
  // to the first file, clear when the pool empties.
  useEffect(() => {
    if (pool.length === 0) {
      if (selected) selectReviewFile(null);
      return;
    }
    if (selected && pool.some((d) => d.path === selected)) return;
    const firstPending = pool.find((d) => verdicts.get(d.path)?.verdict !== 'reviewed');
    selectReviewFile((firstPending ?? pool[0]).path);
  }, [pool, selected, verdicts, selectReviewFile]);

  const current = useMemo(
    () => pool.find((d) => d.path === selected) ?? null,
    [pool, selected],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (pool.length === 0) return;
      const idx = pool.findIndex((d) => d.path === selected);
      const next = pool[Math.max(0, Math.min(pool.length - 1, idx === -1 ? 0 : idx + dir))];
      if (next) selectReviewFile(next.path);
    },
    [pool, selected, selectReviewFile],
  );

  /** Mark the current file reviewed and move on to the next pending one. */
  const markAndAdvance = useCallback(() => {
    if (!current) return;
    const v = verdicts.get(current.path);
    if (!v) return;
    toggleReviewed(current.path, v.hash);
    if (v.verdict === 'reviewed') return; // it was an unmark — stay put
    const idx = pool.findIndex((d) => d.path === current.path);
    const after = [...pool.slice(idx + 1), ...pool.slice(0, idx)];
    const nextPending = after.find((d) => verdicts.get(d.path)?.verdict !== 'reviewed');
    if (nextPending) selectReviewFile(nextPending.path);
  }, [current, verdicts, pool, toggleReviewed, selectReviewFile]);

  // Failed write ops surface here instead of vanishing into the console.
  const [opError, setOpError] = useState<string | null>(null);
  useEffect(() => {
    if (!opError) return;
    const t = setTimeout(() => setOpError(null), 8000);
    return () => clearTimeout(t);
  }, [opError]);
  const fail = useCallback(
    (verb: string) => (e: unknown) => setOpError(`${verb} failed: ${gitErrorHint(e)}`),
    [],
  );

  // Two-step confirms for the destructive actions.
  const [armDiscardAll, setArmDiscardAll] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  useEffect(() => {
    if (!armDiscardAll) return;
    const t = setTimeout(() => setArmDiscardAll(false), 3000);
    return () => clearTimeout(t);
  }, [armDiscardAll]);
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => setConfirmDiscard(null), 2500);
    return () => clearTimeout(t);
  }, [confirmDiscard]);

  const discardCurrent = useCallback(() => {
    if (!current || !unstagedSet.has(current.path)) return;
    if (confirmDiscard === current.path) {
      setConfirmDiscard(null);
      void discardMany([current.path]).catch(fail('Discard'));
    } else {
      setConfirmDiscard(current.path);
    }
  }, [current, unstagedSet, confirmDiscard, discardMany]);

  // ── Keyboard loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="combobox"]')) {
        return;
      }
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          step(1);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          step(-1);
          break;
        case 'n':
        case 'p':
          e.preventDefault();
          stepChangeBlock(e.key === 'n' ? 1 : -1, '.rv-diff-scroll');
          break;
        case ' ':
          e.preventDefault();
          markAndAdvance();
          break;
        case 's':
          if (current && unstagedSet.has(current.path)) {
            e.preventDefault();
            void stageMany([current.path]).catch(fail('Stage'));
          }
          break;
        case 'd':
          e.preventDefault();
          discardCurrent();
          break;
        case 'c':
          e.preventDefault();
          setView('local');
          requestAnimationFrame(() =>
            document.querySelector<HTMLInputElement>('.lc-commit-bar .subject')?.focus(),
          );
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, markAndAdvance, current, unstagedSet, stageMany, discardCurrent, setView]);

  const stageableReviewed = useMemo(
    () => unstagedDiffs.filter((d) => reviewed[d.path] === hashPatch(d.patch)).length,
    [unstagedDiffs, reviewed],
  );
  const unreviewedUnstaged = useMemo(
    () => unstagedDiffs.filter((d) => reviewed[d.path] !== hashPatch(d.patch)).map((d) => d.path),
    [unstagedDiffs, reviewed],
  );

  const when = baseline
    ? new Date(baseline.setAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  if (pool.length === 0) {
    return (
      <div className="rv-wrap">
        <ReviewToolbar
          sessionMode={sessionMode}
          baselineShort={baseline?.short ?? null}
          when={when}
          reviewedCount={0}
          total={0}
          onPin={() => void setBaseline()}
          onClear={() => void clearBaseline()}
        />
        <div className="lc-empty">
          <strong>{sessionMode ? 'Session is clean' : 'Nothing to review'}</strong>
          {sessionMode
            ? `No changes since ${baseline!.short}. Let the agent work — this view follows along live.`
            : 'No unstaged changes. Pin a baseline before an agent session to also track what it commits.'}
        </div>
      </div>
    );
  }

  return (
    <div className="rv-wrap">
      <ReviewToolbar
        sessionMode={sessionMode}
        baselineShort={baseline?.short ?? null}
        when={when}
        reviewedCount={pool.length - pendingCount}
        total={pool.length}
        onPin={() => void setBaseline()}
        onClear={() => void clearBaseline()}
        extra={
          <>
            {stageableReviewed > 0 && (
              <button type="button" className="h-link" onClick={() => void stageReviewed().catch(fail('Stage reviewed'))}>
                Stage reviewed ({stageableReviewed})
              </button>
            )}
            {unreviewedUnstaged.length > 1 && (
              <button
                type="button"
                className={'h-link' + (armDiscardAll ? ' danger' : '')}
                onClick={() => {
                  if (!armDiscardAll) {
                    setArmDiscardAll(true);
                    return;
                  }
                  setArmDiscardAll(false);
                  void discardMany(unreviewedUnstaged).catch(fail('Discard unreviewed'));
                }}
              >
                {armDiscardAll
                  ? `Really discard ${unreviewedUnstaged.length} files?`
                  : `Discard unreviewed (${unreviewedUnstaged.length})`}
              </button>
            )}
          </>
        }
      />

      <div className="rv-main">
        <PanelGroup direction="horizontal" autoSaveId="strand:review">
          <Panel defaultSize={26} minSize={15} maxSize={50}>
            <div className="rv-list" role="listbox" aria-label="Files to review">
              {pool.map((d) => {
                const v = verdicts.get(d.path)!;
                const active = d.path === selected;
                return (
                  <div
                    key={d.path}
                    role="option"
                    aria-selected={active}
                    tabIndex={0}
                    className={
                      'rv-row' + (active ? ' active' : '') + (v.verdict === 'reviewed' ? ' done' : '')
                    }
                    onClick={() => selectReviewFile(d.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') selectReviewFile(d.path);
                    }}
                    title={d.path}
                  >
                    <span className={`rv-status ${d.status}`}>{statusAbbr(d)}</span>
                    <span className="rv-pathwrap">
                      <span className="rv-name">{fileName(d.path)}</span>
                      <span className="rv-dir">{dirName(d.path)}</span>
                    </span>
                    {v.verdict === 'stale' && <span className="rv-stale">changed</span>}
                    <button
                      type="button"
                      className={'rv-check' + (v.verdict === 'reviewed' ? ' on' : '')}
                      aria-pressed={v.verdict === 'reviewed'}
                      aria-label={
                        v.verdict === 'reviewed'
                          ? `Mark ${d.path} as not reviewed`
                          : `Mark ${d.path} as reviewed`
                      }
                      title={v.verdict === 'reviewed' ? 'Reviewed — click to unmark' : 'Mark as reviewed (Space)'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleReviewed(d.path, v.hash);
                      }}
                    >
                      <Icon name="check" size={11} stroke={2.4} />
                    </button>
                  </div>
                );
              })}
            </div>
          </Panel>
          <PanelResizeHandle className="rs-handle vert" />
          <Panel minSize={30}>
            {current ? (
              <div className="rv-diff">
                <div className="rv-file-head">
                  <span className="path">{current.path}</span>
                  <span className="stat-del">−{current.dels}</span>
                  <span className="stat-add">+{current.adds}</span>
                  <span className="rv-head-actions">
                    {unstagedSet.has(current.path) && (
                      <>
                        <button
                          type="button"
                          className="h-link"
                          onClick={() => void stageMany([current.path]).catch(fail('Stage'))}
                          title="Stage this file (s)"
                        >
                          Stage
                        </button>
                        <button
                          type="button"
                          className={'h-link' + (confirmDiscard === current.path ? ' danger' : '')}
                          onClick={discardCurrent}
                          title="Discard this file's working-tree changes (d d)"
                        >
                          {confirmDiscard === current.path ? 'Really discard?' : 'Discard'}
                        </button>
                      </>
                    )}
                    {sessionMode && !unstagedSet.has(current.path) && stagedSet.has(current.path) && (
                      <button
                        type="button"
                        className="h-link"
                        onClick={() => void unstageMany([current.path]).catch(fail('Unstage'))}
                        title="Unstage this file"
                      >
                        Unstage
                      </button>
                    )}
                    <button
                      type="button"
                      className={
                        'rv-check wide' + (verdicts.get(current.path)?.verdict === 'reviewed' ? ' on' : '')
                      }
                      aria-pressed={verdicts.get(current.path)?.verdict === 'reviewed'}
                      onClick={markAndAdvance}
                      title="Mark reviewed and jump to the next pending file (Space)"
                    >
                      <Icon name="check" size={12} stroke={2.2} />
                      {verdicts.get(current.path)?.verdict === 'reviewed' ? 'Reviewed' : 'Mark reviewed'}
                    </button>
                  </span>
                </div>
                <div className="rv-diff-scroll">
                  {current.binary || current.patch.length === 0 ? (
                    <div className="lc-file-note">
                      {current.binary ? 'Binary file — no diff shown.' : 'No textual diff.'}
                    </div>
                  ) : sessionMode ? (
                    // Session diffs span commits — render read-only.
                    <Diff patch={current.patch} layout={layout} hideFileHeader />
                  ) : (
                    // Inbox diffs are pure unstaged changes — full hunk
                    // Stage / Discard actions apply.
                    <HunkAnnotatedDiff diff={current} layout={layout} side="unstaged" />
                  )}
                </div>
              </div>
            ) : (
              <div className="lc-empty">
                <strong>Pick a file</strong>
                Select something on the left to review its diff.
              </div>
            )}
          </Panel>
        </PanelGroup>
      </div>

      <div className="rv-foot" aria-hidden="true">
        <span className="kbd-inline">↑ ↓ j k</span> files
        <span className="kbd-inline">space</span> reviewed → next
        <span className="kbd-inline">n p</span> blocks
        <span className="kbd-inline">s</span> stage
        <span className="kbd-inline">d d</span> discard
        <span className="kbd-inline">c</span> commit
      </div>

      {opError && (
        <div className="toast" role="alert">
          <span style={{ color: 'var(--del, #e5534b)' }}><Icon name="x" size={13} stroke={2} /></span>
          <span>{opError}</span>
          <button type="button" className="toast-action" onClick={() => setOpError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewToolbar({
  sessionMode,
  baselineShort,
  when,
  reviewedCount,
  total,
  onPin,
  onClear,
  extra,
}: {
  sessionMode: boolean;
  baselineShort: string | null;
  when: string | null;
  reviewedCount: number;
  total: number;
  onPin: () => void;
  onClear: () => void;
  extra?: React.ReactNode;
}) {
  const pct = total > 0 ? Math.round((reviewedCount / total) * 100) : 0;
  return (
    <div className="rv-toolbar" role="toolbar" aria-label="Review session">
      <span className="rv-chip">
        <Icon name="history" size={12} />
        {sessionMode ? (
          <>
            Session since <code>{baselineShort}</code>
            {when ? ` · ${when}` : ''}
          </>
        ) : (
          'Unstaged changes'
        )}
      </span>
      {total > 0 && (
        <span className="rv-progress" title={`${reviewedCount} of ${total} files reviewed`}>
          <span className="rv-progress-bar" aria-hidden="true">
            <span className="fill" style={{ width: `${pct}%` }} />
          </span>
          {reviewedCount}/{total} reviewed
        </span>
      )}
      <div className="rv-actions">
        {extra}
        <button
          type="button"
          className="h-link"
          onClick={onPin}
          title={
            sessionMode
              ? 'Re-pin the baseline at the current HEAD'
              : 'Track everything from this point — including commits the agent makes'
          }
        >
          {sessionMode ? 'Move baseline to HEAD' : 'Pin baseline at HEAD'}
        </button>
        {sessionMode && (
          <button type="button" className="h-link" onClick={onClear}>
            Clear baseline
          </button>
        )}
      </div>
    </div>
  );
}

function statusAbbr(d: FileDiff): string {
  switch (d.status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
    default:
      return 'M';
  }
}

function fileName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}
