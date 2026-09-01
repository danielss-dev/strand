import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
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
  stashIndex,
  onClose,
}: {
  start: string | null;
  startLabel: string;
  /** When set, run `git stash branch` instead of ordinary branch creation. */
  stashIndex?: number;
  onClose: () => void;
}) {
  const createBranch = useRepo((s) => s.createBranch);
  const createFromStash = useRepo((s) => s.stashBranch);

  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

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
      if (stashIndex == null) await createBranch(branchName, start, checkout);
      else await createFromStash(stashIndex, branchName);
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title={stashIndex == null ? 'New branch' : 'Branch from stash'}
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
            {busy ? 'Creating…' : stashIndex == null ? 'Create branch' : 'Create from stash'}
          </button>
        </>
      }
    >
      <div className="clone-body">
        <p className="stash-blurb">
          {stashIndex == null ? 'Branch from ' : 'Create and check out a branch from '}
          <code>{startLabel}</code>{stashIndex == null ? '.' : '. The stash is removed after a clean apply.'}
        </p>

        <label className="clone-field">
          <span className="lbl">Name</span>
          <input
            autoFocus
            className="clone-input"
            placeholder="feature/my-branch"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </label>

        {stashIndex == null && (
          <label className="stash-check">
            <input
              type="checkbox"
              checked={checkout}
              disabled={busy}
              onChange={(e) => setCheckout(e.target.checked)}
            />
            <span>Check out after creating</span>
          </label>
        )}

        {error ? <div className="clone-error">{error}</div> : null}
      </div>
    </Dialog>
  );
}
