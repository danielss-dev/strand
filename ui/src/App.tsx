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
import { Commits } from './views/Commits';
import { FileView } from './views/FileView';
import { LocalChanges } from './views/LocalChanges';
import { CommandPalette, type PaletteAction } from './views/Palette';

const waitForPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export function App() {
  const { theme, density, platform, uiFont, monoFont, set: setSetting } = useSettings();

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

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
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
    await waitForPaint();
    try {
      await fetchRepo();
      showToast('Fetched');
    } catch (e) {
      showToast(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [fetchRepo, showToast, syncing]);

  const onPull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    await waitForPaint();
    try {
      await pullRepo();
      showToast('Pulled');
    } catch (e) {
      showToast(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPulling(false);
    }
  }, [pullRepo, showToast, pulling]);

  const onPush = useCallback(async () => {
    if (pushing) return;
    setPushing(true);
    await waitForPaint();
    try {
      await pushRepo();
      showToast('Pushed');
    } catch (e) {
      showToast(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPushing(false);
    }
  }, [pushRepo, showToast, pushing]);

  // Load recents + restore the tabs the user had open last time. Both run
  // once on first mount; restoreSession is idempotent so StrictMode's
  // double-invoke is harmless.
  useEffect(() => {
    void refreshRecents();
    void restoreSession();
  }, [refreshRecents, restoreSession]);

  // Theme tokens live on the document root so portal-rendered popovers
  // (which attach to document.body, outside .os-bg) still see them.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = density;
    root.dataset.platform = platform;
    root.style.setProperty('--font-ui', FONTS.ui[uiFont]);
    root.style.setProperty('--font-mono', FONTS.mono[monoFont]);
  }, [theme, density, platform, uiFont, monoFont]);

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
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, selectFile, openViaDialog]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const base: PaletteAction[] = [
      { id: 'open',    label: 'Open repository…',  shortcut: '⌘O', run: () => { void openViaDialog(); } },
      { id: 'local',   label: 'Show: Local Changes', shortcut: '⌘1', run: () => { setView('local'); selectFile(null); } },
      { id: 'commits', label: 'Show: All Commits',  shortcut: '⌘2', run: () => { setView('commits'); selectFile(null); } },
      { id: 'sync',    label: 'Sync (Fetch + Pull + Push)', shortcut: '⌘⇧S', run: onSync },
      { id: 'tweaks',  label: 'Toggle theme',      shortcut: '⌘⇧T', run: () => setSetting('theme', theme === 'dark' ? 'light' : 'dark') },
    ];
    const recentActions: PaletteAction[] = recents.map((r) => ({
      id: `recent:${r.path}`,
      label: `Open recent: ${r.name}`,
      shortcut: r.path,
      run: () => { void openByPath(r.path); },
    }));
    return [...base, ...recentActions];
  }, [setView, selectFile, onSync, openViaDialog, openByPath, setSetting, theme, recents]);

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
          onSync={onSync}
          onPull={onPull}
          onPush={onPush}
          syncing={syncing}
          pulling={pulling}
          pushing={pushing}
          onToast={showToast}
        />

        <div className="body">
          <PanelGroup direction="horizontal" autoSaveId="strand:body">
            <Panel defaultSize={20} minSize={12} maxSize={40}>
              <Sidebar onOpenRepo={openViaDialog} onOpenRecent={openByPath} />
            </Panel>
            <PanelResizeHandle className="rs-handle vert" />
            <Panel minSize={30}>
              {view === 'file' && selectedFile ? (
                <FileView path={selectedFile} />
              ) : (
                <div className="main">
                  <MainHeader />
                  {view === 'local' && <LocalChanges />}
                  {(view === 'commits' || view === 'branch') && <Commits />}
                </div>
              )}
            </Panel>
          </PanelGroup>
        </div>

        <StatusBar />

        {toast && (
          <div className="toast">
            <span style={{ color: 'var(--add)' }}><Icon name="check" size={13} stroke={2.2} /></span>
            <span>{toast}</span>
          </div>
        )}

        <UndoToast />
      </div>

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

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
  const setSetting = useSettings((s) => s.set);
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
      ? `${commits.length} commits on this branch`
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
              onClick={() => setSetting('diffMode', 'stacked')}
              title="Stacked (unified)"
              aria-label="Stacked (unified) diff view"
            >
              <Icon name="unified" size={13} />
            </button>
            <button
              type="button"
              className={'icon-btn' + (diffMode === 'split' ? ' on' : '')}
              onClick={() => setSetting('diffMode', 'split')}
              title="Split (side-by-side)"
              aria-label="Split (side-by-side) diff view"
            >
              <Icon name="split" size={13} />
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
        <button type="button" className="icon-btn" title="Terminal" aria-label="Terminal"><Icon name="terminal" size={13} /></button>
        <button type="button" className="icon-btn" title="Open externally" aria-label="Open externally"><Icon name="external" size={13} /></button>
      </div>
    </div>
  );
}
