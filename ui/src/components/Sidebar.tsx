import { useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icon';
import { useRepo } from '../stores/repo';
import type { Branch, RemoteBranch, Tag } from '../lib/types';

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
}

function SideSection({ label, collapsed, onToggle, count }: SectionProps) {
  return (
    <button type="button" className={'side-section' + (collapsed ? ' collapsed' : '')} onClick={onToggle}>
      <Icon name="chev-down" size={8} stroke={2} className="chev" />
      <span>{label}</span>
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}

interface SidebarProps {
  onOpenRepo: () => void;
  onOpenRecent: (path: string) => void;
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

export function Sidebar({ onOpenRepo, onOpenRecent }: SidebarProps) {
  const view = useRepo((s) => s.view);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  const status = useRepo((s) => s.status);
  const meta = useRepo((s) => s.meta);
  const recents = useRepo((s) => s.recents);
  const forgetRecent = useRepo((s) => s.forgetRecent);
  const refs = useRepo((s) => s.refs);
  const checkout = useRepo((s) => s.checkout);
  const createBranch = useRepo((s) => s.createBranch);
  const deleteBranch = useRepo((s) => s.deleteBranch);

  const [tab, setTab] = useState<SideTab>('git');
  const [filter, setFilter] = useState('');
  const [sections, setSections] = useState({
    branches: true, remotes: true, tags: false, stashes: true, submods: false,
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

  // Which branch (by full_name) is currently in the inline-confirm state.
  // Only one row can be confirming at a time, so a single string is enough.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Escape cancels a pending delete. Click-outside is handled by the row
  // itself — any click that doesn't land on the confirm UI resets state.
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingDelete(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingDelete]);

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

  // Build one tree per section. Names are split on `/` so e.g. `feature/foo`
  // nests under a `feature` folder. Remote branches use their full
  // `origin/foo` name so the remote name becomes the top-level folder.
  const branchTree = useMemo(() => {
    const t = buildTree<Branch>(filtered.branches, (b) => b.name.split('/'));
    sortTree(t, (a, b) => {
      if (a.is_head !== b.is_head) return a.is_head ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return t;
  }, [filtered.branches]);

  const remoteTree = useMemo(() => {
    const t = buildTree<RemoteBranch>(filtered.remotes, (rb) => rb.name.split('/'));
    sortTree(t, (a, b) => a.name.localeCompare(b.name));
    return t;
  }, [filtered.remotes]);

  const tagTree = useMemo(() => {
    const t = buildTree<Tag>(filtered.tags, (tg) => tg.name.split('/'));
    sortTree(t, (a, b) => a.name.localeCompare(b.name));
    return t;
  }, [filtered.tags]);

  const runBranchOp = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { console.warn(e); }
  };

  const renderBranchLeaf = (b: Branch, depth: number) => (
    <BranchLeaf
      key={b.full_name}
      depth={depth}
      label={leafName(b.name)}
      fullName={b.name}
      isHead={b.is_head}
      meta={b.upstream
        ? `${b.ahead > 0 ? `↑${b.ahead} ` : ''}${b.behind > 0 ? `↓${b.behind}` : ''}`.trim() || b.upstream.name
        : undefined}
      onClick={() => !b.is_head && void runBranchOp(() => checkout(b.name))}
      deletable={!b.is_head}
      confirming={pendingDelete === b.full_name}
      onRequestDelete={() => setPendingDelete(b.full_name)}
      onCancelDelete={() => setPendingDelete(null)}
      onConfirmDelete={() => {
        setPendingDelete(null);
        void runBranchOp(() => deleteBranch(b.name, true));
      }}
    />
  );

  const renderRemoteLeaf = (rb: RemoteBranch, depth: number) => (
    <BranchLeaf
      key={rb.full_name}
      depth={depth}
      label={leafName(rb.name)}
      onClick={() => {
        const localName = refs.branches.some((b) => b.name === rb.branch)
          ? `${rb.remote}/${rb.branch}`
          : rb.branch;
        void runBranchOp(() => createBranch(localName, rb.name, true));
      }}
    />
  );

  const renderTagLeaf = (tg: Tag, depth: number) => (
    <BranchLeaf key={tg.full_name} depth={depth} label={leafName(tg.name)} />
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
          active={view === 'commits'}
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

      <div className="side-filter">
        <Icon name="search" size={11} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={tab === 'git' ? 'Filter branches, tags…' : 'Filter files'}
          aria-label={tab === 'git' ? 'Filter branches and tags' : 'Filter files'}
        />
      </div>

      <div className="side-scroll">
        {!meta ? (
          <EmptyRepoState recents={recents} onOpenRepo={onOpenRepo} onOpenRecent={onOpenRecent} onForget={forgetRecent} />
        ) : tab === 'git' ? (
          <>
            <SideSection
              label="Branches"
              collapsed={!sections.branches}
              onToggle={() => toggle('branches')}
              count={filtered.branches.length}
            />
            {sections.branches &&
              renderTreeChildren(branchTree, 0, collapsed, toggleCollapsed, renderBranchLeaf)}

            <SideSection
              label="Remotes"
              collapsed={!sections.remotes}
              onToggle={() => toggle('remotes')}
              count={filtered.remotes.length}
            />
            {sections.remotes &&
              renderTreeChildren(remoteTree, 0, collapsed, toggleCollapsed, renderRemoteLeaf)}

            <SideSection
              label="Tags"
              collapsed={!sections.tags}
              onToggle={() => toggle('tags')}
              count={filtered.tags.length}
            />
            {sections.tags &&
              renderTreeChildren(tagTree, 0, collapsed, toggleCollapsed, renderTagLeaf)}

            <SideSection label="Stashes" collapsed={!sections.stashes} onToggle={() => toggle('stashes')} count={0} />
            <SideSection label="Submodules" collapsed={!sections.submods} onToggle={() => toggle('submods')} count={0} />
          </>
        ) : (
          <div className="lc-empty" style={{ padding: '16px 12px', fontSize: 12 }}>
            File tree — coming soon.
          </div>
        )}
      </div>
    </div>
  );
}

// Render a TreeNode's children (not the root itself) into a flat JSX list.
// `renderLeaf` provides the row for a leaf; folder rows are handled here.
function renderTreeChildren<T>(
  node: TreeNode<T>,
  depth: number,
  collapsed: Set<string>,
  toggleCollapsed: (path: string) => void,
  renderLeaf: (item: T, depth: number) => React.ReactNode,
): React.ReactNode {
  return node.children.map((child) => {
    if (child.children.length === 0 && child.leaf != null) {
      return renderLeaf(child.leaf, depth);
    }
    const isCollapsed = collapsed.has(child.fullPath);
    return (
      <div key={child.fullPath}>
        <FolderRow
          name={child.name}
          depth={depth}
          collapsed={isCollapsed}
          count={leafCount(child)}
          onToggle={() => toggleCollapsed(child.fullPath)}
        />
        {!isCollapsed &&
          renderTreeChildren(child, depth + 1, collapsed, toggleCollapsed, renderLeaf)}
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

// ─── row components ─────────────────────────────────────────────────────

interface FolderRowProps {
  name: string;
  depth: number;
  collapsed: boolean;
  count: number;
  onToggle: () => void;
}

function FolderRow({ name, depth, collapsed, count, onToggle }: FolderRowProps) {
  return (
    <button
      type="button"
      className={'side-row branch-folder' + (collapsed ? ' collapsed' : '')}
      style={{ paddingLeft: 16 + depth * 14 }}
      onClick={onToggle}
      title={name}
    >
      <span className="folder-chev"><Icon name="chev-down" size={8} stroke={2} /></span>
      <span className="ico"><Icon name="folder" size={13} /></span>
      <span className="label">{name}</span>
      <span className="row-meta">{count}</span>
    </button>
  );
}

interface BranchLeafProps {
  depth: number;
  label: string;
  /** Full branch name, used in the confirm prompt copy. */
  fullName?: string;
  isHead?: boolean;
  meta?: string;
  onClick?: () => void;
  /** When true, the row shows a hover-revealed × that starts the confirm. */
  deletable?: boolean;
  /** When true, the row swaps its meta/× area for an inline confirm prompt. */
  confirming?: boolean;
  onRequestDelete?: () => void;
  onConfirmDelete?: () => void;
  onCancelDelete?: () => void;
}

function BranchLeaf({
  depth,
  label,
  fullName,
  isHead,
  meta,
  onClick,
  deletable,
  confirming,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: BranchLeafProps) {
  // Suppress the title attribute in armed state so the OS tooltip doesn't
  // cover the on-hover toolbar.
  const titleAttr = confirming
    ? `Confirm delete · ${fullName ?? label}`
    : label;

  return (
    <div
      className={
        'side-row branch-row' +
        (isHead ? ' active' : '') +
        (confirming ? ' armed' : '')
      }
      style={{ paddingLeft: 16 + depth * 14 }}
      onClick={confirming ? undefined : onClick}
      onKeyDown={confirming ? undefined : (e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) onClick();
      }}
      title={titleAttr}
      role="button"
      tabIndex={0}
    >
      <span className="folder-chev" aria-hidden />
      <span className="ico"><Icon name="branch" size={13} /></span>
      <span className="label">{label}</span>
      {meta && <span className="row-meta">{meta}</span>}
      {deletable && (
        <span className="row-tools" onClick={(e) => e.stopPropagation()}>
          {confirming && (
            <button
              type="button"
              className="row-tool"
              title="Cancel"
              aria-label="Cancel delete"
              onClick={onCancelDelete}
            >
              <Icon name="x" size={11} stroke={2} />
            </button>
          )}
          <button
            type="button"
            className={'row-tool danger' + (confirming ? ' confirm' : '')}
            title={confirming ? 'Confirm delete' : 'Delete branch'}
            aria-label={confirming ? 'Confirm delete' : 'Delete branch'}
            onClick={confirming ? onConfirmDelete : onRequestDelete}
          >
            <Icon name="trash" size={11} stroke={1.6} />
          </button>
        </span>
      )}
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
