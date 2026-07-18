import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import type { Commit } from '../lib/types';
import { useRepo } from '../stores/repo';

export type MainlineOperation = 'cherry-pick' | 'revert';

/** Choose the parent Git should treat as the mainline for a merge commit. */
export function MainlineDialog({
  commit,
  operation,
  onClose,
  onToast,
}: {
  commit: Commit;
  operation: MainlineOperation;
  onClose: () => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const cherryPick = useRepo((state) => state.cherryPick);
  const revert = useRepo((state) => state.revert);
  const [parent, setParent] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const conflicted =
        operation === 'cherry-pick'
          ? await cherryPick([commit.hash], parent)
          : await revert([commit.hash], parent);
      const verb = operation === 'cherry-pick' ? 'Cherry-pick' : 'Revert';
      onToast(
        conflicted
          ? `${verb} of ${commit.short_hash} has conflicts — resolve in Local Changes`
          : `${operation === 'cherry-pick' ? 'Cherry-picked' : 'Reverted'} ${commit.short_hash} using parent ${parent}`,
      );
      onClose();
    } catch (caught) {
      setError(errMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const title = operation === 'cherry-pick' ? 'Cherry-pick merge commit' : 'Revert merge commit';
  return (
    <div
      className="palette-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="clone-dialog stash-dialog mainline-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name="history" size={15} />
          <span className="title">{title}</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="clone-body">
          <p className="stash-blurb">
            <code>{commit.short_hash}</code> has {commit.parents.length} parents. Choose the parent
            whose version should be treated as the mainline.
          </p>
          <div className="merge-modes" role="radiogroup" aria-label="Mainline parent">
            {commit.parents.map((hash, index) => {
              const number = index + 1;
              return (
                <label key={hash} className={'merge-mode' + (parent === number ? ' on' : '')}>
                  <input
                    autoFocus={index === 0}
                    type="radio"
                    name="mainline-parent"
                    value={number}
                    checked={parent === number}
                    disabled={busy}
                    onChange={() => setParent(number)}
                  />
                  <span className="mm-text">
                    <span className="mm-label">Parent {number}</span>
                    <span className="mm-hint" title={hash}>{hash}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {error ? <div className="clone-error">{error}</div> : null}
        </div>
        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Applying…' : operation === 'cherry-pick' ? 'Cherry-pick' : 'Revert'}
          </button>
        </div>
      </div>
    </div>
  );
}
