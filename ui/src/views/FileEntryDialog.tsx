import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Dialog } from '../components/Dialog';
import { errMessage, tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';

export function FileEntryDialog({
  repoPath,
  dir,
  directory,
  onClose,
  onToast,
}: {
  repoPath: string;
  dir: string;
  directory: boolean;
  onClose: () => void;
  onToast: (message: string, kind?: 'success' | 'error') => void;
}) {
  const refreshLocalChanges = useRepo((state) => state.refreshLocalChanges);
  const markFilesTreeChanged = useRepo((state) => state.markFilesTreeChanged);
  const selectFile = useRepo((state) => state.selectFile);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalized = name.trim().replace(/\\/g, '/');
  const parts = normalized.split('/');
  const invalid = !normalized
    || normalized.startsWith('/')
    || /^[a-z]:/i.test(normalized)
    || parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
  const target = dir ? `${dir}/${normalized}` : normalized;
  const label = directory ? 'folder' : 'file';

  async function submit() {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await tauri.repoFileCreate(repoPath, target, directory);
      await refreshLocalChanges();
      markFilesTreeChanged(repoPath, { kind: 'create', path: target, directory });
      selectFile(target, null, directory);
      onToast(`Created ${label} ${target}`);
      onClose();
    } catch (cause) {
      if (mountedRef.current) setError(errMessage(cause));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return createPortal(
    <Dialog
      title={`New ${label}`}
      icon={directory ? 'folder' : 'file'}
      size="sm"
      busy={busy}
      onClose={onClose}
      initialFocusRef={inputRef}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || invalid} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="clone-body">
        <p className="stash-blurb">
          Create an empty {label} in <code>{dir || '/'}</code>. Existing paths are never overwritten;
          nested paths require their parent folder to exist.
        </p>
        <label className="clone-field">
          <span className="lbl">Relative path</span>
          <input
            ref={inputRef}
            className="clone-input"
            value={name}
            disabled={busy}
            placeholder={directory ? 'folder-name' : 'path/filename.ext'}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        {error ? <div className="clone-error">{error}</div> : null}
      </div>
    </Dialog>,
    document.body,
  );
}
