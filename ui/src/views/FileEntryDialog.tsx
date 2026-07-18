import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '../components/Icon';
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
  const selectFile = useRepo((state) => state.selectFile);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
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
    const focusables = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

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
    <div className="palette-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div
        className="clone-dialog stash-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`New ${label}`}
        ref={dialogRef}
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name={directory ? 'folder' : 'file'} size={15} />
          <span className="title">New {label}</span>
          <button type="button" className="cd-close" aria-label="Close" disabled={busy} onClick={onClose}>×</button>
        </div>
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
        <div className="clone-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || invalid} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
