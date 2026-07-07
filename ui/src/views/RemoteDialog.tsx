import { useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/** Which remote-management flavour the dialog opens in. */
export type RemoteDialogMode =
  | { kind: 'add' }
  | { kind: 'rename'; name: string }
  | { kind: 'url'; name: string; url: string };

/**
 * Modal for managing remotes — add a new one (Name + URL), rename an existing
 * one, or edit its URL. Opened from the Remotes section `+`, a remote folder
 * row's context menu, and the command palette ("Add remote…"). Submits to the
 * matching store action; success surfaces via `onToast`.
 */
export function RemoteDialog({
  mode,
  onClose,
  onToast,
}: {
  mode: RemoteDialogMode;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const addRemote = useRepo((s) => s.addRemote);
  const renameRemote = useRepo((s) => s.renameRemote);
  const setRemoteUrl = useRepo((s) => s.setRemoteUrl);

  const [name, setName] = useState(mode.kind === 'rename' ? mode.name : '');
  const [url, setUrl] = useState(mode.kind === 'url' ? mode.url : '');
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

  const title = mode.kind === 'add' ? 'Add remote'
    : mode.kind === 'rename' ? 'Rename remote'
    : 'Edit remote URL';
  const submitLabel = mode.kind === 'add' ? 'Add remote'
    : mode.kind === 'rename' ? 'Rename'
    : 'Save URL';

  async function submit() {
    if (busy) return;
    const remoteName = name.trim();
    const remoteUrl = url.trim();
    if (mode.kind !== 'url' && !remoteName) {
      setError('Remote name is required.');
      return;
    }
    if (mode.kind !== 'rename' && !remoteUrl) {
      setError('Remote URL is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode.kind === 'add') {
        await addRemote(remoteName, remoteUrl);
        onToast(`Remote ${remoteName} added`);
      } else if (mode.kind === 'rename') {
        const problems = await renameRemote(mode.name, remoteName);
        // Non-empty problems = the rename happened, but git could not rewrite
        // these (non-default) refspecs — warn instead of claiming a clean run.
        onToast(
          problems.length > 0
            ? `Remote renamed — ${problems.length} refspec(s) need manual attention`
            : `Remote ${mode.name} renamed to ${remoteName}`,
        );
      } else {
        await setRemoteUrl(mode.name, remoteUrl);
        onToast(`Remote ${mode.name} URL updated`);
      }
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
        aria-label={title}
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="remote" size={15} />
          <span className="title">{title}</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          {mode.kind !== 'add' && (
            <p className="stash-blurb">
              {mode.kind === 'rename' ? 'Rename remote ' : 'Change the URL of '}
              <code>{mode.name}</code>.
            </p>
          )}

          {mode.kind !== 'url' && (
            <label className="clone-field">
              <span className="lbl">Name</span>
              <input
                autoFocus
                className="clone-input"
                placeholder="upstream"
                value={name}
                disabled={busy}
                // Remote names can't contain spaces — sanitize to dashes as
                // the user types, matching the branch-name fields.
                onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
              />
            </label>
          )}

          {mode.kind !== 'rename' && (
            <label className="clone-field">
              <span className="lbl">URL</span>
              <input
                autoFocus={mode.kind === 'url'}
                className="clone-input"
                placeholder="https://github.com/user/repo.git"
                value={url}
                disabled={busy}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
              />
            </label>
          )}

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
