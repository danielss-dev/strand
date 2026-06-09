import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitStatusEntry } from '@pierre/trees';

import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon, type IconName } from './Icon';
import { copyToClipboard, PierreTree, workStatusToGit, type TreeMenuItem } from './PierreTree';
import { errMessage } from '../lib/tauri';
import { defaultRemote, useRepo } from '../stores/repo';
import type { Branch, RemoteBranch, Stash, Submodule, SubmoduleState, Tag, Worktree } from '../lib/types';

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
  /** Open the New-worktree dialog. */
  onCreateWorktree: () => void;
  /** Open the Merge dialog: merge `source` into the current branch `into`. */
  onMerge: (source: string, into: string) => void;
  /** Open the interactive-rebase editor over `base..HEAD` (base null = root). */
  onInteractiveRebase: (base: string | null, label: string) => void;
  /** Surface a transient message (tag push / remote-delete feedback). */
  onToast: (msg: string) => void;
}

// ─── tree primitives ────────────────────────────────────────────────────

interface TreeNode<T> {
  name: string;
  fullPath: string;
  leaf?: T;
  children: TreeNode<T>[];
}

function buildTree<T>(items: T[], getSegments: (item: T) => string[]): TreeNode<T> {
  const root: TreeNode<T> = { name: '', fullPath: '', children: [] };
  for (const item of items) {
    const parts = getSegments(item);
    let node = root;
    let path = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      path = path ? `${path}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, fullPath: path, children: [] };
        node.children.push(child);
      }
      if (i === parts.length - 1) child.leaf = item;
      node = child;
    }
  }
  return root;
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

export function Sidebar({ onOpenRepo, onOpenRecent, onCreateStash, onCreateTag, onCreateWorktree, onMerge, onInteractiveRebase, onToast }: SidebarProps) {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  const selectedFile = useRepo((s) => s.selectedFile);
  const status = useRepo((s) => s.status);
  const meta = useRepo((s) => s.meta);
  const recents = useRepo((s) => s.recents);
  const forgetRecent = useRepo((s) => s.forgetRecent);
  const refs = useRepo((s) => s.refs);
  const checkout = useRepo((s) => s.checkout);
  const checkoutCommit = useRepo((s) => s.checkoutCommit);
  const revealInGraph = useRepo((s) => s.revealInGraph);
  const createBranch = useRepo((s) => s.createBranch);
  const deleteBranch = useRepo((s) => s.deleteBranch);
  const deleteTag = useRepo((s) => s.deleteTag);
  const pushTag = useRepo((s) => s.pushTag);
  const deleteRemoteTag = useRepo((s) => s.deleteRemoteTag);
  const remoteTags = useRepo((s) => s.remoteTags);
  const refreshRemoteTags = useRepo((s) => s.refreshRemoteTags);
  const workTree = useRepo((s) => s.workTree);
  const refreshTree = useRepo((s) => s.refreshTree);
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
  const rebase = useRepo((s) => s.rebase);
  const currentBranch = useMemo(() => refs.branches.find((b) => b.is_head)?.name ?? null, [refs]);

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

  // The open right-click menu, if any. Per-row actions (checkout, delete,
  // push, …) live here instead of inline on the row.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openMenu = (x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items });

  const unstaged = status.filter((s) => !s.staged).length;
  const toggle = (k: keyof typeof sections) => setSections((s) => ({ ...s, [k]: !s[k] }));

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);

    // Hide remote-tracking branches that already have a local counterpart —
    // the local row already shows the upstream drift counts.
    const trackedRemotes = new Set(
      refs.branches.map((b) => b.upstream?.name).filter((n): n is string => Boolean(n)),
    );

    return {
      branches: refs.branches.filter((b) => match(b.name)),
      remotes: refs.remote_branches
        .filter((rb) => !trackedRemotes.has(rb.name))
        .filter((rb) => match(rb.name)),
      tags: refs.tags.filter((t) => match(t.name)),
    };
  }, [refs, filter]);

  // Local branches render flat with their full name (`feat/foo`). Remote
  // branches group one level under their remote (`origin`), then list flat —
  // tags still split on `/` into folders (see tagTree).
  const branchTree = useMemo(() => {
    const t = buildTree<Branch>(filtered.branches, (b) => [b.name]);
    sortTree(t, (a, b) => {
      if (a.is_head !== b.is_head) return a.is_head ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return t;
  }, [filtered.branches]);

  const remoteTree = useMemo(() => {
    const t = buildTree<RemoteBranch>(filtered.remotes, (rb) => [rb.remote, rb.branch]);
    sortTree(t, (a, b) => a.name.localeCompare(b.name));
    return t;
  }, [filtered.remotes]);

  const tagTree = useMemo(() => {
    const t = buildTree<Tag>(filtered.tags, (tg) => tg.name.split('/'));
    sortTree(t, (a, b) => a.name.localeCompare(b.name));
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
      (w) => (w.branch?.toLowerCase().includes(q) ?? false) || w.path.toLowerCase().includes(q),
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

  // Files tab: lazily fetch the working-tree listing when the tab is shown,
  // and refresh it whenever status (a proxy for working-tree change) updates.
  // Depend on `meta?.path` (not the whole meta object) so a meta refresh that
  // only bumps ahead/behind doesn't re-walk the tree.
  const [treeLoading, setTreeLoading] = useState(false);
  useEffect(() => {
    if (tab !== 'files' || !meta?.path) return;
    let cancelled = false;
    setTreeLoading(true);
    void refreshTree().finally(() => {
      if (!cancelled) setTreeLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, meta?.path, status, refreshTree]);

  // Files tab — the Pierre tree is fed the whole working-tree listing.
  // Filtering is Pierre's own in-tree search box, so the shared filter box
  // (git tab only) no longer touches this list.
  const filePaths = useMemo(() => workTree.map((e) => e.path), [workTree]);
  const fileGitStatus = useMemo<GitStatusEntry[]>(
    () =>
      workTree.flatMap((e) => {
        const s = workStatusToGit(e.status);
        return s ? [{ path: e.path, status: s }] : [];
      }),
    [workTree],
  );
  const fileMenu = useCallback(
    (targets: string[]): TreeMenuItem[] => [
      { label: 'Open', icon: 'content', onSelect: () => selectFile(targets[0]) },
      {
        label: targets.length > 1 ? 'Copy paths' : 'Copy path',
        icon: 'file',
        onSelect: () => copyToClipboard(targets.join('\n')),
      },
    ],
    [selectFile],
  );

  const runBranchOp = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { console.warn(e); }
  };

  // Tag network ops surface success/failure via a toast (unlike the silent
  // local branch/tag ops) — a push can fail on auth or a missing upstream.
  const runTagPush = (name: string) => {
    void (async () => {
      try {
        await pushTag(name);
        onToast(`Pushed ${name} to ${tagRemote}`);
      } catch (e) {
        onToast(`Push failed: ${errMessage(e)}`);
      }
    })();
  };
  const runTagDeleteRemote = (name: string) => {
    void (async () => {
      try {
        await deleteRemoteTag(name);
        onToast(`Deleted ${name} on ${tagRemote}`);
      } catch (e) {
        onToast(`Remote delete failed: ${errMessage(e)}`);
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
        onToast(`Rebase failed: ${errMessage(e)}`);
      }
    })();
  };

  const branchMenu = (b: Branch): MenuItem[] => {
    if (b.is_head) {
      // Interactive rebase over the commits this branch is ahead of its
      // upstream (`upstream..HEAD`) — the unpushed work it's safe to edit.
      const up = b.upstream?.name;
      return [
        { label: 'Current branch', disabled: true, onSelect: () => {} },
        {
          label: 'Interactive rebase…',
          icon: 'rebase',
          onSelect: () =>
            up
              ? onInteractiveRebase(up, up)
              : onToast('No upstream configured — use “Rebase from here” on a commit'),
        },
      ];
    }
    const items: MenuItem[] = [
      { label: 'Checkout', icon: 'branch', onSelect: () => void runBranchOp(() => checkout(b.name)) },
    ];
    if (currentBranch) {
      items.push({ label: `Merge into ${currentBranch}`, icon: 'branch', onSelect: () => onMerge(b.name, currentBranch) });
      items.push({ label: `Rebase ${currentBranch} onto this`, icon: 'rebase', confirm: true, onSelect: () => runRebase(b.name) });
    }
    items.push({ label: 'Delete branch', icon: 'trash', danger: true, confirm: true, onSelect: () => void runBranchOp(() => deleteBranch(b.name, true)) });
    return items;
  };

  const remoteMenu = (rb: RemoteBranch): MenuItem[] => [
    { label: 'Create local branch & track', icon: 'branch', onSelect: () => void runBranchOp(() => createBranch(localBranchName(rb), rb.name, true)) },
  ];

  const tagMenu = (tg: Tag): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Checkout', icon: 'branch', onSelect: () => void runBranchOp(() => checkoutCommit(tg.target)) },
    ];
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
    items.push({ label: 'Delete tag', icon: 'trash', danger: true, confirm: true, onSelect: () => void runBranchOp(() => deleteTag(tg.name)) });
    return items;
  };

  const stashMenu = (s: Stash): MenuItem[] => [
    { label: 'Apply', icon: 'arrow-down', onSelect: () => void runBranchOp(() => stashApply(s.index)) },
    { label: 'Pop (apply & remove)', icon: 'arrow-up', onSelect: () => void runBranchOp(() => stashPop(s.index)) },
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
        onToast(`Submodule update failed: ${errMessage(e)}`);
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
        onToast(`Remove failed: ${errMessage(e)}`);
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
      { label: 'Show in overview', icon: 'worktree', onSelect: () => setView('worktrees') },
      { label: 'Copy path', icon: 'file', onSelect: () => void copyToClipboard(w.path) },
    ];
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

  const renderBranchLeaf = (b: Branch, depth: number) => (
    <SideLeaf
      key={b.full_name}
      depth={depth}
      icon={b.is_head ? 'check' : 'branch'}
      label={b.name}
      active={b.is_head}
      ahead={b.upstream ? b.ahead : 0}
      behind={b.upstream ? b.behind : 0}
      onActivate={() => !b.is_head && void runBranchOp(() => checkout(b.name))}
      onSelect={() => revealInGraph(b.target)}
      onMenu={(x, y) => openMenu(x, y, branchMenu(b))}
    />
  );

  const renderRemoteLeaf = (rb: RemoteBranch, depth: number) => (
    <SideLeaf
      key={rb.full_name}
      depth={depth}
      icon="branch"
      label={rb.branch}
      onActivate={() => void runBranchOp(() => createBranch(localBranchName(rb), rb.name, true))}
      onSelect={() => revealInGraph(rb.target)}
      onMenu={(x, y) => openMenu(x, y, remoteMenu(rb))}
    />
  );

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

  return (
    <div className="sidebar">
      <div className="side-primary">
        <SideRow
          icon="changes"
          label="Local Changes"
          badge={unstaged || undefined}
          active={view === 'local'}
          onClick={() => { setView('local'); selectFile(null); }}
        />
        <SideRow
          icon="graph"
          label="All Commits"
          active={view === 'commits' || view === 'reflog'}
          onClick={() => { setView('commits'); selectFile(null); }}
        />
      </div>

      <div className="side-tabs">
        <button type="button" className={'side-tab' + (tab === 'git' ? ' on' : '')} onClick={() => setTab('git')}>
          <Icon name="branch" size={12} />
          <span>Git</span>
        </button>
        <button type="button" className={'side-tab' + (tab === 'files' ? ' on' : '')} onClick={() => setTab('files')}>
          <Icon name="folder" size={12} />
          <span>Files</span>
        </button>
      </div>

      {tab === 'git' && (
        <div className="side-filter">
          <Icon name="search" size={11} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter branches, tags…"
            aria-label="Filter branches and tags"
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
            action={{ icon: 'plus', title: 'New worktree…', onClick: onCreateWorktree }}
          />
          {sections.worktrees &&
            filteredWorktrees.map((w) => (
              <SideLeaf
                key={w.path}
                depth={0}
                icon={w.is_current ? 'check' : 'worktree'}
                label={w.branch ?? leafName(w.path)}
                active={w.is_current}
                meta={w.is_locked ? 'locked' : w.is_detached ? 'detached' : undefined}
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
          />
          {sections.branches &&
            renderTreeChildren(branchTree, 0, collapsed, toggleCollapsed, renderBranchLeaf, 'branches')}

          <SideSection
            label="Remotes"
            collapsed={!sections.remotes}
            onToggle={() => toggle('remotes')}
            count={refs.remotes.length}
          />
          {sections.remotes &&
            renderTreeChildren(remoteTree, 0, collapsed, toggleCollapsed, renderRemoteLeaf, 'remotes', {
              folderIcon: 'remote',
              showFolderCount: false,
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
                title={`${stashLabel(s)} — double-click to apply`}
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
          <PierreTree
            paths={filePaths}
            gitStatus={fileGitStatus}
            selectedPath={selectedFile}
            onSelect={(p) => selectFile(p)}
            menuItems={fileMenu}
            search
            initialExpansion="closed"
            emptyLabel={treeLoading ? 'Loading working tree…' : 'No files in the working tree.'}
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
  folderOpts?: { folderIcon?: IconName; showFolderCount?: boolean },
): React.ReactNode {
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
          count={folderOpts?.showFolderCount === false ? undefined : leafCount(child)}
          onToggle={() => toggleCollapsed(collapseKey)}
        />
        {!isCollapsed &&
          renderTreeChildren(child, depth + 1, collapsed, toggleCollapsed, renderLeaf, keyPrefix, folderOpts)}
      </div>
    );
  });
}

function leafCount<T>(node: TreeNode<T>): number {
  if (node.children.length === 0) return node.leaf != null ? 1 : 0;
  return node.children.reduce((sum, c) => sum + leafCount(c), 0);
}

function leafName(fullName: string): string {
  const i = fullName.lastIndexOf('/');
  return i === -1 ? fullName : fullName.slice(i + 1);
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
}

function FolderRow({ name, depth, collapsed, icon = 'folder', count, onToggle }: FolderRowProps) {
  return (
    <button
      type="button"
      className={'side-row branch-folder' + (collapsed ? ' collapsed' : '')}
      style={{ paddingLeft: 16 + depth * 14 }}
      onClick={onToggle}
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
function SideLeaf({ depth, icon, label, meta, ahead = 0, behind = 0, active, title, onActivate, onSelect, onMenu }: SideLeafProps) {
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
      <span className="ico"><Icon name={icon} size={13} /></span>
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
