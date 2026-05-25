import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { CommandPalette } from './views/Palette';
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
    const fetchRepo = useRepo((s) => s.fetch);
    const pullRepo = useRepo((s) => s.pull);
    const pushRepo = useRepo((s) => s.push);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [pulling, setPulling] = useState(false);
    const [pushing, setPushing] = useState(false);
    const [toast, setToast] = useState(null);
    const showToast = useCallback((msg) => {
        setToast(msg);
        setTimeout(() => setToast(null), 2200);
    }, []);
    const openByPath = useCallback(async (path) => {
        try {
            await openRepo(path);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            showToast(`Open failed: ${msg}`);
        }
    }, [openRepo, showToast]);
    const openViaDialog = useCallback(async () => {
        const path = await pickRepoDirectory();
        if (path)
            await openByPath(path);
    }, [openByPath]);
    const onSync = useCallback(async () => {
        if (syncing)
            return;
        setSyncing(true);
        try {
            await fetchRepo();
            showToast('Fetched');
        }
        catch (e) {
            showToast(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        finally {
            setSyncing(false);
        }
    }, [fetchRepo, showToast, syncing]);
    const onPull = useCallback(async () => {
        if (pulling)
            return;
        setPulling(true);
        try {
            await pullRepo();
            showToast('Pulled');
        }
        catch (e) {
            showToast(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        finally {
            setPulling(false);
        }
    }, [pullRepo, showToast, pulling]);
    const onPush = useCallback(async () => {
        if (pushing)
            return;
        setPushing(true);
        try {
            await pushRepo();
            showToast('Pushed');
        }
        catch (e) {
            showToast(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        finally {
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
        if (!isTauri())
            return;
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
        if (!isTauri())
            return;
        let lastAt = 0;
        const refresh = () => {
            const now = Date.now();
            if (now - lastAt < 400)
                return;
            lastAt = now;
            const { activePath } = useRepo.getState();
            if (!activePath)
                return;
            void refreshLocalChanges();
            void refreshLog();
            void refreshMeta();
        };
        const onVis = () => { if (document.visibilityState === 'visible')
            refresh(); };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', onVis);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [refreshLocalChanges, refreshLog, refreshMeta]);
    // Global ⌘K / Ctrl+K
    useEffect(() => {
        const onKey = (e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setPaletteOpen((o) => !o);
            }
            else if (mod && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                void openViaDialog();
            }
            else if (mod && e.key === '1') {
                e.preventDefault();
                setView('local');
                selectFile(null);
            }
            else if (mod && e.key === '2') {
                e.preventDefault();
                setView('commits');
                selectFile(null);
            }
            else if (e.key === 'Escape') {
                setPaletteOpen(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setView, selectFile, openViaDialog]);
    const paletteActions = useMemo(() => {
        const base = [
            { id: 'open', label: 'Open repository…', shortcut: '⌘O', run: () => { void openViaDialog(); } },
            { id: 'local', label: 'Show: Local Changes', shortcut: '⌘1', run: () => { setView('local'); selectFile(null); } },
            { id: 'commits', label: 'Show: All Commits', shortcut: '⌘2', run: () => { setView('commits'); selectFile(null); } },
            { id: 'sync', label: 'Sync (Fetch + Pull + Push)', shortcut: '⌘⇧S', run: onSync },
            { id: 'tweaks', label: 'Toggle theme', shortcut: '⌘⇧T', run: () => setSetting('theme', theme === 'dark' ? 'light' : 'dark') },
        ];
        const recentActions = recents.map((r) => ({
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
    };
    return (_jsxs("div", { className: "os-bg", "data-theme": theme, "data-density": density, "data-platform": platform, style: rootStyle, children: [_jsxs("div", { className: "strand-window", children: [_jsx(Topbar, { onOpenPalette: () => setPaletteOpen(true), onOpenRepo: openViaDialog, onOpenRecent: openByPath, onSync: onSync, onPull: onPull, onPush: onPush, syncing: syncing, pulling: pulling, pushing: pushing, onToast: showToast }), _jsx("div", { className: "body", children: _jsxs(PanelGroup, { direction: "horizontal", autoSaveId: "strand:body", children: [_jsx(Panel, { defaultSize: 20, minSize: 12, maxSize: 40, children: _jsx(Sidebar, { onOpenRepo: openViaDialog, onOpenRecent: openByPath }) }), _jsx(PanelResizeHandle, { className: "rs-handle vert" }), _jsx(Panel, { minSize: 30, children: view === 'file' && selectedFile ? (_jsx(FileView, { path: selectedFile })) : (_jsxs("div", { className: "main", children: [_jsx(MainHeader, {}), view === 'local' && _jsx(LocalChanges, {}), (view === 'commits' || view === 'branch') && _jsx(Commits, {})] })) })] }) }), _jsx(StatusBar, {}), toast && (_jsxs("div", { className: "toast", children: [_jsx("span", { style: { color: 'var(--add)' }, children: _jsx(Icon, { name: "check", size: 13, stroke: 2.2 }) }), _jsx("span", { children: toast })] }))] }), paletteOpen && _jsx(CommandPalette, { actions: paletteActions, onClose: () => setPaletteOpen(false) }), !isTauri() && !meta && (_jsxs("div", { style: {
                    position: 'fixed', bottom: 14, right: 16,
                    padding: '8px 12px', borderRadius: 8,
                    background: 'var(--bg-elev)', color: 'var(--text-2)',
                    fontSize: 11, boxShadow: 'var(--shadow-pop)',
                }, children: ["Running in browser \u2014 Rust commands disabled. Run ", _jsx("code", { children: "pnpm tauri dev" }), "."] }))] }));
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
    const diffMode = useSettings((s) => s.diffMode);
    const setSetting = useSettings((s) => s.set);
    const [refreshing, setRefreshing] = useState(false);
    const doRefresh = useCallback(async () => {
        if (!activePath || refreshing)
            return;
        setRefreshing(true);
        try {
            await Promise.all([refreshLocalChanges(), refreshLog(), refreshMeta()]);
        }
        finally {
            setRefreshing(false);
        }
    }, [activePath, refreshing, refreshLocalChanges, refreshLog, refreshMeta]);
    const title = view === 'local' ? 'Local Changes'
        : view === 'commits' ? 'All Commits'
            : view === 'branch' ? 'Branch'
                : '';
    const sub = view === 'local'
        ? `${meta?.branch ?? '—'} · ${status.length} files with changes`
        : view === 'commits'
            ? `${commits.length} commits on this branch`
            : '';
    return (_jsxs("div", { className: "main-header", children: [_jsxs("div", { className: "crumb", children: [_jsx("span", { style: { color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 11 }, children: meta?.name ?? '—' }), _jsx("span", { className: "sep", children: _jsx(Icon, { name: "chev-right", size: 10 }) }), _jsx("span", { className: "leaf", children: title }), _jsxs("span", { style: { color: 'var(--text-dim)', fontSize: 11.5, marginLeft: 6 }, children: ["\u00B7 ", sub] })] }), _jsxs("div", { className: "h-actions", children: [view === 'local' && (_jsxs(_Fragment, { children: [_jsx("div", { className: 'icon-btn' + (diffMode === 'stacked' ? ' on' : ''), onClick: () => setSetting('diffMode', 'stacked'), title: "Stacked (unified)", children: _jsx(Icon, { name: "unified", size: 13 }) }), _jsx("div", { className: 'icon-btn' + (diffMode === 'split' ? ' on' : ''), onClick: () => setSetting('diffMode', 'split'), title: "Split (side-by-side)", children: _jsx(Icon, { name: "split", size: 13 }) })] })), _jsx("div", { className: 'icon-btn' + (!activePath ? ' disabled' : ''), onClick: () => { if (activePath)
                            void doRefresh(); }, title: "Refresh", children: _jsx(Icon, { name: "refresh", size: 13, className: refreshing ? 'spin' : undefined }) }), _jsx("div", { className: "icon-btn", title: "Terminal", children: _jsx(Icon, { name: "terminal", size: 13 }) }), _jsx("div", { className: "icon-btn", title: "Open externally", children: _jsx(Icon, { name: "external", size: 13 }) })] })] }));
}
