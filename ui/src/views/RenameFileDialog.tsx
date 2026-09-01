import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Dialog } from '../components/Dialog';
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
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const moveEntries = useRepo((s) => s.moveEntries);

  const [to, setTo] = useState(from);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

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
    <Dialog
      title="Rename / move"
      icon="file"
      size="sm"
      busy={busy}
      onClose={onClose}
      initialFocusRef={inputRef}
      footer={
        <>
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
        </>
      }
    >
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
    </Dialog>,
    document.body,
  );
}
