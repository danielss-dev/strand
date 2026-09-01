import { useEffect, useMemo, useRef, useState } from 'react';

import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { startCloneDialogFocusLifecycle } from '../lib/cloneDialogFocus';
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
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && document.activeElement instanceof HTMLElement) {
    openerRef.current = document.activeElement;
  }

  // A palette action mounts this auto-focused input before the palette's
  // unmount cleanup restores its own opener. Re-claim focus one frame later so
  // typing cannot escape into the view behind this aria-modal dialog.
  useEffect(() => {
    return startCloneDialogFocusLifecycle(
      openerRef.current,
      () => document.activeElement as HTMLElement | null,
      () => urlRef.current,
      (callback) => window.requestAnimationFrame(callback),
      (id) => window.cancelAnimationFrame(id),
    );
  }, []);

  // Keep the folder name auto-derived from the URL until the user edits it.
  useEffect(() => {
    if (!nameEdited) setName(deriveName(url));
  }, [url, nameEdited]);

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
    <Dialog
      title={t('clone.title')}
      icon="remote"
      blockEscapeWhileBusy={false}
      initialFocusRef={urlRef}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!canClone} onClick={start}>
            {t('clone.action')}
          </button>
        </>
      }
    >
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
    </Dialog>
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
