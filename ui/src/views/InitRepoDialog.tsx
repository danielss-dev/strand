import { useEffect, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { pickDirectory } from '../lib/dialog';
import { errMessage } from '../lib/tauri';
import { useSettings } from '../stores/settings';

export interface InitRepoRequest {
  path: string;
  initialBranch: string;
  gitignore: string | null;
  createInitialCommit: boolean;
}

export function InitRepoDialog({
  onClose,
  onInit,
}: {
  onClose: () => void;
  onInit: (request: InitRepoRequest) => Promise<void>;
}) {
  const defaultDir = useSettings((s) => s.defaultCloneDir);
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState('main');
  const [gitignore, setGitignore] = useState('');
  const [initialCommit, setInitialCommit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  async function browse() {
    const selected = await pickDirectory('Choose repository folder', path || defaultDir || undefined);
    if (selected) setPath(selected);
  }

  async function submit() {
    if (busy) return;
    const target = path.trim();
    const initialBranch = branch.trim();
    if (!target) { setError('Repository folder is required.'); return; }
    if (!initialBranch) { setError('Initial branch is required.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onInit({
        path: target,
        initialBranch,
        gitignore: gitignore.trim() || null,
        createInitialCommit: initialCommit,
      });
      onClose();
    } catch (caught) {
      if (mountedRef.current) setError(errMessage(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title="Initialize repository"
      icon="branch"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Initializing…' : 'Initialize'}
          </button>
        </>
      }
    >
      <div className="clone-body">
        <label className="clone-field">
          <span className="lbl">Repository folder</span>
          <div className="clone-dest init-repo-path">
            <input
              autoFocus
              className="clone-input"
              value={path}
              disabled={busy}
              placeholder="C:\\Projects\\my-project"
              onChange={(event) => setPath(event.target.value)}
            />
            <button type="button" className="btn" disabled={busy} onClick={() => void browse()}>Browse…</button>
          </div>
        </label>

        <label className="clone-field">
          <span className="lbl">Initial branch</span>
          <input
            className="clone-input"
            value={branch}
            disabled={busy}
            onChange={(event) => setBranch(event.target.value.replace(/\s+/g, '-'))}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }}
          />
        </label>

        <label className="clone-field">
          <span className="lbl">.gitignore patterns <span className="muted">(optional)</span></span>
          <textarea
            className="clone-input clone-textarea"
            value={gitignore}
            disabled={busy}
            rows={5}
            placeholder={'node_modules/\ntarget/\n.env'}
            onChange={(event) => setGitignore(event.target.value)}
          />
        </label>

        <label className="stash-check">
          <input
            type="checkbox"
            checked={initialCommit}
            disabled={busy}
            onChange={(event) => setInitialCommit(event.target.checked)}
          />
          <span>Create an initial commit</span>
        </label>
        <p className="stash-blurb">The initial commit contains only the new .gitignore, or is empty when no patterns are entered.</p>
        {error ? <div className="clone-error" role="alert">{error}</div> : null}
      </div>
    </Dialog>
  );
}
