import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
import { useRepo } from '../stores/repo';

/**
 * Rename / move a working-tree file — the keyboard-operable counterpart of
 * dragging a row in the Files tree (context menu → "Rename / move…"). The
 * field holds the full workdir-relative path, so retyping the directory part
 * moves the file; missing directories are created by the engine.
 *
 * Portal-rendered so the fixed backdrop can't be trapped by a transformed
 * ancestor (the ContextMenu precedent).
 */
export function RenameFileDialog({
  from,
  onClose,
  onToast,
}: {
  from: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const moveEntries = useRepo((s) => s.moveEntries);

  const [to, setTo] = useState(from);
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

  // Select just the filename segment — the common case is a rename in place,
  // and the directory prefix stays put for a quick retype-to-move.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const slash = from.lastIndexOf('/');
    const dot = from.lastIndexOf('.');
    const start = slash + 1;
    const end = dot > start ? dot : from.length;
    input.setSelectionRange(start, end);
  }, [from]);

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

  const dest = to.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const unchanged = dest === from;

  async function submit() {
    if (busy || !dest || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      const failures = await moveEntries([{ from, to: dest }]);
      if (failures.length) {
        if (mountedRef.current) setError(failures[0]);
        return;
      }
      onToast(`Moved ${from} → ${dest}`);
      onClose();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return createPortal(
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
        aria-label="Rename or move file"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="file" size={15} />
          <span className="title">Rename / move</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            New path for <code>{from}</code>. Changing the directory moves the
            file; tracked files keep their staged state (<code>git mv</code>).
          </p>
          <label className="clone-field">
            <span className="lbl">New path</span>
            <input
              ref={inputRef}
              className="clone-input"
              value={to}
              disabled={busy}
              onChange={(e) => setTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>
          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !dest || unchanged}
            onClick={() => void submit()}
          >
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
