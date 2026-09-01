import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { RepoTabs } from './RepoTabs';
import { isTauri } from '../lib/tauri';
import { repoFamilyName } from '../lib/repoIdentity';
import { useSettings } from '../stores/settings';
import { useRepo } from '../stores/repo';
import type { PullMode, PushMode } from '../lib/types';

interface Props {
  onOpenPalette: () => void;
  onFetch: (prune?: boolean) => void;
  onPull: (mode?: PullMode, autostash?: boolean) => void;
  onPush: (mode?: PushMode) => void;
  onPushAllTags: () => void;
  onForcePush: () => void;
  pullMode: PullMode;
  fetchPrune: boolean;
  pullAutostash: boolean;
  onSetPullMode: (mode: PullMode) => void;
  onSetFetchPrune: (prune: boolean) => void;
  onSetPullAutostash: (autostash: boolean) => void;
  syncing: boolean;
  pulling: boolean;
  pushing: boolean;
  syncDone: boolean;
  pullDone: boolean;
  pushDone: boolean;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
  /** Open the Save-snapshot dialog (message + keep-changes options). */
  onSaveSnapshot: () => void;
  /** Open the stash preview dialog. */
  onStash: (opts?: { snapshot?: boolean; keepIndex?: boolean }) => void;
  /** Open a repository via the directory picker (tabs-mode `+` menu). */
  onOpenRepo: () => void;
  /** Open the initialize-local-repository dialog. */
  onInitRepo: () => void;
  /** Open a recent / dropped repository by path (tabs-mode `+` menu). */
  onOpenRecent: (path: string) => void;
  /** Open the clone dialog (tabs-mode `+` menu). */
  onClone: () => void;
  /** Open the icon-customization dialog for a repo tab. */
  onCustomize: (path: string) => void;
  /** Open the workspace manager dialog (tabs-mode switcher). */
  onManageWorkspaces: () => void;
  /** "Review vs base" for a worktree tab (tabs-mode context menu). */
  onWorktreeReview: (path: string) => void;
  /** "Merge & clean up…" for a worktree tab (tabs-mode context menu). */
  onWorktreeMerge: (path: string) => void;
  /** Collapse/expand the sidebar panel; the chevron flips with the state. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function Topbar({
  onOpenPalette,
  onFetch,
  onPull,
  onPush,
  onPushAllTags,
  onForcePush,
  pullMode,
  fetchPrune,
  pullAutostash,
  onSetPullMode,
  onSetFetchPrune,
  onSetPullAutostash,
  syncing,
  pulling,
  pushing,
  syncDone,
  pullDone,
  pushDone,
  onToast,
  onSaveSnapshot,
  onStash,
  onOpenRepo,
  onInitRepo,
  onOpenRecent,
  onClone,
  onCustomize,
  onManageWorkspaces,
  onWorktreeReview,
  onWorktreeMerge,
  sidebarCollapsed,
  onToggleSidebar,
}: Props) {
  const platform = useSettings((s) => s.platform);
  const repoNav = useSettings((s) => s.repoNav);
  const meta = useRepo((s) => s.meta);

  const branch = meta?.branch ?? 'no repo';
  const ahead = meta?.ahead ?? 0;
  const behind = meta?.behind ?? 0;
  const repoName = repoFamilyName(meta);
  const [networkMenu, setNetworkMenu] = useState<{ x: number; y: number } | null>(null);
  const networkBusy = syncing || pulling || pushing;
  const pullModeLabel = pullMode === 'default'
    ? 'Git configuration'
    : pullMode === 'fast-forward-only'
      ? 'Fast-forward only'
      : pullMode[0].toUpperCase() + pullMode.slice(1);
  const networkItems = useMemo<MenuItem[]>(() => [
    {
      label: 'Fetch',
      icon: 'refresh',
      disabled: networkBusy,
      submenu: [
        {
          label: `Repository default (${fetchPrune ? 'prune stale branches' : 'keep stale branches'})`,
          icon: 'check',
          onSelect: () => onFetch(),
        },
        { label: 'Fetch and prune', onSelect: () => onFetch(true) },
        { label: 'Fetch without pruning', onSelect: () => onFetch(false) },
        {
          label: 'Set repository default',
          submenu: [
            { label: 'Prune stale branches', icon: fetchPrune ? 'check' : undefined, onSelect: () => onSetFetchPrune(true) },
            { label: 'Keep stale branches', icon: !fetchPrune ? 'check' : undefined, onSelect: () => onSetFetchPrune(false) },
          ],
        },
      ],
    },
    {
      label: 'Pull',
      icon: 'arrow-down',
      disabled: networkBusy,
      submenu: [
        { label: `Repository default (${pullModeLabel})`, icon: 'check', onSelect: () => onPull() },
        { label: 'Use Git configuration', onSelect: () => onPull('default') },
        { label: 'Merge (fast-forward if possible)', onSelect: () => onPull('merge') },
        { label: 'Rebase', onSelect: () => onPull('rebase') },
        { label: 'Fast-forward only', onSelect: () => onPull('fast-forward-only') },
        { label: 'With autostash', onSelect: () => onPull(undefined, true) },
        { label: 'Without autostash', onSelect: () => onPull(undefined, false) },
        {
          label: 'Set default strategy',
          submenu: [
            { label: 'Use Git configuration', icon: pullMode === 'default' ? 'check' : undefined, onSelect: () => onSetPullMode('default') },
            { label: 'Merge', icon: pullMode === 'merge' ? 'check' : undefined, onSelect: () => onSetPullMode('merge') },
            { label: 'Rebase', icon: pullMode === 'rebase' ? 'check' : undefined, onSelect: () => onSetPullMode('rebase') },
            { label: 'Fast-forward only', icon: pullMode === 'fast-forward-only' ? 'check' : undefined, onSelect: () => onSetPullMode('fast-forward-only') },
          ],
        },
        {
          label: 'Set default autostash',
          submenu: [
            { label: 'Autostash local changes', icon: pullAutostash ? 'check' : undefined, onSelect: () => onSetPullAutostash(true) },
            { label: 'Do not autostash', icon: !pullAutostash ? 'check' : undefined, onSelect: () => onSetPullAutostash(false) },
          ],
        },
      ],
    },
    {
      label: 'Push',
      icon: 'arrow-up',
      disabled: networkBusy,
      submenu: [
        { label: 'Current branch', onSelect: () => onPush('default') },
        { label: 'With annotated tags', onSelect: () => onPush('follow-tags') },
        { label: 'All tags', onSelect: onPushAllTags },
        { label: 'Force with lease…', icon: 'arrow-up', danger: true, onSelect: onForcePush },
      ],
    },
  ], [fetchPrune, networkBusy, onFetch, onForcePush, onPull, onPush, onPushAllTags, onSetFetchPrune, onSetPullAutostash, onSetPullMode, pullAutostash, pullMode, pullModeLabel]);

  const inTauri = isTauri();
  // macOS lets the OS draw the traffic lights over our toolbar (`titleBarStyle:
  // Overlay`), so we only pad to clear them. Windows has no native overlay —
  // we strip the OS title bar (see main.rs) and draw our own controls here, in
  // both Tauri and browser preview. The mac traffic lights are faked only in
  // browser preview.
  const macNativeChrome = inTauri && platform === 'mac';
  const showFakeTraffic = !inTauri && platform === 'mac';
  const showWinControls = platform === 'win11';
  // On Windows the toolbar *is* the title bar, so it must drag the window.
  // WebView2 ignores `-webkit-app-region`, so use Tauri's drag-region hook.
  const dragRegion = inTauri && platform === 'win11' ? '' : undefined;

  return (
    <div
      className="topbar"
      data-native-chrome={macNativeChrome ? 'mac' : undefined}
      data-tauri-drag-region={dragRegion}
    >
      {showFakeTraffic && (
        <div className="traffic">
          <div className="dot close" />
          <div className="dot min" />
          <div className="dot max" />
        </div>
      )}

      <button
        type="button"
        className="sync-btn topbar-sidebar-toggle"
        onClick={onToggleSidebar}
        title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={sidebarCollapsed}
      >
        <Icon name={sidebarCollapsed ? 'chev-right' : 'chev-left'} size={13} />
      </button>

      {repoNav === 'tabs' ? (
        <RepoTabs
          onOpenRepo={onOpenRepo}
          onInitRepo={onInitRepo}
          onOpenRecent={onOpenRecent}
          onClone={onClone}
          onCustomize={onCustomize}
          onManageWorkspaces={onManageWorkspaces}
          onWorktreeReview={onWorktreeReview}
          onWorktreeMerge={onWorktreeMerge}
        />
      ) : (
        meta && (
          <div className="topbar-title" data-tauri-drag-region={dragRegion} title={meta.path}>
            {repoName}
          </div>
        )
      )}

      <div className="topbar-spacer" data-tauri-drag-region={dragRegion} />

      <div className="sync-group">
        <button
          type="button"
          className="sync-btn"
          onClick={() => onFetch()}
          title="Fetch"
          aria-label="Fetch"
          disabled={!meta}
        >
          {syncDone ? (
            <span className="sync-done"><Icon name="check" size={13} stroke={2.2} /></span>
          ) : (
            <span className={syncing ? 'icon-spin' : undefined}>
              <Icon name="refresh" size={13} />
            </span>
          )}
        </button>
        <button
          type="button"
          className="sync-btn"
          onClick={() => onPull()}
          title={behind > 0 ? `Pull (${behind} behind)` : 'Pull'}
          aria-label={behind > 0 ? `Pull (${behind} behind)` : 'Pull'}
          disabled={!meta}
        >
          {pullDone ? (
            <span className="sync-done"><Icon name="check" size={13} stroke={2.2} /></span>
          ) : (
            <span className={pulling ? 'slide-icon slide-down' : 'slide-icon'}>
              <Icon name="arrow-down" size={13} />
            </span>
          )}
          {behind > 0 && <span className="count">{behind}</span>}
        </button>
        <button
          type="button"
          className="sync-btn"
          onClick={() => onPush()}
          title={ahead > 0 ? `Push (${ahead} ahead)` : 'Push'}
          aria-label={ahead > 0 ? `Push (${ahead} ahead)` : 'Push'}
          disabled={!meta}
        >
          {pushDone ? (
            <span className="sync-done"><Icon name="check" size={13} stroke={2.2} /></span>
          ) : (
            <span className={pushing ? 'slide-icon slide-up' : 'slide-icon'}>
              <Icon name="arrow-up" size={13} />
            </span>
          )}
          {ahead > 0 && <span className="count">{ahead}</span>}
        </button>
        <button
          type="button"
          className="sync-btn"
          title="More fetch, pull, and push options"
          aria-label="More fetch, pull, and push options"
          aria-haspopup="menu"
          aria-expanded={networkMenu != null}
          disabled={!meta}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setNetworkMenu({ x: r.right - 2, y: r.bottom + 4 });
          }}
        >
          <Icon name="chev-down" size={10} />
        </button>
      </div>

      {networkMenu && (
        <ContextMenu
          x={networkMenu.x}
          y={networkMenu.y}
          items={networkItems}
          onClose={() => setNetworkMenu(null)}
        />
      )}

      <StashButton onToast={onToast} onSaveSnapshot={onSaveSnapshot} onStash={onStash} />

      <BranchSwitcherButton
        branch={branch}
        detached={!!meta?.detached}
        hasRepo={!!meta}
        onToast={onToast}
      />

      <button
        type="button"
        className="cmd-pill"
        onClick={onOpenPalette}
        aria-label="Quick Launch"
        title="Quick Launch"
      >
        <Icon name="search" size={13} />
        <span>Quick Launch</span>
        <kbd>{platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      {showWinControls && <WinControls functional={inTauri} />}
    </div>
  );
}

/**
 * Windows 11 caption controls (minimize / maximize-restore / close). On Windows
 * the toolbar replaces the native title bar, so these drive the real window via
 * the Tauri window API. In browser preview (`functional` false) they render as
 * inert affordances. The maximize glyph toggles to a restore glyph by tracking
 * the live maximized state.
 */
function WinControls({ functional }: { functional: boolean }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!functional) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      setMaximized(await win.isMaximized());
      const un = await win.onResized(async () => setMaximized(await win.isMaximized()));
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [functional]);

  const run = async (action: 'min' | 'max' | 'close') => {
    if (!functional) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (action === 'min') await win.minimize();
    else if (action === 'max') await win.toggleMaximize();
    else await win.close();
  };

  return (
    <div className="win-controls">
      <button type="button" className="wc" aria-label="Minimize" onClick={() => void run('min')}>
        <Icon name="win-min" size={10} stroke={1} />
      </button>
      <button
        type="button"
        className="wc"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void run('max')}
      >
        <Icon name={maximized ? 'win-restore' : 'win-max'} size={10} stroke={1} />
      </button>
      <button type="button" className="wc close" aria-label="Close" onClick={() => void run('close')}>
        <Icon name="win-close" size={10} stroke={1.2} />
      </button>
    </div>
  );
}

