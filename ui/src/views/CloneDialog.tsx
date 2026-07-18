import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { pickDirectory } from '../lib/dialog';
import { t } from '../lib/i18n';
import { useSettings } from '../stores/settings';

/**
 * Modal for configuring a clone. The user pastes a URL and picks a destination;
 * on submit it hands `(url, dest)` to `onStartClone` and closes immediately —
 * the actual clone runs in the background with a persistent progress popup (see
 * `App.runClone`), so the dialog isn't a blocking wait.
 */
export function CloneDialog({
  onClose,
  onStartClone,
}: {
  onClose: () => void;
  onStartClone: (url: string, dest: string) => void;
}) {
  const [url, setUrl] = useState('');
  // Seed the destination with the configured default folder (Settings → Git).
  const [parent, setParent] = useState(() => useSettings.getState().defaultCloneDir ?? '');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Restore focus to whatever opened the dialog when it closes, so keyboard
  // flow returns to the graph/sidebar instead of falling to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);

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

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The folder name must be a single path segment — no separators or `..`,
  // or the clone could land outside the chosen parent directory.
  const trimmedName = name.trim();
  const nameValid = trimmedName !== '' && !/[\\/]/.test(trimmedName) && trimmedName !== '.' && trimmedName !== '..';
  const dest = useMemo(
    () => (parent && nameValid ? joinPath(parent, trimmedName) : ''),
    [parent, nameValid, trimmedName],
  );
  const canClone = Boolean(url.trim() && dest);

  async function chooseParent() {
    const dir = await pickDirectory(t('clone.pickerTitle'), parent || undefined);
    if (dir) setParent(dir);
  }

  function start() {
    if (!canClone) return;
    onStartClone(url.trim(), dest);
    onClose();
  }

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('clone.title')}
        ref={dialogRef}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          <Icon name="remote" size={15} />
          <span className="title">{t('clone.title')}</span>
          <button type="button" className="cd-close" aria-label={t('common.close')} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="clone-body">
          <div className="clone-security-note" role="note">
            <Icon name="warning" size={14} />
            <span>{t('clone.securityNotice')}</span>
          </div>

          <label className="clone-field">
            <span className="lbl">{t('clone.repositoryUrl')}</span>
            <input
              ref={urlRef}
              autoFocus
              className="clone-input"
              placeholder="https://github.com/org/repo.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canClone) start();
              }}
            />
          </label>

          <label className="clone-field">
            <span className="lbl">{t('clone.destinationFolder')}</span>
            <div className="clone-dest">
              <button type="button" className="btn" onClick={() => void chooseParent()}>
                {t('common.choose')}
              </button>
              <span className="clone-dest-path" title={parent || undefined}>
                {parent || t('clone.noFolder')}
              </span>
            </div>
          </label>

          <label className="clone-field">
            <span className="lbl">{t('clone.folderName')}</span>
            <input
              className="clone-input"
              placeholder="repo"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canClone) start();
              }}
            />
          </label>

          {trimmedName && !nameValid ? (
            <div className="clone-error">{t('clone.invalidFolder')}</div>
          ) : dest ? (
            <div className="clone-dest-full">
              {t('clone.destinationPrefix')} <code>{dest}</code>
            </div>
          ) : null}
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!canClone} onClick={start}>
            {t('clone.action')}
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
