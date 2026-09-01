import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { errMessage } from '../lib/tauri';
import { useRepo } from '../stores/repo';

/** Which remote-management flavour the dialog opens in. */
export type RemoteDialogMode =
  | { kind: 'add' }
  | { kind: 'rename'; name: string }
  | { kind: 'url'; name: string; url: string; pushUrl: string }
  | { kind: 'refspecs'; name: string; fetchRefspecs: string[]; pushRefspecs: string[] };

/**
 * Modal for managing remotes — add a new one (Name + URL), rename an existing
 * one, edit its URLs, or inspect its refspecs. Opened from the Remotes section
 * `+`, a remote folder row's context menu, and the command palette. Mutating
 * modes submit to the matching store action; success surfaces via `onToast`.
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
  const setRemoteUrls = useRepo((s) => s.setRemoteUrls);

  const [name, setName] = useState(mode.kind === 'rename' ? mode.name : '');
  const [url, setUrl] = useState(mode.kind === 'url' ? mode.url : '');
  const [pushUrl, setPushUrl] = useState(mode.kind === 'url' ? mode.pushUrl : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Re-arm on mount — StrictMode's dev remount reuses the same ref, so a
  // cleanup-only effect would leave it permanently false (frozen busy state).
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const title = mode.kind === 'add' ? 'Add remote'
    : mode.kind === 'rename' ? 'Rename remote'
    : mode.kind === 'refspecs' ? 'Remote refspecs'
    : 'Edit remote URLs';
  const submitLabel = mode.kind === 'add' ? 'Add remote'
    : mode.kind === 'rename' ? 'Rename'
    : 'Save URLs';

  async function submit() {
    if (busy || mode.kind === 'refspecs') return;
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
        await addRemote(remoteName, remoteUrl, pushUrl.trim() || null);
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
        await setRemoteUrls(mode.name, remoteUrl, pushUrl.trim() || null);
        onToast(`Remote ${mode.name} URLs updated`);
      }
      onClose();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title={title}
      icon="remote"
      size="sm"
      busy={busy}
      onClose={onClose}
      footer={
        mode.kind === 'refspecs' ? (
          <button type="button" autoFocus className="btn primary" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Working…' : submitLabel}
            </button>
          </>
        )
      }
    >
      <div className="clone-body">
        {mode.kind !== 'add' && mode.kind !== 'refspecs' && (
          <p className="stash-blurb">
            {mode.kind === 'rename' ? 'Rename remote ' : 'Change the fetch and push URLs of '}
            <code>{mode.name}</code>.
          </p>
        )}

        {mode.kind !== 'url' && mode.kind !== 'refspecs' && (
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

        {mode.kind !== 'rename' && mode.kind !== 'refspecs' && (
          <label className="clone-field">
            <span className="lbl">Fetch URL</span>
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

        {mode.kind !== 'rename' && mode.kind !== 'refspecs' && (
          <label className="clone-field">
            <span className="lbl">Push URL <span className="muted">(optional)</span></span>
            <input
              className="clone-input"
              placeholder="Uses the fetch URL when blank"
              value={pushUrl}
              disabled={busy}
              onChange={(e) => setPushUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </label>
        )}

        {mode.kind === 'refspecs' && (
          <>
            <p className="stash-blurb">
              Git ref mappings configured for <code>{mode.name}</code>.
            </p>
            <div className="remote-refspec-group">
              <span className="lbl">Fetch refspecs</span>
              {mode.fetchRefspecs.length > 0
                ? mode.fetchRefspecs.map((refspec) => (
                  <code key={refspec} className="remote-refspec">{refspec}</code>
                ))
                : <span className="muted">None configured</span>}
            </div>
            <div className="remote-refspec-group">
              <span className="lbl">Push refspecs</span>
              {mode.pushRefspecs.length > 0
                ? mode.pushRefspecs.map((refspec) => (
                  <code key={refspec} className="remote-refspec">{refspec}</code>
                ))
                : <span className="muted">None configured — Git's push rules apply</span>}
            </div>
          </>
        )}

        {error ? <div className="clone-error">{error}</div> : null}
      </div>
    </Dialog>
  );
}
