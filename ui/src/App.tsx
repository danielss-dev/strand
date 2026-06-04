import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { Icon } from './components/Icon';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Topbar } from './components/Topbar';
import { FONTS, useSettings } from './stores/settings';
import { useRepo } from './stores/repo';
import { pickRepoDirectory } from './lib/dialog';
import { isTauri } from './lib/tauri';
import { useTheme } from './lib/theme';
import { CloneDialog } from './views/CloneDialog';
import { SettingsDialog } from './views/SettingsDialog';
import { StashDialog } from './views/StashDialog';
import { TagDialog } from './views/TagDialog';
import { MergeDialog } from './views/MergeDialog';
import { Commits } from './views/Commits';
import { FileView } from './views/FileView';
import { LocalChanges } from './views/LocalChanges';
import { CommandPalette, type PaletteAction } from './views/Palette';
import type { Progress, RepoMeta } from './lib/types';

const waitForPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export function App() {
  // Per-field selectors (not a bare `useSettings()`) so App only re-renders
  // when one of the five fields it actually reads changes — not on every
  // diffMode / diffsCollapsed / theme write.
  const density = useSettings((s) => s.density);
  const platform = useSettings((s) => s.platform);
  const uiFont = useSettings((s) => s.uiFont);
  const monoFont = useSettings((s) => s.monoFont);
  const accent = useSettings((s) => s.accent);
  // Theme preference → resolved theme; `useTheme` applies `data-theme` on
  // <html>, subscribes to the OS, and exposes setters for the picker/palette.
  const { resolved: theme, setPref: setTheme, cycle: cycleTheme } = useTheme();

  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  const selectedFile = useRepo((s) => s.selectedFile);
  const meta = useRepo((s) => s.meta);
  const recents = useRepo((s) => s.recents);
  const openRepo = useRepo((s) => s.openRepo);
  const refreshRecents = useRepo((s) => s.refreshRecents);
  const restoreSession = useRepo((s) => s.restoreSession);
  const refreshLocalChanges = useRepo((s) => s.refreshLocalChanges);
  const refreshLog = useRepo((s) => s.refreshLog);
  const refreshMeta = useRepo((s) => s.refreshMeta);
  const refreshRefs = useRepo((s) => s.refreshRefs);

  const fetchRepo = useRepo((s) => s.fetch);
  const pullRepo = useRepo((s) => s.pull);
  const pushRepo = useRepo((s) => s.push);
  const pushAllTags = useRepo((s) => s.pushAllTags);
  const abortOperation = useRepo((s) => s.abortOperation);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  // null = closed; otherwise the flavour the dialog opens in (snapshot vs stash).
  const [stashDialog, setStashDialog] = useState<{ snapshot: boolean } | null>(null);
  // null = closed; otherwise the tag target (revspec, null ⇒ HEAD) + its label.
  const [tagDialog, setTagDialog] = useState<{ target: string | null; label: string } | null>(null);
  // null = closed; otherwise the branch to merge (`source`) into the current (`into`).
  const [mergeDialog, setMergeDialog] = useState<{ source: string; into: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  // Brief "done" pulses: after a sync op succeeds the button flashes a
  // check instead of raising a toast. Cleared after the pulse animation.
  const [syncDone, setSyncDone] = useState(false);
  const [pullDone, setPullDone] = useState(false);
  const [pushDone, setPushDone] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Live network-op progress (clone/fetch/pull/push) shown as a pill while
  // a transfer is in flight. Null when idle.
  const [netProgress, setNetProgress] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  // Flash a button's check pulse for ~1.6s. The duration outlasts the
  // pop-in animation so the check lingers briefly before reverting.
  const flashDone = useCallback((set: (v: boolean) => void) => {
    set(true);
    setTimeout(() => set(false), 1600);
  }, []);

  const onNetProgress = useCallback((p: Progress) => {
    setNetProgress(
      p.percent != null ? `${p.phase || 'Working'} · ${p.percent}%` : p.phase || p.raw || null,
    );
  }, []);

  const openByPath = useCallback(async (path: string) => {
    try {
      await openRepo(path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Open failed: ${msg}`);
    }
  }, [openRepo, showToast]);

  const openViaDialog = useCallback(async () => {
    const path = await pickRepoDirectory();
    if (path) await openByPath(path);
  }, [openByPath]);

  const onSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setNetProgress('Fetching…');
    await waitForPaint();
    try {
      await fetchRepo(onNetProgress);
      flashDone(setSyncDone);
    } catch (e) {
      showToast(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
      setNetProgress(null);
    }
  }, [fetchRepo, onNetProgress, showToast, flashDone, syncing]);

  const onPull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    setNetProgress('Pulling…');
    await waitForPaint();
    try {
      await pullRepo(false, onNetProgress);
      flashDone(setPullDone);
    } catch (e) {
      showToast(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPulling(false);
      setNetProgress(null);
    }
  }, [pullRepo, onNetProgress, showToast, flashDone, pulling]);

  const onPush = useCallback(async () => {
    if (pushing) return;
    setPushing(true);
    setNetProgress('Pushing…');
    await waitForPaint();
    try {
      await pushRepo(false, onNetProgress);
      flashDone(setPushDone);
    } catch (e) {
      showToast(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPushing(false);
      setNetProgress(null);
    }
  }, [pushRepo, onNetProgress, showToast, flashDone, pushing]);

  // Load recents + restore the tabs the user had open last time. Both run
  // once on first mount; restoreSession is idempotent so StrictMode's
  // double-invoke is harmless.
  useEffect(() => {
    void refreshRecents();
    void restoreSession();
  }, [refreshRecents, restoreSession]);

  // Density, platform, and font tokens live on the document root so
  // portal-rendered popovers (which attach to document.body, outside .os-bg)
  // still see them. `data-theme` is applied separately by `useTheme`.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = density;
    root.dataset.platform = platform;
    root.dataset.accent = accent;
    root.style.setProperty('--font-ui', FONTS.ui[uiFont]);
    root.style.setProperty('--font-mono', FONTS.mono[monoFont]);
  }, [density, platform, accent, uiFont, monoFont]);

  // Native drag-and-drop: drop a folder onto the window to open it.
  useEffect(() => {
    if (!isTauri()) return;
    const w = getCurrentWebviewWindow();
    const unlisten = w.onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop' && payload.paths.length > 0) {
        void openByPath(payload.paths[0]);
      }
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [openByPath]);

  // Refresh git state whenever the user returns to the app. The OS may
  // have changed files behind our back (CLI commits, editor saves, branch
  // switches from another tool) — pulling fresh status + log on focus
  // keeps Strand from drifting out of sync. A small debounce avoids a
  // double-fetch when both events fire close together.
  useEffect(() => {
    if (!isTauri()) return;
    let lastAt = 0;
    const refresh = () => {
      const now = Date.now();
      if (now - lastAt < 400) return;
      lastAt = now;
      const { activePath } = useRepo.getState();
      if (!activePath) return;
      void refreshLocalChanges();
      void refreshLog();
      void refreshMeta();
      void refreshRefs();
    };
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshLocalChanges, refreshLog, refreshMeta, refreshRefs]);

  // Global ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openViaDialog();
      } else if (mod && e.key === '1') {
        e.preventDefault(); setView('local'); selectFile(null);
      } else if (mod && e.key === '2') {
        e.preventDefault(); setView('commits'); selectFile(null);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const next = cycleTheme();
        showToast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, selectFile, openViaDialog, cycleTheme, showToast]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    // Repo-independent — always available.
    const base: PaletteAction[] = [
      { id: 'open',    label: 'Open repository…',  shortcut: '⌘O', run: () => { void openViaDialog(); } },
      { id: 'clone',   label: 'Clone repository…', run: () => setCloneOpen(true) },
    ];
    // Repo-scoped actions only make sense — and only succeed — with a repo
    // open, so don't surface them (the network ones would fail confusingly).
    if (meta) {
      base.push(
        { id: 'local',   label: 'Show: Local Changes', shortcut: '⌘1', run: () => { setView('local'); selectFile(null); } },
        { id: 'commits', label: 'Show: All Commits',  shortcut: '⌘2', run: () => { setView('commits'); selectFile(null); } },
        { id: 'snapshot', label: 'Save snapshot…',  run: () => setStashDialog({ snapshot: true }) },
        { id: 'stash',    label: 'Stash changes…',  run: () => setStashDialog({ snapshot: false }) },
        { id: 'tag',      label: 'Create tag…',     run: () => setTagDialog({ target: null, label: 'HEAD' }) },
        { id: 'push-tags', label: 'Push all tags', run: () => {
          void (async () => {
            setNetProgress('Pushing tags…');
            try {
              await pushAllTags(onNetProgress);
              showToast('Pushed all tags');
            } catch (e) {
              showToast(`Push tags failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              setNetProgress(null);
            }
          })();
        } },
        { id: 'sync',    label: 'Sync (Fetch + Pull + Push)', shortcut: '⌘⇧S', run: onSync },
      );
    }
    base.push(
      { id: 'settings', label: 'Settings…', shortcut: '⌘,', run: () => setSettingsOpen(true) },
      { id: 'theme-light',  label: 'Theme: Light',  run: () => setTheme('light') },
      { id: 'theme-dark',   label: 'Theme: Dark',   run: () => setTheme('dark') },
      { id: 'theme-system', label: 'Theme: System', shortcut: '⌘⇧T', run: () => setTheme('system') },
    );
    // Surface "Abort" in the palette only while an op is actually paused.
    if (meta?.operation) {
      base.push({
        id: 'abort-op',
        label: `Abort ${meta.operation}`,
        run: () => {
          void (async () => {
            try {
              await abortOperation();
              showToast('Operation aborted');
            } catch (e) {
              showToast(`Abort failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          })();
        },
      });
    }
    const recentActions: PaletteAction[] = recents.map((r) => ({
      id: `recent:${r.path}`,
      label: `Open recent: ${r.name}`,
      shortcut: r.path,
      run: () => { void openByPath(r.path); },
    }));
    return [...base, ...recentActions];
  }, [setView, selectFile, onSync, openViaDialog, openByPath, setTheme, recents,
      pushAllTags, onNetProgress, showToast, meta, abortOperation]);

  const rootStyle = {
    '--font-ui': FONTS.ui[uiFont],
    '--font-mono': FONTS.mono[monoFont],
  } as React.CSSProperties;

  return (
    <div className="os-bg" data-theme={theme} data-density={density} data-platform={platform} style={rootStyle}>
      <div className="strand-window">
        <Topbar
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenRepo={openViaDialog}
          onOpenRecent={openByPath}
          onClone={() => setCloneOpen(true)}
          onSync={onSync}
          onPull={onPull}
          onPush={onPush}
          syncing={syncing}
          pulling={pulling}
          pushing={pushing}
          syncDone={syncDone}
          pullDone={pullDone}
          pushDone={pushDone}
          onToast={showToast}
          onSaveSnapshot={() => setStashDialog({ snapshot: true })}
        />

        <div className="body">
          <PanelGroup direction="horizontal" autoSaveId="strand:body">
            <Panel defaultSize={20} minSize={12} maxSize={40}>
              <Sidebar
                onOpenRepo={openViaDialog}
                onOpenRecent={openByPath}
                onCreateStash={() => setStashDialog({ snapshot: true })}
                onCreateTag={() => setTagDialog({ target: null, label: 'HEAD' })}
                onMerge={(source, into) => setMergeDialog({ source, into })}
                onToast={showToast}
              />
            </Panel>
            <PanelResizeHandle className="rs-handle vert" />
            <Panel minSize={30}>
              {view === 'file' && selectedFile ? (
                <FileView path={selectedFile} />
              ) : (
                <div className="main">
                  <MainHeader />
                  <OpBanner onToast={showToast} />
                  {view === 'local' && <LocalChanges />}
                  {(view === 'commits' || view === 'branch') && (
                    <Commits
                      onCreateTag={(target, label) => setTagDialog({ target, label })}
                      onToast={showToast}
                    />
                  )}
                </div>
              )}
            </Panel>
          </PanelGroup>
        </div>

        <StatusBar onOpenSettings={() => setSettingsOpen(true)} />

        {/* Persistent live region: the visible pills below mount/unmount, which
            is unreliable for screen readers, so announce the active message
            from an always-present node. assertive because the toast is the
            sole channel for network-op failures. */}
        <div className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
          {toast ?? netProgress ?? ''}
        </div>

        {netProgress && (
          <div className="toast progress" aria-hidden="true">
            <span className="icon-spin"><Icon name="refresh" size={13} /></span>
            <span>{netProgress}</span>
          </div>
        )}

        {toast && (
          <div className="toast" aria-hidden="true">
            <span style={{ color: 'var(--add)' }}><Icon name="check" size={13} stroke={2.2} /></span>
            <span>{toast}</span>
          </div>
        )}

        <UndoToast />
      </div>

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {cloneOpen && (
        <CloneDialog onClose={() => setCloneOpen(false)} onCloned={openByPath} />
      )}

      {stashDialog && (
        <StashDialog initialSnapshot={stashDialog.snapshot} onClose={() => setStashDialog(null)} />
      )}

      {tagDialog && (
        <TagDialog
          target={tagDialog.target}
          targetLabel={tagDialog.label}
          onClose={() => setTagDialog(null)}
        />
      )}

      {mergeDialog && (
        <MergeDialog
          source={mergeDialog.source}
          into={mergeDialog.into}
          onClose={() => setMergeDialog(null)}
          onToast={showToast}
        />
      )}

      {!isTauri() && !meta && (
        <div style={{
          position: 'fixed', bottom: 14, right: 16,
          padding: '8px 12px', borderRadius: 8,
          background: 'var(--bg-elev)', color: 'var(--text-2)',
          fontSize: 12, boxShadow: 'var(--shadow-pop)',
        }}>
          Running in browser — Rust commands disabled. Run <code>pnpm tauri dev</code>.
        </div>
      )}
    </div>
  );
}

/**
 * Single-undo affordance for discards. Watches `lastDiscard`; whenever a
 * new handle appears it surfaces a toast with an Undo button for a few
 * seconds, then lets the handle expire. Clicking Undo forward-applies the
 * discarded slice back to the working tree. Modeled on the "Undo send"
 * pattern — the window to undo is the lifetime of the toast.
 */
const UNDO_WINDOW_MS = 6000;

function UndoToast() {
  const lastDiscard = useRepo((s) => s.lastDiscard);
  const undoDiscard = useRepo((s) => s.undoDiscard);
  const clearUndo = useRepo((s) => s.clearUndo);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lastDiscard) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      clearUndo();
    }, UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [lastDiscard, clearUndo]);

  if (!visible || !lastDiscard) return null;

  return (
    <div className="toast undo">
      <span style={{ color: 'var(--text-2)' }}><Icon name="trash" size={13} /></span>
      <span>{lastDiscard.label}</span>
      <button type="button" className="toast-action" onClick={() => void undoDiscard()}>
        Undo
      </button>
    </div>
  );
}

/** Human label for an in-progress sequencer op (from `meta.operation`). */
const OP_LABEL: Record<NonNullable<RepoMeta['operation']>, string> = {
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry-pick in progress',
  revert: 'Revert in progress',
  merge: 'Merge in progress',
};

/**
 * Banner shown above the main view whenever a merge/rebase/cherry-pick/revert
 * is paused (typically on a conflict). Offers an Abort that restores the
 * pre-op state — the in-app escape hatch until the three-way resolution UI
 * lands. Resolving + committing the conflict (via Local Changes) clears
 * `operation` on the next refresh, which hides the banner.
 */
function OpBanner({ onToast }: { onToast: (msg: string) => void }) {
  const operation = useRepo((s) => s.meta?.operation ?? null);
  const abortOperation = useRepo((s) => s.abortOperation);
  const [busy, setBusy] = useState(false);
  if (!operation) return null;

  const onAbort = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await abortOperation();
      onToast('Operation aborted');
    } catch (e) {
      onToast(`Abort failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="op-banner" role="status">
      <Icon name="rebase" size={13} />
      <span className="op-label">{OP_LABEL[operation]}</span>
      <span className="op-hint">Resolve the conflicts in Local Changes and commit, or</span>
      <button type="button" className="btn ghost op-abort" disabled={busy} onClick={() => void onAbort()}>
        {busy ? 'Aborting…' : 'Abort'}
      </button>
    </div>
  );
}

function MainHeader() {
  const view = useRepo((s) => s.view);
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);
  const commits = useRepo((s) => s.commits);
  const activePath = useRepo((s) => s.activePath);
  const refreshLocalChanges = useRepo((s) => s.refreshLocalChanges);
  const refreshLog = useRepo((s) => s.refreshLog);
  const refreshMeta = useRepo((s) => s.refreshMeta);
  const refreshRefs = useRepo((s) => s.refreshRefs);
  const diffMode = useSettings((s) => s.diffMode);
  const diffsCollapsed = useSettings((s) => s.diffsCollapsed);
  const setSetting = useSettings((s) => s.set);
  const setDiffMode = useRepo((s) => s.setDiffMode);
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = useCallback(async () => {
    if (!activePath || refreshing) return;
    setRefreshing(true);
    await waitForPaint();
    try {
      await Promise.all([refreshLocalChanges(), refreshLog(), refreshMeta(), refreshRefs()]);
    } finally {
      setRefreshing(false);
    }
  }, [activePath, refreshing, refreshLocalChanges, refreshLog, refreshMeta, refreshRefs]);

  const title = view === 'local' ? 'Local Changes'
    : view === 'commits' ? 'All Commits'
    : view === 'branch' ? 'Branch'
    : '';
  const sub = view === 'local'
    ? `${meta?.branch ?? '—'} · ${status.length} files with changes`
    : view === 'commits'
      ? `${commits.length} commits across all branches`
      : '';

  return (
    <div className="main-header">
      <div className="crumb">
        <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {meta?.name ?? '—'}
        </span>
        <span className="sep"><Icon name="chev-right" size={10} /></span>
        <span className="leaf">{title}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11.5, marginLeft: 6 }}>· {sub}</span>
      </div>
      <div className="h-actions">
        {view === 'local' && (
          <>
            <button
              type="button"
              className={'icon-btn' + (diffMode === 'stacked' ? ' on' : '')}
              onClick={() => setDiffMode('stacked')}
              title="Stacked (unified)"
              aria-label="Stacked (unified) diff view"
            >
              <Icon name="unified" size={13} />
            </button>
            <button
              type="button"
              className={'icon-btn' + (diffMode === 'split' ? ' on' : '')}
              onClick={() => setDiffMode('split')}
              title="Split (side-by-side)"
              aria-label="Split (side-by-side) diff view"
            >
              <Icon name="split" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSetting('diffsCollapsed', !diffsCollapsed)}
              title={diffsCollapsed ? 'Expand all diffs' : 'Collapse all diffs'}
              aria-label={diffsCollapsed ? 'Expand all diffs' : 'Collapse all diffs'}
              aria-pressed={diffsCollapsed}
            >
              <Icon name={diffsCollapsed ? 'expand-all' : 'collapse-all'} size={13} />
            </button>
          </>
        )}
        <button
          type="button"
          className={'icon-btn' + (!activePath ? ' disabled' : '')}
          onClick={() => { if (activePath) void doRefresh(); }}
          title="Refresh"
          aria-label="Refresh"
          disabled={!activePath}
        >
          <span className={refreshing ? 'icon-spin' : undefined}>
            <Icon name="refresh" size={13} />
          </span>
        </button>
        {/* Planned, not yet wired — disabled so they don't present a dead
            affordance (a click that silently does nothing). */}
        <button type="button" className="icon-btn" title="Terminal (coming soon)" aria-label="Open terminal (coming soon)" disabled><Icon name="terminal" size={13} /></button>
        <button type="button" className="icon-btn" title="Open externally (coming soon)" aria-label="Open externally (coming soon)" disabled><Icon name="external" size={13} /></button>
      </div>
    </div>
  );
}
