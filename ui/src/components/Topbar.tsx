import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { isTauri } from '../lib/tauri';
import { useSettings } from '../stores/settings';
import { useRepo } from '../stores/repo';

interface Props {
  onOpenPalette: () => void;
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onSync: () => void;
  syncing: boolean;
  onToast: (msg: string) => void;
}

export function Topbar({ onOpenPalette, onOpenRepo, onOpenRecent, onSync, syncing, onToast }: Props) {
  const platform = useSettings((s) => s.platform);
  const tabs = useRepo((s) => s.tabs);
  const activeTabPath = useRepo((s) => s.activeTabPath);
  const setActiveTab = useRepo((s) => s.setActiveTab);
  const closeTab = useRepo((s) => s.closeTab);
  const meta = useRepo((s) => s.meta);
  const recents = useRepo((s) => s.recents);
  const forgetRecent = useRepo((s) => s.forgetRecent);

  const branch = meta?.branch ?? 'no repo';
  const ahead = meta?.ahead ?? 0;
  const behind = meta?.behind ?? 0;

  // In Tauri the host window draws real macOS traffic lights / Win11 controls.
  // The HTML fakes are only for browser-only preview (`pnpm dev`).
  const showFakeChrome = !isTauri();

  return (
    <div className="topbar" data-native-chrome={!showFakeChrome ? platform : undefined}>
      {showFakeChrome && platform === 'mac' && (
        <div className="traffic">
          <div className="dot close" />
          <div className="dot min" />
          <div className="dot max" />
        </div>
      )}

      <div className="repo-tabs">
        {tabs.map((t) => (
          <div
            key={t.path}
            className={'repo-tab' + (t.path === activeTabPath ? ' active' : '')}
            title={t.path}
            onClick={() => { void setActiveTab(t.path); }}
          >
            <div className="repo-dot" style={{ background: 'var(--b-1)' }} />
            <div className="repo-name">{t.meta.name}</div>
            <div
              className="repo-x"
              title="Close repository"
              onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
            >
              <Icon name="x" size={9} stroke={2} />
            </div>
          </div>
        ))}

        <RepoSwitcherButton
          onOpenRepo={onOpenRepo}
          onOpenRecent={onOpenRecent}
          recents={recents}
          onForget={forgetRecent}
        />
      </div>

      <div className="topbar-spacer" />

      <div className="sync-group">
        <button className="sync-btn" onClick={onSync} title="Fetch" disabled={!meta}>
          <Icon name="refresh" size={13} className={syncing ? 'spin' : ''} />
        </button>
        <button className="sync-btn" title="Pull" disabled={!meta}>
          <Icon name="arrow-down" size={13} />
          <span className="count">{behind}</span>
        </button>
        <button className="sync-btn" title="Push" disabled={!meta}>
          <Icon name="arrow-up" size={13} />
          <span className="count">{ahead}</span>
        </button>
      </div>

      <BranchSwitcherButton branch={branch} hasRepo={!!meta} onToast={onToast} />

      <div className="cmd-pill" onClick={onOpenPalette}>
        <Icon name="search" size={13} />
        <span>Quick Launch</span>
        <kbd>{platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd>
      </div>

      {showFakeChrome && platform === 'win11' && (
        <div className="win-controls">
          <div className="wc"><Icon name="win-min" size={10} stroke={1} /></div>
          <div className="wc"><Icon name="win-max" size={10} stroke={1} /></div>
          <div className="wc close"><Icon name="win-close" size={10} stroke={1.2} /></div>
        </div>
      )}
    </div>
  );
}

/**
 * `+` button in the tab strip — opens a dropdown with "Open…" + recents.
 *
 * The menu is rendered via a portal because the tab strip uses
 * `overflow: hidden` to clip long lists of tabs; an in-tree absolute
 * positioned menu would be invisible.
 */
function RepoSwitcherButton({
  onOpenRepo,
  onOpenRecent,
  recents,
  onForget,
}: {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  recents: ReturnType<typeof useRepo.getState>['recents'];
  onForget: (path: string) => Promise<void>;
}) {
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
      <div
        className="tab-add"
        title="Open repository"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={12} />
      </div>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
        >
          <div
            className="repo-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenRepo(); }}
          >
            <span className="ico"><Icon name="folder-open" size={13} /></span>
            <span className="label">Open repository…</span>
            <span className="meta">⌘O</span>
          </div>

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
                  title={r.path}
                  onClick={() => { setOpen(false); onOpenRecent(r.path); }}
                >
                  <span className="ico"><Icon name="folder" size={13} /></span>
                  <span className="label">{r.name}</span>
                  <span className="meta">{r.path}</span>
                  <span
                    className="x"
                    title="Remove from recents"
                    onClick={(e) => { e.stopPropagation(); void onForget(r.path); }}
                  >
                    <Icon name="x" size={9} stroke={2} />
                  </span>
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

/** Topbar branch button — opens a dropdown with branches + create. */
function BranchSwitcherButton({
  branch,
  hasRepo,
  onToast,
}: {
  branch: string;
  hasRepo: boolean;
  onToast: (msg: string) => void;
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
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div
        className="branch-btn"
        title={hasRepo ? 'Switch branch' : 'No repository open'}
        onClick={() => { if (hasRepo) setOpen((o) => !o); }}
        style={hasRepo ? undefined : { opacity: 0.5, cursor: 'default' }}
      >
        <Icon name="branch" size={13} />
        <span className="branch-name">{branch}</span>
        <Icon name="chev-down" size={11} className="chev" />
      </div>
      {open && hasRepo && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, minWidth: 240 }}
        >
          <div className="repo-menu-sect">On this repo</div>
          <div className="repo-menu-item" role="menuitem" aria-disabled>
            <span className="ico"><Icon name="branch" size={13} /></span>
            <span className="label">{branch}</span>
            <span className="meta">current</span>
          </div>

          <div className="repo-menu-empty">
            Other branches will list here once branch reads land (task #3).
          </div>

          <div className="repo-menu-divider" />

          <div
            className="repo-menu-item"
            role="menuitem"
            onClick={() => { setOpen(false); onToast('Create branch — wired in task #4'); }}
          >
            <span className="ico"><Icon name="plus" size={13} /></span>
            <span className="label">Create branch…</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * Close a popover on outside mousedown or Escape, while `active` is true.
 * Accepts multiple refs because portal-rendered menus live outside their
 * trigger's DOM subtree.
 */
function useOutsideClose(
  refs: React.RefObject<HTMLElement>[],
  active: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((r) => r.current?.contains(target))) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [refs, active, close]);
}
