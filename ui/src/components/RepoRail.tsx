import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { useRepo } from '../stores/repo';
import { useRepoIcons } from '../stores/repoIcons';
import { useOutsideClose } from '../lib/useOutsideClose';
import { groupTabs, repoTabLabel, tileGlyph } from '../lib/repoIdentity';
import type { RepoTab } from '../stores/repo';

interface Props {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onClone: () => void;
  /** Open the icon-customization dialog for a repo tab. */
  onCustomize: (path: string) => void;
}

/** Right-click context menu target. */
interface MenuState {
  path: string;
  name: string;
  worktree: boolean;
  x: number;
  y: number;
}

/**
 * Vertical repo rail — replaces the old top-bar tab strip. Each open repository
 * is a square tile (initials, emoji, or image on a colored ground); worktrees
 * of the same repo nest as smaller sub-tiles beneath their parent. Scales to
 * many repos by scrolling vertically instead of clipping like the tab strip.
 */
export function RepoRail({ onOpenRepo, onOpenRecent, onClone, onCustomize }: Props) {
  const tabs = useRepo((s) => s.tabs);
  const activeTabPath = useRepo((s) => s.activeTabPath);
  const setActiveTab = useRepo((s) => s.setActiveTab);
  const closeTab = useRepo((s) => s.closeTab);
  const icons = useRepoIcons((s) => s.icons);
  const ensure = useRepoIcons((s) => s.ensure);

  const ordered = useMemo(() => groupTabs(tabs), [tabs]);

  // Pull each open repo's saved icon config in as it appears.
  useEffect(() => {
    for (const t of tabs) ensure(t.path);
  }, [tabs, ensure]);

  // Background color per group: the group's main (non-linked) tab's custom
  // color if set, else the configured app accent. Worktrees inherit it. The
  // default uses `--accent-base` (the configured accent), NOT `--accent` —
  // `--accent` follows the active repo's re-theme, so using it would bleed one
  // repo's custom color onto every other tile. `--accent-base` keeps the rail
  // isolated: other repos always show the app's own accent.
  const colorForGroup = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of ordered) {
      if (m.has(t.meta.common_dir)) continue;
      const main = ordered.find(
        (x) => x.meta.common_dir === t.meta.common_dir && !x.meta.is_linked_worktree,
      );
      const custom = main ? icons[main.path]?.color : undefined;
      m.set(t.meta.common_dir, custom || 'var(--accent-base)');
    }
    return m;
  }, [ordered, icons]);

  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = (e: React.MouseEvent, t: RepoTab) => {
    e.preventDefault();
    setMenu({
      path: t.path,
      name: repoTabLabel(t).repo,
      worktree: t.meta.is_linked_worktree,
      x: e.clientX,
      y: e.clientY,
    });
  };

  return (
    <div className="repo-rail" role="tablist" aria-label="Open repositories">
      <div className="rail-tabs">
        {ordered.map((t) => {
          const linked = t.meta.is_linked_worktree;
          const color = colorForGroup.get(t.meta.common_dir)!;
          const icon = icons[t.path];
          const active = t.path === activeTabPath;
          const label = repoTabLabel(t);
          return (
            <button
              key={t.path}
              type="button"
              role="tab"
              aria-selected={active}
              className={'rail-tile' + (active ? ' active' : '') + (linked ? ' worktree' : '')}
              title={label.title}
              aria-label={label.ariaLabel}
              onClick={() => { void setActiveTab(t.path); }}
              onContextMenu={(e) => openMenu(e, t)}
            >
              {linked ? (
                <span className="rail-glyph" style={{ background: color }}>
                  <Icon name="worktree" size={13} />
                </span>
              ) : icon?.image ? (
                <span className="rail-glyph image">
                  <img src={icon.image} alt="" />
                </span>
              ) : (
                <span
                  className={'rail-glyph' + (icon?.emoji ? ' emoji' : '')}
                  style={{ background: color }}
                >
                  {tileGlyph(icon, label.repo)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <RailAddButton onOpenRepo={onOpenRepo} onOpenRecent={onOpenRecent} onClone={onClone} />

      {menu && createPortal(
        <RailContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onCustomize={() => { onCustomize(menu.path); setMenu(null); }}
          onCloseRepo={() => { closeTab(menu.path); setMenu(null); }}
        />,
        document.body,
      )}
    </div>
  );
}

/** Right-click menu: customize (main repos only) + close. */
function RailContextMenu({
  menu,
  onClose,
  onCustomize,
  onCloseRepo,
}: {
  menu: MenuState;
  onClose: () => void;
  onCustomize: () => void;
  onCloseRepo: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose([ref], true, onClose);

  // Clamp the menu inside the viewport (it opens at the cursor).
  const [pos, setPos] = useState({ top: menu.y, left: menu.x });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(menu.x, window.innerWidth - r.width - 8);
    const top = Math.min(menu.y, window.innerHeight - r.height - 8);
    setPos({ top, left });
  }, [menu]);

  return (
    <div
      ref={ref}
      className="repo-menu"
      role="menu"
      style={{ position: 'fixed', top: pos.top, left: pos.left }}
    >
      {!menu.worktree && (
        <button type="button" className="repo-menu-item" role="menuitem" onClick={onCustomize}>
          <span className="ico"><Icon name="edit" size={13} /></span>
          <span className="label">Customize…</span>
        </button>
      )}
      <button type="button" className="repo-menu-item" role="menuitem" onClick={onCloseRepo}>
        <span className="ico"><Icon name="x" size={13} /></span>
        <span className="label">{menu.worktree ? 'Close worktree' : 'Close repository'}</span>
      </button>
    </div>
  );
}

/**
 * `+` tile at the bottom of the rail — opens a menu with Open / Clone and the
 * recent repositories, mirroring the old tab strip's switcher.
 */
function RailAddButton({
  onOpenRepo,
  onOpenRecent,
  onClone,
}: {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onClone: () => void;
}) {
  const recents = useRepo((s) => s.recents);
  const forgetRecent = useRepo((s) => s.forgetRecent);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    // Open to the right of the rail, bottom-aligned to the button.
    setPos({ top: r.top, left: r.right + 6 });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  return (
    <div ref={wrapRef} className="rail-add-wrap">
      <button
        type="button"
        className="rail-add"
        title="Open repository"
        aria-label="Open repository"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={15} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenRepo(); }}
          >
            <span className="ico"><Icon name="folder-open" size={13} /></span>
            <span className="label">Open repository…</span>
            <span className="meta">⌘O</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onClone(); }}
          >
            <span className="ico"><Icon name="remote" size={13} /></span>
            <span className="label">Clone repository…</span>
          </button>

          <div className="repo-menu-divider" />

          {recents.length === 0 ? (
            <div className="repo-menu-empty">No recent repositories yet.</div>
          ) : (
            <>
              <div className="repo-menu-sect">Recent</div>
              {recents.map((r) => (
                <button
                  type="button"
                  key={r.path}
                  className="repo-menu-item"
                  role="menuitem"
                  title={r.path}
                  onClick={() => { setOpen(false); onOpenRecent(r.path); }}
                >
                  <span className="ico"><Icon name="folder" size={13} /></span>
                  <span className="label">{r.name}</span>
                  <span className="meta">{r.path}</span>
                  <span
                    className="x"
                    title="Remove from recents"
                    onClick={(e) => { e.stopPropagation(); void forgetRecent(r.path); }}
                  >
                    <Icon name="x" size={9} stroke={2} />
                  </span>
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
