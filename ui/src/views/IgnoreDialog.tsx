import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
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
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const gitignoreAdd = useRepo((s) => s.gitignoreAdd);

  const [pattern, setPattern] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Prefilled with a path — select it so the user can retype a pattern at once.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

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
    <Dialog
      title="Add ignore pattern"
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
            disabled={busy || !pattern.trim()}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add pattern'}
          </button>
        </>
      }
    >
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
    </Dialog>
  );
}
