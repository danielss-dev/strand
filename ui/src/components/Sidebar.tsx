import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import {
  copyToClipboard,
  PierreTree,
  type TreeMenuContext,
  type TreeMenuItem,
} from './PierreTree';
import { ignorePatterns } from '../lib/ignore';
import { applyEmptyDirectoryMutation } from '../lib/emptyDirectories';
import { t } from '../lib/i18n';
import { worktreeName } from '../lib/repoIdentity';
import { workTreeGitStatus } from '../lib/workTreeGitStatus';
import { errMessage, tauri } from '../lib/tauri';
import { defaultRemote, useRepo } from '../stores/repo';
import type {
  Branch,
  PullMode,
  PushMode,
  RemoteBranch,
  Stash,
  Submodule,
  SubmoduleState,
  Tag,
  Worktree,
  WorktreeHealth,
} from '../lib/types';
import type { RemoteDialogMode } from '../views/RemoteDialog';
import type { BranchNetworkDialogMode } from '../views/BranchNetworkDialog';
import { RenameFileDialog } from '../views/RenameFileDialog';
import { WorktreeMergeDialog } from '../views/WorktreeMergeDialog';
import { CompareRefsDialog, type CompareChoice } from '../views/CompareRefsDialog';

type SideTab = 'git' | 'files';

interface RowProps {
  icon?: IconName;
  label: string;
  badge?: number | string;
  active?: boolean;
  onClick?: () => void;
}

function SideRow({ icon, label, badge, active, onClick }: RowProps) {
  return (
    <button type="button" className={'side-row' + (active ? ' active' : '')} onClick={onClick}>
      {icon && <span className="ico"><Icon name={icon} size={14} /></span>}
      <span className="label">{label}</span>
      {badge != null && badge !== 0 && <span className="badge">{badge}</span>}
    </button>
  );
}

interface SectionProps {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  count?: number;
  /** Optional trailing action (e.g. "+" to create) shown on the right. */
  action?: { icon: IconName; title: string; onClick: () => void };
}

