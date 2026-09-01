import { useEffect, useRef, type ReactNode } from 'react';

import { trapTabKey } from '../lib/dialogFocus';
import { t } from '../lib/i18n';
import { Icon, type IconName } from './Icon';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'wide';

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'dialog-sm',
  md: '',
  lg: 'dialog-lg',
  xl: 'dialog-xl',
  wide: 'dialog-wide',
};

export function Dialog({
  title,
  icon,
  size = 'md',
  role = 'dialog',
  labelledBy,
  describedBy,
  busy = false,
  closeOnEscape = true,
  blockEscapeWhileBusy = true,
  onClose,
  children,
  footer,
  className,
  initialFocusRef,
}: {
  title: string;
  icon?: IconName;
  size?: DialogSize;
  role?: 'dialog' | 'alertdialog';
  labelledBy?: string;
  describedBy?: string;
  busy?: boolean;
  /** Esc closes. Default true. */
  closeOnEscape?: boolean;
  /** When true (default), Esc is ignored while `busy`. */
  blockEscapeWhileBusy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = labelledBy ?? 'dialog-title';

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current
      ?? dialogRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button.btn.danger, button.btn.primary, button',
      );
    target?.focus();
    return () => prev?.focus?.();
  }, [initialFocusRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!closeOnEscape) return;
      if (busy && blockEscapeWhileBusy) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, blockEscapeWhileBusy, closeOnEscape, onClose]);

  function onTrapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!dialogRef.current) return;
    if (trapTabKey(dialogRef.current, e.key, e.shiftKey)) e.preventDefault();
  }

  const sizeClass = SIZE_CLASS[size];
  const shell = ['clone-dialog', sizeClass, className].filter(Boolean).join(' ');

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !(busy && blockEscapeWhileBusy)) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={shell}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onKeyDown={onTrapKeyDown}
      >
        <div className="clone-head">
          {icon ? <Icon name={icon} size={15} /> : null}
          <span id={titleId} className="title">{title}</span>
          <button
            type="button"
            className="cd-close"
            aria-label={t('common.close')}
            disabled={busy && blockEscapeWhileBusy}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
        {footer ? <div className="clone-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
