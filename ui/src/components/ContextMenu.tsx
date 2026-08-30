import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from './Icon';

export interface MenuItem {
  label: string;
  thumb?: ReactNode;
  icon?: IconName;
  /** Red styling for destructive actions. */
  danger?: boolean;
  disabled?: boolean;
  /**
   * Require a second activation ("Confirm: …") before running — the
   * right-click equivalent of the old inline-confirm on destructive rows.
   */
  confirm?: boolean;
  /**
   * Nested items. The row renders a "›" and opens a child menu to its right
   * on hover, → , or Enter; the parent item is a disclosure, not an action.
   */
  submenu?: MenuItem[];
  /** Run on activation. Optional only when `submenu` is set (a parent row). */
  onSelect?: () => void;
}

/**
 * A right-click menu for sidebar rows, rendered in a portal at the cursor (or,
 * when opened from the keyboard, at the row's corner). Keyboard-operable:
 * ↑/↓ move, Enter/Space select, → opens a submenu, ← / Esc closes it (or the
 * whole menu). Destructive items with `confirm` swap to a "Confirm: …" step
 * before running. Closes on outside click, right-click elsewhere, or
 * selection; restores focus to the opener on close.
 *
 * `onBack` is set only on a nested submenu: it returns to the parent (← / Esc)
 * without tearing down the whole chain, and tells the component to skip its own
 * backdrop (the root menu's backdrop already catches outside clicks).
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  onBack,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  onBack?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const firstEnabled = items.findIndex((it) => !it.disabled);
  const [active, setActive] = useState(firstEnabled);
  const [confirming, setConfirming] = useState<number | null>(null);
  // The open submenu: which parent index, and where to anchor the child.
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);

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

  // Anchor a child menu to the right edge of item `i`'s row.
  const openSub = (i: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-idx="${i}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setActive(i);
    setSub({ index: i, x: r.right - 4, y: r.top - 4 });
  };

  const choose = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    if (it.submenu && it.submenu.length > 0) {
      openSub(i);
      return;
    }
    if (it.confirm && confirming !== i) {
      setConfirming(i);
      setActive(i);
      return;
    }
    onClose();
    it.onSelect?.();
  };

  const menu = (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={onBack ? { left: pos.x, top: pos.y, zIndex: 201 } : { left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (items[active]?.submenu?.length) openSub(active);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (sub) setSub(null);
          else onBack?.();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose(active);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (confirming != null) setConfirming(null);
          else if (sub) setSub(null);
          else if (onBack) onBack();
          else onClose();
        }
      }}
    >
      {items.map((it, i) => {
        const isConfirm = confirming === i;
        const hasSub = !!it.submenu?.length;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            data-idx={i}
            disabled={it.disabled}
            aria-haspopup={hasSub || undefined}
            aria-expanded={hasSub ? sub?.index === i : undefined}
            className={
              'context-menu-item' +
              (it.danger || isConfirm ? ' danger' : '') +
              (i === active ? ' active' : '') +
              (it.disabled ? ' disabled' : '')
            }
            onMouseEnter={() => {
              if (it.disabled) return;
              setActive(i);
              if (hasSub) openSub(i);
              else setSub(null);
            }}
            onClick={() => choose(i)}
          >
            {it.thumb}
            {it.icon && (
              <span className="ico">
                <Icon name={isConfirm ? 'check' : it.icon} size={13} />
              </span>
            )}
            <span className="label">{isConfirm ? `Confirm: ${it.label}` : it.label}</span>
            {hasSub && (
              <span className="cm-sub-arrow" aria-hidden="true">
                <Icon name="chev-right" size={12} />
              </span>
            )}
          </button>
        );
      })}

      {sub && items[sub.index]?.submenu && (
        <ContextMenu
          x={sub.x}
          y={sub.y}
          items={items[sub.index].submenu!}
          onClose={onClose}
          onBack={() => {
            setSub(null);
            ref.current?.focus();
          }}
        />
      )}
    </div>
  );

  // A submenu skips its own backdrop and rides at a higher z-index above the
  // parent (whose backdrop still catches outside clicks for the whole chain).
  if (onBack) return createPortal(menu, document.body);

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
      {menu}
    </div>,
    document.body,
  );
}
