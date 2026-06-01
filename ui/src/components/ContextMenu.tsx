import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Red styling for destructive actions. */
  danger?: boolean;
  disabled?: boolean;
  /**
   * Require a second activation ("Confirm: …") before running — the
   * right-click equivalent of the old inline-confirm on destructive rows.
   */
  confirm?: boolean;
  onSelect: () => void;
}

/**
 * A right-click menu for sidebar rows, rendered in a portal at the cursor (or,
 * when opened from the keyboard, at the row's corner). Keyboard-operable:
 * ↑/↓ move, Enter/Space select, Esc closes (or cancels a pending confirm).
 * Destructive items with `confirm` swap to a "Confirm: …" step before running,
 * so a delete still takes two deliberate actions. Closes on outside click,
 * right-click elsewhere, or selection; restores focus to the opener on close.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const firstEnabled = items.findIndex((it) => !it.disabled);
  const [active, setActive] = useState(firstEnabled);
  const [confirming, setConfirming] = useState<number | null>(null);

  // Clamp into the viewport once the menu has a measured size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + r.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Take focus for keyboard nav; restore it to the opener on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);

  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const move = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const cur = enabled.indexOf(active);
    const base = cur === -1 ? (dir === 1 ? -1 : 0) : cur;
    setActive(enabled[(base + dir + enabled.length) % enabled.length]);
  };

  const choose = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    if (it.confirm && confirming !== i) {
      setConfirming(i);
      setActive(i);
      return;
    }
    onClose();
    it.onSelect();
  };

  return createPortal(
    <div
      className="context-menu-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(active);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (confirming != null) setConfirming(null);
            else onClose();
          }
        }}
      >
        {items.map((it, i) => {
          const isConfirm = confirming === i;
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className={
                'context-menu-item' +
                (it.danger || isConfirm ? ' danger' : '') +
                (i === active ? ' active' : '') +
                (it.disabled ? ' disabled' : '')
              }
              onMouseEnter={() => !it.disabled && setActive(i)}
              onClick={() => choose(i)}
            >
              {it.icon && (
                <span className="ico">
                  <Icon name={isConfirm ? 'check' : it.icon} size={13} />
                </span>
              )}
              <span className="label">{isConfirm ? `Confirm: ${it.label}` : it.label}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
