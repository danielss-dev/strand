import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/**
 * Modal for renaming a local branch (`git branch -m`). Opened from a branch
 * row's context menu and the palette's "Rename current branch…". The branch's
 * upstream config moves with the rename, and HEAD follows when the renamed
 * branch is checked out (core behavior).
 */
export function RenameBranchDialog({
  name,
  onClose,
  onToast,
}: {
  name: string;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const renameBranch = useRepo((s) => s.renameBranch);

  const [newName, setNewName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the sidebar/palette instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
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
    const branchName = newName.trim();
    if (!branchName) {
      setError('Branch name is required.');
      return;
    }
    if (branchName === name) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameBranch(name, branchName);
      onToast(`Branch ${name} renamed to ${branchName}`);
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
        aria-label="Rename branch"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="branch" size={15} />
          <span className="title">Rename branch</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Rename <code>{name}</code> — its upstream moves along.
          </p>

          <label className="clone-field">
            <span className="lbl">New name</span>
            <input
              autoFocus
              className="clone-input"
              placeholder="feature/my-branch"
              value={newName}
              disabled={busy}
              // Ref names can't contain spaces — sanitize to dashes as the
              // user types, matching the branch-create field.
              onChange={(e) => setNewName(e.target.value.replace(/\s+/g, '-'))}
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
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Renaming…' : 'Rename branch'}
          </button>
        </div>
      </div>
    </div>
  );
}
