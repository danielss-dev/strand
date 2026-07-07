import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/**
 * Modal for creating a branch with a chosen name from any start point —
 * the "branch from here, but let me name it" path (the remote rows' one-click
 * create derives the name automatically; this one asks).
 *
 * Opened from the Branches section `+` (HEAD), the command palette (HEAD),
 * and a branch / remote-branch row's "New branch from here…" (that ref).
 * `start` is the revspec to branch from (`null` ⇒ HEAD); `startLabel` is the
 * human label shown in the blurb. Starting from a remote-tracking branch
 * auto-tracks it (core behavior).
 */
export function BranchDialog({
  start,
  startLabel,
  onClose,
}: {
  start: string | null;
  startLabel: string;
  onClose: () => void;
}) {
  const createBranch = useRepo((s) => s.createBranch);

  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the graph/sidebar instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Keep Tab focus inside the modal — same aria-modal contract as TagDialog.
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
    const branchName = name.trim();
    if (!branchName) {
      setError('Branch name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createBranch(branchName, start, checkout);
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

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
        aria-label="New branch"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="branch" size={15} />
          <span className="title">New branch</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Branch from <code>{startLabel}</code>.
          </p>

          <label className="clone-field">
            <span className="lbl">Name</span>
            <input
              autoFocus
              className="clone-input"
              placeholder="feature/my-branch"
              value={name}
              disabled={busy}
              // Ref names can't contain spaces — sanitize to dashes as the
              // user types, matching the branch-create field.
              onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>

          <label className="stash-check">
            <input
              type="checkbox"
              checked={checkout}
              disabled={busy}
              onChange={(e) => setCheckout(e.target.checked)}
            />
            <span>Check out after creating</span>
          </label>

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create branch'}
          </button>
        </div>
      </div>
    </div>
  );
}
