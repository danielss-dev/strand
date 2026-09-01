import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
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
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

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
    <Dialog
      title="Rename branch"
      icon="branch"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Renaming…' : 'Rename branch'}
          </button>
        </>
      }
    >
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
    </Dialog>
  );
}
