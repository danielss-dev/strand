import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { HistoryModeToggle } from './components/HistoryModeToggle';
import { Icon } from './components/Icon';
import { ProgressPopup, formatDuration } from './components/ProgressPopup';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Topbar } from './components/Topbar';
import { FONTS, useSettings } from './stores/settings';
import { useRepo } from './stores/repo';
import { pickRepoDirectory } from './lib/dialog';
import { errMessage, isCancelled, isTauri, tauri } from './lib/tauri';
import { useTheme } from './lib/theme';
import { CloneDialog } from './views/CloneDialog';
import { SettingsDialog } from './views/SettingsDialog';
import { StashDialog } from './views/StashDialog';
import { TagDialog } from './views/TagDialog';
import { MergeDialog } from './views/MergeDialog';
import { RebaseEditor } from './views/RebaseEditor';
import { Commits } from './views/Commits';
import { FileView } from './views/FileView';
import { LocalChanges } from './views/LocalChanges';
import { Reflog } from './views/Reflog';
import { Review } from './views/Review';
import { Worktrees } from './views/Worktrees';
import { WorktreeDialog } from './views/WorktreeDialog';
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

  // Repo data the command palette indexes (branches / files / commits).
  const refs = useRepo((s) => s.refs);
  const commits = useRepo((s) => s.commits);
  const workTree = useRepo((s) => s.workTree);
  const refreshTree = useRepo((s) => s.refreshTree);
  const checkout = useRepo((s) => s.checkout);
  const createBranch = useRepo((s) => s.createBranch);
  const revealInGraph = useRepo((s) => s.revealInGraph);
  const requestCommitSearch = useRepo((s) => s.requestCommitSearch);
  const selectCommit = useRepo((s) => s.selectCommit);

  const fetchRepo = useRepo((s) => s.fetch);
  const pullRepo = useRepo((s) => s.pull);
  const pushRepo = useRepo((s) => s.push);
  const pushAllTags = useRepo((s) => s.pushAllTags);
  const abortOperation = useRepo((s) => s.abortOperation);
  const stashes = useRepo((s) => s.stashes);
  const submodules = useRepo((s) => s.submodules);
  const stashApply = useRepo((s) => s.stashApply);
  const stashPop = useRepo((s) => s.stashPop);
  const submoduleUpdate = useRepo((s) => s.submoduleUpdate);
  const baseline = useRepo((s) => s.baseline);
  const setBaseline = useRepo((s) => s.setBaseline);
  const clearBaseline = useRepo((s) => s.clearBaseline);
  const stageReviewed = useRepo((s) => s.stageReviewed);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  // null = closed; otherwise the flavour the dialog opens in (snapshot vs stash).
  const [stashDialog, setStashDialog] = useState<{ snapshot: boolean } | null>(null);
  // null = closed; otherwise the tag target (revspec, null ⇒ HEAD) + its label.
  const [tagDialog, setTagDialog] = useState<{ target: string | null; label: string } | null>(null);
  // null = closed; otherwise the branch to merge (`source`) into the current (`into`).
  const [mergeDialog, setMergeDialog] = useState<{ source: string; into: string } | null>(null);
  // null = closed; otherwise the interactive-rebase base (revspec before the
  // first editable commit, null ⇒ root) + a short label for the blurb.
  const [rebaseDialog, setRebaseDialog] = useState<{ base: string | null; label: string } | null>(null);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
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
  // Cancellable-op id for the in-flight fetch/pull/push (the pill's ✕).
  const [netOpId, setNetOpId] = useState<string | null>(null);
  const opIdSeq = useRef(0);
  const nextOpId = useCallback(() => `op-${Date.now()}-${++opIdSeq.current}`, []);
  // Persistent clone/open progress popup — stays until the op completes.
  const [opProgress, setOpProgress] = useState<OpProgress | null>(null);
  // Cancellable-op id for the in-flight clone (the popup's Cancel button).
  const [cloneCancelId, setCloneCancelId] = useState<string | null>(null);
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
    const cancelId = nextOpId();
    setCloneCancelId(cancelId);
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
      }, cancelId);
      clonedPath = res.path;
    } catch (e) {
      setCloneCancelId(null);
      // A user cancel just clears the popup; a real failure surfaces in the
      // popup itself (persistent + dismissible) so a clone that dies isn't a
      // popup that just vanishes with a fleeting toast.
      if (isCancelled(e)) {
        setOpProgress((cur) => (cur && cur.id === id ? null : cur));
        showToast('Clone cancelled');
        return;
      }
      const msg = errMessage(e);
      setOpProgress((cur) => (cur && cur.id === id ? { ...cur, error: msg, percent: null, eta: null } : cur));
      return;
    }
    setCloneCancelId(null);
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
  }, [openRepo, showToast, nextOpId]);

  const openViaDialog = useCallback(async () => {
    const path = await pickRepoDirectory();
    if (path) await openByPath(path);
  }, [openByPath]);

  const onSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setNetProgress('Fetching…');
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await fetchRepo(onNetProgress, opId);
      flashDone(setSyncDone);
    } catch (e) {
      if (isCancelled(e)) showToast('Fetch cancelled');
      else showToast(`Fetch failed: ${errMessage(e)}`);
    } finally {
      setSyncing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [fetchRepo, onNetProgress, showToast, flashDone, syncing, nextOpId]);

  const onPull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    setNetProgress('Pulling…');
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await pullRepo(false, onNetProgress, opId);
      flashDone(setPullDone);
    } catch (e) {
      if (isCancelled(e)) showToast('Pull cancelled');
      else showToast(`Pull failed: ${errMessage(e)}`);
    } finally {
      setPulling(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [pullRepo, onNetProgress, showToast, flashDone, pulling, nextOpId]);

  const onPush = useCallback(async () => {
    if (pushing) return;
    setPushing(true);
    setNetProgress('Pushing…');
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await pushRepo(false, onNetProgress, opId);
      flashDone(setPushDone);
    } catch (e) {
      if (isCancelled(e)) showToast('Push cancelled');
      else showToast(`Push failed: ${errMessage(e)}`);
    } finally {
      setPushing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [pushRepo, onNetProgress, showToast, flashDone, pushing, nextOpId]);

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

  // Primary freshness signal: the Rust file watcher. It debounces write
  // bursts and emits `repo://changed` with the repo path — exactly what an
  // AI agent editing files in a terminal produces. The store ignores events
  // for non-active tabs.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<string>('repo://changed', (event) => {
      void useRepo.getState().handleExternalChange(event.payload);
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  // Fallback freshness signal: refresh when the user returns to the app, in
  // case the watcher missed something (network drives, watcher start
  // failure). refreshLocalChanges is snapshot-based, so meta/refs/submodules
  // ride along. A small debounce avoids a double-fetch when focus and
  // visibilitychange fire together.
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
    };
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refreshLocalChanges, refreshLog]);

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
      } else if (mod && e.key === '3') {
        e.preventDefault(); setView('reflog'); selectFile(null);
      } else if (mod && e.key === '4') {
        e.preventDefault(); setView('review'); selectFile(null);
      } else if (mod && e.key === '5') {
        e.preventDefault(); setView('worktrees'); selectFile(null);
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

    // Stashes — apply (keep on stack) or pop. Same ops as the sidebar rows.
    for (const st of stashes) {
      out.push({
        id: `stash-apply:${st.oid}`,
        label: `Apply stash: ${st.message}`,
        group: 'Stashes',
        keywords: `stash apply ${st.branch ?? ''}`,
        meta: `stash@{${st.index}}`,
        run: () => {
          void stashApply(st.index).catch((e) => showToast(`Apply failed: ${errMessage(e)}`));
        },
      });
      out.push({
        id: `stash-pop:${st.oid}`,
        label: `Pop stash: ${st.message}`,
        group: 'Stashes',
        keywords: `stash pop ${st.branch ?? ''}`,
        meta: `stash@{${st.index}}`,
        run: () => {
          void stashPop(st.index).catch((e) => showToast(`Pop failed: ${errMessage(e)}`));
        },
      });
    }

    // Submodules — recursive init + update, same as the sidebar action.
    for (const sm of submodules) {
      out.push({
        id: `submodule:${sm.path}`,
        label: `Update submodule: ${sm.name}`,
        group: 'Actions',
        keywords: `submodule init update ${sm.path}`,
        meta: sm.status,
        run: () => {
          void submoduleUpdate([sm.path], true, true).catch((e) =>
            showToast(`Submodule update failed: ${errMessage(e)}`));
        },
      });
    }

    return out;
  }, [paletteOpen, meta, refs, workTree, commits, stashes, submodules, checkout,
      createBranch, revealInGraph, selectCommit, selectFile, showToast,
      stashApply, stashPop, submoduleUpdate]);

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
        { id: 'reflog',  label: 'Show: Reflog',       group: 'Actions', shortcut: '⌘3', keywords: 'history head recover lost orphan', run: () => { setView('reflog'); selectFile(null); } },
        { id: 'review-view', label: 'Show: Review', group: 'Actions', shortcut: '⌘4', keywords: 'ai agent review session changes verdict', run: () => { setView('review'); selectFile(null); } },
        { id: 'worktrees', label: 'Show: Worktrees',  group: 'Actions', shortcut: '⌘5', keywords: 'worktree agent feature checkout overview', run: () => { setView('worktrees'); selectFile(null); } },
        { id: 'worktree-new', label: 'New worktree…', group: 'Actions', keywords: 'worktree add branch checkout agent', run: () => setWorktreeOpen(true) },
        { id: 'search-commits', label: 'Search commits…', group: 'Actions', shortcut: '/', keywords: 'find filter grep message author hash', run: () => { requestCommitSearch(); } },
        { id: 'review-baseline', label: baseline ? `Review: move baseline to HEAD (now at ${baseline.short})` : 'Review: pin baseline at HEAD', group: 'Actions', keywords: 'ai agent session since diff review baseline', run: () => {
          void setBaseline().then(() => { setView('review'); selectFile(null); })
            .catch((e) => showToast(`Set baseline failed: ${errMessage(e)}`));
        } },
        ...(baseline ? [{ id: 'review-clear', label: 'Review: clear baseline', group: 'Actions', keywords: 'ai agent session review baseline', run: () => { void clearBaseline(); } } satisfies PaletteAction] : []),
        { id: 'review-stage', label: 'Review: stage reviewed files', group: 'Actions', keywords: 'accept reviewed stage bulk', run: () => {
          void stageReviewed().catch((e) => showToast(`Stage reviewed failed: ${errMessage(e)}`));
        } },
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
        { id: 'rebase-i', label: 'Interactive rebase…', group: 'Actions', keywords: 'rebase reorder squash fixup reword drop history edit', run: () => {
          const st = useRepo.getState();
          const c = st.selectedCommit ? st.commits.find((x) => x.hash === st.selectedCommit) : null;
          if (!c) { showToast('Select a commit in the graph first'); return; }
          setRebaseDialog({ base: c.parents.length ? `${c.hash}^` : null, label: c.short_hash });
        } },
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
      pushAllTags, onNetProgress, showToast, meta, abortOperation, requestCommitSearch,
      repoActions, setRebaseDialog, baseline, setBaseline, clearBaseline, stageReviewed]);

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
                onCreateWorktree={() => setWorktreeOpen(true)}
                onMerge={(source, into) => setMergeDialog({ source, into })}
                onInteractiveRebase={(base, label) => setRebaseDialog({ base, label })}
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
                  {view === 'review' && <Review />}
                  {view === 'reflog' && <Reflog />}
                  {view === 'worktrees' && (
                    <Worktrees onCreateWorktree={() => setWorktreeOpen(true)} onToast={showToast} />
                  )}
                  {(view === 'commits' || view === 'branch') && (
                    <Commits
                      onCreateTag={(target, label) => setTagDialog({ target, label })}
                      onInteractiveRebase={(base, label) => setRebaseDialog({ base, label })}
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
          <div className="toast progress" aria-hidden={netOpId ? undefined : 'true'}>
            <span aria-hidden="true" className="icon-spin"><Icon name="refresh" size={13} /></span>
            <span aria-hidden="true">{netProgress}</span>
            {netOpId && (
              <button
                type="button"
                className="toast-action"
                aria-label="Cancel network operation"
                onClick={() => { void tauri.repoCancelOp(netOpId); }}
              >
                Cancel
              </button>
            )}
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
            onCancel={
              opProgress.kind === 'clone' && !opProgress.error && cloneCancelId
                ? () => { void tauri.repoCancelOp(cloneCancelId); }
                : undefined
            }
          />
        )}

        <UndoToast />
        <BulkUndoToast onToast={showToast} />
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

      {rebaseDialog && (
        <RebaseEditor
          base={rebaseDialog.base}
          label={rebaseDialog.label}
          onClose={() => setRebaseDialog(null)}
          onToast={showToast}
        />
      )}

      {worktreeOpen && <WorktreeDialog onClose={() => setWorktreeOpen(false)} />}

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

