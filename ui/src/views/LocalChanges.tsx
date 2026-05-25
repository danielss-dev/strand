import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { Diff } from '../components/Diff';
import { Icon } from '../components/Icon';
import type { LocalSelection } from '../stores/repo';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import type { FileDiff } from '../lib/types';

/**
 * The staging workspace described in PRD §5: a left column with two file
 * trees (unstaged on top, staged on the bottom), a diff pane on the right,
 * and the commit form pinned to the bottom.
 *
 * Per-row Stage / Unstage shows on hover. Discard lives in the right-click
 * menu (to be wired) so it can't be hit by accident. Clicking a file
 * selects it; ⌘↵ in the subject field commits.
 */
export function LocalChanges() {
  const unstaged = useRepo((s) => s.unstagedDiffs);
  const staged = useRepo((s) => s.stagedDiffs);
  const selection = useRepo((s) => s.localSelection);
  const stage = useRepo((s) => s.stage);
  const unstage = useRepo((s) => s.unstage);
  const stageAll = useRepo((s) => s.stageAll);
  const unstageAll = useRepo((s) => s.unstageAll);
  const selectLocalFile = useRepo((s) => s.selectLocalFile);

  // Auto-select first file when the previous selection disappears so the
  // diff pane stays populated between operations.
  useEffect(() => {
    if (selection) return;
    const first =
      unstaged[0] != null
        ? { file: unstaged[0].path, staged: false }
        : staged[0] != null
          ? { file: staged[0].path, staged: true }
          : null;
    if (first) selectLocalFile(first);
  }, [selection, unstaged, staged, selectLocalFile]);

  const selectedDiff = useMemo(() => {
    if (!selection) return null;
    const pool = selection.staged ? staged : unstaged;
    return pool.find((d) => d.path === selection.file) ?? null;
  }, [selection, unstaged, staged]);

  return (
    <div className="lc-stack">
      <div className="lc-main">
        <PanelGroup direction="horizontal" autoSaveId="strand:lc-main">
          <Panel defaultSize={28} minSize={15} maxSize={60}>
            <div className="lc-files">
              <PanelGroup direction="vertical" autoSaveId="strand:lc-files">
                <Panel defaultSize={50} minSize={10}>
                  <FileSection
                    title="Unstaged"
                    files={unstaged}
                    staged={false}
                    selection={selection}
                    onSelect={selectLocalFile}
                    onAction={(f) => void stage(f)}
                    actionLabel="Stage"
                    onBulk={() => void stageAll()}
                    bulkLabel="Stage all"
                  />
                </Panel>
                <PanelResizeHandle className="rs-handle horiz" />
                <Panel defaultSize={50} minSize={10}>
                  <FileSection
                    title="Staged"
                    files={staged}
                    staged={true}
                    selection={selection}
                    onSelect={selectLocalFile}
                    onAction={(f) => void unstage(f)}
                    actionLabel="Unstage"
                    onBulk={() => void unstageAll()}
                    bulkLabel="Unstage all"
                  />
                </Panel>
              </PanelGroup>
            </div>
          </Panel>
          <PanelResizeHandle className="rs-handle vert" />
          <Panel minSize={30}>
            <DiffPane diff={selectedDiff} />
          </Panel>
        </PanelGroup>
      </div>

      <CommitBar canCommit={staged.length > 0} />
    </div>
  );
}

interface SectionProps {
  title: string;
  files: FileDiff[];
  staged: boolean;
  selection: LocalSelection | null;
  onSelect(sel: LocalSelection): void;
  onAction(file: string): void;
  actionLabel: string;
  onBulk(): void;
  bulkLabel: string;
}

function FileSection({
  title,
  files,
  staged,
  selection,
  onSelect,
  onAction,
  actionLabel,
  onBulk,
  bulkLabel,
}: SectionProps) {
  return (
    <div className="lc-files-section">
      <div className="lc-col-head">
        {title}
        <span className="count">{files.length}</span>
        <div className="h-actions">
          {files.length > 0 && (
            <span className="h-link" onClick={onBulk} role="button">
              {bulkLabel}
            </span>
          )}
        </div>
      </div>
      {files.length > 0 && (
        <FileTree
          files={files}
          staged={staged}
          selection={selection}
          onSelect={onSelect}
          onAction={onAction}
          actionLabel={actionLabel}
        />
      )}
    </div>
  );
}

// ─── File tree ──────────────────────────────────────────────────────────────

type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[]; count: number }
  | { kind: 'file'; name: string; path: string; diff: FileDiff };

/**
 * Group a flat list of `FileDiff`s into a folder tree. Single-child folders
 * collapse into their parent (`crates/strand-core/src` → one row) so we
 * don't waste rows on long unique prefixes.
 */
function buildTree(files: FileDiff[]): TreeNode[] {
  interface Mut {
    name: string;
    path: string;
    children: Map<string, Mut>;
    file?: FileDiff;
  }
  const root: Mut = { name: '', path: '', children: new Map() };

  for (const diff of files) {
    const parts = diff.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let next = cur.children.get(part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
        };
        cur.children.set(part, next);
      }
      cur = next;
    }
    const fname = parts[parts.length - 1];
    cur.children.set(fname, { name: fname, path: diff.path, children: new Map(), file: diff });
  }

  function build(node: Mut): TreeNode {
    if (node.file && node.children.size === 0) {
      return { kind: 'file', name: node.name, path: node.path, diff: node.file };
    }
    let children = Array.from(node.children.values()).map(build);
    // Sort: folders first, then files; alphabetical within each.
    children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      kind: 'folder',
      name: node.name,
      path: node.path,
      children,
      count: countLeaves(children),
    };
  }

  function countLeaves(nodes: TreeNode[]): number {
    let n = 0;
    for (const c of nodes) n += c.kind === 'file' ? 1 : c.count;
    return n;
  }

  const top = Array.from(root.children.values()).map(build);
  top.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return top;
}

