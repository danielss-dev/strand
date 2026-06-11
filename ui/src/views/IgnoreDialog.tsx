import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/**
 * Append a custom pattern to the repo's root `.gitignore`. Opened from the
 * "Add ignore pattern…" context-menu item (Local Changes Unstaged tree +
 * sidebar Files tab), prefilled with the picked file's path so the user can
 * broaden it (`assets/1.png` → `*.png`, `build/`, `src/**​/*.tmp`, `!keep.txt`).
 *
 * The pattern is written **verbatim** — gitignore glob syntax is the whole
 * point here, so unlike the one-click "Add to .gitignore" path (which escapes
 * metacharacters to match one literal file) nothing is escaped.
 */
export function IgnoreDialog({
  initial,
  onClose,
  onToast,
}: {
  initial: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const gitignoreAdd = useRepo((s) => s.gitignoreAdd);

  const [pattern, setPattern] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Restore focus to the opener (the context menu / row) when the dialog closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Prefilled with a path — select it so the user can retype a pattern at once.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Keep Tab focus inside the modal — same contract as the other dialogs.
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

  // Escape closes (unless a write is mid-flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit() {
    const p = pattern.trim();
    if (busy || !p) return;
    setBusy(true);
    setError(null);
    try {
      await gitignoreAdd(p);
      onToast(`Added “${p}” to .gitignore`);
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
        aria-label="Add ignore pattern"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="file" size={15} />
          <span className="title">Add ignore pattern</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Append a pattern to the repo&rsquo;s <code>.gitignore</code>.
          </p>
          <label className="clone-field">
            <span className="lbl">Pattern</span>
            <input
              ref={inputRef}
              className="clone-input"
              placeholder="*.log"
              value={pattern}
              disabled={busy}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>
          <p className="stash-note">
            Glob syntax: <code>*.log</code> · <code>build/</code> ·{' '}
            <code>src/**​/*.tmp</code> · <code>!keep.txt</code> (un-ignore)
          </p>
          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !pattern.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add pattern'}
          </button>
        </div>
      </div>
    </div>
  );
}