function SideSection({ label, collapsed, onToggle, count, action }: SectionProps) {
  return (
    <div className={'side-section' + (collapsed ? ' collapsed' : '')}>
      <button type="button" className="ss-toggle" onClick={onToggle}>
        <Icon name="chev-down" size={8} stroke={2} className="chev" />
        <span>{label}</span>
      </button>
      {action && (
        <button type="button" className="ss-action" title={action.title} aria-label={action.title} onClick={action.onClick}>
          <Icon name={action.icon} size={12} stroke={2} />
        </button>
      )}
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}

interface SidebarProps {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  /** Open the Save-snapshot / Stash dialog. */
  onCreateStash: () => void;
  /** Open the New-tag dialog targeting HEAD. */
  onCreateTag: () => void;
  /** Open the New-branch dialog from `start` (`null` ⇒ HEAD); `label` is the
   * human name shown in the blurb. */
  onCreateBranch: (start: string | null, label: string) => void;
  /** Open the branch-from-stash dialog for `stash@{index}`. */
  onBranchFromStash: (index: number) => void;
  /** Open the New-worktree dialog, optionally pre-picking a start point
   * (`ref` = branch/tag/commit for the new task branch). */
  onCreateWorktree: (start?: { ref: string; label: string }) => void;
  /** Open the Merge dialog: merge `source` into the current branch `into`. */
  onMerge: (source: string, into: string) => void;
  /** Open the interactive-rebase editor over `base..HEAD` (base null = root). */
  onInteractiveRebase: (base: string | null, label: string) => void;
  /** Open the remote-management dialog in the given mode (add/rename/url). */
  onManageRemote: (mode: RemoteDialogMode) => void;
  /** Open the Rename-branch dialog for the branch `name`. */
  onRenameBranch: (name: string) => void;
  /** Open branch upstream/push configuration for any local branch. */
  onManageBranchNetwork: (mode: BranchNetworkDialogMode) => void;
  /** Current-branch network actions, owned by App so progress/cancellation stay global. */
  onPull: (mode?: PullMode) => void;
  onPush: (mode?: PushMode) => void;
  onForcePush: () => void;
  onFetchBranch: (branch: RemoteBranch) => void;
  onPullBranch: (branch: RemoteBranch, mode?: PullMode) => void;
  /** Open one working-tree file in the configured external editor. */
  onOpenFileInEditor: (file: string) => void;
  /** Create a working-tree file/folder inside `dir`. */
  onCreateFileEntry: (dir: string, directory: boolean) => void;
  /** Surface a transient message (tag push / remote-delete feedback). */
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}

// ─── tree primitives ────────────────────────────────────────────────────

interface TreeNode<T> {
  name: string;
  fullPath: string;
  leaf?: T;
  children: TreeNode<T>[];
  /** Leaf rows at or beneath this node — filled once per build by
   * {@link countLeaves}, read by folder rows (was re-counted recursively on
   * every render before). */
  leaves: number;
}

function buildTree<T>(items: T[], getSegments: (item: T) => string[]): TreeNode<T> {
  const root: TreeNode<T> = { name: '', fullPath: '', children: [], leaves: 0 };
  for (const item of items) {
    const parts = getSegments(item);
    let node = root;
    let path = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      path = path ? `${path}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, fullPath: path, children: [], leaves: 0 };
        node.children.push(child);
      }
      if (i === parts.length - 1) child.leaf = item;
      node = child;
    }
  }
  return root;
}

function countLeaves<T>(node: TreeNode<T>): number {
  node.leaves =
    node.children.length === 0
      ? node.leaf != null
        ? 1
        : 0
      : node.children.reduce((sum, c) => sum + countLeaves(c), 0);
  return node.leaves;
}

function sortTree<T>(node: TreeNode<T>, leafCmp: (a: T, b: T) => number): void {
  node.children.sort((a, b) => {
    const aFolder = a.children.length > 0;
    const bFolder = b.children.length > 0;
    if (aFolder !== bFolder) return aFolder ? 1 : -1; // leaves first
    if (a.leaf && b.leaf) return leafCmp(a.leaf, b.leaf);
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortTree(c, leafCmp);
}

// ─── component ──────────────────────────────────────────────────────────

export function Sidebar({ onOpenRepo, onOpenRecent, onCreateStash, onCreateTag, onCreateBranch, onBranchFromStash, onCreateWorktree, onMerge, onInteractiveRebase, onManageRemote, onRenameBranch, onManageBranchNetwork, onPull, onPush, onForcePush, onFetchBranch, onPullBranch, onOpenFileInEditor, onCreateFileEntry, onToast }: SidebarProps) {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  const setFileTab = useRepo((s) => s.setFileTab);
  const selectedFile = useRepo((s) => s.selectedFile);
  const selectedFileIsDirectory = useRepo((s) => s.selectedFileIsDirectory);
  const status = useRepo((s) => s.status);
  const meta = useRepo((s) => s.meta);
  const recents = useRepo((s) => s.recents);
  const forgetRecent = useRepo((s) => s.forgetRecent);
  const refs = useRepo((s) => s.refs);
  const pullMode = useRepo((s) => s.pullMode);
  const setBranchUpstream = useRepo((s) => s.setBranchUpstream);
  const checkout = useRepo((s) => s.checkout);
  const checkoutCommit = useRepo((s) => s.checkoutCommit);
  const revealInGraph = useRepo((s) => s.revealInGraph);
  const createBranch = useRepo((s) => s.createBranch);
  const deleteBranch = useRepo((s) => s.deleteBranch);
  const deleteRemoteBranch = useRepo((s) => s.deleteRemoteBranch);
  const removeRemote = useRepo((s) => s.removeRemote);
  const fetchRemote = useRepo((s) => s.fetchRemote);
  const setDefaultRemote = useRepo((s) => s.setDefaultRemote);
  const deleteTag = useRepo((s) => s.deleteTag);
  const pushTag = useRepo((s) => s.pushTag);
  const deleteRemoteTag = useRepo((s) => s.deleteRemoteTag);
  const remoteTags = useRepo((s) => s.remoteTags);
  const refreshRemoteTags = useRepo((s) => s.refreshRemoteTags);
  const workTree = useRepo((s) => s.workTree);
  const filesTreeRevision = useRepo((s) => s.filesTreeRevision);
  const filesTreeMutation = useRepo((s) => s.filesTreeMutation);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const refreshLocalChanges = useRepo((s) => s.refreshLocalChanges);
  const markFilesTreeChanged = useRepo((s) => s.markFilesTreeChanged);
  const gitignoreAdd = useRepo((s) => s.gitignoreAdd);
  const moveEntries = useRepo((s) => s.moveEntries);
  const openIgnoreDialog = useRepo((s) => s.openIgnoreDialog);
  const stashes = useRepo((s) => s.stashes);
  const stashApply = useRepo((s) => s.stashApply);
  const stashPop = useRepo((s) => s.stashPop);
  const stashDrop = useRepo((s) => s.stashDrop);
  const submodules = useRepo((s) => s.submodules);
  const submoduleUpdate = useRepo((s) => s.submoduleUpdate);
  const worktrees = useRepo((s) => s.worktrees);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const pruneWorktrees = useRepo((s) => s.pruneWorktrees);
  const refreshWorktrees = useRepo((s) => s.refreshWorktrees);
  const reviewWorktree = useRepo((s) => s.reviewWorktree);
  // "Merge & clean up" opened from a worktree's context menu; state fetched
  // on demand (the sidebar doesn't track per-worktree health).
  const [wtMerge, setWtMerge] = useState<{
    worktree: Worktree;
    health: WorktreeHealth;
    dirty: number;
  } | null>(null);
  const rebase = useRepo((s) => s.rebase);
  const setBaseline = useRepo((s) => s.setBaseline);
  const currentBranch = useMemo(() => refs.branches.find((b) => b.is_head)?.name ?? null, [refs]);
  const compareChoices = useMemo<CompareChoice[]>(
    () => [
      ...refs.branches.map((branch) => ({ value: branch.name, label: `Local · ${branch.name}` })),
      ...refs.remote_branches.map((branch) => ({ value: branch.name, label: `Remote · ${branch.name}` })),
      ...refs.tags.map((tag) => ({ value: tag.full_name, label: `Tag · ${tag.name}` })),
    ],
    [refs],
  );
  const [refCompare, setRefCompare] = useState<{ from: string; to: string } | null>(null);
  // Branches that are HEAD of another worktree — checkout here is guaranteed
  // to fail, so their rows badge the fact and open that worktree instead.
  const worktreeByBranch = useMemo(
    () =>
      new Map(
        worktrees
          .filter((w) => !w.is_current && w.branch)
          .map((w) => [w.branch as string, w]),
      ),
    [worktrees],
  );

  const [tab, setTab] = useState<SideTab>('git');
  const [filter, setFilter] = useState('');
  const [sections, setSections] = useState({
    worktrees: true, branches: true, remotes: true, tags: false, stashes: true, submods: false,
  });
  // Folders are expanded by default — track which ones the user collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // The open sidebar menu, if any. Per-row actions (checkout, delete, push,
  // …) and the Files create actions share the same keyboard-operable surface.
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    source: 'context' | 'file-create';
  } | null>(null);
  const openMenu = (
    x: number,
    y: number,
    items: MenuItem[],
    source: 'context' | 'file-create' = 'context',
  ) => setMenu({ x, y, items, source });
  const fileCreateButtonRef = useRef<HTMLButtonElement>(null);

  const openFileCreateMenu = () => {
    const rect = fileCreateButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu(rect.left, rect.bottom + 4, [
      { label: t('files.newFile'), icon: 'file-plus', onSelect: () => onCreateFileEntry('', false) },
      { label: t('files.newFolder'), icon: 'folder-plus', onSelect: () => onCreateFileEntry('', true) },
    ], 'file-create');
  };

  const unstaged = status.filter((s) => !s.staged).length;
  const toggle = (k: keyof typeof sections) => setSections((s) => ({ ...s, [k]: !s[k] }));

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);

    // All remote-tracking branches show, including ones a local branch
    // already tracks (origin/main must stay visible and actionable even when
    // main is the only local branch) — tracked rows just act differently
    // (checkout the local instead of creating a duplicate; see remoteMenu).
    return {
      branches: refs.branches.filter((b) => match(b.name)),
      remotes: refs.remote_branches.filter((rb) => match(rb.name)),
      tags: refs.tags.filter((t) => match(t.name)),
    };
  }, [refs, filter]);

  // Local branch tracking a given remote-tracking ref (`origin/main` → local
  // `main`), used to route remote-row actions to the local when one exists.
  const localByUpstream = useMemo(
    () =>
      new Map(
        refs.branches
          .filter((b) => b.upstream)
          .map((b) => [b.upstream!.name, b] as const),
      ),
    [refs.branches],
  );

  // Local branches render flat with their full name (`feat/foo`). Remote
  // branches group one level under their remote (`origin`), then list flat —
  // tags still split on `/` into folders (see tagTree).
  const branchTree = useMemo(() => {
    const t = buildTree<Branch>(filtered.branches, (b) => [b.name]);
    sortTree(t, (a, b) => {
      if (a.is_head !== b.is_head) return a.is_head ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    countLeaves(t);
    return t;
  }, [filtered.branches]);

  const remoteTree = useMemo(() => {
    const t = buildTree<RemoteBranch>(filtered.remotes, (rb) => [rb.remote, rb.branch]);
    // Every *configured* remote gets a top-level row, even with zero
    // remote-tracking refs (just added, or never fetched) — otherwise the
    // remote exists in the section count but renders nowhere, and its
    // management menu (Fetch / Edit URL / Rename / Remove) is unreachable.
    const q = filter.trim().toLowerCase();
    for (const r of refs.remotes) {
      if (q && !r.name.toLowerCase().includes(q)) continue;
      if (!t.children.some((c) => c.name === r.name)) {
        t.children.push({ name: r.name, fullPath: r.name, children: [], leaves: 0 });
      }
    }
    sortTree(t, (a, b) => a.name.localeCompare(b.name));
    countLeaves(t);
    return t;
  }, [filtered.remotes, refs.remotes, filter]);

  const tagTree = useMemo(() => {
    const t = buildTree<Tag>(filtered.tags, (tg) => tg.name.split('/'));
    sortTree(t, (a, b) => a.name.localeCompare(b.name));
    countLeaves(t);
    return t;
  }, [filtered.tags]);

  // Default remote for tag push / remote-delete — null hides those tools.
  const tagRemote = useMemo(() => defaultRemote(refs), [refs]);

  // Lazily learn which tags the remote already has (a network ls-remote), the
  // first time the Tags section is opened for a repo. `remoteTags` resets to
  // null on tab switch, so this re-runs per repo; it stays loaded after, so
  // collapsing/expanding doesn't re-hit the network.
  useEffect(() => {
    if (tab === 'git' && sections.tags && meta?.path && tagRemote && remoteTags === null) {
      void refreshRemoteTags();
    }
  }, [tab, sections.tags, meta?.path, tagRemote, remoteTags, refreshRemoteTags]);

  // Stashes are a flat stack (their messages can contain `/`, so we don't
  // split them into a folder tree like branches). Filter on message + branch.
  const filteredStashes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return stashes;
    return stashes.filter(
      (s) => s.message.toLowerCase().includes(q) || (s.branch?.toLowerCase().includes(q) ?? false),
    );
  }, [stashes, filter]);

  // Worktrees are a flat list filtered on branch + path.
  const filteredWorktrees = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return worktrees;
    return worktrees.filter(
      (w) => worktreeName(w).toLowerCase().includes(q) || w.path.toLowerCase().includes(q),
    );
  }, [worktrees, filter]);

  // Submodules are a flat list filtered on path + name.
  const filteredSubmodules = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return submodules;
    return submodules.filter(
      (s) => s.path.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    );
  }, [submodules, filter]);

  // Files tab: lazily fetch the selected commit's immutable tree, or the
  // working-tree listing when no commit detail is open. Path-changing actions
  // advance `filesTreeRevision`; ordinary status/stage updates deliberately do
  // not, because recursively re-walking ignored directories is expensive.
  const [treeLoading, setTreeLoading] = useState(false);
  const [revisionTree, setRevisionTree] = useState<typeof workTree | null>(null);
  const [ignoredTree, setIgnoredTree] = useState<typeof workTree | null>(null);
  const [emptyDirectories, setEmptyDirectories] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const mutationTargetsRepo = filesTreeMutation?.repoPath === meta?.path;
  const workingTreeRevision = selectedCommit || !mutationTargetsRepo ? 0 : filesTreeRevision;
  useEffect(() => setEmptyDirectories(new Set()), [meta?.path]);
  useEffect(() => {
    if (!filesTreeMutation || !mutationTargetsRepo) return;
    setEmptyDirectories((current) => applyEmptyDirectoryMutation(current, filesTreeMutation));
  }, [filesTreeMutation, mutationTargetsRepo]);
  useEffect(() => {
    if (tab !== 'files' || !meta?.path) return;
    let cancelled = false;
    setTreeLoading(true);
    setTreeError(null);
    if (selectedCommit) setRevisionTree(null);
    else setIgnoredTree(null);
    const load = selectedCommit
      ? tauri.repoTreeAt(meta.path, selectedCommit).then((tree) => {
          if (!cancelled) setRevisionTree(tree);
        })
      : tauri.repoTree(meta.path, true).then((tree) => {
          if (!cancelled) setIgnoredTree(tree);
        });
    void load
      .catch((e) => {
        if (!cancelled) {
          setRevisionTree(null);
          setTreeError(errMessage(e));
        }
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, meta?.path, selectedCommit, workingTreeRevision]);

  // Files tab — Pierre receives either the selected revision or working tree.
  // Filtering is Pierre's own in-tree search box, so the shared filter box
  // (git tab only) no longer touches this list.
  const displayedTree = selectedCommit
    ? (revisionTree ?? [])
    : (ignoredTree ?? workTree);
  const filePaths = useMemo(
    () => [
      ...displayedTree.map((e) => e.path),
      ...(selectedCommit ? [] : emptyDirectories),
    ],
    [displayedTree, emptyDirectories, selectedCommit],
  );
  const selectedTreePath = selectedFile && selectedFileIsDirectory
    ? `${selectedFile.replace(/\/+$/, '')}/`
    : selectedFile;
  const fileGitStatus = useMemo(() => workTreeGitStatus(displayedTree), [displayedTree]);
  // Rename / move — the drop handler for drag-to-move in the tree, and the
  // dialog behind the context menu's keyboard-operable equivalent.
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const moveTo = useCallback(
    (sources: string[], dir: string) => {
      const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
      const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
      // The tree validated the drop as a whole; per-source, skip entries the
      // move wouldn't change (already in the target dir, folder into itself).
      const moves = sources
        .filter((s) => parent(s) !== dir && dir !== s && !dir.startsWith(s + '/'))
        .map((s) => ({ from: s, to: dir ? `${dir}/${base(s)}` : base(s) }));
      if (moves.length === 0) return;
      void moveEntries(moves).then((failures) => {
        if (failures.length) {
          const more = failures.length > 1 ? ` (+${failures.length - 1} more)` : '';
          onToast(`Move failed: ${failures[0]}${more}`, 'error');
        }
      });
    },
    [moveEntries, onToast],
  );

  const fileMenu = useCallback(
    (targets: string[], context: TreeMenuContext): TreeMenuItem[] => {
      const rowPath = context.path;
      const rowIsDirectory = context.kind === 'directory';
      const actionPaths = rowIsDirectory ? [rowPath] : targets;
      const items: TreeMenuItem[] = [
        {
          label: 'Open',
          icon: 'content',
          onSelect: () => selectFile(rowPath, selectedCommit, rowIsDirectory),
        },
      ];
      if (!selectedCommit && actionPaths.length === 1) {
        items.push(
          {
            label: 'Open in editor',
            icon: 'external',
            onSelect: () => onOpenFileInEditor(rowPath),
          },
          {
            label: 'Reveal in file manager',
            icon: 'folder-open',
            onSelect: () => {
              if (!meta) return;
              void tauri.repoFileReveal(meta.path, rowPath).catch((cause) =>
                onToast(`Reveal failed: ${errMessage(cause)}`, 'error'));
            },
          },
        );
      }
      if (!selectedCommit && !rowIsDirectory && actionPaths.length === 1) {
        items.push(
          {
            label: 'Open file history',
            icon: 'history',
            onSelect: () => {
              selectFile(rowPath);
              setFileTab('history');
            },
          },
          {
            label: 'Open blame',
            icon: 'blame',
            onSelect: () => {
              selectFile(rowPath);
              setFileTab('blame');
            },
          },
        );
      }
      if (!selectedCommit && actionPaths.length === 1) {
        items.push({
          label: 'Rename / move…',
          icon: 'file',
          onSelect: () => setRenameTarget(rowPath),
        });
        const dir = rowIsDirectory ? rowPath : parentPath(rowPath);
        items.push(
          { label: 'New file here…', icon: 'file', onSelect: () => onCreateFileEntry(dir, false) },
          { label: 'New folder here…', icon: 'folder', onSelect: () => onCreateFileEntry(dir, true) },
        );
      }
      // .gitignore quick actions for a single untracked file.
      if (
        !selectedCommit &&
        !rowIsDirectory &&
        actionPaths.length === 1 &&
        workTree.some((e) => e.path === rowPath && e.status === 'UNTRACKED')
      ) {
        const ignore = (pattern: string) =>
          void gitignoreAdd(pattern).catch((e) => onToast(`Ignore failed: ${errMessage(e)}`, 'error'));
        const base = leafName(rowPath);
        const { exact, extension } = ignorePatterns(rowPath);
        const submenu: MenuItem[] = [
          { label: `Ignore “${base}”`, onSelect: () => ignore(exact) },
        ];
        if (extension) {
          submenu.push({ label: `Ignore all ${extension} files`, onSelect: () => ignore(extension) });
        }
        submenu.push({ label: 'Custom pattern…', onSelect: () => openIgnoreDialog(rowPath) });
        items.push({ label: 'Ignore', icon: 'file', submenu });
      }
      items.push({
        label: actionPaths.length > 1 ? 'Copy relative paths' : 'Copy relative path',
        icon: 'file',
        onSelect: () => {
          copyToClipboard(actionPaths.join('\n'));
          onToast(actionPaths.length > 1 ? 'Relative paths copied' : 'Relative path copied');
        },
      });
      if (!selectedCommit && meta) {
        items.push({
          label: actionPaths.length > 1 ? 'Copy absolute paths' : 'Copy absolute path',
          icon: 'file',
          onSelect: () => {
            void tauri.repoFileAbsolutePaths(meta.path, actionPaths).then(
              (paths) => {
                copyToClipboard(paths.join('\n'));
                onToast(paths.length > 1 ? 'Absolute paths copied' : 'Absolute path copied');
              },
              (cause) => onToast(`Copy failed: ${errMessage(cause)}`, 'error'),
            );
          },
        });
        items.push({
          label: rowIsDirectory
            ? 'Delete folder'
            : actionPaths.length > 1
              ? `Delete ${actionPaths.length} files`
              : 'Delete file',
          icon: 'trash',
          danger: true,
          confirm: true,
          onSelect: () => {
            void tauri.repoFileDelete(meta.path, actionPaths).then(
              async () => {
                if (selectedFile && actionPaths.some((path) =>
                  selectedFile === path || selectedFile.startsWith(`${path}/`))) {
                  setView('local');
                  selectFile(null);
                }
                await refreshLocalChanges();
                markFilesTreeChanged(meta.path, { kind: 'delete', paths: actionPaths });
                onToast(actionPaths.length > 1 ? `Deleted ${actionPaths.length} entries` : `Deleted ${actionPaths[0]}`);
              },
              (cause) => onToast(`Delete failed: ${errMessage(cause)}`, 'error'),
            );
          },
        });
      }
      return items;
    },
    [
      gitignoreAdd,
      meta,
      markFilesTreeChanged,
      onCreateFileEntry,
      onOpenFileInEditor,
      onToast,
      openIgnoreDialog,
      refreshLocalChanges,
      selectFile,
      selectedCommit,
      selectedFile,
      setFileTab,
      setView,
      workTree,
    ],
  );

  const renameDialog = renameTarget ? (
    <RenameFileDialog
      from={renameTarget}
      onClose={() => setRenameTarget(null)}
      onToast={onToast}
    />
  ) : null;

  // Branch/tag ops don't toast on success (the sidebar itself updates), but
  // failures must be loud — a silently refused checkout reads as the app
  // doing nothing (DAN-12).
  const runBranchOp = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { onToast(errMessage(e), 'error'); }
  };

  // Tag network ops surface success/failure via a toast — a push can fail on
  // auth or a missing upstream.
  const runTagPush = (name: string) => {
    void (async () => {
      try {
        await pushTag(name);
        onToast(`Pushed ${name} to ${tagRemote}`);
      } catch (e) {
        onToast(`Push failed: ${errMessage(e)}`, 'error');
      }
    })();
  };
  const runTagDeleteRemote = (name: string) => {
    void (async () => {
      try {
        await deleteRemoteTag(name);
        onToast(`Deleted ${name} on ${tagRemote}`);
      } catch (e) {
        onToast(`Remote delete failed: ${errMessage(e)}`, 'error');
      }
    })();
  };

  const runRemoteBranchDelete = (rb: RemoteBranch) => {
    void (async () => {
      try {
        await deleteRemoteBranch(rb.remote, rb.branch);
        onToast(`Deleted ${rb.branch} on ${rb.remote}`);
      } catch (e) {
        onToast(`Remote delete failed: ${errMessage(e)}`, 'error');
      }
    })();
  };

  // ── per-row menus — every action a row supports lives here ──
  const localBranchName = (rb: RemoteBranch) =>
    refs.branches.some((b) => b.name === rb.branch) ? `${rb.remote}/${rb.branch}` : rb.branch;

  // Merge/rebase a non-current branch into/onto the current one. Both can
  // conflict — surface git's message (and success) via a toast.
  const runRebase = (onto: string) => {
    void (async () => {
      try {
        const conflicted = await rebase(onto);
        onToast(
          conflicted
            ? `Rebase onto ${onto} has conflicts — resolve in Local Changes`
            : `Rebased ${currentBranch} onto ${onto}`,
        );
      } catch (e) {
        onToast(`Rebase failed: ${errMessage(e)}`, 'error');
      }
    })();
  };

  // Pin the review baseline at merge-base(HEAD, base) and open the Review
  // view — the current branch's own work, reviewed against the branch the
  // user picked instead of an auto-detected one.
  const reviewAgainst = (base: string) => {
    void (async () => {
      if (!meta) return;
      try {
        const oid = await tauri.repoMergeBase(meta.path, 'HEAD', base);
        await setBaseline(oid);
        setView('review');
        selectFile(null);
      } catch (e) {
        onToast(`Can't compare with ${base}: ${errMessage(e)}`, 'error');
      }
    })();
  };

  const compareAgainst = (target: string) => {
    if (!currentBranch) {
      onToast('Check out a local branch before comparing refs', 'error');
      return;
    }
    setRefCompare({ from: target, to: currentBranch });
  };

  const branchMenu = (b: Branch): MenuItem[] => {
    const newBranchItem: MenuItem = {
      label: 'New branch from here…',
      icon: 'plus',
      onSelect: () => onCreateBranch(b.name, b.name),
    };
    const newWorktreeItem: MenuItem = {
      label: 'New worktree from here…',
      icon: 'worktree',
      onSelect: () => onCreateWorktree({ ref: b.name, label: b.name }),
    };
    const renameItem: MenuItem = {
      label: 'Rename branch…',
      icon: 'edit',
      onSelect: () => onRenameBranch(b.name),
    };
    if (b.is_head) {
      // Interactive rebase over the commits this branch is ahead of its
      // upstream (`upstream..HEAD`) — the unpushed work it's safe to edit.
      const up = b.upstream?.name;
      return [
        { label: 'Current branch', disabled: true, onSelect: () => {} },
        {
          label: 'Pull',
          icon: 'arrow-down',
          submenu: [
            { label: `Repository default (${pullMode === 'default' ? 'Git configuration' : pullMode})`, icon: 'check', onSelect: () => onPull() },
            { label: 'Use Git configuration', onSelect: () => onPull('default') },
            { label: 'Merge (fast-forward if possible)', onSelect: () => onPull('merge') },
            { label: 'Rebase', onSelect: () => onPull('rebase') },
            { label: 'Fast-forward only', onSelect: () => onPull('fast-forward-only') },
          ],
        },
        { label: 'Push to remote…', icon: 'remote', onSelect: () => onManageBranchNetwork({ kind: 'push', branch: b }) },
        { label: b.upstream ? `Change upstream (${b.upstream.name})…` : 'Set upstream…', icon: 'remote', onSelect: () => onManageBranchNetwork({ kind: 'upstream', branch: b }) },
        {
          label: 'Push',
          icon: 'arrow-up',
          submenu: [
            { label: 'Current branch', onSelect: () => onPush('default') },
            { label: 'With annotated tags', onSelect: () => onPush('follow-tags') },
            { label: 'Force with lease…', danger: true, onSelect: onForcePush },
          ],
        },
        newBranchItem,
        newWorktreeItem,
        renameItem,
        {
          label: 'Interactive rebase…',
          icon: 'rebase',
          onSelect: () =>
            up
              ? onInteractiveRebase(up, up)
              : onToast('No upstream configured — use “Rebase from here” on a commit'),
        },
        {
          label: 'Compare branch…',
          icon: 'compare',
          disabled: compareChoices.length < 2,
          onSelect: () => {
            const other = compareChoices.find((choice) => choice.value !== b.name);
            if (other) setRefCompare({ from: other.value, to: b.name });
          },
        },
        { label: 'Copy branch name', icon: 'file', onSelect: () => { void copyToClipboard(b.name); onToast('Branch name copied'); } },
        { label: 'Copy full ref', icon: 'file', onSelect: () => { void copyToClipboard(b.full_name); onToast('Branch ref copied'); } },
        { label: 'Copy commit SHA', icon: 'file', onSelect: () => { void copyToClipboard(b.target); onToast('Commit SHA copied'); } },
      ];
    }
    const wt = worktreeByBranch.get(b.name);
    const items: MenuItem[] = [
      // A branch that is HEAD of another worktree can't be checked out here —
      // offer its worktree tab where Checkout would sit.
      wt
        ? { label: 'Open worktree', icon: 'worktree', onSelect: () => void openWorktree(wt.path) }
        : { label: 'Checkout', icon: 'branch', onSelect: () => void runBranchOp(() => checkout(b.name)) },
      { label: 'Push to remote…', icon: 'arrow-up', onSelect: () => onManageBranchNetwork({ kind: 'push', branch: b }) },
      { label: b.upstream ? `Change upstream (${b.upstream.name})…` : 'Set upstream…', icon: 'remote', onSelect: () => onManageBranchNetwork({ kind: 'upstream', branch: b }) },
      newBranchItem,
      newWorktreeItem,
      renameItem,
    ];
    if (currentBranch) {
      items.push({ label: `Compare ${currentBranch} with this…`, icon: 'compare', onSelect: () => compareAgainst(b.name) });
      items.push({ label: `Review ${currentBranch} vs this`, icon: 'eye', onSelect: () => reviewAgainst(b.name) });
      items.push({ label: `Merge into ${currentBranch}`, icon: 'branch', onSelect: () => onMerge(b.name, currentBranch) });
      items.push({ label: `Rebase ${currentBranch} onto this`, icon: 'rebase', confirm: true, onSelect: () => runRebase(b.name) });
    }
    items.push(
      { label: 'Copy branch name', icon: 'file', onSelect: () => { void copyToClipboard(b.name); onToast('Branch name copied'); } },
      { label: 'Copy full ref', icon: 'file', onSelect: () => { void copyToClipboard(b.full_name); onToast('Branch ref copied'); } },
      { label: 'Copy commit SHA', icon: 'file', onSelect: () => { void copyToClipboard(b.target); onToast('Commit SHA copied'); } },
    );
    items.push({ label: 'Delete branch', icon: 'trash', danger: true, confirm: true, onSelect: () => void runBranchOp(() => deleteBranch(b.name, true)) });
    return items;
  };

  const remoteMenu = (rb: RemoteBranch): MenuItem[] => {
    const local = localByUpstream.get(rb.name);
    const items: MenuItem[] = [];
    items.push({ label: 'Fetch this branch', icon: 'arrow-down', onSelect: () => onFetchBranch(rb) });
    if (currentBranch) {
      items.push({
        label: `Compare ${currentBranch} with this…`,
        icon: 'compare',
        onSelect: () => compareAgainst(rb.name),
      });
      items.push({
        label: `Pull into ${currentBranch}`,
        icon: 'arrow-down',
        submenu: [
          { label: `Repository default (${pullMode === 'default' ? 'Git configuration' : pullMode})`, confirm: true, onSelect: () => onPullBranch(rb) },
          { label: 'Use Git configuration', confirm: true, onSelect: () => onPullBranch(rb, 'default') },
          { label: 'Merge (fast-forward if possible)', confirm: true, onSelect: () => onPullBranch(rb, 'merge') },
          { label: 'Rebase', confirm: true, onSelect: () => onPullBranch(rb, 'rebase') },
          { label: 'Fast-forward only', confirm: true, onSelect: () => onPullBranch(rb, 'fast-forward-only') },
        ],
      });
      const head = refs.branches.find((branch) => branch.is_head);
      if (head && head.upstream?.name !== rb.name) {
        items.push({
          label: `Set as upstream for ${head.name}`,
          icon: 'remote',
          onSelect: () => {
            void setBranchUpstream(head.name, rb.name).then(
              () => onToast(`${head.name} now tracks ${rb.name}`),
              (caught) => onToast(`Upstream failed: ${errMessage(caught)}`, 'error'),
            );
          },
        });
      }
    }
    if (local) {
      items.push(
        local.is_head
          ? { label: `Tracked by current branch (${local.name})`, disabled: true, onSelect: () => {} }
          : { label: `Checkout ${local.name}`, icon: 'branch', onSelect: () => void runBranchOp(() => checkout(local.name)) },
      );
    }
    if (!local) {
      items.push({
        label: 'Create local branch & track',
        icon: 'branch',
        onSelect: () => void runBranchOp(() => createBranch(localBranchName(rb), rb.name, true)),
      });
    }
    // Same create, but with a chosen name (auto-tracks — core wires upstream
    // when the start point is a remote-tracking branch).
    items.push({
      label: 'New branch from here…',
      icon: 'plus',
      onSelect: () => onCreateBranch(rb.name, rb.name),
    });
    items.push({
      label: 'New worktree from here…',
      icon: 'worktree',
      onSelect: () => onCreateWorktree({ ref: rb.name, label: rb.name }),
    });
    items.push(
      { label: 'Copy branch name', icon: 'file', onSelect: () => { void copyToClipboard(rb.branch); onToast('Branch name copied'); } },
      { label: 'Copy remote ref', icon: 'file', onSelect: () => { void copyToClipboard(rb.name); onToast('Remote branch ref copied'); } },
      { label: 'Copy commit SHA', icon: 'file', onSelect: () => { void copyToClipboard(rb.target); onToast('Commit SHA copied'); } },
    );
    items.push({
      label: `Delete branch on ${rb.remote}`,
      icon: 'trash',
      danger: true,
      confirm: true,
      onSelect: () => runRemoteBranchDelete(rb),
    });
    return items;
  };

  // Menu for a remotes-tree top-level folder — the remote itself (`origin`),
  // not one of its branches.
  const remoteFolderMenu = (name: string): MenuItem[] => {
    const remote = refs.remotes.find((r) => r.name === name);
    const url = remote?.url ?? null;
    const pushUrl = remote?.push_url ?? null;
    const items: MenuItem[] = [
      {
        label: 'Fetch',
        icon: 'arrow-down',
        onSelect: () =>
          void fetchRemote(name).then(
            () => onToast(`Fetched ${name}`),
            (e) => onToast(`Fetch failed: ${errMessage(e)}`, 'error'),
          ),
      },
      {
        label: 'Prune stale branches',
        icon: 'sync',
        onSelect: () =>
          void fetchRemote(name, true).then(
            () => onToast(`Pruned ${name}`),
            (e) => onToast(`Prune failed: ${errMessage(e)}`, 'error'),
          ),
      },
      {
        label: 'Edit URLs…',
        icon: 'edit',
        onSelect: () => onManageRemote({ kind: 'url', name, url: url ?? '', pushUrl: pushUrl ?? '' }),
      },
      {
        label: 'Inspect refspecs…',
        icon: 'search',
        onSelect: () => onManageRemote({
          kind: 'refspecs',
          name,
          fetchRefspecs: remote?.fetch_refspecs ?? [],
          pushRefspecs: remote?.push_refspecs ?? [],
        }),
      },
      { label: 'Rename…', icon: 'edit', onSelect: () => onManageRemote({ kind: 'rename', name }) },
    ];
    if (remote?.is_default) {
      items.push({ label: 'Default remote', icon: 'check', disabled: true });
    } else {
      items.push({
        label: 'Set as default remote',
        icon: 'check',
        onSelect: () => void setDefaultRemote(name).then(
          () => onToast(`Default remote: ${name}`),
          (e) => onToast(`Set default failed: ${errMessage(e)}`, 'error'),
        ),
      });
    }
    if (url) {
      items.push({ label: 'Copy fetch URL', icon: 'file', onSelect: () => { void copyToClipboard(url); onToast('Fetch URL copied'); } });
    }
    if (pushUrl) {
      items.push({ label: 'Copy push URL', icon: 'file', onSelect: () => { void copyToClipboard(pushUrl); onToast('Push URL copied'); } });
    }
    items.push({
      label: 'Remove remote',
      icon: 'trash',
      danger: true,
      confirm: true,
      onSelect: () => void removeRemote(name).catch((e) => onToast(`Remove failed: ${errMessage(e)}`, 'error')),
    });
    return items;
  };

  const tagMenu = (tg: Tag): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Checkout', icon: 'branch', onSelect: () => void runBranchOp(() => checkoutCommit(tg.target)) },
      { label: 'New branch from here…', icon: 'plus', onSelect: () => onCreateBranch(tg.full_name, tg.name) },
      { label: 'New worktree from here…', icon: 'worktree', onSelect: () => onCreateWorktree({ ref: tg.full_name, label: tg.name }) },
    ];
    if (currentBranch) {
      items.push({ label: `Compare ${currentBranch} with this tag…`, icon: 'compare', onSelect: () => compareAgainst(tg.full_name) });
    }
    if (tagRemote) {
      items.push({ label: `Push to ${tagRemote}`, icon: 'arrow-up', onSelect: () => runTagPush(tg.name) });
      // Gray out remote-delete when we know the remote doesn't have this tag.
      // `remoteTags === null` means we haven't checked yet → leave it enabled.
      const onRemote = remoteTags === null || remoteTags.includes(tg.name);
      items.push({
        label: `Delete on ${tagRemote}`,
        icon: 'remote',
        danger: true,
        confirm: true,
        disabled: !onRemote,
        onSelect: () => runTagDeleteRemote(tg.name),
      });
    }
    items.push(
      { label: 'Copy tag name', icon: 'file', onSelect: () => { void copyToClipboard(tg.name); onToast('Tag name copied'); } },
      { label: 'Copy commit SHA', icon: 'file', onSelect: () => { void copyToClipboard(tg.target); onToast('Commit SHA copied'); } },
    );
    items.push({ label: 'Delete tag', icon: 'trash', danger: true, confirm: true, onSelect: () => void runBranchOp(() => deleteTag(tg.name)) });
    return items;
  };

  const inspectStash = (s: Stash) => {
    revealInGraph(s.oid);
  };

  const stashMenu = (s: Stash): MenuItem[] => [
    { label: 'Inspect changes', icon: 'search', onSelect: () => inspectStash(s) },
    { label: 'Apply', icon: 'arrow-down', onSelect: () => void runBranchOp(() => stashApply(s.index)) },
    { label: 'Pop (apply & remove)', icon: 'arrow-up', onSelect: () => void runBranchOp(() => stashPop(s.index)) },
    { label: 'Create branch from stash…', icon: 'branch', onSelect: () => onBranchFromStash(s.index) },
    { label: 'Copy stash name', icon: 'file', onSelect: () => { void copyToClipboard(`stash@{${s.index}}`); onToast('Stash name copied'); } },
    { label: 'Copy commit SHA', icon: 'file', onSelect: () => { void copyToClipboard(s.oid); onToast('Commit SHA copied'); } },
    { label: 'Drop', icon: 'trash', danger: true, confirm: true, onSelect: () => void runBranchOp(() => stashDrop(s.index)) },
  ];

  // Open a submodule's working tree as its own repo tab (via openByPath, which
  // shows the progress popup). Paths join the canonical superproject path with
  // the forward-slashed submodule path — git's discover handles mixed separators.
  const openSubmodule = (sub: Submodule) => {
    if (!meta || !sub.initialized) return;
    onOpenRecent(`${meta.path}/${sub.path}`);
  };
  // `git submodule update` (always --init --recursive) for the given paths
  // (empty ⇒ all). Surfaces start + result via a toast.
  const runSubmoduleUpdate = (paths: string[], label: string) => {
    void (async () => {
      onToast(`Updating ${label}…`);
      try {
        await submoduleUpdate(paths, true, true);
        onToast(`Updated ${label}`);
      } catch (e) {
        onToast(`Submodule update failed: ${errMessage(e)}`, 'error');
      }
    })();
  };
  const submoduleMenu = (sub: Submodule): MenuItem[] => {
    const items: MenuItem[] = [];
    if (sub.initialized) {
      items.push({ label: 'Open submodule', icon: 'folder-open', onSelect: () => openSubmodule(sub) });
    }
    items.push({
      label: sub.initialized ? 'Update' : 'Init & update',
      icon: 'arrow-down',
      onSelect: () => runSubmoduleUpdate([sub.path], leafName(sub.path)),
    });
    items.push({ label: 'Copy path', icon: 'file', onSelect: () => void copyToClipboard(sub.path) });
    return items;
  };

  // Remove a worktree, surfacing git's reason on failure (it refuses a dirty
  // worktree without --force, so the menu offers a separate Force remove).
  const runWorktreeRemove = (w: Worktree, force: boolean) => {
    void (async () => {
      try {
        await removeWorktree(w.path, force);
        onToast(`Removed worktree ${w.branch ?? leafName(w.path)}`);
      } catch (e) {
        onToast(`Remove failed: ${errMessage(e)}`, 'error');
      }
    })();
  };
  // The same review flow as the overview's Review button (store-owned).
  const runWorktreeReview = (w: Worktree) => {
    void (async () => {
      const { base, detectError } = await reviewWorktree(w);
      if (base) onToast(`Reviewing ${w.branch ?? leafName(w.path)} vs ${base}`);
      else if (detectError) onToast(`Can't detect base branch: ${detectError}`, 'error');
    })();
  };
  // "Merge & clean up" needs the worktree's health + dirty count before the
  // dialog can render — fetched on demand when the menu item is picked.
  const openWorktreeMerge = (w: Worktree) => {
    if (!w.branch) return;
    void (async () => {
      try {
        const [health, status] = await Promise.all([
          tauri.repoWorktreeHealth(w.path, w.branch as string),
          tauri.repoStatus(w.path),
        ]);
        setWtMerge({ worktree: w, health, dirty: status.length });
      } catch (e) {
        onToast(`Can't load worktree state: ${errMessage(e)}`, 'error');
      }
    })();
  };
  const runWorktreeLock = (w: Worktree, lock: boolean) => {
    if (!meta) return;
    void (async () => {
      try {
        if (lock) await tauri.repoWorktreeLock(meta.path, w.path, null);
        else await tauri.repoWorktreeUnlock(meta.path, w.path);
        await refreshWorktrees();
        onToast(lock ? `Locked ${leafName(w.path)}` : `Unlocked ${leafName(w.path)}`);
      } catch (e) {
        onToast(`${lock ? 'Lock' : 'Unlock'} failed: ${errMessage(e)}`, 'error');
      }
    })();
  };
  const worktreeMenu = (w: Worktree): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: w.is_current ? 'Focus tab' : 'Open in new tab',
        icon: 'folder-open',
        onSelect: () => void openWorktree(w.path),
      },
    ];
    if (!w.is_main) {
      items.push({ label: 'Review vs base', icon: 'eye', onSelect: () => runWorktreeReview(w) });
      if (w.branch) {
        items.push({ label: 'Merge & clean up…', icon: 'branch', onSelect: () => openWorktreeMerge(w) });
      }
    }
    items.push({ label: 'Show in overview', icon: 'worktree', onSelect: () => setView('worktrees') });
    items.push({ label: 'Copy path', icon: 'file', onSelect: () => void copyToClipboard(w.path) });
    if (!w.is_main) {
      items.push(
        w.is_locked
          ? { label: 'Unlock worktree', icon: 'lock', onSelect: () => runWorktreeLock(w, false) }
          : { label: 'Lock worktree', icon: 'lock', onSelect: () => runWorktreeLock(w, true) },
      );
    }
    // The main worktree and the one you're in can't be removed.
    if (!w.is_main && !w.is_current) {
      items.push({ label: 'Remove worktree', icon: 'trash', danger: true, confirm: true, onSelect: () => runWorktreeRemove(w, false) });
      items.push({ label: 'Force remove (discard changes)', icon: 'trash', danger: true, confirm: true, onSelect: () => runWorktreeRemove(w, true) });
    }
    if (w.is_prunable) {
      items.push({ label: 'Prune stale entries', icon: 'sync', onSelect: () => void pruneWorktrees() });
    }
    return items;
  };

  const worktreeMeta = (w: Worktree): string | undefined => {
    const labels = [
      w.is_main ? 'main' : null,
      w.is_current ? 'current' : null,
      w.is_locked ? 'locked' : null,
      w.is_detached ? 'detached' : null,
      w.is_prunable ? 'stale' : null,
    ].filter((x): x is string => Boolean(x));
    return labels.length > 0 ? labels.join(' · ') : undefined;
  };

  const renderBranchLeaf = (b: Branch, depth: number) => {
    const wt = !b.is_head ? worktreeByBranch.get(b.name) : undefined;
    return (
      <SideLeaf
        key={b.full_name}
        depth={depth}
        icon={b.is_head ? 'check' : wt ? 'worktree' : 'branch'}
        label={b.name}
        meta={wt ? 'worktree' : undefined}
        merged={b.merged}
        title={
          wt
            ? `${b.name} — checked out in worktree ${wt.path}; double-click to open it`
            : b.merged && refs.primary_branch
              ? `${b.name} — merged into ${refs.primary_branch}; safe to delete`
              : undefined
        }
        active={b.is_head}
        ahead={b.upstream ? b.ahead : 0}
        behind={b.upstream ? b.behind : 0}
        onActivate={() => {
          if (b.is_head) return;
          if (wt) void openWorktree(wt.path);
          else void runBranchOp(() => checkout(b.name));
        }}
        onSelect={() => revealInGraph(b.target)}
        onMenu={(x, y) => openMenu(x, y, branchMenu(b))}
      />
    );
  };

  // Remote rows with a local tracking branch check the local out on
  // activate; only untracked ones create-and-track (avoids accidentally
  // minting a local literally named `origin/main`). Both via the menu too.
  const renderRemoteLeaf = (rb: RemoteBranch, depth: number) => {
    const local = localByUpstream.get(rb.name);
    return (
      <SideLeaf
        key={rb.full_name}
        depth={depth}
        icon="branch"
        label={rb.branch}
        meta={local ? 'tracked' : undefined}
        title={
          local
            ? `${rb.name} — tracked by ${local.name}; double-click to check ${local.name} out`
            : `${rb.name} — double-click to create a tracking branch`
        }
        onActivate={() =>
          void runBranchOp(() =>
            local
              ? local.is_head
                ? Promise.resolve()
                : checkout(local.name)
              : createBranch(localBranchName(rb), rb.name, true),
          )
        }
        onSelect={() => revealInGraph(rb.target)}
        onMenu={(x, y) => openMenu(x, y, remoteMenu(rb))}
      />
    );
  };

  const renderTagLeaf = (tg: Tag, depth: number) => (
    <SideLeaf
      key={tg.full_name}
      depth={depth}
      icon="tag"
      label={leafName(tg.name)}
      meta={tg.annotated ? 'annotated' : undefined}
      title={`${leafName(tg.name)} — click to reveal, double-click to check out`}
      onActivate={() => void runBranchOp(() => checkoutCommit(tg.target))}
      onSelect={() => revealInGraph(tg.target)}
      onMenu={(x, y) => openMenu(x, y, tagMenu(tg))}
    />
  );

  const fileCreateToolbar = (
    <div
      className={'side-files-tools' + (filePaths.length === 0 ? ' standalone' : '')}
      role="toolbar"
      aria-label="Working-tree file actions"
    >
      <button
        ref={fileCreateButtonRef}
        type="button"
        className="side-files-create"
        title={t('files.createEntry')}
        aria-label={t('files.createEntry')}
        aria-haspopup="menu"
        aria-expanded={menu?.source === 'file-create'}
        onClick={openFileCreateMenu}
      >
        <Icon name="plus" size={14} stroke={2} />
      </button>
    </div>
  );

  return (
    <div className="sidebar">
      {wtMerge && (
        <WorktreeMergeDialog
          worktree={wtMerge.worktree}
          health={wtMerge.health}
          dirty={wtMerge.dirty}
          onClose={() => setWtMerge(null)}
          onToast={onToast}
        />
      )}
      {refCompare && meta && (
        <CompareRefsDialog
          repoPath={meta.path}
          choices={compareChoices}
          initialFrom={refCompare.from}
          initialTo={refCompare.to}
          title="Compare branches and refs"
          onClose={() => setRefCompare(null)}
        />
      )}
      <div className="side-primary">
        <SideRow
          icon="changes"
          label={t('nav.localChanges')}
          badge={unstaged || undefined}
          active={view === 'local'}
          onClick={() => { setView('local'); selectFile(null); }}
        />
        <SideRow
          icon="check"
          label={t('nav.review')}
          active={view === 'review' || view === 'workspace-review'}
          onClick={() => { setView('review'); selectFile(null); }}
        />
        <SideRow
          icon="remote"
          label={t('nav.pullRequests')}
          active={view === 'pull-requests'}
          onClick={() => { setView('pull-requests'); selectFile(null); }}
        />
        <SideRow
          icon="graph"
          label={t('nav.allCommits')}
          active={view === 'commits' || view === 'reflog'}
          onClick={() => { setView('commits'); selectFile(null); }}
        />
      </div>

      <div className="side-tabs">
        <button type="button" className={'side-tab' + (tab === 'git' ? ' on' : '')} onClick={() => setTab('git')}>
          <Icon name="branch" size={12} />
          <span>{t('nav.git')}</span>
        </button>
        <button type="button" className={'side-tab' + (tab === 'files' ? ' on' : '')} onClick={() => setTab('files')}>
          <Icon name="folder" size={12} />
          <span>{t('nav.files')}</span>
        </button>
      </div>

      {tab === 'git' && (
        <div className="side-filter">
          <Icon name="search" size={11} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('nav.filterRefs')}
            aria-label={t('nav.filterRefsLabel')}
          />
        </div>
      )}

      {!meta ? (
        <div className="side-scroll">
          <EmptyRepoState recents={recents} onOpenRepo={onOpenRepo} onOpenRecent={onOpenRecent} onForget={forgetRecent} />
        </div>
      ) : tab === 'git' ? (
        <div className="side-scroll">
          <SideSection
            label="Worktrees"
            collapsed={!sections.worktrees}
            onToggle={() => toggle('worktrees')}
            count={filteredWorktrees.length}
            action={{ icon: 'plus', title: 'New worktree…', onClick: () => onCreateWorktree() }}
          />
          {sections.worktrees &&
            filteredWorktrees.map((w) => (
              <SideLeaf
                key={w.path}
                depth={0}
                icon={w.is_current ? 'check' : 'worktree'}
                label={worktreeName(w)}
                active={w.is_current}
                meta={worktreeMeta(w)}
                title={`${w.path}${w.is_main ? ' — main worktree' : ''}${w.is_current ? ' — current' : ' — double-click to open in a tab'}`}
                onActivate={() => void openWorktree(w.path)}
                onSelect={() => setView('worktrees')}
                onMenu={(x, y) => openMenu(x, y, worktreeMenu(w))}
              />
            ))}

          <SideSection
            label="Branches"
            collapsed={!sections.branches}
            onToggle={() => toggle('branches')}
            count={filtered.branches.length}
            action={{ icon: 'plus', title: 'New branch…', onClick: () => onCreateBranch(null, 'HEAD') }}
          />
          {sections.branches &&
            renderTreeChildren(branchTree, 0, collapsed, toggleCollapsed, renderBranchLeaf, 'branches')}

          <SideSection
            label="Remotes"
            collapsed={!sections.remotes}
            onToggle={() => toggle('remotes')}
            count={refs.remotes.length}
            action={{ icon: 'plus', title: 'Add remote…', onClick: () => onManageRemote({ kind: 'add' }) }}
          />
          {sections.remotes &&
            renderTreeChildren(remoteTree, 0, collapsed, toggleCollapsed, renderRemoteLeaf, 'remotes', {
              folderIcon: 'remote',
              showFolderCount: false,
              folderMenu: remoteFolderMenu,
              openMenu,
            })}

          <SideSection
            label="Tags"
            collapsed={!sections.tags}
            onToggle={() => toggle('tags')}
            count={filtered.tags.length}
            action={{ icon: 'plus', title: 'New tag…', onClick: onCreateTag }}
          />
          {sections.tags &&
            renderTreeChildren(tagTree, 0, collapsed, toggleCollapsed, renderTagLeaf, 'tags')}

          <SideSection
            label="Stashes"
            collapsed={!sections.stashes}
            onToggle={() => toggle('stashes')}
            count={filteredStashes.length}
            action={{ icon: 'plus', title: 'Save snapshot…', onClick: onCreateStash }}
          />
          {sections.stashes &&
            filteredStashes.map((s) => (
              <SideLeaf
                key={s.index}
                depth={0}
                icon="stash"
                label={stashLabel(s)}
                meta={s.branch ?? undefined}
                title={`${stashLabel(s)} — click to inspect; double-click to apply`}
                onSelect={() => inspectStash(s)}
                onActivate={() => void runBranchOp(() => stashApply(s.index))}
                onMenu={(x, y) => openMenu(x, y, stashMenu(s))}
              />
            ))}

          <SideSection
            label="Submodules"
            collapsed={!sections.submods}
            onToggle={() => toggle('submods')}
            count={filteredSubmodules.length}
            action={
              submodules.length > 0
                ? { icon: 'sync', title: 'Update all submodules', onClick: () => runSubmoduleUpdate([], 'all submodules') }
                : undefined
            }
          />
          {sections.submods &&
            filteredSubmodules.map((sub) => (
              <SideLeaf
                key={sub.path}
                depth={0}
                icon="submodule"
                label={leafName(sub.path)}
                meta={submoduleStateLabel(sub.status)}
                title={`${sub.path}${sub.url ? ` — ${sub.url}` : ''}${sub.initialized ? ' — double-click to open' : ' — not initialized'}`}
                onActivate={() => openSubmodule(sub)}
                onMenu={(x, y) => openMenu(x, y, submoduleMenu(sub))}
              />
            ))}
        </div>
      ) : (
        <div className="side-files">
          {renameDialog}
          {!selectedCommit && filePaths.length === 0 && fileCreateToolbar}
          {selectedCommit && (
            <div className="side-files-revision" title={`Files at commit ${selectedCommit}`}>
              Files at <code>{selectedCommit.slice(0, 7)}</code>
            </div>
          )}
          <PierreTree
            paths={filePaths}
            gitStatus={fileGitStatus}
            onMove={selectedCommit ? undefined : moveTo}
            selectedPath={selectedTreePath}
            onSelect={(p, kind) => selectFile(p, selectedCommit, kind === 'directory')}
            menuItems={fileMenu}
            search
            searchAction={!selectedCommit && filePaths.length > 0 ? fileCreateToolbar : undefined}
            initialExpansion="closed"
            emptyLabel={
              treeLoading
                ? selectedCommit ? 'Loading commit tree…' : 'Loading working tree…'
                : treeError ?? (selectedCommit ? 'No files at this commit.' : 'No files in the working tree.')
            }
          />
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

// Render a TreeNode's children (not the root itself) into a flat JSX list.
// `renderLeaf` provides the row for a leaf; folder rows are handled here.
// `keyPrefix` namespaces the collapse key per tree (branches/remotes/tags/files)
// so a folder named `feature/` in one tree doesn't fold a same-named folder in
// another — all four trees share one `collapsed` Set.
function renderTreeChildren<T>(
  node: TreeNode<T>,
  depth: number,
  collapsed: Set<string>,
  toggleCollapsed: (path: string) => void,
  renderLeaf: (item: T, depth: number) => React.ReactNode,
  keyPrefix: string,
  folderOpts?: {
    folderIcon?: IconName;
    showFolderCount?: boolean;
    /** Context-menu items for a *top-level* (depth-0) folder — the remotes
     * tree's remote-name rows. Opened via `openMenu` (the owner's menu state). */
    folderMenu?: (name: string) => MenuItem[];
    openMenu?: (x: number, y: number, items: MenuItem[]) => void;
  },
): React.ReactNode {
  const open = folderOpts?.openMenu;
  const menuFor = depth === 0 ? folderOpts?.folderMenu : undefined;
  return node.children.map((child) => {
    if (child.children.length === 0 && child.leaf != null) {
      return renderLeaf(child.leaf, depth);
    }
    const collapseKey = `${keyPrefix}:${child.fullPath}`;
    const isCollapsed = collapsed.has(collapseKey);
    return (
      <div key={child.fullPath}>
        <FolderRow
          name={child.name}
          depth={depth}
          collapsed={isCollapsed}
          icon={folderOpts?.folderIcon ?? 'folder'}
          count={folderOpts?.showFolderCount === false ? undefined : child.leaves}
          onToggle={() => toggleCollapsed(collapseKey)}
          onMenu={menuFor && open ? (x, y) => open(x, y, menuFor(child.name)) : undefined}
        />
        {!isCollapsed &&
          renderTreeChildren(child, depth + 1, collapsed, toggleCollapsed, renderLeaf, keyPrefix, folderOpts)}
      </div>
    );
  });
}

function leafName(fullName: string): string {
  const i = fullName.lastIndexOf('/');
  return i === -1 ? fullName : fullName.slice(i + 1);
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Muted trailing label for a submodule row; clean (up-to-date) shows nothing. */
function submoduleStateLabel(s: SubmoduleState): string {
  switch (s) {
    case 'uninitialized': return 'uninit';
    case 'out-of-date': return 'out of date';
    case 'modified': return 'modified';
    case 'up-to-date': return '';
  }
}

// Strip the "WIP on <branch>: " / "On <branch>: " prefix git prepends — the
// branch already shows in the row meta, so the label keeps just the
// description (a custom message, or "<oid> <subject>" for an auto-stash).
function stashLabel(s: Stash): string {
  const m = s.message;
  const colon = m.indexOf(':');
  if (colon !== -1 && (m.startsWith('WIP on ') || m.startsWith('On '))) {
    const rest = m.slice(colon + 1).trim();
    if (rest) return rest;
  }
  return m;
}

// ─── row components ─────────────────────────────────────────────────────

interface FolderRowProps {
  name: string;
  depth: number;
  collapsed: boolean;
  /** Leaf icon for the folder (default `folder`; remotes use `remote`). */
  icon?: IconName;
  /** Child count shown on the right; omit to hide it (e.g. remote groups). */
  count?: number;
  onToggle: () => void;
  /** Open the folder's action menu at the given viewport coordinates —
   * wired like SideLeaf's (right-click, or ContextMenu / Shift+F10). */
  onMenu?: (x: number, y: number) => void;
}

function FolderRow({ name, depth, collapsed, icon = 'folder', count, onToggle, onMenu }: FolderRowProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const openKeyboardMenu = () => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r) onMenu?.(r.left + 12, r.bottom - 4);
  };
  return (
    <button
      ref={rowRef}
      type="button"
      className={'side-row branch-folder' + (collapsed ? ' collapsed' : '')}
      style={{ paddingLeft: 16 + depth * 14 }}
      onClick={onToggle}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      onKeyDown={
        onMenu
          ? (e) => {
              if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                e.preventDefault();
                openKeyboardMenu();
              }
            }
          : undefined
      }
      title={name}
    >
      <span className="folder-chev"><Icon name="chev-down" size={8} stroke={2} /></span>
      <span className="ico"><Icon name={icon} size={13} /></span>
      <span className="label">{name}</span>
      {count != null && <span className="row-meta">{count}</span>}
    </button>
  );
}

