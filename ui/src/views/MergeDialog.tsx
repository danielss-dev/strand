import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import type { MergeMode } from '../lib/types';

const MODES: { value: MergeMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Fast-forward when possible',
    hint: 'Move the branch pointer forward if it can; otherwise make a merge commit.',
  },
  {
    value: 'no_ff',
    label: 'Always create a merge commit',
    hint: 'Record the merge explicitly with a second parent, even if a fast-forward was possible.',
  },
  {
    value: 'squash',
    label: 'Squash',
    hint: 'Stage the combined changes without committing — review, then commit yourself.',
  },
];

/**
 * Modal for merging a branch into the current one. Opened from a branch row's
 * context menu in the sidebar (`source` = the branch to merge in; `into` = the
 * current branch, for the blurb). A conflict leaves the merge in progress and
 * surfaces via `onToast` + the in-progress banner; the dialog closes either way
 * on a non-error return.
 */
export function MergeDialog({
  source,
  into,
  onClose,
  onToast,
}: {
  source: string;
  into: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const merge = useRepo((s) => s.merge);

  const [mode, setMode] = useState<MergeMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the graph/sidebar instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

  // Keep Tab focus inside the modal — same contract as TagDialog/StashDialog.
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
    try {
      const conflicted = await merge(source, mode);
      onToast(
        conflicted
          ? `Merge stopped with conflicts — resolve them in Local Changes`
          : mode === 'squash'
            ? `Squashed ${source} into the index — review and commit`
            : `Merged ${source} into ${into}`,
      );
      // A conflict is an expected outcome — close and let the resolver open
      // (the store already switched to Local Changes). Only a real failure
      // (dirty tree, unrelated histories) lands in catch and keeps us open.
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
        aria-label="Merge branch"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="branch" size={15} />
          <span className="title">Merge branch</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <p className="stash-blurb">
            Merge <code>{source}</code> into <code>{into}</code>.
          </p>

          <div className="merge-modes" role="radiogroup" aria-label="Merge strategy">
            {MODES.map((m) => (
              <label key={m.value} className={'merge-mode' + (mode === m.value ? ' on' : '')}>
                <input
                  type="radio"
                  name="merge-mode"
                  value={m.value}
                  checked={mode === m.value}
                  disabled={busy}
                  onChange={() => setMode(m.value)}
                />
                <span className="mm-text">
                  <span className="mm-label">{m.label}</span>
                  <span className="mm-hint">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