/**
 * Stash split button — the primary face stashes all changes; the chevron
 * opens a menu with create variants (untracked / keep-index) and "Pop latest".
 * Per-stash apply / pop / drop lives on the sidebar Stashes list. Reads the
 * store directly; `onToast` reports quick-stash results and `onSaveSnapshot`
 * hands off to the message dialog, mirroring {@link BranchSwitcherButton}.
 */
function StashButton({
  onToast,
  onSaveSnapshot,
  onStash,
}: {
  onToast: (msg: string, kind?: 'success' | 'error') => void;
  onSaveSnapshot: () => void;
  onStash: (opts?: { snapshot?: boolean; keepIndex?: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const meta = useRepo((s) => s.meta);
  const stashes = useRepo((s) => s.stashes);
  const stashPop = useRepo((s) => s.stashPop);

  const hasRepo = !!meta;

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  const openStash = (opts?: { snapshot?: boolean; keepIndex?: boolean }) => {
    setOpen(false);
    onStash(opts);
  };

  const pop = async (index: number) => {
    if (busy) return;
    // Guard the empty stack — the menu item only renders when non-empty, but
    // the list can empty between render and click (a concurrent drop/pop, or
    // an external git command). Avoids a needless "Pop failed" toast.
    if (stashes.length === 0) {
      onToast('No stashes to pop');
      return;
    }
    setBusy(true);
    try {
      await stashPop(index);
      onToast('Popped stash');
      setOpen(false);
    } catch (e) {
      onToast(`Pop failed: ${(e as Error).message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="sync-group stash-group">
      <button
        type="button"
        className="sync-btn"
        onClick={() => openStash({ snapshot: false })}
        title="Stash changes…"
        aria-label="Stash changes…"
        disabled={!hasRepo || busy}
      >
        <span><Icon name="stash" size={13} /></span>
        <span>Stash</span>
      </button>
      <button
        type="button"
        className="sync-btn"
        onClick={() => { if (hasRepo) setOpen((o) => !o); }}
        title="Stash options"
        aria-label="Stash options"
        disabled={!hasRepo}
      >
        <Icon name="chev-down" size={10} />
        {stashes.length > 0 && <span className="count">{stashes.length}</span>}
      </button>
      {open && hasRepo && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, left: 'auto', minWidth: 240 }}
        >
          <div className="repo-menu-sect">Create stash</div>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => { setOpen(false); onSaveSnapshot(); }}
          >
            <span className="ico"><Icon name="plus" size={13} /></span>
            <span className="label">Save snapshot…</span>
            <span className="meta">keep</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => openStash({ snapshot: false })}
          >
            <span className="ico"><Icon name="stash" size={13} /></span>
            <span className="label">Stash all changes…</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => openStash({ snapshot: false })}
          >
            <span className="ico"><Icon name="stash" size={13} /></span>
            <span className="label">Stash including untracked…</span>
            <span className="meta">-u</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => openStash({ snapshot: false, keepIndex: true })}
          >
            <span className="ico"><Icon name="stash" size={13} /></span>
            <span className="label">Stash, keep staged…</span>
            <span className="meta">--keep-index</span>
          </button>

          <div className="repo-menu-divider" />

          {stashes.length === 0 ? (
            <div className="repo-menu-empty">No stashes yet.</div>
          ) : (
            <>
              <div className="repo-menu-sect">
                {stashes.length} stash{stashes.length > 1 ? 'es' : ''}
              </div>
              <button
                type="button"
                className="repo-menu-item"
                role="menuitem"
                tabIndex={0}
                title="Apply & remove the most recent stash"
                onClick={() => void pop(0)}
              >
                <span className="ico"><Icon name="arrow-up" size={13} /></span>
                <span className="label">Pop latest</span>
                <span className="meta">{stashes[0]?.branch ?? ''}</span>
              </button>
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
  detached,
  hasRepo,
  onToast,
}: {
  branch: string;
  detached: boolean;
  hasRepo: boolean;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const refs = useRepo((s) => s.refs);
  const checkout = useRepo((s) => s.checkout);
  const createBranch = useRepo((s) => s.createBranch);
  const worktrees = useRepo((s) => s.worktrees);
  const openWorktree = useRepo((s) => s.openWorktree);

  // Branches that are HEAD of another worktree can't become HEAD here too —
  // their rows say so and open that worktree's tab instead of a checkout
  // that's guaranteed to fail (DAN-12).
  const worktreeByBranch = new Map(
    worktrees
      .filter((w) => !w.is_current && w.branch)
      .map((w) => [w.branch as string, w]),
  );

  // Run a branch op, toasting the outcome and closing the menu on success.
  // Errors keep the menu open so the user can try a different row.
  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onToast(label);
      setOpen(false);
    } catch (e) {
      onToast(`${label} failed: ${(e as Error).message ?? e}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Pick a short branch name for tracking a remote branch. If `foo` is
  // already taken locally, fall back to the full `origin/foo` form so git2
  // doesn't error on name collision.
  const localBranchNameFor = (remote: string, branchPart: string): string => {
    const taken = refs.branches.some((b) => b.name === branchPart);
    return taken ? `${remote}/${branchPart}` : branchPart;
  };

  const allBranchNames = [
    ...refs.branches.map((b) => b.name),
    ...refs.remote_branches.map((rb) => rb.name),
  ];

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  const currentBranch = refs.branches.find((b) => b.is_head);
  const otherBranches = refs.branches.filter((b) => !b.is_head);

  // Hide remote branches that already track a local branch — they'd just
  // duplicate the local row.
  const trackedRemotes = new Set(
    refs.branches
      .map((b) => b.upstream?.name)
      .filter((n): n is string => Boolean(n)),
  );
  const remoteBranches = refs.remote_branches.filter((rb) => !trackedRemotes.has(rb.name));

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={'branch-btn' + (detached ? ' detached' : '')}
        title={
          !hasRepo
            ? 'No repository open'
            : detached
              ? `Detached HEAD at ${branch}`
              : 'Switch branch'
        }
        aria-label={
          !hasRepo ? 'No repository open' : detached ? `Detached HEAD at ${branch}` : 'Switch branch'
        }
        onClick={() => { if (hasRepo) setOpen((o) => !o); }}
        disabled={!hasRepo}
      >
        <Icon name={detached ? 'circle' : 'branch'} size={13} />
        {detached && <span className="det-chip">detached</span>}
        <span className="branch-name">{branch}</span>
        <Icon name="chev-down" size={11} className="chev" />
      </button>
      {open && hasRepo && pos && createPortal(
        <div
          ref={menuRef}
          className="repo-menu"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right, left: 'auto', minWidth: 280 }}
        >
          <div className="repo-menu-sect">Current branch</div>
          <div className="repo-menu-item" role="menuitem" aria-disabled="true" tabIndex={-1}>
            <span className="ico"><Icon name="branch" size={13} /></span>
            <span className="label">{currentBranch?.name ?? branch}</span>
            <span className="meta">
              {currentBranch?.upstream ? currentBranch.upstream.name : 'no upstream'}
            </span>
          </div>

          {otherBranches.length > 0 && (
            <>
              <div className="repo-menu-divider" />
              <div className="repo-menu-sect">Local branches</div>
              {otherBranches.map((b) => {
                const wt = worktreeByBranch.get(b.name);
                return (
                  <button
                    type="button"
                    key={b.full_name}
                    className="repo-menu-item"
                    role="menuitem"
                    tabIndex={0}
                    title={
                      wt
                        ? `Checked out in worktree ${wt.path} — opens that tab`
                        : b.upstream ? `tracks ${b.upstream.name}` : 'no upstream'
                    }
                    onClick={() => {
                      void (wt
                        ? run(`Opened worktree for ${b.name}`, () => openWorktree(wt.path))
                        : run(`Switched to ${b.name}`, () => checkout(b.name)));
                    }}
                  >
                    <span className="ico"><Icon name={wt ? 'worktree' : 'branch'} size={13} /></span>
                    <span className="label">{b.name}</span>
                    <span className="meta">
                      {wt
                        ? 'worktree'
                        : b.upstream
                          ? `${b.ahead > 0 ? `↑${b.ahead} ` : ''}${b.behind > 0 ? `↓${b.behind}` : ''}`.trim() ||
                            b.upstream.name
                          : ''}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {remoteBranches.length > 0 && (
            <>
              <div className="repo-menu-divider" />
              <div className="repo-menu-sect">Remote branches</div>
              {remoteBranches.map((rb) => {
                const localName = localBranchNameFor(rb.remote, rb.branch);
                return (
                <button
                  type="button"
                  key={rb.full_name}
                  className="repo-menu-item"
                  role="menuitem"
                  tabIndex={0}
                  title={`Create ${localName} tracking ${rb.name}`}
                  onClick={() => {
                    void run(
                      `Tracking ${rb.name}`,
                      () => createBranch(localName, rb.name, true),
                    );
                  }}
                >
                  <span className="ico"><Icon name="branch" size={13} /></span>
                  <span className="label">{rb.branch}</span>
                  <span className="meta">{rb.remote}</span>
                </button>
                );
              })}
            </>
          )}

          {otherBranches.length === 0 && remoteBranches.length === 0 && (
            <div className="repo-menu-empty">No other branches.</div>
          )}

          <div className="repo-menu-divider" />

          <CreateBranchField
            existing={allBranchNames}
            disabled={busy}
            onCreate={(name) => run(`Created ${name}`, () => createBranch(name, null, true))}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * Inline create-branch field. Lives at the bottom of the branch dropdown.
 *
 * - Spaces are normalized to `-` as the user types (Git doesn't allow
 *   spaces in ref names anyway).
 * - Below the field we show prefix matches against existing branches
 *   (local + remote). Useful when the project has a convention like
 *   `feature/foo` or `developments/bar` — you type `feature`, see the
 *   siblings, and Tab to land on `feature/`.
 * - ↑/↓ navigates the suggestion list; the highlighted match is what
 *   Tab fills the input with — never beyond the next `/`, so Tab only
 *   ever extends one folder segment at a time.
 * - Enter submits the typed value as a new branch name.
 */
function CreateBranchField({
  existing,
  disabled,
  onCreate,
}: {
  existing: string[];
  disabled: boolean;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sanitize = (raw: string): string => raw.replace(/\s+/g, '-');

  const matches = useMemo(() => {
    if (!value) return [];
    const q = value.toLowerCase();
    return existing
      .filter((n) => n.toLowerCase().startsWith(q) && n !== value)
      .slice(0, 6);
  }, [existing, value]);

  // Keep the highlight in range when the match list changes (e.g. the user
  // types another character and fewer candidates survive).
  useEffect(() => {
    if (selected >= matches.length) setSelected(0);
  }, [matches.length, selected]);

  // Fill the input with the next folder segment of `match`. No-op if the
  // match has no `/` past the current cursor — Tab never completes leaves.
  const acceptFolder = (match: string) => {
    const slash = match.indexOf('/', value.length);
    if (slash !== -1) setValue(match.slice(0, slash + 1));
  };

  const submit = () => {
    const name = value.trim();
    if (!name) return;
    void Promise.resolve(onCreate(name));
    setValue('');
    setSelected(0);
  };

  // Can the currently-highlighted match contribute a folder segment? Used
  // to gate the hint copy so we don't promise something Tab won't deliver.
  const canCompleteFolder =
    matches.length > 0 && matches[selected]?.indexOf('/', value.length) !== -1;

  return (
    <div className="branch-create">
      <div className="branch-create-input">
        <Icon name="plus" size={13} />
        <input
          ref={inputRef}
          value={value}
          placeholder="Create branch…"
          aria-label="Create branch"
          disabled={disabled}
          onChange={(e) => { setValue(sanitize(e.target.value)); setSelected(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              if (matches[selected]) acceptFolder(matches[selected]);
            } else if (e.key === 'ArrowDown' && matches.length > 0) {
              e.preventDefault();
              setSelected((i) => (i + 1) % matches.length);
            } else if (e.key === 'ArrowUp' && matches.length > 0) {
              e.preventDefault();
              setSelected((i) => (i - 1 + matches.length) % matches.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      {matches.length > 0 && (
        <div className="branch-create-hints">
          {matches.map((m, i) => (
            <div
              key={m}
              className={'branch-create-hint' + (i === selected ? ' selected' : '')}
              title={`Use prefix from ${m}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                acceptFolder(m);
                inputRef.current?.focus();
              }}
            >
              <span className="hint-typed">{m.slice(0, value.length)}</span>
              <span className="hint-rest">{m.slice(value.length)}</span>
            </div>
          ))}
          <div className="branch-create-tabhint">
            {canCompleteFolder
              ? 'Tab fills next folder · ↑↓ to choose'
              : '↑↓ to choose · Tab once a folder is in range'}
          </div>
        </div>
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