interface SideLeafProps {
  depth: number;
  icon: IconName;
  label: string;
  /** Muted trailing text (stash branch, "annotated", …). */
  meta?: string;
  /** Commits ahead of upstream — rendered as a green `N↑`. */
  ahead?: number;
  /** Commits behind upstream — rendered as a red `N↓`. */
  behind?: number;
  /** Branch tip is already reachable from the checked-out branch. */
  merged?: boolean;
  /** Highlights the row (the checked-out branch). */
  active?: boolean;
  /** Tooltip; defaults to the label. */
  title?: string;
  /** Primary action — double-click, Enter, or Space. */
  onActivate?: () => void;
  /** Single-click action — reveals the row's tip commit in the graph. */
  onSelect?: () => void;
  /** Open the row's action menu at the given viewport coordinates. */
  onMenu: (x: number, y: number) => void;
}

/**
 * A sidebar leaf row (branch / remote / tag / stash). The primary action runs
 * on double-click / Enter; every action the row supports — including the primary one
 * — also lives in a right-click menu opened via `onMenu`. Keyboard users open
 * it with the Menu key or Shift+F10, positioned at the row's corner.
 */
function SideLeaf({ depth, icon, label, meta, ahead = 0, behind = 0, merged, active, title, onActivate, onSelect, onMenu }: SideLeafProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const openKeyboardMenu = () => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r) onMenu(r.left + 12, r.bottom - 4);
  };
  return (
    <div
      ref={rowRef}
      className={'side-row branch-row' + (active ? ' active' : '')}
      style={{ paddingLeft: 16 + depth * 14 }}
      onClick={onSelect}
      onDoubleClick={onActivate}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && onActivate) {
          e.preventDefault(); // Space would otherwise scroll the sidebar
          onActivate();
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          openKeyboardMenu();
        }
      }}
      title={title ?? label}
      role="button"
      tabIndex={0}
    >
      <span className="folder-chev" aria-hidden />
      <span className={'ico' + (merged ? ' branch-icon-merged' : '')}>
        <Icon name={icon} size={13} />
        {merged && (
          <span className="branch-merged-mark" aria-label="merged">
            <Icon name="check" size={6} stroke={2.5} />
          </span>
        )}
      </span>
      <span className="row-text">
        <span className="label">{label}</span>
        {ahead > 0 || behind > 0 ? (
          <span className="drift">
            {ahead > 0 && <span className="drift-ahead">{ahead}↑</span>}
            {behind > 0 && <span className="drift-behind">{behind}↓</span>}
          </span>
        ) : (
          meta && <span className="row-meta">{meta}</span>
        )}
      </span>
    </div>
  );
}

