import { useEffect, useRef } from 'react';

import { Icon } from '../components/Icon';

/**
 * Confirmation boundary for rewriting a remote branch. Strand only exposes
 * `--force-with-lease`: it refuses when the remote moved since the last fetch,
 * while plain `--force` is intentionally unavailable.
 */
export function ForcePushDialog({
  branch,
  upstream,
  onClose,
  onConfirm,
}: {
  branch: string;
  upstream: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>('.btn.danger')?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function trapFocus(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
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

  return (
    <div className="palette-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="clone-dialog stash-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="force-push-title"
        aria-describedby="force-push-description"
        onKeyDown={trapFocus}
      >
        <div className="clone-head">
          <Icon name="arrow-up" size={15} />
          <span id="force-push-title" className="title">Force push with lease</span>
          <button type="button" className="cd-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="clone-body">
          <p id="force-push-description" className="stash-blurb">
            Rewrite <code>{upstream ?? branch}</code> with the local history of <code>{branch}</code>?
          </p>
          <div className="clone-error">
            This can replace commits on the remote. Strand uses <code>--force-with-lease</code>,
            so the push is refused if the remote changed since your last fetch.
          </div>
        </div>

        <div className="clone-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger" onClick={onConfirm}>Force push with lease</button>
        </div>
      </div>
    </div>
  );
}