/**
 * Undo affordance for a bulk (multi-file) discard. The store stashed a
 * safety snapshot just before discarding; Restore applies it back. A longer
 * window than the single-hunk toast — a 30-file discard deserves more than
 * six seconds of regret. The snapshot also stays on the stash stack after
 * the toast expires, so even a missed window is recoverable by hand.
 */
const BULK_UNDO_WINDOW_MS = 15000;

function BulkUndoToast({ onToast }: { onToast: (msg: string) => void }) {
  const lastBulkDiscard = useRepo((s) => s.lastBulkDiscard);
  const undoBulkDiscard = useRepo((s) => s.undoBulkDiscard);
  const clearBulkUndo = useRepo((s) => s.clearBulkUndo);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lastBulkDiscard) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      clearBulkUndo();
    }, BULK_UNDO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [lastBulkDiscard, clearBulkUndo]);

  if (!visible || !lastBulkDiscard) return null;

  const restore = async () => {
    try {
      await undoBulkDiscard();
      onToast('Changes restored from safety snapshot');
    } catch (e) {
      onToast(`Restore failed: ${errMessage(e)}`);
    }
  };

  return (
    <div className="toast undo">
      <span style={{ color: 'var(--text-2)' }}><Icon name="trash" size={13} /></span>
      <span>Discarded {lastBulkDiscard.count} files (snapshot saved)</span>
      <button type="button" className="toast-action" onClick={() => void restore()}>
        Restore
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
 * is paused (typically on a conflict). Offers **Continue** (resume once the
 * conflicts are resolved in Local Changes — `git … --continue`, which is the
 * only way a paused rebase advances; committing doesn't) and **Abort** (restore
 * the pre-op state). Continue is disabled while any conflict remains. The op
 * clears `operation` on the next refresh, which hides the banner.
 */
function OpBanner({ onToast }: { onToast: (msg: string) => void }) {
  const operation = useRepo((s) => s.meta?.operation ?? null);
  const status = useRepo((s) => s.status);
  const abortOperation = useRepo((s) => s.abortOperation);
  const continueOperation = useRepo((s) => s.continueOperation);
  const [busy, setBusy] = useState<null | 'continue' | 'abort'>(null);

  const hasConflicts = useMemo(() => status.some((s) => s.kind === 'CONFLICTED'), [status]);

  if (!operation) return null;

  const onAbort = async () => {
    if (busy) return;
    setBusy('abort');
    try {
      await abortOperation();
      onToast('Operation aborted');
    } catch (e) {
      onToast(`Abort failed: ${errMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onContinue = async () => {
    if (busy) return;
    setBusy('continue');
    try {
      const stillConflicted = await continueOperation();
      onToast(
        stillConflicted
          ? 'Paused again on conflicts — resolve them in Local Changes'
          : `${OP_LABEL[operation].replace(' in progress', '')} complete`,
      );
    } catch (e) {
      onToast(`Continue failed: ${errMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="op-banner" role="status">
      <Icon name="rebase" size={13} />
      <span className="op-label">{OP_LABEL[operation]}</span>
      <span className="op-hint">
        {hasConflicts
          ? 'Resolve the conflicts in Local Changes, then'
          : 'Conflicts resolved —'}
      </span>
      <button
        type="button"
        className="btn op-continue"
        disabled={busy !== null || hasConflicts}
        title={hasConflicts ? 'Resolve all conflicts first' : undefined}
        onClick={() => void onContinue()}
      >
        {busy === 'continue' ? 'Continuing…' : 'Continue'}
      </button>
      <button
        type="button"
        className="btn ghost op-abort"
        disabled={busy !== null}
        onClick={() => void onAbort()}
      >
        {busy === 'abort' ? 'Aborting…' : 'Abort'}
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
      // refreshLocalChanges is snapshot-based — meta/refs/tree/submodules
      // come along with status + diffs in one walk.
      await Promise.all([refreshLocalChanges(), refreshLog()]);
    } finally {
      setRefreshing(false);
    }
  }, [activePath, refreshing, refreshLocalChanges, refreshLog]);

  const reflog = useRepo((s) => s.reflog);
  const worktrees = useRepo((s) => s.worktrees);
  const baseline = useRepo((s) => s.baseline);
  const baselineDiffs = useRepo((s) => s.baselineDiffs);
  const unstagedCount = useRepo((s) => s.unstagedDiffs.length);
  const title = view === 'local' ? 'Local Changes'
    : view === 'commits' ? 'All Commits'
    : view === 'reflog' ? 'Reflog'
    : view === 'review' ? 'Review'
    : view === 'worktrees' ? 'Worktrees'
    : view === 'branch' ? 'Branch'
    : '';
  const sub = view === 'local'
    ? `${meta?.branch ?? '—'} · ${status.length} files with changes`
    : view === 'commits'
      ? `${commits.length} commits across all branches`
      : view === 'reflog'
        ? `${reflog.length} HEAD movements`
        : view === 'review'
          ? baseline
            ? `${baselineDiffs.length} files since ${baseline.short}`
            : `${unstagedCount} unstaged files`
          : view === 'worktrees'
            ? `${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`
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
        {(view === 'commits' || view === 'reflog') && <HistoryModeToggle />}
        {(view === 'local' || view === 'review') && (
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
          </>
        )}
        {view === 'local' && (
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
