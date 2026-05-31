import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';
import { isTauri } from '../lib/tauri';
import { useSettings } from '../stores/settings';
import { useRepo } from '../stores/repo';

interface Props {
  onOpenPalette: () => void;
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onClone: () => void;
  onSync: () => void;
  onPull: () => void;
  onPush: () => void;
  syncing: boolean;
  pulling: boolean;
  pushing: boolean;
  syncDone: boolean;
  pullDone: boolean;
  pushDone: boolean;
  onToast: (msg: string) => void;
}

export function Topbar({
  onOpenPalette,
  onOpenRepo,
  onOpenRecent,
  onClone,
  onSync,
  onPull,
  onPush,
  syncing,
  pulling,
  pushing,
  syncDone,
  pullDone,
  pushDone,
  onToast,
}: Props) {
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
          onClone={onClone}
          recents={recents}
          onForget={forgetRecent}
        />
      </div>

      <div className="topbar-spacer" />

      <div className="sync-group">
        <button
          type="button"
          className="sync-btn"
          onClick={onSync}
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
          onClick={onPull}
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
          <span className="count">{behind}</span>
        </button>
        <button
          type="button"
          className="sync-btn"
          onClick={onPush}
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
          <span className="count">{ahead}</span>
        </button>
      </div>

      <StashButton onToast={onToast} />

      <BranchSwitcherButton
        branch={branch}
        detached={!!meta?.detached}
        hasRepo={!!meta}
        onToast={onToast}
      />

      <button type="button" className="cmd-pill" onClick={onOpenPalette} aria-label="Quick Launch">
        <Icon name="search" size={13} />
        <span>Quick Launch</span>
        <kbd>{platform === 'mac' ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

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
  onClone,
  recents,
  onForget,
}: {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onClone: () => void;
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
                  tabIndex={0}
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

/**
 * Stash split button — the primary face stashes all changes; the chevron
 * opens a menu with create variants (untracked / keep-index) and "Pop latest".
 * Per-stash apply / pop / drop lives on the sidebar Stashes list. Reads the
 * store directly and only takes `onToast`, mirroring {@link BranchSwitcherButton}.
 */
function StashButton({ onToast }: { onToast: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const meta = useRepo((s) => s.meta);
  const stashes = useRepo((s) => s.stashes);
  const stashSave = useRepo((s) => s.stashSave);
  const stashPop = useRepo((s) => s.stashPop);

  const hasRepo = !!meta;

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open]);

  useOutsideClose([wrapRef, menuRef], open, () => setOpen(false));

  const save = async (includeUntracked: boolean, keepIndex: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await stashSave(null, includeUntracked, keepIndex);
      onToast(outcome.oid ? 'Stashed changes' : 'Nothing to stash');
      setOpen(false);
    } catch (e) {
      onToast(`Stash failed: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
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
      onToast(`Pop failed: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="sync-group stash-group">
      <button
        type="button"
        className="sync-btn"
        onClick={() => void save(false, false)}
        title="Stash all changes"
        aria-label="Stash all changes"
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
            onClick={() => void save(false, false)}
          >
            <span className="ico"><Icon name="stash" size={13} /></span>
            <span className="label">Stash all changes</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => void save(true, false)}
          >
            <span className="ico"><Icon name="stash" size={13} /></span>
            <span className="label">Stash including untracked</span>
            <span className="meta">-u</span>
          </button>
          <button
            type="button"
            className="repo-menu-item"
            role="menuitem"
            tabIndex={0}
            onClick={() => void save(false, true)}
          >
            <span className="ico"><Icon name="stash" size={13} /></span>
            <span className="label">Stash, keep staged</span>
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
  onToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const refs = useRepo((s) => s.refs);
  const checkout = useRepo((s) => s.checkout);
  const createBranch = useRepo((s) => s.createBranch);

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
      onToast(`${label} failed: ${(e as Error).message ?? e}`);
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
        style={hasRepo ? undefined : { opacity: 0.5, cursor: 'default' }}
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
              {otherBranches.map((b) => (
                <button
                  type="button"
                  key={b.full_name}
                  className="repo-menu-item"
                  role="menuitem"
                  tabIndex={0}
                  title={b.upstream ? `tracks ${b.upstream.name}` : 'no upstream'}
                  onClick={() => {
                    void run(`Switched to ${b.name}`, () => checkout(b.name));
                  }}
                >
                  <span className="ico"><Icon name="branch" size={13} /></span>
                  <span className="label">{b.name}</span>
                  <span className="meta">
                    {b.upstream
                      ? `${b.ahead > 0 ? `↑${b.ahead} ` : ''}${b.behind > 0 ? `↓${b.behind}` : ''}`.trim() ||
                        b.upstream.name
                      : ''}
                  </span>
                </button>
              ))}
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
