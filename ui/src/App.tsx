import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { Icon } from './components/Icon';
import { ProgressPopup, formatDuration } from './components/ProgressPopup';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Topbar } from './components/Topbar';
import { FONTS, useSettings } from './stores/settings';
import { useRepo } from './stores/repo';
import { pickRepoDirectory } from './lib/dialog';
import { errMessage, isTauri, tauri } from './lib/tauri';
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
import type { Progress, RepoMeta, StatusKind } from './lib/types';

const waitForPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Single-letter status badge shown as the palette meta for a working-tree file. */
const STATUS_ABBR: Record<StatusKind, string> = {
  MODIFIED: 'M',
  ADDED: 'A',
  DELETED: 'D',
  RENAMED: 'R',
  UNTRACKED: 'U',
  CONFLICTED: 'C',
};

/** Spoken status word for the palette option's accessible name. */
const STATUS_WORD: Record<StatusKind, string> = {
  MODIFIED: 'modified',
  ADDED: 'added',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  UNTRACKED: 'untracked',
  CONFLICTED: 'conflicted',
};

/** A long-running clone/open driving the persistent progress popup. */
interface OpProgress {
  /** Monotonic id of the owning operation — a finally only clears its own popup
   *  so overlapping opens/clones can't wipe each other's progress. */
  id: number;
  kind: 'clone' | 'open';
  /** Verb line ("Cloning" / "Opening"). */
  title: string;
  /** Repo / folder name. */
  subject: string;
  /** 0–100 for a determinate bar; null for an indeterminate sweep. */
  percent: number | null;
  /** Phase text under the bar. */
  detail: string;
  /** Pre-formatted ETA ("~1m 12s remaining"), or null to show elapsed instead. */
  eta: string | null;
  startedAt: number;
  /** When set, the op failed: the popup shows this reason + a Dismiss button
   *  and stays until dismissed, instead of silently vanishing. */
  error?: string | null;
}

