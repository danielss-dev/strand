import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useRepo } from '../stores/repo';
import { useRepoIcons } from '../stores/repoIcons';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';
import { useOutsideClose } from '../lib/useOutsideClose';
import { t } from '../lib/i18n';
import { groupTabs, repoTabLabel, tileGlyph, workspaceMemberSet } from '../lib/repoIdentity';
import type { RepoTab } from '../stores/repo';

interface Props {
  onOpenRepo: () => void;
  onInitRepo: () => void;
  onOpenRecent: (path: string) => void;
  onClone: () => void;
  /** Open the icon-customization dialog for a repo tab. */
  onCustomize: (path: string) => void;
  /** Open the workspace manager dialog. */
  onManageWorkspaces: () => void;
  /** "Review vs base" for a worktree tab (App owns the store flow). */
  onWorktreeReview: (path: string) => void;
  /** "Merge & clean up…" for a worktree tab (App owns the dialog). */
  onWorktreeMerge: (path: string) => void;
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
export function RepoRail({ onOpenRepo, onInitRepo, onOpenRecent, onClone, onCustomize, onManageWorkspaces, onWorktreeReview, onWorktreeMerge }: Props) {
  const tabs = useRepo((s) => s.tabs);
  const activeTabPath = useRepo((s) => s.activeTabPath);
  const setActiveTab = useRepo((s) => s.setActiveTab);
  const icons = useRepoIcons((s) => s.icons);
  const ensure = useRepoIcons((s) => s.ensure);

  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWsId = useWorkspaces((s) => s.activeWorkspaceId);
  // Workspace-aware close: leaves the active workspace; only truly closes
  // when no other workspace still holds the repo.
  const closeRepo = useWorkspaces((s) => s.closeRepo);
  // Default (`null`) is itself a workspace with its own membership.
  const activeWs = workspaces.find((w) => w.id === (activeWsId ?? DEFAULT_WORKSPACE_ID)) ?? null;

  // The rail shows only the active workspace's repos; others stay open but
  // hidden. Switching to another workspace (or Default) re-filters.
  const visibleTabs = useMemo(() => {
    if (!activeWs) return tabs;
    const members = workspaceMemberSet(tabs, new Set(activeWs.repoPaths));
    return tabs.filter((t) => members.has(t.path));
  }, [tabs, activeWs]);
  const ordered = useMemo(() => groupTabs(visibleTabs), [visibleTabs]);

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

  const renderTile = (t: RepoTab) => {
    const linked = t.meta.is_linked_worktree;
    const color = colorForGroup.get(t.meta.common_dir)!;
    const icon = icons[t.path];
    const isActive = t.path === activeTabPath;
    const label = repoTabLabel(t);
    return (
      <button
        key={t.path}
        type="button"
        role="tab"
        aria-selected={isActive}
        className={'rail-tile' + (isActive ? ' active' : '') + (linked ? ' worktree' : '')}
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
  };

  return (
    <div className="repo-rail" role="tablist" aria-label="Open repositories">
      <WorkspaceSwitcher placement="rail" onManage={onManageWorkspaces} />

      <div className="rail-tabs">
        {ordered.map(renderTile)}
      </div>

      <RailAddButton onOpenRepo={onOpenRepo} onInitRepo={onInitRepo} onOpenRecent={onOpenRecent} onClone={onClone} />

      {menu && createPortal(
        <RailContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onCustomize={() => { onCustomize(menu.path); setMenu(null); }}
          onCloseRepo={() => { void closeRepo(menu.path); setMenu(null); }}
          onReview={() => { onWorktreeReview(menu.path); setMenu(null); }}
          onMerge={() => { onWorktreeMerge(menu.path); setMenu(null); }}
        />,
        document.body,
      )}
    </div>
  );
}

/** Right-click menu: customize (main repos only) or the worktree review /
 * merge pair (worktrees only) + close. */
function RailContextMenu({
  menu,
  onClose,
  onCustomize,
  onCloseRepo,
  onReview,
  onMerge,
}: {
  menu: MenuState;
  onClose: () => void;
  onCustomize: () => void;
  onCloseRepo: () => void;
  onReview: () => void;
  onMerge: () => void;
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
      {menu.worktree && (
        <>
          <button type="button" className="repo-menu-item" role="menuitem" onClick={onReview}>
            <span className="ico"><Icon name="eye" size={13} /></span>
            <span className="label">Review vs base</span>
          </button>
          <button type="button" className="repo-menu-item" role="menuitem" onClick={onMerge}>
            <span className="ico"><Icon name="branch" size={13} /></span>
            <span className="label">Merge &amp; clean up…</span>
          </button>
        </>
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
  onInitRepo,
  onOpenRecent,
  onClone,
}: {
  onOpenRepo: () => void;
  onInitRepo: () => void;
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
            onClick={() => { setOpen(false); onInitRepo(); }}
          >
            <span className="ico"><Icon name="branch" size={13} /></span>
            <span className="label">Initialize repository…</span>
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
                <div
                  key={r.path}
                  className="repo-menu-item"
                  role="menuitem"
                  tabIndex={0}
                  title={r.path}
                  onClick={() => { setOpen(false); onOpenRecent(r.path); }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    setOpen(false);
                    onOpenRecent(r.path);
                  }}
                >
                  <span className="ico"><Icon name="folder" size={13} /></span>
                  <span className="label">{r.name}</span>
                  <span className="meta">{r.path}</span>
                  <button
                    type="button"
                    className="x"
                    aria-label={t('common.removeRecent')}
                    title={t('common.removeRecent')}
                    onClick={(e) => { e.stopPropagation(); void forgetRecent(r.path); }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Icon name="x" size={9} stroke={2} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