interface TreeProps {
  files: FileDiff[];
  staged: boolean;
  selection: LocalSelection | null;
  onSelect(sel: LocalSelection): void;
  onAction(file: string): void;
  actionLabel: string;
}

function FileTree({ files, staged, selection, onSelect, onAction, actionLabel }: TreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  // Default: all folders expanded. Collapsed-state is per-section, lives in
  // memory only for now (per-repo persistence comes with A7).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="lc-tree">
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          staged={staged}
          collapsed={collapsed}
          onToggle={toggle}
          selection={selection}
          onSelect={onSelect}
          onAction={onAction}
          actionLabel={actionLabel}
        />
      ))}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  staged: boolean;
  collapsed: Set<string>;
  onToggle(path: string): void;
  selection: LocalSelection | null;
  onSelect(sel: LocalSelection): void;
  onAction(file: string): void;
  actionLabel: string;
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, staged, collapsed, onToggle } = props;
  const indent = { '--depth': depth } as CSSProperties;

  if (node.kind === 'folder') {
    const open = !collapsed.has(node.path);
    return (
      <>
        <div
          className="lc-tree-row folder"
          style={indent}
          onClick={() => onToggle(node.path)}
          role="button"
        >
          <span className="chev">
            <Icon name={open ? 'chev-down' : 'chev-right'} size={11} />
          </span>
          <span className="ftype">
            <Icon name={open ? 'folder-open' : 'folder'} size={13} />
          </span>
          <span />
          <span className="fname">{node.name}</span>
          <span className="folder-count">{node.count}</span>
        </div>
        {open &&
          node.children.map((child) => (
            <TreeRow {...props} key={child.path} node={child} depth={depth + 1} />
          ))}
      </>
    );
  }

  const selected = props.selection?.file === node.path && props.selection.staged === staged;
  const code = statusCode(node.diff.status);

  return (
    <div
      className={`lc-tree-row${selected ? ' active' : ''}`}
      style={indent}
      onClick={() => props.onSelect({ file: node.path, staged })}
      role="button"
      tabIndex={0}
    >
      <span />
      <span className={`badge ${code}`}>{code}</span>
      <span className="ftype">
        <Icon name="file" size={13} />
      </span>
      <span className="fname">{node.name}</span>
      <span
        className="lc-action"
        onClick={(e) => {
          e.stopPropagation();
          props.onAction(node.path);
        }}
        role="button"
      >
        {props.actionLabel}
      </span>
    </div>
  );
}

function statusCode(status: FileDiff['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
  }
}

// ─── Diff pane ──────────────────────────────────────────────────────────────

function DiffPane({ diff }: { diff: FileDiff | null }) {
  // The unified/split toggle lives in the main header (App.tsx → MainHeader)
  // and writes to `useSettings.diffMode`. Pierre talks 'unified' | 'split',
  // our setting is 'stacked' | 'split' — map at the boundary.
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  return (
    <div className="lc-diff">
      <div className="lc-diff-scroll">
        <DiffBody diff={diff} layout={layout} />
      </div>
    </div>
  );
}

function DiffBody({ diff, layout }: { diff: FileDiff | null; layout: 'unified' | 'split' }) {
  if (!diff) {
    return (
      <div className="lc-empty">
        <strong>Select a file</strong>
        Pick something on the left to see its diff.
      </div>
    );
  }
  if (diff.binary || diff.patch.length === 0) {
    return (
      <div className="lc-empty">
        <strong>{diff.binary ? 'Binary file' : 'No textual diff'}</strong>
        {diff.binary
          ? 'Strand does not render binary file diffs yet.'
          : 'Nothing to show — the file may have been moved or its content is identical.'}
      </div>
    );
  }
  return <Diff patch={diff.patch} layout={layout} />;
}

// ─── Commit bar ─────────────────────────────────────────────────────────────

function CommitBar({ canCommit }: { canCommit: boolean }) {
  const commit = useRepo((s) => s.commit);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = subject.trim();
    if (!trimmed || submitting) return;
    if (!canCommit && !amend) return;
    setSubmitting(true);
    try {
      await commit(trimmed, body.trim() || null, amend);
      setSubject('');
      setBody('');
      setAmend(false);
    } catch (e) {
      console.error('commit failed', e);
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || !subject.trim() || (!canCommit && !amend);

  return (
    <div className="lc-commit-bar">
      <div className="cb-top">
        <div className="subject-row">
          <input
            className="subject"
            placeholder="Commit subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <label className="amend">
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => setAmend(e.target.checked)}
          />{' '}
          <span>Amend</span>
        </label>
        <button
          className="btn primary cb-commit"
          disabled={disabled}
          onClick={() => void submit()}
        >
          {amend ? 'Amend' : 'Commit'}
          <span className="kbd-inline">⌘↵</span>
        </button>
      </div>
      <textarea
        className="cb-body"
        placeholder="Description (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </div>
  );
}