/** Last path segment of a filesystem path (handles `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

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
  const activePath = useRepo((s) => s.activePath);
  const recents = useRepo((s) => s.recents);
  const openRepo = useRepo((s) => s.openRepo);
  const refreshRecents = useRepo((s) => s.refreshRecents);
  const restoreSession = useRepo((s) => s.restoreSession);
  const refreshLocalChanges = useRepo((s) => s.refreshLocalChanges);
  const refreshLog = useRepo((s) => s.refreshLog);
  const refreshMeta = useRepo((s) => s.refreshMeta);
  const refreshRefs = useRepo((s) => s.refreshRefs);
  const refreshSubmodules = useRepo((s) => s.refreshSubmodules);

  // Repo data the command palette indexes (branches / files / commits).
  const refs = useRepo((s) => s.refs);
  const commits = useRepo((s) => s.commits);
  const workTree = useRepo((s) => s.workTree);
  const refreshTree = useRepo((s) => s.refreshTree);
  const checkout = useRepo((s) => s.checkout);
  const createBranch = useRepo((s) => s.createBranch);
  const revealInGraph = useRepo((s) => s.revealInGraph);
  const selectCommit = useRepo((s) => s.selectCommit);

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
  // Live network-op progress (fetch/pull/push) shown as a pill while a
  // transfer is in flight. Null when idle.
  const [netProgress, setNetProgress] = useState<string | null>(null);
  // Persistent clone/open progress popup — stays until the op completes.
  const [opProgress, setOpProgress] = useState<OpProgress | null>(null);
  // Monotonic op id so a finished op only clears its *own* popup — concurrent
  // opens (drag-drop while a recent is loading) or a drop mid-clone can't
  // stomp each other's progress.
  const opGen = useRef(0);

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
    const id = ++opGen.current;
    const startedAt = Date.now();
    // Delay the popup briefly so opening a small repo (the common case, which
    // finishes well under this) doesn't flash a bar. A big repo blows past the
    // delay and shows the indeterminate "Opening…" bar until it's ready.
    let shown = false;
    const timer = setTimeout(() => {
      shown = true;
      setOpProgress({
        id,
        kind: 'open',
        title: 'Opening',
        subject: basename(path),
        percent: null,
        detail: 'Reading repository…',
        eta: null,
        startedAt,
      });
    }, 200);
    try {
      await openRepo(path);
      clearTimeout(timer);
      // Success: clear the popup if this op still owns it.
      setOpProgress((cur) => (cur && cur.id === id ? null : cur));
    } catch (e) {
      clearTimeout(timer);
      const msg = errMessage(e);
      // If the popup is up, switch it to a persistent error so the failure
      // isn't swallowed; if the open failed before the popup showed (fast fail,
      // e.g. "not a git repository"), a toast is enough.
      if (shown) setOpProgress((cur) => (cur && cur.id === id ? { ...cur, error: msg } : cur));
      else showToast(`Open failed: ${msg}`);
    }
  }, [openRepo, showToast]);

  // Run a clone with the persistent progress popup, then open the result. The
  // same popup (one op id) switches in place from "Cloning" to "Opening" — no
  // flicker. The Clone dialog closes the moment this starts; failures surface
  // as a toast (there's no dialog to return to).
  const runClone = useCallback(async (url: string, dest: string) => {
    const id = ++opGen.current;
    const startedAt = Date.now();
    // Per-phase ETA: git's percent resets each phase (Counting → Compressing →
    // Receiving → Resolving), so time the current phase and extrapolate from it
    // — the dominant "Receiving objects" phase is where the estimate matters.
    let phaseStart = startedAt;
    let phaseLabel = '';
    setOpProgress({
      id,
      kind: 'clone',
      title: 'Cloning',
      subject: basename(dest),
      percent: null,
      detail: 'Starting…',
      eta: null,
      startedAt,
    });
    let clonedPath: string | null = null;
    try {
      const res = await tauri.repoClone(url, dest, (p: Progress) => {
        if (p.phase && p.phase !== phaseLabel) {
          phaseLabel = p.phase;
          phaseStart = Date.now();
        }
        const pct = p.percent;
        let eta: string | null = null;
        if (pct != null && pct > 1 && pct < 100) {
          const remaining = ((Date.now() - phaseStart) / 1000) * (100 - pct) / pct;
          if (remaining >= 1) eta = `~${formatDuration(remaining)} remaining`;
        }
        const detail = pct != null ? `${p.phase || 'Working'} ${pct}%` : p.raw || p.phase || 'Cloning…';
        setOpProgress((cur) => (cur && cur.id === id && cur.kind === 'clone' ? { ...cur, percent: pct, detail, eta } : cur));
      });
      clonedPath = res.path;
    } catch (e) {
      // Surface the failure in the popup itself (persistent + dismissible) so a
      // clone that dies isn't a popup that just vanishes with a fleeting toast.
      const msg = errMessage(e);
      setOpProgress((cur) => (cur && cur.id === id ? { ...cur, error: msg, percent: null, eta: null } : cur));
      return;
    }
    // Switch the same popup to "Opening" in place (no delay, no flicker) and
    // open the freshly cloned repo.
    setOpProgress((cur) =>
      cur && cur.id === id
        ? { id, kind: 'open', title: 'Opening', subject: basename(clonedPath!), percent: null, detail: 'Reading repository…', eta: null, startedAt: Date.now() }
        : cur,
    );
    try {
      await openRepo(clonedPath);
      setOpProgress((cur) => (cur && cur.id === id ? null : cur));
    } catch (e) {
      const msg = errMessage(e);
      setOpProgress((cur) => (cur && cur.id === id ? { ...cur, error: msg } : cur));
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
      showToast(`Fetch failed: ${errMessage(e)}`);
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
      showToast(`Pull failed: ${errMessage(e)}`);
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
      showToast(`Push failed: ${errMessage(e)}`);
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
      void refreshSubmodules();
    };
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshLocalChanges, refreshLog, refreshMeta, refreshRefs, refreshSubmodules]);

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

  // The working-tree file list is otherwise lazy (only the Files sidebar tab
  // loads it). Pull it when the palette opens so file search has data; keyed on
  // activePath so it refreshes on a tab switch but not on every meta tick.
  useEffect(() => {
    if (paletteOpen && activePath) void refreshTree();
  }, [paletteOpen, activePath, refreshTree]);

  // Repo data items (branches / tags / files / commits) are built only while
  // the palette is open, so a large repo's log and file tree cost nothing when
  // it's closed. The CommandPalette caps how many actually render.
  const repoActions = useMemo<PaletteAction[]>(() => {
    if (!paletteOpen || !meta) return [];
    const out: PaletteAction[] = [];

    // Branches — checkout a local branch. The current branch can't be checked
    // out again, so it reveals its tip in the graph instead.
    for (const b of refs.branches) {
      const drift = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : '']
        .filter(Boolean).join(' ');
      const driftSpoken = [b.ahead ? `${b.ahead} ahead` : '', b.behind ? `${b.behind} behind` : '']
        .filter(Boolean).join(', ');
      out.push({
        id: `branch:${b.full_name}`,
        label: b.name,
        group: 'Branches',
        keywords: b.full_name,
        meta: b.is_head ? 'current' : drift || b.target.slice(0, 7),
        metaLabel: b.is_head ? undefined : driftSpoken || undefined,
        icon: b.is_head ? 'check' : 'branch',
        run: () => {
          if (b.is_head) { revealInGraph(b.target); return; }
          void checkout(b.name).catch((e) =>
            showToast(`Checkout failed: ${errMessage(e)}`));
        },
      });
    }

    // Remote branches without a local counterpart — checkout creates a local
    // tracking branch (createBranch auto-tracks a remote-tracking start point).
    const localNames = new Set(refs.branches.map((b) => b.name));
    for (const rb of refs.remote_branches) {
      if (localNames.has(rb.branch)) continue;
      out.push({
        id: `remote:${rb.full_name}`,
        label: `${rb.remote}/${rb.branch}`,
        group: 'Branches',
        keywords: `${rb.full_name} remote track checkout`,
        meta: rb.target.slice(0, 7),
        icon: 'remote',
        run: () => {
          // Pass the shorthand (origin/foo), not the full ref — createBranch
          // only auto-tracks when the start point resolves as a remote-tracking
          // *branch*, which git2 finds by shorthand.
          void createBranch(rb.branch, rb.name, true).catch((e) =>
            showToast(`Checkout failed: ${errMessage(e)}`));
        },
      });
    }

    // Tags — reveal the tagged commit in the graph (non-destructive; checkout
    // detaches HEAD and stays a deliberate sidebar action).
    for (const t of refs.tags) {
      out.push({
        id: `tag:${t.full_name}`,
        label: t.name,
        group: 'Tags',
        keywords: t.full_name,
        meta: t.target.slice(0, 7),
        run: () => { revealInGraph(t.target); },
      });
    }

    // Files — open in the file view, same as clicking a row in the Files tab.
    for (const f of workTree) {
      out.push({
        id: `file:${f.path}`,
        label: f.path,
        group: 'Files',
        meta: f.status ? STATUS_ABBR[f.status] : undefined,
        metaLabel: f.status ? STATUS_WORD[f.status] : undefined,
        run: () => { selectFile(f.path); },
      });
    }

    // Commits — reveal in the graph and open the detail panel.
    for (const c of commits) {
      out.push({
        id: `commit:${c.hash}`,
        label: c.subject || '(no message)',
        group: 'Commits',
        keywords: `${c.hash} ${c.author_name}`,
        meta: c.short_hash,
        run: () => { revealInGraph(c.hash); void selectCommit(c.hash); },
      });
    }

    return out;
  }, [paletteOpen, meta, refs, workTree, commits, checkout, createBranch,
      revealInGraph, selectCommit, selectFile, showToast]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    // Repo-independent — always available.
    const base: PaletteAction[] = [
      { id: 'open',    label: 'Open repository…',  group: 'Actions', shortcut: '⌘O', run: () => { void openViaDialog(); } },
      { id: 'clone',   label: 'Clone repository…', group: 'Actions', run: () => setCloneOpen(true) },
    ];
    // Repo-scoped actions only make sense — and only succeed — with a repo
    // open, so don't surface them (the network ones would fail confusingly).
    if (meta) {
      base.push(
        { id: 'local',   label: 'Show: Local Changes', group: 'Actions', shortcut: '⌘1', run: () => { setView('local'); selectFile(null); } },
        { id: 'commits', label: 'Show: All Commits',  group: 'Actions', shortcut: '⌘2', run: () => { setView('commits'); selectFile(null); } },
        { id: 'snapshot', label: 'Save snapshot…',  group: 'Actions', run: () => setStashDialog({ snapshot: true }) },
        { id: 'stash',    label: 'Stash changes…',  group: 'Actions', run: () => setStashDialog({ snapshot: false }) },
        { id: 'tag',      label: 'Create tag…',     group: 'Actions', run: () => setTagDialog({ target: null, label: 'HEAD' }) },
        { id: 'push-tags', label: 'Push all tags', group: 'Actions', run: () => {
          void (async () => {
            setNetProgress('Pushing tags…');
            try {
              await pushAllTags(onNetProgress);
              showToast('Pushed all tags');
            } catch (e) {
              showToast(`Push tags failed: ${errMessage(e)}`);
            } finally {
              setNetProgress(null);
            }
          })();
        } },
        { id: 'sync',    label: 'Sync (Fetch + Pull + Push)', group: 'Actions', shortcut: '⌘⇧S', run: onSync },
      );
    }
    base.push(
      { id: 'settings', label: 'Settings…', group: 'Actions', shortcut: '⌘,', run: () => setSettingsOpen(true) },
      { id: 'theme-light',  label: 'Theme: Light',  group: 'Actions', run: () => setTheme('light') },
      { id: 'theme-dark',   label: 'Theme: Dark',   group: 'Actions', run: () => setTheme('dark') },
      { id: 'theme-system', label: 'Theme: System', group: 'Actions', shortcut: '⌘⇧T', run: () => setTheme('system') },
    );
    // Surface "Abort" in the palette only while an op is actually paused.
    if (meta?.operation) {
      base.push({
        id: 'abort-op',
        label: `Abort ${meta.operation}`,
        group: 'Actions',
        run: () => {
          void (async () => {
            try {
              await abortOperation();
              showToast('Operation aborted');
            } catch (e) {
              showToast(`Abort failed: ${errMessage(e)}`);
            }
          })();
        },
      });
    }
    const recentActions: PaletteAction[] = recents.map((r) => ({
      id: `recent:${r.path}`,
      label: r.name,
      group: 'Recent',
      keywords: r.path,
      meta: r.path,
      icon: 'history',
      run: () => { void openByPath(r.path); },
    }));
    return [...base, ...repoActions, ...recentActions];
  }, [setView, selectFile, onSync, openViaDialog, openByPath, setTheme, recents,
      pushAllTags, onNetProgress, showToast, meta, abortOperation, repoActions]);

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

        {opProgress && (
          <ProgressPopup
            title={opProgress.title}
            subject={opProgress.subject}
            detail={opProgress.detail}
            percent={opProgress.percent}
            eta={opProgress.eta}
            startedAt={opProgress.startedAt}
            error={opProgress.error ?? null}
            onDismiss={() => setOpProgress((cur) => (cur && cur.id === opProgress.id ? null : cur))}
          />
        )}

        <UndoToast />
      </div>

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {cloneOpen && (
        <CloneDialog onClose={() => setCloneOpen(false)} onStartClone={runClone} />
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
      onToast(`Abort failed: ${errMessage(e)}`);
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
  const refreshSubmodules = useRepo((s) => s.refreshSubmodules);
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
      await Promise.all([
        refreshLocalChanges(), refreshLog(), refreshMeta(), refreshRefs(), refreshSubmodules(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [activePath, refreshing, refreshLocalChanges, refreshLog, refreshMeta, refreshRefs, refreshSubmodules]);

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