interface EmptyProps {
  recents: ReturnType<typeof useRepo.getState>['recents'];
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
  onForget: (path: string) => Promise<void>;
}

function EmptyRepoState({ recents, onOpenRepo, onOpenRecent, onForget }: EmptyProps) {
  return (
    <div className="lc-empty" style={{ padding: '16px 12px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>No repository open. Use <kbd>⌘O</kbd>, drop a folder onto the window, or:</div>
      <button
        type="button"
        onClick={onOpenRepo}
        style={{
          padding: '6px 10px', borderRadius: 6,
          background: 'var(--bg-elev)', color: 'var(--text-1)',
          border: '1px solid var(--border)', fontSize: 12, cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        Open repository…
      </button>

      {recents.length > 0 && (
        <div>
          <div style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10, margin: '4px 0 6px' }}>
            Recent
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recents.map((r) => (
              <button
                type="button"
                key={r.path}
                onClick={() => onOpenRecent(r.path)}
                title={r.path}
                className="recent-item"
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                <span
                  onClick={(e) => { e.stopPropagation(); void onForget(r.path); }}
                  title="Remove from recents"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      void onForget(r.path);
                    }
                  }}
                  style={{ color: 'var(--text-dim)', padding: 2 }}
                >
                  <Icon name="x" size={9} stroke={2} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
