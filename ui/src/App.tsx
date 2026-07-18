import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { HistoryModeToggle } from './components/HistoryModeToggle';
import { ReviewModeToggle } from './components/ReviewModeToggle';
import { Icon } from './components/Icon';
import { copyToClipboard } from './components/PierreTree';
import { Presence } from './components/Presence';
import { ProgressPopup, formatDuration } from './components/ProgressPopup';
import { PullRequestMonitor } from './components/PullRequestMonitor';
import { RepoRail } from './components/RepoRail';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Topbar } from './components/Topbar';
import { FONTS, useSettings } from './stores/settings';
import { usePullRequests } from './stores/pullRequests';
import { useRepo } from './stores/repo';
import { useRepoIcons } from './stores/repoIcons';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from './stores/workspaces';
import { useWorkspaceReview } from './stores/workspaceReview';
import { useUpdates } from './stores/updates';
import { accentHueForColor, groupTabs, pathKey, repoFamilyName, workspaceMemberSet } from './lib/repoIdentity';
import { buildCrashIssueUrl } from './lib/crashReport';
import { pickCodeWorkspaceFile, pickRepoDirectories } from './lib/dialog';
import { editorTemplate, osType, terminalTemplate } from './lib/integrations';
import { t } from './lib/i18n';
import { concatPatches, patchesToMarkdown } from './lib/patchExport';
import { buildReviewFeedback, collectFeedbackFiles } from './lib/reviewExport';
import { appMenuInstalled, installAppMenu, type MenuHandlers } from './lib/menu';
import {
  EDITABLE_SELECTOR,
  eventInside,
  eventToBinding,
  formatBinding,
  isPlainKey,
  MENU_COMMANDS,
  REPO_COMMANDS,
  resolveBindings,
  toMudaAccelerator,
  type CommandId,
} from './lib/keys';
import { errMessage, isCancelled, isTauri, tauri } from './lib/tauri';
import { useTheme } from './lib/theme';
import { CloneDialog } from './views/CloneDialog';
import { InitRepoDialog, type InitRepoRequest } from './views/InitRepoDialog';
import { SettingsDialog, type SettingsSectionId } from './views/SettingsDialog';
import { StashDialog } from './views/StashDialog';
import { BranchDialog } from './views/BranchDialog';
import { BranchCleanupDialog } from './views/BranchCleanupDialog';
import { TagDialog } from './views/TagDialog';
import { MergeDialog } from './views/MergeDialog';
import { RebaseEditor } from './views/RebaseEditor';
import { RemoteDialog, type RemoteDialogMode } from './views/RemoteDialog';
import { MaintenanceDialog } from './views/MaintenanceDialog';
import { FileEntryDialog } from './views/FileEntryDialog';
import { RenameBranchDialog } from './views/RenameBranchDialog';
import { ResetDialog } from './views/ResetDialog';
import { IgnoreDialog } from './views/IgnoreDialog';
import { RepoIconDialog } from './views/RepoIconDialog';
import { WorkspaceManagerDialog } from './views/WorkspaceManagerDialog';
import { Commits } from './views/Commits';
import { FileView } from './views/FileView';
import { LocalChanges } from './views/LocalChanges';
import { Reflog } from './views/Reflog';
import { Review } from './views/Review';
import { PullRequests } from './views/PullRequests';
import { WorkspaceReview } from './views/WorkspaceReview';
import { Worktrees } from './views/Worktrees';
import { WorktreeDialog, type WorktreeDialogStart } from './views/WorktreeDialog';
import { WorktreeMergeDialog } from './views/WorktreeMergeDialog';
import { ForcePushDialog } from './views/ForcePushDialog';
import { BranchNetworkDialog, type BranchNetworkDialogMode } from './views/BranchNetworkDialog';
import { CommandPalette, type PaletteAction } from './views/Palette';
import { RepoSwitcher } from './views/RepoSwitcher';
import type {
  CrashCheck,
  BranchPushRequest,
  FileDiff,
  Progress,
  PullMode,
  PushMode,
  RepoMeta,
  RemoteBranch,
  StatusKind,
  Worktree,
  WorktreeHealth,
} from './lib/types';

const waitForPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Whole-UI zoom bounds + step for the browser-style Ctrl/⌘ +/− shortcuts.
 *  Ctrl+= / Ctrl++ zoom in, Ctrl+- out, Ctrl+0 resets to 100%. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
