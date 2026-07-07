import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/**
 * Modal for creating a git tag at a target commit. A non-empty message makes
 * an **annotated** tag (tagger from the user's git config); an empty message
 * makes a **lightweight** tag.
 *
 * Opened from three places, each supplying the target: the Tags section's `+`
 * (HEAD), the command palette (HEAD), and a commit's detail panel (that
 * commit). `target` is the revspec to tag (`null` ⇒ HEAD); `targetLabel` is
 * the human label shown in the blurb. On success the new tag shows up in the
 * sidebar Tags list and as a chip on the graph (the store refreshes refs).
 */
export function TagDialog({
  target,
  targetLabel,
  onClose,
}: {
  target: string | null;
  targetLabel: string;
  onClose: () => void;
}) {
  const createTag = useRepo((s) => s.createTag);

  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
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

  // Keep Tab focus inside the modal — same aria-modal contract as StashDialog.
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
    const tagName = name.trim();
    if (!tagName) {
      setError('Tag name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createTag(tagName, target, message.trim() || null);
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const annotated = message.trim().length > 0;

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
        aria-label="New tag"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="tag" size={15} />
          <span className="title">New tag</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Tag <code>{targetLabel}</code>. Leave the message empty for a lightweight tag.
          </p>

          <label className="clone-field">
            <span className="lbl">Name</span>
            <input
              autoFocus
              className="clone-input"
              placeholder="v1.0.0"
              value={name}
              disabled={busy}
              // Tag names can't contain spaces — sanitize to dashes as the
              // user types, matching the branch-create field.
              onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>

          <label className="clone-field">
            <span className="lbl">Message</span>
            <textarea
              className="clone-input"
              placeholder="Annotation (optional)"
              value={message}
              disabled={busy}
              rows={3}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>

          <div className="stash-note">
            {annotated ? 'Creates an annotated tag.' : 'Creates a lightweight tag.'}
          </div>

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create tag'}
          </button>
        </div>
      </div>
    </div>
  );
}
