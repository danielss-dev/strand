import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { pickDirectory } from '../lib/dialog';
import { tauri } from '../lib/tauri';
import type { Progress } from '../lib/types';

/**
 * Modal for cloning a repository. The user pastes a URL, picks a destination
 * folder, and watches a live progress bar fed by `repo_clone`'s streamed
 * git output. On success it hands the cloned path to `onCloned` (which opens
 * it as a new tab) and closes.
 */
export function CloneDialog({
  onClose,
  onCloned,
}: {
  onClose: () => void;
  onCloned: (path: string) => void | Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // A successful clone calls onClose() (unmounting us) before the finally
  // block settles state — skip those updates so we don't touch an unmounted
  // component.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Keep Tab focus inside the modal — required by the aria-modal contract,
  // and stops a keyboard user silently driving the controls behind it.
  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  // Keep the folder name auto-derived from the URL until the user edits it.
  useEffect(() => {
    if (!nameEdited) setName(deriveName(url));
  }, [url, nameEdited]);

  // Escape closes (unless a clone is mid-flight — don't strand a running op).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cloning) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cloning, onClose]);

  // The folder name must be a single path segment — no separators or `..`,
  // or the clone could land outside the chosen parent directory.
  const trimmedName = name.trim();
  const nameValid = trimmedName !== '' && !/[\\/]/.test(trimmedName) && trimmedName !== '.' && trimmedName !== '..';
  const dest = useMemo(
    () => (parent && nameValid ? joinPath(parent, trimmedName) : ''),
    [parent, nameValid, trimmedName],
  );
  const canClone = Boolean(url.trim() && dest) && !cloning;

  async function chooseParent() {
    const dir = await pickDirectory('Clone into…');
    if (dir) setParent(dir);
  }

  async function doClone() {
    if (!canClone) return;
    setCloning(true);
    setError(null);
    setProgress(null);
    try {
      const res = await tauri.repoClone(url.trim(), dest, (p) => setProgress(p));
      await onCloned(res.path);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setCloning(false);
    }
  }

  const pct = progress?.percent ?? null;
  const progLabel = progress
    ? progress.percent != null
      ? `${progress.phase || 'Working'} · ${progress.percent}%`
      : progress.raw || progress.phase || 'Cloning…'
    : null;

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !cloning) onClose();
      }}
    >
      <div
        className="clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Clone repository"
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="remote" size={15} />
          <span className="title">Clone repository</span>
          <button
            type="button"
            className="cd-close"
            aria-label="Close"
            disabled={cloning}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="clone-body">
          <label className="clone-field">
            <span className="lbl">Repository URL</span>
            <input
              ref={urlRef}
              autoFocus
              className="clone-input"
              placeholder="https://github.com/org/repo.git"
              value={url}
              disabled={cloning}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canClone) void doClone();
              }}
            />
          </label>

          <label className="clone-field">
            <span className="lbl">Destination folder</span>
            <div className="clone-dest">
              <button type="button" className="btn" disabled={cloning} onClick={() => void chooseParent()}>
                Choose…
              </button>
              <span className="clone-dest-path" title={parent || undefined}>
                {parent || 'No folder chosen'}
              </span>
            </div>
          </label>

          <label className="clone-field">
            <span className="lbl">Folder name</span>
            <input
              className="clone-input"
              placeholder="repo"
              value={name}
              disabled={cloning}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canClone) void doClone();
              }}
            />
          </label>

          {trimmedName && !nameValid ? (
            <div className="clone-error">Folder name must be a single folder, with no slashes or “..”.</div>
          ) : dest ? (
            <div className="clone-dest-full">
              Clones into <code>{dest}</code>
            </div>
          ) : null}

          {progLabel ? (
            <div className="clone-progress" aria-live="polite">
              <div className="clone-progress-bar">
                <div
                  className="fill"
                  style={{ width: pct != null ? `${pct}%` : '40%' }}
                  data-indeterminate={pct == null ? '' : undefined}
                />
              </div>
              <div className="clone-progress-label">{progLabel}</div>
            </div>
          ) : null}

          {error ? <div className="clone-error">{error}</div> : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" disabled={cloning} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canClone} onClick={() => void doClone()}>
            {cloning ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Best-effort folder name from a clone URL: last path segment minus a
 * trailing `.git`. Handles both `https://host/org/repo.git` and scp-style
 * `git@host:org/repo.git`.
 */
function deriveName(url: string): string {
  const trimmed = url.trim().replace(/[/]+$/, '');
  if (!trimmed) return '';
  const seg = trimmed.split(/[/:]/).pop() ?? '';
  return seg.replace(/\.git$/i, '');
}

/** Join `parent` + `name` using the separator already in `parent`. */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}