/** Clamp to range and snap to one-decimal steps (avoids float drift like 0.7000001). */
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

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
  const zoom = useSettings((s) => s.zoom);
  const platform = useSettings((s) => s.platform);
  const repoNav = useSettings((s) => s.repoNav);
  const uiFont = useSettings((s) => s.uiFont);
  const monoFont = useSettings((s) => s.monoFont);
  const diffFont = useSettings((s) => s.diffFont);
  const accent = useSettings((s) => s.accent);
  const keybindings = useSettings((s) => s.keybindings);
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
  const refreshRecents = useRepo((s) => s.refreshRecents);
  const restoreSession = useRepo((s) => s.restoreSession);
  const refreshLocalChanges = useRepo((s) => s.refreshLocalChanges);
  const refreshLog = useRepo((s) => s.refreshLog);

  // Active repo group + custom icon colors, for re-theming the accent to the
  // selected repo's color (see the --accent-h effect below).
  const tabs = useRepo((s) => s.tabs);
  const activeTabPath = useRepo((s) => s.activeTabPath);
  const repoIcons = useRepoIcons((s) => s.icons);

  // Repo data the command palette indexes (branches / files / commits).
  const refs = useRepo((s) => s.refs);
  const commits = useRepo((s) => s.commits);
  const workTree = useRepo((s) => s.workTree);
  const refreshTree = useRepo((s) => s.refreshTree);
  const checkout = useRepo((s) => s.checkout);
  const createBranch = useRepo((s) => s.createBranch);
  const revealInGraph = useRepo((s) => s.revealInGraph);
  const requestCommitSearch = useRepo((s) => s.requestCommitSearch);
  const requestDiffSearch = useRepo((s) => s.requestDiffSearch);
  const requestSuggestCommitMessage = useRepo((s) => s.requestSuggestCommitMessage);
  const requestSelectSinceBaseline = useRepo((s) => s.requestSelectSinceBaseline);
  const selectCommit = useRepo((s) => s.selectCommit);

  const fetchRepo = useRepo((s) => s.fetch);
  const pullRepo = useRepo((s) => s.pull);
  const pushRepo = useRepo((s) => s.push);
  const fetchBranch = useRepo((s) => s.fetchBranch);
  const pullBranch = useRepo((s) => s.pullBranch);
  const pushBranch = useRepo((s) => s.pushBranch);
  const pullMode = useRepo((s) => s.pullMode);
  const setPullMode = useRepo((s) => s.setPullMode);
  const fetchPrune = useRepo((s) => s.fetchPrune);
  const setFetchPrune = useRepo((s) => s.setFetchPrune);
  const pullAutostash = useRepo((s) => s.pullAutostash);
  const setPullAutostash = useRepo((s) => s.setPullAutostash);
  const pushAllTags = useRepo((s) => s.pushAllTags);
  const abortOperation = useRepo((s) => s.abortOperation);
  const stashes = useRepo((s) => s.stashes);
  const submodules = useRepo((s) => s.submodules);
  const stashApply = useRepo((s) => s.stashApply);
  const stashPop = useRepo((s) => s.stashPop);
  const submoduleUpdate = useRepo((s) => s.submoduleUpdate);
  const pruneWorktrees = useRepo((s) => s.pruneWorktrees);
  const baseline = useRepo((s) => s.baseline);
  const setBaseline = useRepo((s) => s.setBaseline);
  const clearBaseline = useRepo((s) => s.clearBaseline);
  const stageReviewed = useRepo((s) => s.stageReviewed);
  const clearReviewNotes = useRepo((s) => s.clearReviewNotes);
  // Count-only selector (like the diff counts below): gates the feedback
  // actions without re-rendering App on unrelated store churn.
  const reviewNoteCount = useRepo((s) =>
    Object.values(s.reviewNotes).reduce((n, list) => n + list.length, 0));
  const resetTo = useRepo((s) => s.reset);
  // Length-only selectors: they gate the "Copy … diff" palette actions without
  // re-rendering App on every diff-content refresh (the actions read the
  // actual diffs from the store at run time).
  const unstagedCount = useRepo((s) => s.unstagedDiffs.length);
  const stagedCount = useRepo((s) => s.stagedDiffs.length);
  const baselineDiffCount = useRepo((s) => s.baselineDiffs.length);
  // Workspace list + active id feed the palette's Workspaces group — a
  // handful of user-created entries, so subscribing whole is cheap.
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaces((s) => s.activeWorkspaceId);
  const activePullRequestKey = usePullRequests((s) => s.active?.key ?? null);
  const activePullRequestFollowed = usePullRequests((s) =>
    activePullRequestKey ? Boolean(s.followed[activePullRequestKey]) : false);
  const activePullRequestCanUpdateBranch = usePullRequests((s) =>
    s.active?.repository.provider === 'git_hub'
      && ['open', 'active'].includes(s.active.pr.state.toLowerCase()));
  const toggleActivePullRequest = usePullRequests((s) => s.toggleActive);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [repoSwitcherOpen, setRepoSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('appearance');
  const [cloneOpen, setCloneOpen] = useState(false);
  const [initRepoOpen, setInitRepoOpen] = useState(false);
  // null = closed; otherwise the flavour the dialog opens in (snapshot vs stash).
  const [stashDialog, setStashDialog] = useState<{ snapshot: boolean; keepIndex: boolean } | null>(null);
  const stashDialogRequest = useRepo((s) => s.stashDialogRequest);
  const clearStashDialogRequest = useRepo((s) => s.clearStashDialogRequest);
  // null = closed; otherwise the tag target (revspec, null ⇒ HEAD) + its label.
  const [tagDialog, setTagDialog] = useState<{ target: string | null; label: string } | null>(null);
  const [branchDialog, setBranchDialog] = useState<{
    start: string | null;
    label: string;
    stashIndex?: number;
  } | null>(null);
  const [branchCleanupOpen, setBranchCleanupOpen] = useState(false);
  // null = closed; otherwise which remote-management flavour (add/rename/url).
  const [remoteDialog, setRemoteDialog] = useState<RemoteDialogMode | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [fileEntryDialog, setFileEntryDialog] = useState<{ dir: string; directory: boolean } | null>(null);
  // null = closed; otherwise the branch to rename.
  const [renameBranchDialog, setRenameBranchDialog] = useState<{ name: string } | null>(null);
  const [branchNetworkDialog, setBranchNetworkDialog] = useState<BranchNetworkDialogMode | null>(null);
  // null = closed; otherwise the branch to merge (`source`) into the current (`into`).
  const [mergeDialog, setMergeDialog] = useState<{ source: string; into: string } | null>(null);
  // null = closed; otherwise the interactive-rebase base (revspec before the
  // first editable commit, null ⇒ root) + a short label for the blurb.
  const [rebaseDialog, setRebaseDialog] = useState<{ base: string | null; label: string } | null>(null);
  // null = closed; otherwise the commit-ish to reset to + its human label.
  const [resetDialog, setResetDialog] = useState<{ target: string; label: string } | null>(null);
  // The "Add ignore pattern…" dialog is opened from two surfaces (Local Changes
  // + the Files tab), so its draft lives in the store; App renders the one modal.
  const ignoreDraft = useRepo((s) => s.ignoreDraft);
  const closeIgnoreDialog = useRepo((s) => s.closeIgnoreDialog);
  // null = closed; `start` pre-picks the new branch's start point when opened
  // from a branch/commit "New worktree from here" context menu.
  const [worktreeDialog, setWorktreeDialog] = useState<
    { start: WorktreeDialogStart | null } | null
  >(null);
  // "Merge & clean up" opened from a rail/tab-strip worktree context menu —
  // the same on-demand fetch the sidebar's worktree menu does.
  const [wtMergeDialog, setWtMergeDialog] = useState<{
    worktree: Worktree;
    health: WorktreeHealth;
    dirty: number;
  } | null>(null);
  // Registry entry for the worktree tab at `path`, listed from `anchorPath`
  // so `is_current` means "the active tab", matching the sidebar's list.
  const worktreeForTab = async (anchorPath: string, path: string): Promise<Worktree | null> => {
    const list = await tauri.repoWorktrees(anchorPath);
    return list.find((w) => pathKey(w.path) === pathKey(path)) ?? null;
  };
  // Rail/tab-strip "Review vs base" — the store's reviewWorktree flow
  // (detect base, open the worktree tab, pin the baseline).
  const reviewWorktreeTab = (path: string) => {
    void (async () => {
      try {
        const w = await worktreeForTab(path, path);
        if (!w || w.is_main) return;
        const name = w.branch ?? w.path.split('/').pop() ?? w.path;
        const { base, detectError } = await useRepo.getState().reviewWorktree(w);
        if (base) showToast(`Reviewing ${name} vs ${base}`);
        else if (detectError) showToast(`Can't detect base branch: ${detectError}`, 'error');
      } catch (e) {
        showToast(`Review failed: ${errMessage(e)}`, 'error');
      }
    })();
  };
  // Rail/tab-strip "Merge & clean up…". The dialog reads refs/worktrees from
  // the *active* repo, so when the target belongs to another family, focus a
  // member first — preferring the main checkout so cleanup (which can't
  // remove the current worktree) stays available.
  const mergeWorktreeTab = (path: string) => {
    void (async () => {
      try {
        const { tabs, meta, setActiveTab } = useRepo.getState();
        const tab = tabs.find((t) => pathKey(t.path) === pathKey(path));
        if (!tab) return;
        let anchor = meta && meta.common_dir === tab.meta.common_dir ? meta.path : null;
        if (!anchor) {
          const fam = tabs.filter((t) => t.meta.common_dir === tab.meta.common_dir);
          anchor = (fam.find((t) => !t.meta.is_linked_worktree) ?? tab).path;
          await setActiveTab(anchor);
        }
        const w = await worktreeForTab(anchor, path);
        if (!w || w.is_main) return;
        if (!w.branch) {
          showToast('A detached worktree has no branch to merge', 'error');
          return;
        }
        const [health, status] = await Promise.all([
          tauri.repoWorktreeHealth(w.path, w.branch),
          tauri.repoStatus(w.path),
        ]);
        setWtMergeDialog({ worktree: w, health, dirty: status.length });
      } catch (e) {
        showToast(`Can't load worktree state: ${errMessage(e)}`, 'error');
      }
    })();
  };
  // null = closed; otherwise the repo whose rail tile is being customized.
  const [iconDialog, setIconDialog] = useState<{ path: string; name: string } | null>(null);
  // false = closed; 'create' opens the manager mid-create (palette "New
  // workspace…") — the dialog spawns a workspace and focuses its name field.
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState<boolean | 'create'>(false);
  const [syncing, setSyncing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [forcePushOpen, setForcePushOpen] = useState(false);
  // Brief "done" pulses: after a sync op succeeds the button flashes a
  // check instead of raising a toast. Cleared after the pulse animation.
  const [syncDone, setSyncDone] = useState(false);
  const [pullDone, setPullDone] = useState(false);
  const [pushDone, setPushDone] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  // Unacknowledged crash from a previous run (Settings → Privacy, opt-in).
  // Non-null renders the persistent CrashToast until reported or dismissed.
  const [crashReport, setCrashReport] = useState<CrashCheck | null>(null);
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

  // Errors linger longer — a failure that flashes by in 2s with a success
  // check reads as "nothing happened" (DAN-12). The timer is tracked so a
  // quick success right before an error can't cut the error's time short.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((msg: string, kind: 'success' | 'error' = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, kind });
    toastTimer.current = setTimeout(() => setToast(null), kind === 'error' ? 4500 : 2200);
  }, []);
  // The window keydown handler is attached once (empty deps); it reaches the
  // latest showToast through this ref instead of re-subscribing.
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const openSettingsAt = useCallback((section: SettingsSectionId) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  // Launch the configured terminal / editor (Settings → Integrations) on the
  // active repo. Unconfigured routes to Settings instead of silently no-oping.
  const openInTerminal = useCallback(() => {
    const path = useRepo.getState().activePath;
    if (!path) return;
    const template = terminalTemplate(useSettings.getState().terminalTool);
    if (!template) {
      showToast('Choose a terminal in Settings → Integrations');
      openSettingsAt('integrations');
      return;
    }
    tauri.repoOpenInTerminal(path, template)
      .catch((e) => showToast(`Open terminal failed: ${errMessage(e)}`, 'error'));
  }, [showToast, openSettingsAt]);

  const openEditorTarget = useCallback((path: string, file: string | null) => {
    const template = editorTemplate(useSettings.getState().editorTool);
    if (!template) {
      showToast('Choose an editor in Settings → Integrations');
      openSettingsAt('integrations');
      return;
    }
    tauri.repoOpenInEditor(path, file, null, template)
      .catch((e) => showToast(`Open editor failed: ${errMessage(e)}`, 'error'));
  }, [showToast, openSettingsAt]);

  const openActiveFileInEditor = useCallback((file: string) => {
    const path = useRepo.getState().activePath;
    if (path) openEditorTarget(path, file);
  }, [openEditorTarget]);

  const openInEditor = useCallback(() => {
    const path = useRepo.getState().activePath;
    if (!path) return;
    // With no file selected the repo directory opens instead.
    openEditorTarget(path, useRepo.getState().selectedFile);
  }, [openEditorTarget]);

  // Copy a diff list to the clipboard (raw patch or Markdown) and confirm
  // with a file count — powers the palette's "Copy … diff" actions.
  const copyDiffs = useCallback(
    (diffs: FileDiff[], markdown: boolean, title?: string) => {
      copyToClipboard(markdown ? patchesToMarkdown(diffs, { title }) : concatPatches(diffs));
      const n = diffs.filter((d) => d.patch.length > 0).length;
      showToast(`Copied diff — ${n} file${n === 1 ? '' : 's'}`);
    },
    [showToast],
  );

  // Flash a button's check pulse for ~1.6s. The duration outlasts the
  // pop-in animation so the check lingers briefly before reverting.
  const flashDone = useCallback((set: (v: boolean) => void) => {
    set(true);
    setTimeout(() => set(false), 1600);
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
      // Workspace-aware open: the repo also joins the active workspace, even
      // when it was already open but hidden under another one.
      await useWorkspaces.getState().openRepoInActive(path);
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
      else showToast(`Open failed: ${msg}`, 'error');
    }
  }, [showToast]);

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
      await useWorkspaces.getState().openRepoInActive(clonedPath);
      setOpProgress((cur) => (cur && cur.id === id ? null : cur));
    } catch (e) {
      const msg = errMessage(e);
      setOpProgress((cur) => (cur && cur.id === id ? { ...cur, error: msg } : cur));
    }
  }, [showToast, nextOpId]);

  const runInitRepo = useCallback(async (request: InitRepoRequest) => {
    const outcome = await tauri.repoInit(
      request.path,
      request.initialBranch,
      request.gitignore,
      request.createInitialCommit,
    );
    await useWorkspaces.getState().openRepoInActive(outcome.path);
    showToast(`Initialized ${basename(outcome.path)} on ${outcome.initial_branch}`);
  }, [showToast]);

  // Open a batch of repos as tabs, one after another. Sequential (not
  // parallel) so the shared active-tab state and the progress popup don't race
  // — same pattern as session restore. A folder that isn't a repo fails inside
  // openByPath (toast/error popup) without aborting the rest; the last one to
  // open successfully ends up active.
  const openMany = useCallback(async (paths: string[]) => {
    for (const p of paths) await openByPath(p);
  }, [openByPath]);

  const openViaDialog = useCallback(async () => {
    await openMany(await pickRepoDirectories());
  }, [openMany]);

  // Import a VS Code .code-workspace as a named workspace: pick the file,
  // let the store parse/validate it, then open the result. Folders that
  // aren't repos are reported in the toast, not fatal.
  const importCodeWorkspaceFlow = useCallback(async () => {
    const file = await pickCodeWorkspaceFile();
    if (!file) return;
    try {
      const r = await useWorkspaces.getState().importCodeWorkspace(file);
      await useWorkspaces.getState().openWorkspace(r.id);
      const skipped = r.skipped.length
        ? ` — ${r.skipped.length} folder${r.skipped.length === 1 ? '' : 's'} skipped (not a repository)`
        : '';
      showToast(`Imported “${r.name}” with ${r.added} repositor${r.added === 1 ? 'y' : 'ies'}${skipped}`);
    } catch (e) {
      showToast(`Import failed: ${errMessage(e)}`, 'error');
    }
  }, [showToast]);

  // Open the tile/tab icon-customization dialog for a repo. Shared by the repo
  // rail and the toolbar tab strip (whichever `repoNav` selects).
  const openIconDialog = useCallback((path: string) => {
    const tab = useRepo.getState().tabs.find((t) => t.path === path);
    setIconDialog({ path, name: tab ? repoFamilyName(tab.meta) : basename(path) });
  }, []);

  // Switch the active repository to the next (+1) / previous (-1) open one,
  // wrapping around. Cycles in on-screen order (worktrees grouped with their
  // repo) so it matches the rail/tab strip — which means only the active
  // workspace's visible repos; hidden tabs are skipped. A no-op with fewer
  // than two visible tabs. Drives ⌘/Ctrl+Tab and the palette's Next/Previous
  // repository actions, in both repo-nav layouts.
  const cycleTab = useCallback((delta: 1 | -1) => {
    const { tabs: open, activeTabPath: active, setActiveTab } = useRepo.getState();
    const wsState = useWorkspaces.getState();
    const ws = wsState.workspaces.find(
      (w) => w.id === (wsState.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID),
    );
    const members = ws ? workspaceMemberSet(open, new Set(ws.repoPaths)) : null;
    const visible = members ? open.filter((t) => members.has(t.path)) : open;
    if (visible.length < 2) return;
    const ordered = groupTabs(visible);
    const i = ordered.findIndex((t) => t.path === active);
    const base = i === -1 ? 0 : i;
    const next = ordered[(base + delta + ordered.length) % ordered.length];
    void setActiveTab(next.path);
  }, []);

  const onFetch = useCallback(async (prune?: boolean) => {
    if (syncing || pulling || pushing) return;
    setSyncing(true);
    setNetProgress('Fetching…');
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await fetchRepo(prune, undefined, opId);
      flashDone(setSyncDone);
    } catch (e) {
      if (isCancelled(e)) showToast('Fetch cancelled');
      else showToast(`Fetch failed: ${errMessage(e)}`, 'error');
    } finally {
      setSyncing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [fetchRepo, showToast, flashDone, syncing, pulling, pushing, nextOpId]);

  const onPull = useCallback(async (mode?: PullMode, autostash?: boolean) => {
    if (syncing || pulling || pushing) return;
    const effectiveMode = mode ?? pullMode;
    const effectiveAutostash = autostash ?? pullAutostash;
    const label = effectiveMode === 'rebase'
      ? 'Pull with rebase'
      : effectiveMode === 'fast-forward-only'
        ? 'Fast-forward-only pull'
        : effectiveMode === 'merge'
          ? 'Pull with merge'
          : 'Pull';
    setPulling(true);
    setNetProgress(`${label}${effectiveAutostash ? ' with autostash' : ''}…`);
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await pullRepo(effectiveMode, effectiveAutostash, undefined, opId);
      flashDone(setPullDone);
    } catch (e) {
      if (isCancelled(e)) showToast(`${label} cancelled`);
      else showToast(`${label} failed: ${errMessage(e)}`, 'error');
    } finally {
      setPulling(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [pullRepo, showToast, flashDone, syncing, pulling, pushing, pullAutostash, pullMode, nextOpId]);

  const onPush = useCallback(async (mode: PushMode = 'default') => {
    if (syncing || pulling || pushing) return;
    const label = mode === 'force-with-lease'
      ? 'Force push with lease'
      : mode === 'follow-tags'
        ? 'Push with annotated tags'
        : 'Push';
    setPushing(true);
    setNetProgress(`${label}…`);
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await pushRepo(mode, undefined, opId);
      flashDone(setPushDone);
    } catch (e) {
      if (isCancelled(e)) showToast(`${label} cancelled`);
      else showToast(`${label} failed: ${errMessage(e)}`, 'error');
    } finally {
      setPushing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [pushRepo, showToast, flashDone, syncing, pulling, pushing, nextOpId]);

  const onPushAllTags = useCallback(async () => {
    if (syncing || pulling || pushing) return;
    setPushing(true);
    setNetProgress('Pushing all tags…');
    await waitForPaint();
    try {
      await pushAllTags();
      flashDone(setPushDone);
    } catch (e) {
      showToast(`Push all tags failed: ${errMessage(e)}`, 'error');
    } finally {
      setPushing(false);
      setNetProgress(null);
    }
  }, [pushAllTags, showToast, flashDone, syncing, pulling, pushing]);

  const onFetchBranch = useCallback(async (remoteBranch: RemoteBranch) => {
    if (syncing || pulling || pushing) return;
    setSyncing(true);
    setNetProgress(`Fetching ${remoteBranch.name}…`);
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await fetchBranch(remoteBranch.remote, remoteBranch.branch, undefined, opId);
      flashDone(setSyncDone);
      showToast(`Fetched ${remoteBranch.name}`);
    } catch (caught) {
      if (isCancelled(caught)) showToast(`Fetch ${remoteBranch.name} cancelled`);
      else showToast(`Fetch ${remoteBranch.name} failed: ${errMessage(caught)}`, 'error');
    } finally {
      setSyncing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [fetchBranch, flashDone, nextOpId, pulling, pushing, showToast, syncing]);

  const onPullBranch = useCallback(async (remoteBranch: RemoteBranch, mode?: PullMode) => {
    if (syncing || pulling || pushing) return;
    const effectiveMode = mode ?? pullMode;
    setPulling(true);
    setNetProgress(`Pulling ${remoteBranch.name}…`);
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await pullBranch(
        remoteBranch.remote,
        remoteBranch.branch,
        effectiveMode,
        pullAutostash,
        undefined,
        opId,
      );
      flashDone(setPullDone);
      showToast(`Pulled ${remoteBranch.name} into the current branch`);
    } catch (caught) {
      if (isCancelled(caught)) showToast(`Pull ${remoteBranch.name} cancelled`);
      else showToast(`Pull ${remoteBranch.name} failed: ${errMessage(caught)}`, 'error');
    } finally {
      setPulling(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [flashDone, nextOpId, pullAutostash, pullBranch, pullMode, pulling, pushing, showToast, syncing]);

  const onPushBranch = useCallback(async (request: BranchPushRequest) => {
    if (syncing || pulling || pushing) return;
    setPushing(true);
    setNetProgress(`Pushing ${request.branch} to ${request.remote}/${request.remoteBranch}…`);
    const opId = nextOpId();
    setNetOpId(opId);
    await waitForPaint();
    try {
      await pushBranch(request, undefined, opId);
      flashDone(setPushDone);
      showToast(`Pushed ${request.branch} to ${request.remote}/${request.remoteBranch}`);
    } catch (caught) {
      if (isCancelled(caught)) showToast(`Push ${request.branch} cancelled`);
      else showToast(`Push ${request.branch} failed: ${errMessage(caught)}`, 'error');
    } finally {
      setPushing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [flashDone, nextOpId, pulling, pushBranch, pushing, showToast, syncing]);

  const onSync = useCallback(async () => {
    if (syncing || pulling || pushing) return;
    setSyncing(true);
    const opId = nextOpId();
    setNetOpId(opId);
    let phase = 'Fetch';
    try {
      setNetProgress('Sync: fetching…');
      await waitForPaint();
      await fetchRepo(fetchPrune, undefined, opId);
      phase = 'Pull';
      setNetProgress('Sync: pulling…');
      await pullRepo(pullMode, pullAutostash, undefined, opId);
      phase = 'Push';
      setNetProgress('Sync: pushing…');
      await pushRepo('default', undefined, opId);
      flashDone(setSyncDone);
      showToast('Sync complete');
    } catch (caught) {
      if (isCancelled(caught)) showToast(`Sync cancelled during ${phase.toLowerCase()}`);
      else showToast(`${phase} failed during sync: ${errMessage(caught)}`, 'error');
    } finally {
      setSyncing(false);
      setNetProgress(null);
      setNetOpId(null);
    }
  }, [fetchPrune, fetchRepo, flashDone, nextOpId, pullAutostash, pullMode, pullRepo, pulling, pushRepo, pushing, showToast, syncing]);

  // Keyboard refresh — same snapshot-based refresh the header button runs
  // (meta/refs/tree/submodules ride along with status), guarded on an open repo.
  const onRefresh = useCallback(() => {
    if (!useRepo.getState().activePath) return;
    void refreshLocalChanges();
    void refreshLog();
  }, [refreshLocalChanges, refreshLog]);

  useEffect(() => {
    if (!stashDialogRequest) return;
    setStashDialog(stashDialogRequest);
    clearStashDialogRequest();
  }, [stashDialogRequest, clearStashDialogRequest]);

  // Resolved keybindings: defaults from the registry overlaid with the user's
  // overrides. Drives the window keydown handler, the palette shortcut chips,
  // and the native-menu accelerators.
  const keyMap = useMemo(() => resolveBindings(keybindings), [keybindings]);
  /** Formatted binding for a command (e.g. "⌘P" / "Ctrl+P"), or undefined. */
  const keyHint = useCallback(
    (id: CommandId) => formatBinding(keyMap.byCommand.get(id) ?? null, platform) || undefined,
    [keyMap, platform],
  );

  // One handler per global command. Rebuilt each render so it closes over the
  // latest callbacks; the keydown effect reads it through a ref (below) so it
  // never has to re-subscribe.
  const commandHandlers = useMemo<Record<CommandId, () => void>>(() => ({
    'palette': () => setPaletteOpen((o) => !o),
    'open-repo': () => { void openViaDialog(); },
    'clone-repo': () => setCloneOpen(true),
    'settings': () => openSettingsAt('appearance'),
    'view-local': () => { setView('local'); selectFile(null); },
    'view-commits': () => { setView('commits'); selectFile(null); },
    'view-reflog': () => { setView('reflog'); selectFile(null); },
    'view-review': () => { setView('review'); selectFile(null); },
    'view-workspace-review': () => { setView('workspace-review'); selectFile(null); },
    'view-worktrees': () => { setView('worktrees'); selectFile(null); },
    'tab-next': () => cycleTab(1),
    'tab-prev': () => cycleTab(-1),
    'switch-repo': () => setRepoSwitcherOpen((o) => !o),
    'theme-toggle': () => {
      const next = cycleTheme();
      showToast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
    },
    'fetch': () => { void onFetch(); },
    'pull': () => { void onPull(); },
    'push': () => { void onPush(); },
    'sync': () => { void onSync(); },
    'open-editor': openInEditor,
    'open-terminal': openInTerminal,
    'refresh': onRefresh,
    'suggest-commit': () => { requestSuggestCommitMessage(); },
  }), [openViaDialog, openSettingsAt, setView, selectFile, cycleTheme, showToast,
       onFetch, onSync, onPull, onPush, openInEditor, openInTerminal, onRefresh, cycleTab,
       requestSuggestCommitMessage]);
  const commandHandlersRef = useRef(commandHandlers);
  commandHandlersRef.current = commandHandlers;
  const keyMapRef = useRef(keyMap);
  keyMapRef.current = keyMap;

  // Load recents, then the saved workspaces, then restore last session's tabs,
  // then run the workspace post-restore init (adopt unclaimed repos into
  // Default + install the focus reconciler). The order matters: init must run
  // after `load` (the Default entry exists) and after `restoreSession` (the
  // tabs are open). Each step is idempotent, so StrictMode's double-invoke is
  // harmless.
  useEffect(() => {
    void refreshRecents();
    void (async () => {
      await useWorkspaces.getState().load();
      try {
        await restoreSession();
      } finally {
        useWorkspaces.getState().initAfterRestore();
      }
    })();
  }, [refreshRecents, restoreSession]);

  // Native macOS menubar. Menu item actions read the latest callbacks
  // through this ref, so the menu itself only rebuilds when the repo-scoped
  // items' enabled state flips (repo opened/closed) — not on every render.
  const menuHandlersRef = useRef<MenuHandlers>(null!);
  menuHandlersRef.current = {
    openRepo: () => { void openViaDialog(); },
    cloneRepo: () => setCloneOpen(true),
    openSettings: () => openSettingsAt('appearance'),
    checkUpdates: () => {
      openSettingsAt('updates');
      void useUpdates.getState().check();
    },
    openPalette: () => setPaletteOpen((o) => !o),
    showView: (v) => { setView(v); selectFile(null); },
    cycleTheme: () => {
      const next = cycleTheme();
      showToast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
    },
    sync: () => { void onSync(); },
    pull: () => { void onPull(); },
    push: () => { void onPush(); },
    openInEditor,
    openInTerminal,
  };
  const hasRepo = Boolean(meta);
  useEffect(() => {
    if (!isTauri() || osType() !== 'macos') return;
    // Accelerators track the resolved bindings, so a remap in Settings updates
    // the menu too (this effect re-runs when `keyMap` changes).
    const accel = (id: CommandId) =>
      toMudaAccelerator(keyMap.byCommand.get(id) ?? null) ?? undefined;
    installAppMenu(() => menuHandlersRef.current, hasRepo, accel)
      .catch((e) => console.warn('app menu install failed', e));
  }, [hasRepo, keyMap]);

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
    // Pierre reads `--diffs-font-family` inside its shadow DOM (custom
    // properties pierce shadow roots), so the diff font is just this var.
    root.style.setProperty('--diffs-font-family', FONTS.mono[diffFont === 'inherit' ? monoFont : diffFont]);
  }, [density, platform, accent, uiFont, monoFont, diffFont]);

  // Whole-UI zoom (Ctrl/⌘ +/−). Use the webview's *native* zoom — it reflows
  // the page exactly like a browser's Ctrl +/−, so viewport-relative layout
  // (the 100vh window shell, flex panels, the topbar) stays responsive and
  // nothing gets clipped. CSS `zoom` was avoided here: it scales after layout,
  // so the window-fill shell overflows and pushes the chrome off-screen.
  // Browser dev (no Tauri) falls back to CSS `zoom` on <html> just for preview.
  useEffect(() => {
    if (isTauri()) {
      void getCurrentWebviewWindow().setZoom(zoom).catch((e) =>
        console.warn('set zoom failed', e));
    } else {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
    }
  }, [zoom]);

  // Accent follows the active repo: if the selected repo group has a custom
  // tile color, re-theme the whole app to that color's hue (an inline
  // `--accent-h` that wins over the `[data-accent]` preset). Repos without a
  // custom color keep the user's configured accent. Worktrees inherit their
  // group's main tab color. The repo rail itself opts out — its default tiles
  // use `--accent-base` (the configured accent, immune to this override; see
  // tokens.css / RepoRail) so a custom color on one repo never bleeds onto the
  // other rail tiles.
  const activeAccentHue = useMemo(() => {
    const active = tabs.find((t) => t.path === activeTabPath);
    if (!active) return null;
    const main = tabs.find(
      (t) => t.meta.common_dir === active.meta.common_dir && !t.meta.is_linked_worktree,
    );
    return accentHueForColor(main ? repoIcons[main.path]?.color : undefined);
  }, [tabs, activeTabPath, repoIcons]);
  useEffect(() => {
    const root = document.documentElement;
    if (activeAccentHue != null) root.style.setProperty('--accent-h', String(activeAccentHue));
    else root.style.removeProperty('--accent-h');
  }, [activeAccentHue]);

  // Update auto-check on launch (Settings → Updates). Delayed a few seconds
  // so it never competes with cold-start work, and soft-fails quietly — the
  // update endpoint may not be reachable. One-shot by design: prefs read at
  // fire time, not subscribed.
  useEffect(() => {
    if (!isTauri()) return;
    const timer = setTimeout(() => {
      const { updateAutoCheck, updateAutoInstall } = useSettings.getState();
      if (!updateAutoCheck) return;
      void (async () => {
        const updates = useUpdates.getState();
        await updates.check();
        const { status, version } = useUpdates.getState();
        if (status !== 'available') return;
        if (updateAutoInstall) {
          await updates.downloadAndInstall();
          if (useUpdates.getState().status === 'ready') {
            showToast(`Update ${version} ready — restart from Settings → Updates`);
          }
        } else {
          showToast(`Update ${version} available — see Settings → Updates`);
        }
      })().catch((e) => console.warn('update auto-check failed', e));
    }, 3000);
    return () => clearTimeout(timer);
  }, [showToast]);

  // Crash-report check on launch (Settings → Privacy, opt-in and off by
  // default). Reads the *local* crash log for entries past the acknowledged
  // offset; when one exists, a persistent toast offers a user-mediated
  // report (a prefilled GitHub issue in the browser) or Dismiss — nothing is
  // ever uploaded automatically. Delayed like the update check so it never
  // competes with cold-start work; prefs read at fire time.
  useEffect(() => {
    if (!isTauri()) return;
    const timer = setTimeout(() => {
      const { crashPrompt, crashAck, set } = useSettings.getState();
      if (!crashPrompt) return;
      void tauri
        .crashReportCheck(crashAck)
        .then((check) => {
          if (check.entry) setCrashReport(check);
          // Log shrank or vanished (cleared by hand) — realign the ack so a
          // stale large offset can't hide the next crash forever.
          else if (check.len < crashAck) set('crashAck', check.len);
        })
        .catch((e) => console.warn('crash-report check failed', e));
    }, 3500);
    return () => clearTimeout(timer);
  }, []);

  // Native drag-and-drop: drop one or more folders onto the window to open
  // them, each as its own tab.
  useEffect(() => {
    if (!isTauri()) return;
    const w = getCurrentWebviewWindow();
    const unlisten = w.onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop' && payload.paths.length > 0) {
        void openMany(payload.paths);
      }
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [openMany]);

  // Primary freshness signal: the Rust file watcher. It debounces write
  // bursts and emits `repo://changed` with the repo path — exactly what an
  // AI agent editing files in a terminal produces. The single-repo store
  // ignores events for non-active tabs; the workspace review store follows
  // *every* member while its view is live (and no-ops otherwise).
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<string>('repo://changed', (event) => {
      void useRepo.getState().handleExternalChange(event.payload);
      useWorkspaceReview.getState().handleExternalChange(event.payload);
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

  // Global keyboard dispatch — every binding is resolved from the registry +
  // user overrides (see `lib/keys.ts`). Attached once; the latest bindings and
  // handlers are read through refs so settings changes never re-subscribe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc always closes the palette / repo switcher (their own handlers cover
      // the focused case; this is the global fallback).
      if (e.key === 'Escape') { setPaletteOpen(false); setRepoSwitcherOpen(false); return; }
      // Browser-style UI zoom — Ctrl/⌘ with +, −, or 0. These sit outside the
      // rebindable registry: + / = (plus their Shift and numpad variants) don't
      // map to a single canonical binding, and zoom keys are conventionally
      // fixed. Allowed even in text fields, exactly like the browser's own zoom.
      if (e.ctrlKey || e.metaKey) {
        const cur = useSettings.getState().zoom;
        let next: number | null = null;
        if (e.key === '+' || e.key === '=' || e.key === 'Add') next = clampZoom(cur + ZOOM_STEP);
        else if (e.key === '-' || e.key === '_' || e.key === 'Subtract') next = clampZoom(cur - ZOOM_STEP);
        else if (e.key === '0') next = 1;
        if (next !== null) {
          e.preventDefault();
          if (next !== cur) useSettings.getState().set('zoom', next);
          showToastRef.current(`Zoom ${Math.round(next * 100)}%`);
          return;
        }
      }
      const binding = eventToBinding(e);
      if (!binding) return;
      const cmd = keyMapRef.current.byBinding.get(binding);
      if (!cmd) return;
      // On macOS the native menu owns its accelerators — AppKit fires the menu
      // action before the webview sees the key — so defer to it for menu-owned,
      // representable combos (no menu installed elsewhere ⇒ JS handles them).
      if (appMenuInstalled() && MENU_COMMANDS.has(cmd) && toMudaAccelerator(binding)) return;
      // Only Mod-combos may act while a text field is focused — a plain,
      // Shift-, or Alt-modified key is typing (a capital letter arrives as
      // Shift+letter). `eventInside` sees through shadow DOM, where `e.target`
      // is retargeted to the host (Pierre's in-tree file-search box).
      if (isPlainKey(binding) && eventInside(e, EDITABLE_SELECTOR)) return;
      // Repo-scoped commands no-op without a repository open.
      if (REPO_COMMANDS.has(cmd) && !useRepo.getState().meta) return;
      const handler = commandHandlersRef.current[cmd];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
            showToast(`Checkout failed: ${errMessage(e)}`, 'error'));
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
            showToast(`Checkout failed: ${errMessage(e)}`, 'error'));
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
          void stashApply(st.index).catch((e) => showToast(`Apply failed: ${errMessage(e)}`, 'error'));
        },
      });
      out.push({
        id: `stash-pop:${st.oid}`,
        label: `Pop stash: ${st.message}`,
        group: 'Stashes',
        keywords: `stash pop ${st.branch ?? ''}`,
        meta: `stash@{${st.index}}`,
        run: () => {
          void stashPop(st.index).catch((e) => showToast(`Pop failed: ${errMessage(e)}`, 'error'));
        },
      });
      out.push({
        id: `stash-branch:${st.oid}`,
        label: `Create branch from stash: ${st.message}`,
        group: 'Stashes',
        keywords: `stash branch checkout ${st.branch ?? ''}`,
        meta: `stash@{${st.index}}`,
        run: () => setBranchDialog({
          start: `stash@{${st.index}}`,
          label: `stash@{${st.index}}`,
          stashIndex: st.index,
        }),
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
            showToast(`Submodule update failed: ${errMessage(e)}`, 'error'));
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
      { id: 'open',    label: 'Open repository…',  group: 'Actions', shortcut: keyHint('open-repo'), run: () => { void openViaDialog(); } },
      { id: 'init',    label: 'Initialize repository…', group: 'Actions', keywords: 'new create git init local repository', run: () => setInitRepoOpen(true) },
      { id: 'clone',   label: t('clone.paletteAction'), group: 'Actions', shortcut: keyHint('clone-repo'), run: () => setCloneOpen(true) },
      { id: 'switch-repo', label: 'Switch repository…', group: 'Actions', shortcut: keyHint('switch-repo'), keywords: 'switch repo repository jump active picker quick open', run: () => setRepoSwitcherOpen(true) },
      { id: 'workspace-new', label: 'New workspace…', group: 'Actions', keywords: 'workspace create group repositories multi repo', run: () => setWorkspaceManagerOpen('create') },
      { id: 'workspace-manage', label: 'Manage workspaces…', group: 'Actions', keywords: 'workspace edit curate repositories add remove rename delete', run: () => setWorkspaceManagerOpen(true) },
      { id: 'workspace-import', label: 'Import .code-workspace…', group: 'Actions', keywords: 'workspace import vscode visual studio code folders multi root', run: () => { void importCodeWorkspaceFlow(); } },
    ];
    // Repo-scoped actions only make sense — and only succeed — with a repo
    // open, so don't surface them (the network ones would fail confusingly).
    if (meta) {
      base.push(
        { id: 'local',   label: 'Show: Local Changes', group: 'Actions', shortcut: keyHint('view-local'), run: () => { setView('local'); selectFile(null); } },
        { id: 'commits', label: 'Show: All Commits',  group: 'Actions', shortcut: keyHint('view-commits'), run: () => { setView('commits'); selectFile(null); } },
        { id: 'reflog',  label: 'Show: Reflog',       group: 'Actions', shortcut: keyHint('view-reflog'), keywords: 'history head recover lost orphan', run: () => { setView('reflog'); selectFile(null); } },
        { id: 'review-view', label: 'Show: Review', group: 'Actions', shortcut: keyHint('view-review'), keywords: 'ai agent review session changes verdict', run: () => { setView('review'); selectFile(null); } },
        { id: 'pull-requests', label: 'Show: Pull Requests', group: 'Actions', keywords: 'pr github azure devops code review merge request', run: () => { setView('pull-requests'); selectFile(null); } },
        ...(!meta.detached ? [{
          id: 'pull-request-create',
          label: 'Pull Requests: create for current branch…',
          group: 'Actions',
          keywords: 'pr github azure devops open publish current branch',
          run: () => {
            setView('pull-requests');
            selectFile(null);
            window.setTimeout(() => window.dispatchEvent(new CustomEvent('strand:pull-request-create')), 50);
          },
        } satisfies PaletteAction, {
          id: 'pull-request-draft-ai',
          label: 'Draft pull request with AI…',
          group: 'Actions',
          keywords: 'pr ai codex claude generate title description current branch',
          run: () => {
            setView('pull-requests');
            selectFile(null);
            window.setTimeout(() => window.dispatchEvent(new CustomEvent(
              'strand:pull-request-create',
              { detail: { autoFill: true } },
            )), 50);
          },
        } satisfies PaletteAction] : []),
        ...(view === 'pull-requests' ? [
          {
            id: 'pull-request-search',
            label: 'Pull Requests: search…',
            group: 'Actions',
            keywords: 'pr inbox find filter authored completed',
            run: () => window.dispatchEvent(new CustomEvent('strand:pull-request-search')),
          } satisfies PaletteAction,
          ...(activePullRequestKey ? [{
            id: 'pull-request-merge',
            label: 'Pull Requests: merge or mark ready…',
            group: 'Actions',
            keywords: 'pr github azure devops complete squash rebase draft review ready',
            run: () => window.dispatchEvent(new CustomEvent('strand:pull-request-merge')),
          } satisfies PaletteAction,
          {
            id: 'pull-request-submit-review',
            label: 'Pull Requests: submit review…',
            group: 'Actions',
            keywords: 'pr github azure devops comment approve request changes pending review',
            run: () => window.dispatchEvent(new CustomEvent('strand:pull-request-review')),
          } satisfies PaletteAction,
          {
            id: 'pull-request-open-worktree',
            label: 'Pull Requests: open branch in worktree…',
            group: 'Actions',
            keywords: 'pr github azure devops checkout branch worktree isolated',
            run: () => window.dispatchEvent(new CustomEvent('strand:pull-request-open-worktree')),
          } satisfies PaletteAction,
          ...(activePullRequestCanUpdateBranch ? [{
            id: 'pull-request-update-branch',
            label: 'Pull Requests: update branch…',
            group: 'Actions',
            keywords: 'pr github update branch target base behind merge',
            run: () => window.dispatchEvent(new CustomEvent('strand:pull-request-update-branch')),
          } satisfies PaletteAction] : []),
          {
            id: 'pull-request-follow',
            label: activePullRequestFollowed
              ? 'Pull Requests: unfollow open pull request'
              : 'Pull Requests: follow open pull request',
            group: 'Actions',
            keywords: 'pr notifications bell watch follow unfollow',
            run: () => {
              void toggleActivePullRequest().catch((caught) => {
                showToast(`Could not update pull request following: ${errMessage(caught)}`, 'error');
              });
            },
          } satisfies PaletteAction] : []),
        ] : []),
        { id: 'workspace-review-view', label: 'Show: Workspace Review', group: 'Actions', shortcut: keyHint('view-workspace-review'), keywords: 'workspace review aggregate cross repo multi combined agent', run: () => { setView('workspace-review'); selectFile(null); } },
        { id: 'worktrees', label: 'Show: Worktrees',  group: 'Actions', shortcut: keyHint('view-worktrees'), keywords: 'worktree agent feature checkout overview', run: () => { setView('worktrees'); selectFile(null); } },
        { id: 'tab-next', label: 'Next repository', group: 'Actions', shortcut: keyHint('tab-next'), keywords: 'switch repo tab next cycle', run: () => cycleTab(1) },
        { id: 'tab-prev', label: 'Previous repository', group: 'Actions', shortcut: keyHint('tab-prev'), keywords: 'switch repo tab previous cycle', run: () => cycleTab(-1) },
        { id: 'worktree-new', label: 'New worktree…', group: 'Actions', keywords: 'worktree add branch checkout agent', run: () => setWorktreeDialog({ start: null }) },
        { id: 'worktree-cleanup', label: 'Clean up merged worktrees…', group: 'Actions', keywords: 'worktree remove merged clean stale retire agent', run: () => {
          // The candidate list + confirm dialog live in the overview; land
          // there and ask it to open the dialog once mounted.
          setView('worktrees'); selectFile(null);
          setTimeout(() => window.dispatchEvent(new CustomEvent('strand:worktrees-cleanup')), 50);
        } },
        { id: 'worktree-prune', label: 'Prune stale worktrees', group: 'Actions', keywords: 'worktree prune stale registry gone missing', run: () => {
          void pruneWorktrees().then(
            () => showToast('Pruned stale worktree entries'),
            (e) => showToast(`Prune failed: ${errMessage(e)}`, 'error'),
          );
        } },
        { id: 'search-commits', label: 'Search commits…', group: 'Actions', shortcut: '/', keywords: 'find filter grep message author hash', run: () => { requestCommitSearch(); } },
        { id: 'search-content', label: 'Search file contents…', group: 'Actions', keywords: 'pickaxe content diff code history full grep -G -S', run: () => { requestCommitSearch('content'); } },
        // Opens the contextual Mod+F bar. A file view searches its source;
        // diff surfaces search their current pool; other views route local.
        { id: 'search-diff', label: view === 'file' ? 'Search in file…' : 'Search in diff…', group: 'Actions', shortcut: formatBinding('Mod+F', platform), keywords: 'find in file diff grep text content search', run: () => {
          const v = useRepo.getState().view;
          if (v !== 'file' && v !== 'local' && v !== 'review' && v !== 'workspace-review') setView('local');
          requestDiffSearch();
        } },
        { id: 'suggest-commit', label: 'Suggest commit message', group: 'Actions', shortcut: keyHint('suggest-commit'), keywords: 'ai generate commit message chatgpt codex claude suggest', run: () => { requestSuggestCommitMessage(); } },
        { id: 'review-baseline', label: baseline ? `Review: move baseline to HEAD (now at ${baseline.short})` : 'Review: pin baseline at HEAD', group: 'Actions', keywords: 'ai agent session since diff review baseline', run: () => {
          void setBaseline().then(() => { setView('review'); selectFile(null); })
            .catch((e) => showToast(`Set baseline failed: ${errMessage(e)}`, 'error'));
        } },
        ...(baseline ? [{ id: 'review-clear', label: 'Review: clear baseline', group: 'Actions', keywords: 'ai agent session review baseline', run: () => { void clearBaseline(); } } satisfies PaletteAction] : []),
        ...(baseline ? [{ id: 'review-select-commits', label: `Review: select commits since baseline (${baseline.short})`, group: 'Actions', keywords: 'ai agent session graph commits baseline select', run: () => { selectFile(null); requestSelectSinceBaseline(); } } satisfies PaletteAction] : []),
        { id: 'review-stage', label: 'Review: stage reviewed files', group: 'Actions', keywords: 'accept reviewed stage bulk', run: () => {
          void stageReviewed().catch((e) => showToast(`Stage reviewed failed: ${errMessage(e)}`, 'error'));
        } },
        // Notes → one Markdown prompt to paste back into the coding agent.
        ...(reviewNoteCount > 0 ? [
          { id: 'review-copy-feedback', label: 'Review: copy feedback as prompt', group: 'Actions', keywords: 'ai agent review notes feedback prompt export clipboard', run: () => {
            const st = useRepo.getState();
            const pool = st.baseline ? st.baselineDiffs : st.reviewUnstagedDiffs;
            // Union: pool files with notes + noted paths outside the pool
            // (staged away, or Review never populated the pool this session) —
            // a stored note always exports, just without an excerpt.
            const files = collectFeedbackFiles(pool, st.reviewNotes);
            if (!st.activePath || files.length === 0) {
              showToast('No review notes to copy');
              return;
            }
            copyToClipboard(buildReviewFeedback({
              repoName: repoFamilyName(st.meta),
              branch: st.meta?.branch ?? null,
              baselineShort: st.baseline?.short ?? null,
              files,
            }));
            const n = files.reduce((a, f) => a + f.notes.length, 0);
            showToast(`Copied feedback — ${n} note${n === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}`);
          } } satisfies PaletteAction,
          { id: 'review-clear-notes', label: 'Review: clear notes', group: 'Actions', keywords: 'ai agent review notes clear remove reset', run: () => {
            clearReviewNotes();
            showToast('Review notes cleared');
          } } satisfies PaletteAction,
        ] : []),
        // Diff export — paste a patch into an AI agent / PR comment. Markdown
        // for staged/review stays reachable via the file-tree context menus.
        ...(unstagedCount > 0 ? [
          { id: 'copy-unstaged-diff', label: 'Copy unstaged diff', group: 'Actions', keywords: 'patch clipboard export unstaged', run: () => copyDiffs(useRepo.getState().unstagedDiffs, false) } satisfies PaletteAction,
          { id: 'copy-unstaged-diff-md', label: 'Copy unstaged diff as Markdown', group: 'Actions', keywords: 'patch clipboard export unstaged markdown', run: () => copyDiffs(useRepo.getState().unstagedDiffs, true, 'Unstaged changes') } satisfies PaletteAction,
        ] : []),
        ...(stagedCount > 0 ? [{ id: 'copy-staged-diff', label: 'Copy staged diff', group: 'Actions', keywords: 'patch clipboard export staged', run: () => copyDiffs(useRepo.getState().stagedDiffs, false) } satisfies PaletteAction] : []),
        ...(baseline && baselineDiffCount > 0
          ? [{ id: 'copy-review-diff', label: `Copy review diff (since ${baseline.short})`, group: 'Actions', keywords: 'patch clipboard export review baseline session', run: () => copyDiffs(useRepo.getState().baselineDiffs, false) } satisfies PaletteAction]
          : []),
        { id: 'open-editor', label: 'Open in editor', group: 'Actions', shortcut: keyHint('open-editor'), keywords: 'external code reveal vscode editor', run: openInEditor },
        { id: 'open-terminal', label: 'Open in terminal', group: 'Actions', shortcut: keyHint('open-terminal'), keywords: 'shell console cwd iterm terminal', run: openInTerminal },
        { id: 'file-new', label: 'New file…', group: 'Actions', keywords: 'create empty file working tree', run: () => setFileEntryDialog({ dir: '', directory: false }) },
        { id: 'folder-new', label: 'New folder…', group: 'Actions', keywords: 'create directory working tree', run: () => setFileEntryDialog({ dir: '', directory: true }) },
        { id: 'snapshot', label: 'Save snapshot…',  group: 'Actions', run: () => setStashDialog({ snapshot: true, keepIndex: false }) },
        { id: 'stash',    label: 'Stash changes…',  group: 'Actions', run: () => setStashDialog({ snapshot: false, keepIndex: false }) },
        { id: 'branch-new', label: 'Create branch…', group: 'Actions', keywords: 'new branch from head', run: () => setBranchDialog({ start: null, label: 'HEAD' }) },
        { id: 'branch-cleanup', label: 'Clear merged branches…', group: 'Actions', keywords: 'branch delete merged local remote origin cleanup prune', run: () => setBranchCleanupOpen(true) },
        // Renaming the short OID HEAD shows while detached is meaningless —
        // only offer the rename on a real branch.
        ...(meta.branch && !meta.detached
          ? [
              { id: 'branch-rename', label: 'Rename current branch…', group: 'Actions', keywords: 'branch rename move', run: () => setRenameBranchDialog({ name: meta.branch }) } satisfies PaletteAction,
              ...(() => {
                const branch = refs.branches.find((candidate) => candidate.is_head);
                return branch ? [
                  { id: 'branch-upstream', label: 'Manage current branch upstream…', group: 'Actions', keywords: 'branch track tracking set change unset remote upstream', run: () => setBranchNetworkDialog({ kind: 'upstream', branch }) } satisfies PaletteAction,
                  { id: 'branch-push-explicit', label: 'Push current branch to…', group: 'Actions', keywords: 'branch push remote destination refspec publish', run: () => setBranchNetworkDialog({ kind: 'push', branch }) } satisfies PaletteAction,
                ] : [];
              })(),
            ]
          : []),
        { id: 'remote-add', label: 'Add remote…', group: 'Actions', keywords: 'remote origin upstream url add', run: () => setRemoteDialog({ kind: 'add' }) },
        { id: 'repository-maintenance', label: 'Repository maintenance…', group: 'Actions', keywords: 'git gc fsck integrity optimize activity log command output', run: () => {
          setPaletteOpen(false);
          setMaintenanceOpen(true);
        } },
        ...refs.remotes.flatMap((remote) => [
          { id: `remote-${remote.name}-prune`, label: `Prune remote: ${remote.name}`, group: 'Actions', keywords: 'remote fetch prune stale tracking refs', run: () => {
            void useRepo.getState().fetchRemote(remote.name, true).then(
              () => showToast(`Pruned ${remote.name}`),
              (e) => showToast(`Prune failed: ${errMessage(e)}`, 'error'),
            );
          } } satisfies PaletteAction,
          { id: `remote-${remote.name}-refspecs`, label: `Inspect remote refspecs: ${remote.name}`, group: 'Actions', keywords: 'remote fetch push refspec mapping inspect', run: () => setRemoteDialog({
            kind: 'refspecs',
            name: remote.name,
            fetchRefspecs: remote.fetch_refspecs,
            pushRefspecs: remote.push_refspecs,
          }) } satisfies PaletteAction,
          ...(!remote.is_default ? [{
            id: `remote-${remote.name}-default`,
            label: `Set default remote: ${remote.name}`,
            group: 'Actions',
            keywords: 'remote push default origin configure',
            run: () => {
              void useRepo.getState().setDefaultRemote(remote.name).then(
                () => showToast(`Default remote: ${remote.name}`),
                (e) => showToast(`Set default failed: ${errMessage(e)}`, 'error'),
              );
            },
          } satisfies PaletteAction] : []),
        ]),
        { id: 'tag',      label: 'Create tag…',     group: 'Actions', run: () => setTagDialog({ target: null, label: 'HEAD' }) },
        { id: 'push-tags', label: 'Push all tags', group: 'Actions', keywords: 'push upload publish tags remote', run: onPushAllTags },
        { id: 'fetch',   label: 'Fetch', group: 'Actions', shortcut: keyHint('fetch'), keywords: 'fetch remote refs download', run: onFetch },
        { id: 'fetch-prune', label: 'Fetch and prune stale branches', group: 'Actions', keywords: 'fetch prune delete stale remote tracking refs', run: () => { void onFetch(true); } },
        { id: 'fetch-no-prune', label: 'Fetch without pruning', group: 'Actions', keywords: 'fetch keep stale remote tracking refs', run: () => { void onFetch(false); } },
        { id: 'pull',    label: 'Pull', group: 'Actions', shortcut: keyHint('pull'), keywords: 'pull merge remote download integrate', run: onPull },
        { id: 'pull-autostash', label: 'Pull with autostash', group: 'Actions', keywords: 'pull dirty changes stash restore', run: () => { void onPull(undefined, true); } },
        { id: 'pull-no-autostash', label: 'Pull without autostash', group: 'Actions', keywords: 'pull dirty changes no stash', run: () => { void onPull(undefined, false); } },
        { id: 'pull-merge', label: 'Pull: merge (fast-forward if possible)', group: 'Actions', keywords: 'pull merge fetch integrate ff', run: () => { void onPull('merge'); } },
        { id: 'pull-rebase', label: 'Pull: rebase', group: 'Actions', keywords: 'pull rebase fetch linear autostash', run: () => { void onPull('rebase'); } },
        { id: 'pull-ff-only', label: 'Pull: fast-forward only', group: 'Actions', keywords: 'pull fetch ff-only safe refuse diverged', run: () => { void onPull('fast-forward-only'); } },
        { id: 'push',    label: 'Push', group: 'Actions', shortcut: keyHint('push'), keywords: 'push upload publish remote', run: onPush },
        { id: 'push-follow-tags', label: 'Push with annotated tags', group: 'Actions', keywords: 'push follow tags upload publish remote', run: () => { void onPush('follow-tags'); } },
        { id: 'push-force-lease', label: 'Force push with lease…', group: 'Actions', keywords: 'push force lease rewrite remote history safe', run: () => setForcePushOpen(true) },
        { id: 'sync',    label: 'Sync (Fetch + Pull + Push)', group: 'Actions', shortcut: keyHint('sync'), run: onSync },
        // Gated on a non-root HEAD commit — HEAD~1 must exist to reset to.
        ...(meta.head_oid && commits.find((c) => c.hash === meta.head_oid)?.parents.length
          ? [{
              id: 'undo-commit',
              label: 'Undo last commit (soft reset)',
              group: 'Actions',
              keywords: 'uncommit rollback reset soft head',
              icon: 'history',
              run: () => {
                void resetTo('HEAD~1', 'soft')
                  .then(() => showToast('Last commit undone — changes kept staged'))
                  .catch((e) => showToast(`Undo failed: ${errMessage(e)}`, 'error'));
              },
            } satisfies PaletteAction]
          : []),
        { id: 'rebase-i', label: 'Interactive rebase…', group: 'Actions', keywords: 'rebase reorder squash fixup reword drop history edit', run: () => {
          const st = useRepo.getState();
          const c = st.selectedCommit ? st.commits.find((x) => x.hash === st.selectedCommit) : null;
          if (!c) { showToast('Select a commit in the graph first'); return; }
          setRebaseDialog({ base: c.parents.length ? `${c.hash}^` : null, label: c.short_hash });
        } },
      );
    }
    base.push(
      { id: 'settings', label: 'Settings…', group: 'Actions', shortcut: keyHint('settings'), keywords: 'preferences shortcuts keyboard config options', run: () => openSettingsAt('appearance') },
      { id: 'keybindings', label: 'Settings: Keyboard shortcuts', group: 'Actions', keywords: 'keyboard shortcuts keybindings rebind configure customize', run: () => openSettingsAt('keyboard') },
      { id: 'settings-ai', label: 'Settings: AI', group: 'Actions', keywords: 'ai chatgpt codex claude commit message suggest login', run: () => openSettingsAt('ai') },
      { id: 'theme-light',  label: 'Theme: Light',  group: 'Actions', run: () => setTheme('light') },
      { id: 'theme-dark',   label: 'Theme: Dark',   group: 'Actions', run: () => setTheme('dark') },
      { id: 'theme-system', label: 'Theme: System', group: 'Actions', shortcut: keyHint('theme-toggle'), run: () => setTheme('system') },
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
              showToast(`Abort failed: ${errMessage(e)}`, 'error');
            }
          })();
        },
      });
    }
    // Workspace switching — one row per workspace (Default included), shown
    // only once a named workspace exists; with none, "switch" is meaningless.
    const workspaceActions: PaletteAction[] =
      workspaces.some((w) => w.id !== DEFAULT_WORKSPACE_ID)
        ? workspaces.map((w) => {
            const isActive = (activeWorkspaceId ?? DEFAULT_WORKSPACE_ID) === w.id;
            const n = w.repoPaths.length;
            return {
              id: `workspace:${w.id}`,
              label: w.id === DEFAULT_WORKSPACE_ID ? 'Default' : w.name,
              group: 'Workspaces',
              keywords: 'workspace open switch group',
              meta: isActive ? 'active' : `${n} repo${n === 1 ? '' : 's'}`,
              metaLabel: isActive
                ? 'active workspace'
                : `${n} repositor${n === 1 ? 'y' : 'ies'}`,
              ...(isActive ? { icon: 'check' as const } : {}),
              run: () => { void useWorkspaces.getState().openWorkspace(w.id); },
            };
          })
        : [];
    const recentActions: PaletteAction[] = recents.map((r) => ({
      id: `recent:${r.path}`,
      label: r.name,
      group: 'Recent',
      keywords: r.path,
      meta: r.path,
      icon: 'history',
      run: () => { void openByPath(r.path); },
    }));
    return [...base, ...repoActions, ...workspaceActions, ...recentActions];
  }, [setView, selectFile, onFetch, onSync, onPull, onPush, onPushAllTags, openViaDialog, openByPath, setTheme, recents,
      showToast, meta, abortOperation, requestCommitSearch,
      requestDiffSearch, requestSuggestCommitMessage, requestSelectSinceBaseline, openInEditor, openInTerminal, openSettingsAt,
      repoActions, setRebaseDialog, setRemoteDialog, setRenameBranchDialog,
      baseline, setBaseline, clearBaseline, stageReviewed, commits, resetTo,
      unstagedCount, stagedCount, baselineDiffCount, copyDiffs,
      reviewNoteCount, clearReviewNotes, keyHint, platform, cycleTab, view,
      workspaces, activeWorkspaceId, importCodeWorkspaceFlow, pruneWorktrees,
      activePullRequestKey, activePullRequestFollowed, activePullRequestCanUpdateBranch,
      toggleActivePullRequest]);

  const rootStyle = {
    '--font-ui': FONTS.ui[uiFont],
    '--font-mono': FONTS.mono[monoFont],
    '--diffs-font-family': FONTS.mono[diffFont === 'inherit' ? monoFont : diffFont],
  } as React.CSSProperties;

  return (
    <div className="os-bg" data-theme={theme} data-density={density} data-platform={platform} style={rootStyle}>
      <PullRequestMonitor />
      <div className="strand-window">
        <Topbar
          onOpenPalette={() => setPaletteOpen(true)}
          onFetch={onFetch}
          onPull={onPull}
          onPush={onPush}
          onPushAllTags={onPushAllTags}
          onForcePush={() => setForcePushOpen(true)}
          pullMode={pullMode}
          fetchPrune={fetchPrune}
          pullAutostash={pullAutostash}
          onSetPullMode={(mode) => {
            setPullMode(mode);
            showToast(`Repository pull default: ${mode === 'default' ? 'Git configuration' : mode}`);
          }}
          onSetFetchPrune={(prune) => {
            setFetchPrune(prune);
            showToast(`Repository fetch default: ${prune ? 'prune stale branches' : 'keep stale branches'}`);
          }}
          onSetPullAutostash={(autostash) => {
            setPullAutostash(autostash);
            showToast(`Repository pull autostash: ${autostash ? 'on' : 'off'}`);
          }}
          syncing={syncing}
          pulling={pulling}
          pushing={pushing}
          syncDone={syncDone}
          pullDone={pullDone}
          pushDone={pushDone}
          onToast={showToast}
          onSaveSnapshot={() => setStashDialog({ snapshot: true, keepIndex: false })}
          onStash={(opts) => setStashDialog({ snapshot: opts?.snapshot ?? false, keepIndex: opts?.keepIndex ?? false })}
          onOpenRepo={openViaDialog}
          onInitRepo={() => setInitRepoOpen(true)}
          onOpenRecent={openByPath}
          onClone={() => setCloneOpen(true)}
          onCustomize={openIconDialog}
          onManageWorkspaces={() => setWorkspaceManagerOpen(true)}
          onWorktreeReview={reviewWorktreeTab}
          onWorktreeMerge={mergeWorktreeTab}
        />

        <div className="body">
          {repoNav === 'rail' && (
            <RepoRail
              onOpenRepo={openViaDialog}
              onInitRepo={() => setInitRepoOpen(true)}
              onOpenRecent={openByPath}
              onClone={() => setCloneOpen(true)}
              onCustomize={openIconDialog}
              onManageWorkspaces={() => setWorkspaceManagerOpen(true)}
              onWorktreeReview={reviewWorktreeTab}
              onWorktreeMerge={mergeWorktreeTab}
            />
          )}
          <PanelGroup direction="horizontal" autoSaveId="strand:body" className="body-panels">
            <Panel defaultSize={20} minSize={12} maxSize={40}>
              <Sidebar
                onOpenRepo={openViaDialog}
                onOpenRecent={openByPath}
                onCreateStash={() => setStashDialog({ snapshot: true, keepIndex: false })}
                onCreateTag={() => setTagDialog({ target: null, label: 'HEAD' })}
                onCreateBranch={(start, label) => setBranchDialog({ start, label })}
                onBranchFromStash={(index) => setBranchDialog({
                  start: `stash@{${index}}`,
                  label: `stash@{${index}}`,
                  stashIndex: index,
                })}
                onCreateWorktree={(start) => setWorktreeDialog({ start: start ?? null })}
                onMerge={(source, into) => setMergeDialog({ source, into })}
                onInteractiveRebase={(base, label) => setRebaseDialog({ base, label })}
                onManageRemote={(mode) => setRemoteDialog(mode)}
                onRenameBranch={(name) => setRenameBranchDialog({ name })}
                onManageBranchNetwork={(mode) => setBranchNetworkDialog(mode)}
                onPull={onPull}
                onPush={onPush}
                onForcePush={() => setForcePushOpen(true)}
                onFetchBranch={onFetchBranch}
                onPullBranch={onPullBranch}
                onOpenFileInEditor={openActiveFileInEditor}
                onCreateFileEntry={(dir, directory) => setFileEntryDialog({ dir, directory })}
                onToast={showToast}
              />
            </Panel>
            <PanelResizeHandle className="rs-handle vert" />
            <Panel minSize={30}>
              {view === 'file' && selectedFile ? (
                <FileView path={selectedFile} />
              ) : (
                <div className="main">
                  <MainHeader onOpenEditor={openInEditor} onOpenTerminal={openInTerminal} />
                  <OpBanner onToast={showToast} />
                  {view === 'local' && <LocalChanges onOpenFileInEditor={openActiveFileInEditor} />}
                  {view === 'review' && <Review onOpenFileInEditor={openActiveFileInEditor} />}
                  {view === 'pull-requests' && (
                    <PullRequests
                      onToast={showToast}
                      onCreateWorktree={(start) => setWorktreeDialog({ start })}
                    />
                  )}
                  {view === 'workspace-review' && <WorkspaceReview onOpenFileInEditor={openEditorTarget} />}
                  {view === 'reflog' && (
                    <Reflog
                      onResetTo={(target, label) => setResetDialog({ target, label })}
                      onCreateBranch={(start, label) => setBranchDialog({ start, label })}
                      onToast={showToast}
                    />
                  )}
                  {view === 'worktrees' && (
                    <Worktrees onCreateWorktree={() => setWorktreeDialog({ start: null })} onToast={showToast} />
                  )}
                  {(view === 'commits' || view === 'branch') && (
                    <Commits
                      onCreateTag={(target, label) => setTagDialog({ target, label })}
                      onInteractiveRebase={(base, label) => setRebaseDialog({ base, label })}
                      onResetTo={(target, label) => setResetDialog({ target, label })}
                      onCreateWorktree={(start) => setWorktreeDialog({ start })}
                      onToast={showToast}
                    />
                  )}
                </div>
              )}
            </Panel>
          </PanelGroup>
        </div>

        <StatusBar onOpenSettings={() => openSettingsAt('appearance')} />

        {/* Persistent live region: the visible pills below mount/unmount, which
            is unreliable for screen readers, so announce the active message
            from an always-present node. assertive because the toast is the
            sole channel for network-op failures. */}
        <div className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
          {toast?.msg ?? netProgress ?? ''}
        </div>

        <Presence value={netProgress}>
          {(msg, exiting) => (
            <div className={`toast progress${exiting ? ' exiting' : ''}`} aria-hidden={netOpId && !exiting ? undefined : 'true'}>
              <span aria-hidden="true" className="icon-spin"><Icon name="refresh" size={13} /></span>
              <span aria-hidden="true">{msg}</span>
              {netOpId && !exiting && (
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
        </Presence>

        <Presence value={toast}>
          {(t, exiting) => (
            <div className={`toast${exiting ? ' exiting' : ''}`} aria-hidden="true">
              <span style={{ color: t.kind === 'error' ? 'var(--del)' : 'var(--add)' }}>
                <Icon name={t.kind === 'error' ? 'x' : 'check'} size={13} stroke={2.2} />
              </span>
              <span>{t.msg}</span>
            </div>
          )}
        </Presence>

        <Presence value={opProgress}>
          {(op, exiting) => (
            <ProgressPopup
              title={op.title}
              subject={op.subject}
              detail={op.detail}
              percent={op.percent}
              eta={op.eta}
              startedAt={op.startedAt}
              error={op.error ?? null}
              exiting={exiting}
              onDismiss={() => setOpProgress((cur) => (cur && cur.id === op.id ? null : cur))}
              onCancel={
                op.kind === 'clone' && !op.error && cloneCancelId
                  ? () => { void tauri.repoCancelOp(cloneCancelId); }
                  : undefined
              }
            />
          )}
        </Presence>

        <UndoToast />
        <BulkUndoToast onToast={showToast} />
        {crashReport && (
          <CrashToast
            check={crashReport}
            onClose={() => setCrashReport(null)}
            onToast={showToast}
          />
        )}
      </div>

      {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}

      {repoSwitcherOpen && (
        <RepoSwitcher onOpenRecent={openByPath} onClose={() => setRepoSwitcherOpen(false)} />
      )}

      {settingsOpen && (
        <SettingsDialog initialSection={settingsSection} onClose={() => setSettingsOpen(false)} />
      )}

      {cloneOpen && (
        <CloneDialog onClose={() => setCloneOpen(false)} onStartClone={runClone} />
      )}

      {initRepoOpen && (
        <InitRepoDialog onClose={() => setInitRepoOpen(false)} onInit={runInitRepo} />
      )}

      {stashDialog && (
        <StashDialog
          snapshot={stashDialog.snapshot}
          keepIndex={stashDialog.keepIndex}
          onClose={() => setStashDialog(null)}
        />
      )}

      {tagDialog && (
        <TagDialog
          target={tagDialog.target}
          targetLabel={tagDialog.label}
          onClose={() => setTagDialog(null)}
        />
      )}

      {branchDialog && (
        <BranchDialog
          start={branchDialog.start}
          startLabel={branchDialog.label}
          stashIndex={branchDialog.stashIndex}
          onClose={() => setBranchDialog(null)}
        />
      )}

      {branchCleanupOpen && (
        <BranchCleanupDialog
          onClose={() => setBranchCleanupOpen(false)}
          onToast={showToast}
        />
      )}

      {remoteDialog && (
        <RemoteDialog mode={remoteDialog} onClose={() => setRemoteDialog(null)} onToast={showToast} />
      )}

      {maintenanceOpen && meta && (
        <MaintenanceDialog path={meta.path} onClose={() => setMaintenanceOpen(false)} onToast={showToast} />
      )}

      {fileEntryDialog && meta && (
        <FileEntryDialog
          repoPath={meta.path}
          dir={fileEntryDialog.dir}
          directory={fileEntryDialog.directory}
          onClose={() => setFileEntryDialog(null)}
          onToast={showToast}
        />
      )}

      {renameBranchDialog && (
        <RenameBranchDialog
          name={renameBranchDialog.name}
          onClose={() => setRenameBranchDialog(null)}
          onToast={showToast}
        />
      )}

      {branchNetworkDialog && (
        <BranchNetworkDialog
          mode={branchNetworkDialog}
          onClose={() => setBranchNetworkDialog(null)}
          onPush={(request) => { void onPushBranch(request); }}
          onToast={showToast}
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

      {resetDialog && (
        <ResetDialog
          target={resetDialog.target}
          label={resetDialog.label}
          onClose={() => setResetDialog(null)}
          onToast={showToast}
        />
      )}

      {forcePushOpen && meta && (
        <ForcePushDialog
          branch={meta.branch}
          upstream={refs.branches.find((branch) => branch.is_head)?.upstream?.name ?? null}
          onClose={() => setForcePushOpen(false)}
          onConfirm={() => {
            setForcePushOpen(false);
            void onPush('force-with-lease');
          }}
        />
      )}

      {ignoreDraft != null && (
        <IgnoreDialog initial={ignoreDraft} onClose={closeIgnoreDialog} onToast={showToast} />
      )}

      {worktreeDialog && (
        <WorktreeDialog
          initialStart={worktreeDialog.start}
          onToast={showToast}
          onClose={() => setWorktreeDialog(null)}
        />
      )}

      {wtMergeDialog && (
        <WorktreeMergeDialog
          worktree={wtMergeDialog.worktree}
          health={wtMergeDialog.health}
          dirty={wtMergeDialog.dirty}
          onClose={() => setWtMergeDialog(null)}
          onToast={showToast}
        />
      )}

      {iconDialog && (
        <RepoIconDialog
          path={iconDialog.path}
          name={iconDialog.name}
          onClose={() => setIconDialog(null)}
        />
      )}

      {workspaceManagerOpen && (
        <WorkspaceManagerDialog
          initialCreate={workspaceManagerOpen === 'create'}
          onClose={() => setWorkspaceManagerOpen(false)}
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

/**
 * Undo affordance for a bulk (multi-file) discard. The store stashed a
 * safety snapshot just before discarding; Restore applies it back. A longer
 * window than the single-hunk toast — a 30-file discard deserves more than
 * six seconds of regret. The snapshot also stays on the stash stack after
 * the toast expires, so even a missed window is recoverable by hand.
 */
const BULK_UNDO_WINDOW_MS = 15000;

function BulkUndoToast({ onToast }: { onToast: (msg: string, kind?: 'success' | 'error') => void }) {
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
      onToast(`Restore failed: ${errMessage(e)}`, 'error');
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

/**
 * Prompt shown when the previous run crashed and crash-report offers are
 * enabled (Settings → Privacy — opt-in, off by default). Persistent until
 * acted on — unlike the undo toasts there's no expiry, a crash deserves a
 * decision. "Report…" opens a *prefilled GitHub issue* in the browser so the
 * user reviews exactly what leaves the machine before submitting; Strand
 * never uploads anything itself. Both actions acknowledge the log offset so
 * the same crash never re-prompts.
 */
function CrashToast({
  check,
  onClose,
  onToast,
}: {
  check: CrashCheck;
  onClose: () => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const ack = () => {
    useSettings.getState().set('crashAck', check.len);
    onClose();
  };
  const report = async () => {
    try {
      const version = await getVersion().catch(() => 'unknown');
      await shellOpen(buildCrashIssueUrl(check.entry ?? '', version, osType()));
      onToast('Crash report opened in your browser — review it before submitting');
    } catch (e) {
      onToast(`Couldn't open the report: ${errMessage(e)}`);
    }
    ack();
  };
  return (
    <div className="toast undo" role="alert">
      <span>Strand crashed last session</span>
      <button type="button" className="toast-action" onClick={() => void report()}>
        Report…
      </button>
      <button type="button" className="toast-action" onClick={ack}>
        Dismiss
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
 * is paused (on a conflict or an interactive-rebase `edit`). Offers
 * **Continue** once conflicts are resolved or the edited commit is amended,
 * and **Abort** to restore the pre-op state. Continue is disabled while any
 * conflict remains. The op clears `operation` on the next refresh, which hides
 * the banner.
 */
function OpBanner({ onToast }: { onToast: (msg: string, kind?: 'success' | 'error') => void }) {
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
      onToast(`Abort failed: ${errMessage(e)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const onContinue = async () => {
    if (busy) return;
    setBusy('continue');
    try {
      const stillPaused = await continueOperation();
      onToast(
        stillPaused
          ? 'Rebase paused again — amend the commit or resolve conflicts, then Continue'
          : `${OP_LABEL[operation].replace(' in progress', '')} complete`,
      );
    } catch (e) {
      onToast(`Continue failed: ${errMessage(e)}`, 'error');
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
          : operation === 'rebase'
            ? 'Amend this commit if needed, then'
            : 'Ready to continue —'}
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

function MainHeader({
  onOpenEditor,
  onOpenTerminal,
}: {
  onOpenEditor: () => void;
  onOpenTerminal: () => void;
}) {
  const view = useRepo((s) => s.view);
  const meta = useRepo((s) => s.meta);
  const status = useRepo((s) => s.status);
  const commits = useRepo((s) => s.commits);
  const activePath = useRepo((s) => s.activePath);
  const selectedFile = useRepo((s) => s.selectedFile);
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
  const wsMembers = useWorkspaceReview((s) => s.members);
  const title = view === 'local' ? t('nav.localChanges')
    : view === 'commits' ? t('nav.allCommits')
    : view === 'reflog' ? t('nav.reflog')
    : view === 'review' ? t('nav.review')
    : view === 'workspace-review' ? t('nav.workspaceReview')
    : view === 'worktrees' ? t('nav.worktrees')
    : view === 'branch' ? t('nav.branch')
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
          : view === 'workspace-review'
            ? (() => {
                const repos = wsMembers.filter((m) => m.worktree == null).length;
                const wts = wsMembers.length - repos;
                return (
                  `${repos} repo${repos === 1 ? '' : 's'}` +
                  (wts > 0 ? ` + ${wts} worktree${wts === 1 ? '' : 's'}` : '') +
                  ` · ${wsMembers.reduce((n, m) => n + m.diffs.length, 0)} files to review`
                );
              })()
            : view === 'worktrees'
              ? `${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`
              : '';

  return (
    <div className="main-header">
      <div className="crumb">
        <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {repoFamilyName(meta)}
        </span>
        <span className="sep"><Icon name="chev-right" size={10} /></span>
        <span className="leaf">{title}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 11.5, marginLeft: 6 }}>· {sub}</span>
      </div>
      <div className="h-actions">
        {(view === 'commits' || view === 'reflog') && <HistoryModeToggle />}
        {(view === 'review' || view === 'workspace-review') && <ReviewModeToggle />}
        {(view === 'local' || view === 'review' || view === 'workspace-review') && (
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
        {/* Unconfigured tools route to Settings → Integrations (with a toast)
            rather than silently no-oping; only "no repo" disables. */}
        <button
          type="button"
          className={'icon-btn' + (!activePath ? ' disabled' : '')}
          onClick={onOpenTerminal}
          title="Open in terminal"
          aria-label="Open repository in terminal"
          disabled={!activePath}
        >
          <Icon name="terminal" size={13} />
        </button>
        <button
          type="button"
          className={'icon-btn' + (!activePath ? ' disabled' : '')}
          onClick={onOpenEditor}
          title={selectedFile ? 'Open file in editor' : 'Open repository in editor'}
          aria-label={selectedFile ? 'Open file in external editor' : 'Open repository in external editor'}
          disabled={!activePath}
        >
          <Icon name="external" size={13} />
        </button>
      </div>
    </div>
  );
}
