import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { Worktree, WorktreeHealth } from '../lib/types';

type Mode = 'squash' | 'merge' | 'ff';

/**
 * "Merge & clean up" — land a worktree's branch on its detected base and
 * (optionally) retire the worktree + branch in the same motion. The preview
 * box shows the exact git commands that will run: trust through legibility.
 *
 * The merge itself runs in whichever worktree has the base checked out (its
 * workdir must be clean); when none does, only a pure ref fast-forward is
 * offered. Cleanup always archives a full snapshot first (see
 * `removeWorktree` in the repo store), so nothing is unrecoverable.
 */
export function WorktreeMergeDialog({
  worktree,
  health,
  dirty,
  onClose,
  onToast,
}: {
  worktree: Worktree;
  health: WorktreeHealth;
  /** Uncommitted files in the worktree — they won't be part of the merge. */
  dirty: number;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const activePath = useRepo((s) => s.activePath);
  const worktrees = useRepo((s) => s.worktrees);
  const refs = useRepo((s) => s.refs);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const refreshWorktrees = useRepo((s) => s.refreshWorktrees);
  const refreshRefs = useRepo((s) => s.refreshRefs);
  const refreshLocalChanges = useRepo((s) => s.refreshLocalChanges);

  const branch = worktree.branch ?? '';
  // The detected base is a heuristic — with several sibling worktrees cut
  // from one commit it can name a sibling — so the target is user-editable.
  const [base, setBase] = useState(health.base_branch ?? '');
  const baseOptions = useMemo(
    () => refs.branches.map((b) => b.name).filter((n) => n !== branch),
    [refs, branch],
  );
  const baseTip = refs.branches.find((b) => b.name === base)?.target ?? null;
  // Where the merge will run; without a checkout of the base, only a pure
  // ref fast-forward is possible.
  const holder = useMemo(
    () => worktrees.find((w) => w.branch === base) ?? null,
    [worktrees, base],
  );

  const [mode, setMode] = useState<Mode>(holder ? 'squash' : 'ff');
  const [cleanup, setCleanup] = useState(!worktree.is_current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fast-forward is possible iff the base tip is still the fork point —
  // recomputed per selected base (null while the merge-base lookup runs).
  const [ffPossible, setFfPossible] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFfPossible(null);
    if (!activePath || !branch || !base || !baseTip) return;
    void tauri
      .repoMergeBase(activePath, branch, base)
      .then((mb) => { if (!cancelled) setFfPossible(mb === baseTip); })
      .catch(() => { if (!cancelled) setFfPossible(false); });
    return () => { cancelled = true; };
  }, [activePath, branch, base, baseTip]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Restore focus to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Changing the base can invalidate the chosen mode: no checkout of the
  // base leaves only ff, and a moved base rules ff out.
  useEffect(() => {
    if (!holder && mode !== 'ff') setMode('ff');
    else if (holder && mode === 'ff' && ffPossible === false) setMode('squash');
  }, [holder, mode, ffPossible]);

  const canSubmit = !busy && !!branch && !!base && (mode !== 'ff' || ffPossible === true);

  const commands = useMemo(() => {
    const lines: string[] = [];
    if (holder) {
      const cd = `git -C ${holder.path}`;
      if (mode === 'squash') {
        lines.push(`${cd} merge --squash ${branch}`, `${cd} commit --no-edit`);
      } else if (mode === 'merge') {
        lines.push(`${cd} merge --no-ff --no-edit ${branch}`);
      } else {
        lines.push(`${cd} merge --ff-only ${branch}`);
      }
    } else {
      lines.push(`git update-ref refs/heads/${base} ${branch}   # ${base} is not checked out`);
    }
    if (cleanup) {
      lines.push('# full snapshot → refs/strand/archive/…  (restorable)');
      lines.push(`git worktree remove --force ${worktree.path}`);
      lines.push(`git branch -D ${branch}`);
    }
    return lines;
  }, [holder, mode, cleanup, branch, base, worktree.path]);

  async function submit() {
    if (!canSubmit || !activePath) return;
    setBusy(true);
    setError(null);
    try {
      await tauri.repoWorktreeIntegrate(activePath, branch, base, mode);
      if (cleanup) {
        // removeWorktree archives the worktree's full state first.
        await removeWorktree(worktree.path, true);
        // -D: a squashed branch never reads as "merged" to git's own check.
        await tauri.repoBranchDelete(activePath, branch, true);
      }
      await Promise.all([refreshWorktrees(), refreshRefs(), refreshLocalChanges()]);
      onToast(
        cleanup
          ? `Merged ${branch} into ${base} and removed the worktree`
          : `Merged ${branch} into ${base}`,
      );
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const modeOption = (value: Mode, label: string, hint: string, disabled: boolean) => (
    <label className={'stash-check' + (disabled ? ' disabled' : '')}>
      <input
        type="radio"
        name="wt-merge-mode"
        checked={mode === value}
        disabled={busy || disabled}
        onChange={() => setMode(value)}
      />
      <span>
        {label}
        <span className="hint">{hint}</span>
      </span>
    </label>
  );

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="clone-dialog worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Merge worktree"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="worktree" size={15} />
          <span className="title">Merge &amp; clean up</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Land <strong>{branch}</strong>
            {base === health.base_branch
              ? ` (${health.ahead_of_base} commit${health.ahead_of_base === 1 ? '' : 's'})`
              : ''}{' '}
            on the branch below
            {holder ? '' : ` — ${base} isn't checked out anywhere, so only a fast-forward is possible`}.
          </p>

          <label className="clone-field">
            <span className="lbl">Into</span>
            <select
              className="clone-input"
              value={base}
              disabled={busy}
              onChange={(e) => setBase(e.target.value)}
            >
              {baseOptions.map((b) => (
                <option key={b} value={b}>
                  {b}{b === health.base_branch ? ' (detected base)' : ''}
                </option>
              ))}
            </select>
          </label>

          {modeOption(
            'squash',
            'Squash into one commit',
            'One tidy commit on the base — agent WIP history stays out.',
            !holder,
          )}
          {modeOption(
            'merge',
            'Merge commit',
            'Keeps every commit and records the merge.',
            !holder,
          )}
          {modeOption(
            'ff',
            'Fast-forward only',
            ffPossible === null
              ? 'Checking whether the base has moved since the fork…'
              : ffPossible
                ? `${base} hasn't moved since the fork — the ref just moves up.`
                : `${base} has moved since the fork — fast-forward isn't possible.`,
            ffPossible !== true,
          )}

          <label className="stash-check">
            <input
              type="checkbox"
              checked={cleanup}
              disabled={busy || worktree.is_current}
              onChange={(e) => setCleanup(e.target.checked)}
            />
            <span>
              Remove the worktree and delete the branch
              <span className="hint">
                {worktree.is_current
                  ? 'Unavailable for the worktree you are currently in.'
                  : 'A full snapshot is archived first — restorable from this view.'}
              </span>
            </span>
          </label>

          {dirty > 0 && (
            <p className="stash-blurb wt-merge-warn">
              {dirty} uncommitted file{dirty === 1 ? '' : 's'} in this worktree won't be merged
              {cleanup ? ' — they are kept in the archived snapshot' : ''}.
            </p>
          )}

          <pre className="wt-merge-preview" aria-label="Commands that will run">
            {commands.join('\n')}
          </pre>

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Merging…' : cleanup ? 'Merge & remove' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
