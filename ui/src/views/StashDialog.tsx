import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/**
 * Modal for creating a stash from the working tree. Two flavours, toggled by
 * the "keep changes in working directory" checkbox:
 *
 * - **Save snapshot** (`keep` on) records the changes onto the stash stack but
 *   leaves them in place — a backup you can keep working on top of.
 * - **Stash** (`keep` off) moves the changes onto the stack and clears the
 *   working tree, the classic `git stash`.
 *
 * `initialSnapshot` picks the flavour the dialog opens in; the checkbox lets
 * the user switch. On success the new entry shows up in the sidebar's Stashes
 * section (the store refreshes the stack). A clean tree is surfaced inline as
 * a no-op rather than an error.
 */
export function StashDialog({
  initialSnapshot,
  onClose,
}: {
  initialSnapshot: boolean;
  onClose: () => void;
}) {
  const stashSave = useRepo((s) => s.stashSave);
  const stashSnapshot = useRepo((s) => s.stashSnapshot);

  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keep, setKeep] = useState(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the graph/sidebar instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Keep Tab focus inside the modal — same aria-modal contract as CloneDialog.
  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    setNote(null);
    try {
      const msg = message.trim() || null;
      const outcome = keep
        ? await stashSnapshot(msg, includeUntracked)
        : await stashSave(msg, includeUntracked, false);
      if (outcome.oid === null) {
        if (mountedRef.current) setNote('Nothing to stash — the working tree is clean.');
        return;
      }
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const title = keep ? 'Save snapshot' : 'Stash changes';
  const cta = keep ? 'Save Snapshot' : 'Stash';

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
        aria-label={title}
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="stash" size={15} />
          <span className="title">{title}</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            {keep
              ? 'Save your local changes to a new stash, but keep them in the working directory.'
              : 'Save your local changes to a new stash and clear them from the working directory.'}
          </p>

          <label className="clone-field">
            <span className="lbl">Message</span>
            <input
              autoFocus
              className="clone-input"
              placeholder="Stash message (optional)"
              value={message}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>

          <label className="stash-check">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={busy}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            <span>
              Include untracked files
              <span className="hint">New files are left behind unless included.</span>
            </span>
          </label>

          <label className="stash-check">
            <input
              type="checkbox"
              checked={keep}
              disabled={busy}
              onChange={(e) => setKeep(e.target.checked)}
            />
            <span>
              Keep changes in working directory
              <span className="hint">Snapshot — the stash is a backup, your changes stay put.</span>
            </span>
          </label>

          {note ? <div className="stash-note">{note}</div> : null}
          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : cta}
          </button>
        </div>
      </div>
    </div>
  );
}
