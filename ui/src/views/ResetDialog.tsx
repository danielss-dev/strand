import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
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
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

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
        autoFocus={m === 'mixed'}
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
    <Dialog
      title="Reset"
      icon="history"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
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
        </>
      }
    >
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
    </Dialog>
  );
}
