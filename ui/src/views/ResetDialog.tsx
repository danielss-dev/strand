import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { ResetMode } from '../lib/types';

/**
 * Modal for `git reset` to a chosen commit — opened from a commit row's
 * "Reset … to here…" and the Reflog's "Reset HEAD here…".
 *
 * `target` is the revspec to reset to; `label` is the human label shown in
 * the blurb (short hash or `HEAD@{n}`). Mode defaults to mixed; hard resets
 * stash a safety snapshot first (the backend does this for a dirty tree),
 * which the success toast points at.
 */
export function ResetDialog({
  target,
  label,
  onClose,
  onToast,
}: {
  target: string;
  label: string;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const reset = useRepo((s) => s.reset);
  const meta = useRepo((s) => s.meta);
  const headLabel = meta && !meta.detached ? meta.branch : 'HEAD';

  const [mode, setMode] = useState<ResetMode>('mixed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the graph/reflog instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Move focus INTO the modal on open (after the opener is captured above —
  // effect order matters). The other dialogs get this from an input's
  // autoFocus; radios have none, and without it the keyboard keeps driving
  // the view behind the backdrop.
  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.focus();
  }, []);

  // Keep Tab focus inside the modal — same aria-modal contract as BranchDialog.
  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  // Escape closes (unless an op is mid-flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await reset(target, mode);
      onToast(
        `Reset to ${label} (${mode})` +
          (outcome.snapshot_oid ? ' — snapshot saved to stashes' : ''),
      );
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const option = (m: ResetMode, title: string, desc: string, danger?: boolean) => (
    <label className="stash-check">
      <input
        type="radio"
        name="reset-mode"
        value={m}
        checked={mode === m}
        disabled={busy}
        onChange={() => setMode(m)}
      />
      <span>
        <strong style={danger ? { color: 'var(--del)' } : undefined}>{title}</strong>
        {' — '}
        {desc}
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
        className="clone-dialog stash-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Reset"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="history" size={15} />
          <span className="title">Reset</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Move <code>{headLabel}</code> to <code>{label}</code>.
          </p>

          <div role="radiogroup" aria-label="Reset mode">
            {option('soft', 'Soft', 'keep all changes staged')}
            {option('mixed', 'Mixed', 'keep changes, unstaged')}
            {option('hard', 'Hard', 'discard all changes (a safety snapshot stash is saved first)', true)}
          </div>

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={mode === 'hard' ? 'btn danger' : 'btn primary'}
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Resetting…' : `Reset (${mode})`}
          </button>
        </div>
      </div>
    </div>
  );
}
