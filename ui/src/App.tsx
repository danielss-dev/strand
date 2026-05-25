import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

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

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
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

  const onSync = useCallback(() => {
    setSyncing(true);
    // TODO: wire to a real `repo_fetch` Tauri command.
    setTimeout(() => {
      setSyncing(false);
      showToast('Fetched origin · up to date');
    }, 900);
  }, [showToast]);

  // Load recents once at startup so the empty-state sidebar + palette
  // have something to show before the user opens anything.
  useEffect(() => { void refreshRecents(); }, [refreshRecents]);

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
          syncing={syncing}
          onToast={showToast}
        />

        <div className="body">
          <Sidebar onOpenRepo={openViaDialog} onOpenRecent={openByPath} />

          {view === 'file' && selectedFile ? (
            <FileView path={selectedFile} />
          ) : (
            <div className="main">
              <MainHeader />
              {view === 'local' && <LocalChanges />}
              {(view === 'commits' || view === 'branch') && <Commits />}
            </div>
          )}
        </div>

        <StatusBar />

        {toast && (
          <div className="toast">
            <span style={{ color: 'var(--add)' }}><Icon name="check" size={13} stroke={2.2} /></span>
            <span>{toast}</span>
          </div>
        )}
      </div>

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

      {!isTauri() && !meta && (
        <div style={{
          position: 'fixed', bottom: 14, right: 16,
          padding: '8px 12px', borderRadius: 8,
          background: 'var(--bg-elev)', color: 'var(--text-2)',
          fontSize: 11, boxShadow: 'var(--shadow-pop)',
        }}>
          Running in browser — Rust commands disabled. Run <code>pnpm tauri dev</code>.
        </div>
      )}
    </div>
  );
}

function MainHeader() {
  const view = useRepo((s) => s.view);
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);
  const commits = useRepo((s) => s.commits);
  const diffMode = useSettings((s) => s.diffMode);
  const setSetting = useSettings((s) => s.set);

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
        <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          {meta?.name ?? '—'}
        </span>
        <span className="sep"><Icon name="chev-right" size={10} /></span>
        <span className="leaf">{title}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11.5, marginLeft: 6 }}>· {sub}</span>
      </div>
      <div className="h-actions">
        {view === 'local' && (
          <>
            <div className={'icon-btn' + (diffMode === 'stacked' ? ' on' : '')}
                 onClick={() => setSetting('diffMode', 'stacked')} title="Stacked (unified)">
              <Icon name="unified" size={13} />
            </div>
            <div className={'icon-btn' + (diffMode === 'split' ? ' on' : '')}
                 onClick={() => setSetting('diffMode', 'split')} title="Split (side-by-side)">
              <Icon name="split" size={13} />
            </div>
          </>
        )}
        <div className="icon-btn" title="Refresh"><Icon name="refresh" size={13} /></div>
        <div className="icon-btn" title="Terminal"><Icon name="terminal" size={13} /></div>
        <div className="icon-btn" title="Open externally"><Icon name="external" size={13} /></div>
      </div>
    </div>
  );
}
