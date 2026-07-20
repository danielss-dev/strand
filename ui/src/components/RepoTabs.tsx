import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useRepo } from '../stores/repo';
import { useRepoIcons } from '../stores/repoIcons';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';
import { useOutsideClose } from '../lib/useOutsideClose';
import { groupColor, groupTabs, repoTabLabel, workspaceMemberSet } from '../lib/repoIdentity';
import { t as translate } from '../lib/i18n';
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
  worktree: boolean;
  x: number;
  y: number;
}

/**
 * Horizontal repo tab strip — the toolbar alternative to the vertical
 * {@link RepoRail}, chosen in Settings → Appearance (`repoNav: 'tabs'`). Each
 * open repository is a pill with a color dot + name; worktrees of the same
 * repo cluster contiguously after their main tab. Lives inside the topbar's
 * flex flow, replacing the static repo-name title.
 *
 * The pills sit in a horizontally-scrollable lane so a long list never clips:
 * the active tab auto-scrolls into view (⌘/Ctrl+Tab cycling drives this), the
 * mouse wheel slides the lane, and a ▾ button — shown only when the lane
 * overflows — drops a jump list of every open repo. The `+` and ▾ controls sit
 * outside the scroller so they stay put. Menus render through a portal since
 * the lane clips.
 */
export function RepoTabs({ onOpenRepo, onInitRepo, onOpenRecent, onClone, onCustomize, onManageWorkspaces, onWorktreeReview, onWorktreeMerge }: Props) {
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

  // The strip shows only the active workspace's repos; others stay open but
  // hidden. Switching to another workspace (or Default) re-filters.
  const visibleTabs = useMemo(() => {
    if (!activeWs) return tabs;
    const members = workspaceMemberSet(tabs, new Set(activeWs.repoPaths));
    return tabs.filter((t) => members.has(t.path));
  }, [tabs, activeWs]);
  const ordered = useMemo(() => groupTabs(visibleTabs), [visibleTabs]);

  // Pull each open repo's saved icon in as it appears (for the custom dot color).
  useEffect(() => {
    for (const t of tabs) ensure(t.path);
  }, [tabs, ensure]);

  // Dot color per group: the group's main (non-linked) tab's custom color if
  // set, else a stable hashed color so each repo is distinguishable. (The rail
  // defaults to the app accent instead — here a per-repo hue reads better since
  // the dot is the tab's only color cue.)
  const colorForGroup = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of ordered) {
      if (m.has(t.meta.common_dir)) continue;
      const main = ordered.find(
        (x) => x.meta.common_dir === t.meta.common_dir && !x.meta.is_linked_worktree,
      );
      const custom = main ? icons[main.path]?.color : undefined;
      m.set(t.meta.common_dir, custom || groupColor(t.meta.common_dir));
    }
    return m;
  }, [ordered, icons]);
  const colorFor = (t: RepoTab) => colorForGroup.get(t.meta.common_dir)!;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Track whether the lane overflows, to gate the ▾ jump menu. Re-measured on
  // tab add/remove (the `ordered` dep) and on width changes (ResizeObserver).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ordered]);

  // Keep the active tab visible — switching via keyboard (⌘/Ctrl+Tab) or the
  // jump menu can land on a tab scrolled off-screen. `block: 'nearest'` keeps
  // the scroll purely horizontal.
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeTabPath, ordered]);

  // Most mice only have a vertical wheel — translate it to horizontal so the
  // lane scrolls without a modifier. Trackpad horizontal swipes scroll natively.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (e.deltaX === 0 && e.deltaY !== 0) el.scrollLeft += e.deltaY;
  };

  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = (e: React.MouseEvent, t: RepoTab) => {
    e.preventDefault();
    setMenu({
      path: t.path,
      worktree: t.meta.is_linked_worktree,
      x: e.clientX,
      y: e.clientY,
    });
  };

  return (
    <div className="repo-tabs">
      <WorkspaceSwitcher placement="tabs" onManage={onManageWorkspaces} />

      <div className="repo-tabs-scroll" ref={scrollRef} role="tablist" aria-label="Open repositories" onWheel={onWheel}>
        {ordered.map((t, i) => {
          // Linked worktrees of the same repo share a dot color and sit
          // contiguously; mark a tab that continues its predecessor's group so
          // CSS can tighten the gap into a visual cluster.
          const prev = ordered[i - 1];
          const sameGroup = !!prev && prev.meta.common_dir === t.meta.common_dir;
          const linked = t.meta.is_linked_worktree;
          const active = t.path === activeTabPath;
          const label = repoTabLabel(t);
          return (
            <button
              key={t.path}
              type="button"
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className={
                'repo-tab' +
                (active ? ' active' : '') +
                (sameGroup ? ' same-group' : '') +
                (linked ? ' worktree' : '')
              }
              title={label.title}
              aria-label={label.ariaLabel}
              onClick={() => { void setActiveTab(t.path); }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                void closeRepo(t.path);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault();
                  void closeRepo(t.path);
                  return;
                }
                let next = i;
                if (e.key === 'ArrowLeft') next = (i - 1 + ordered.length) % ordered.length;
                else if (e.key === 'ArrowRight') next = (i + 1) % ordered.length;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = ordered.length - 1;
                else return;
                e.preventDefault();
                const nextTab = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next];
                nextTab?.focus();
                void setActiveTab(ordered[next].path);
              }}
              onContextMenu={(e) => openMenu(e, t)}
            >
              <span className="repo-dot" style={{ background: colorFor(t) }} />
              {linked && <span className="repo-wt-ico"><Icon name="worktree" size={11} /></span>}
              <span className="repo-name">
                <span className="repo-primary">{label.primary}</span>
                {linked && label.secondary && <span className="repo-sub">{label.secondary}</span>}
              </span>
              <span
                className="repo-x"
                aria-hidden="true"
                title={translate(linked ? 'repo.closeWorktree' : 'repo.close')}
                onClick={(e) => { e.stopPropagation(); void closeRepo(t.path); }}
              >
                <Icon name="x" size={9} stroke={2} />
              </span>
            </button>
          );
        })}
      </div>

      <RepoSwitcherButton onOpenRepo={onOpenRepo} onInitRepo={onInitRepo} onOpenRecent={onOpenRecent} onClone={onClone} />

      {overflowing && (
        <OverflowMenu
          tabs={ordered}
          activeTabPath={activeTabPath}
          colorFor={colorFor}
          onPick={(path) => { void setActiveTab(path); }}
        />
      )}

      {menu && createPortal(
        <TabContextMenu
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
 * merge pair (worktrees only) + close. Mirrors the rail's. */
function TabContextMenu({
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
 * ▾ button shown only when the lane overflows — drops a jump list of every
 * open repo (color dot + name, the active one checked) so off-screen tabs are
 * reachable in one click. Portal-rendered because the lane clips.
 */
function OverflowMenu({
  tabs,
  activeTabPath,
  colorFor,
  onPick,
}: {
  tabs: RepoTab[];
  activeTabPath: string | null;
  colorFor: (t: RepoTab) => string;
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  return (
    <div ref={wrapRef} className="tab-overflow-wrap">
      <button
        type="button"
        className="tab-overflow"
        title="All open repositories"
        aria-label="All open repositories"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chev-down" size={12} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, left: 'auto', minWidth: 220 }}
        >
          <div className="repo-menu-sect">Open repositories</div>
          {tabs.map((t) => {
            const linked = t.meta.is_linked_worktree;
            const active = t.path === activeTabPath;
            const label = repoTabLabel(t);
            return (
              <button
                type="button"
                key={t.path}
                className="repo-menu-item"
                role="menuitemradio"
                aria-checked={active}
                tabIndex={0}
                title={label.title}
                onClick={() => { setOpen(false); onPick(t.path); }}
              >
                <span className="ico">
                  {linked
                    ? <Icon name="worktree" size={12} />
                    : <span className="repo-menu-dot" style={{ background: colorFor(t) }} />}
                </span>
                <span className="label">{linked && label.secondary ? `${label.primary} / ${label.secondary}` : label.primary}</span>
                {active && <span className="meta"><Icon name="check" size={12} stroke={2.2} /></span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * `+` button at the end of the strip — opens a dropdown with Open / Clone and
 * the recent repositories. The menu renders through a portal because the strip
 * clips with `overflow: hidden`.
 */
function RepoSwitcherButton({
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
    setPos({ top: r.bottom + 6, left: r.left });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  return (
    <div ref={wrapRef} className="tab-add-wrap">
      <button
        type="button"
        className="tab-add"
        title="Open repository"
        aria-label="Open repository"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={12} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
        >
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
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
            tabIndex={0}
            onClick={() => { setOpen(false); onInitRepo(); }}
          >
            <span className="ico"><Icon name="branch" size={13} /></span>
            <span className="label">Initialize repository…</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
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
                    aria-label={translate('common.removeRecent')}
                    title={translate('common.removeRecent')}
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
