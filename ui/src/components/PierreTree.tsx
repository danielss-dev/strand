import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { GitStatus, GitStatusEntry } from '@pierre/trees';

import { ContextMenu, type MenuItem } from './ContextMenu';
import type { DiffStatus, StatusKind } from '../lib/types';

// ─── status mapping ───────────────────────────────────────────────────────
// Strand's status enums → Pierre's GitStatus (drives the colored filename +
// status lane). Conflicted/copied/typechange have no Pierre equivalent, so
// they fold onto the nearest colour.

export function workStatusToGit(s: StatusKind | null): GitStatus | null {
  switch (s) {
    case 'MODIFIED': return 'modified';
    case 'ADDED': return 'added';
    case 'DELETED': return 'deleted';
    case 'RENAMED': return 'renamed';
    case 'UNTRACKED': return 'untracked';
    case 'CONFLICTED': return 'modified';
    default: return null;
  }
}

export function diffStatusToGit(s: DiffStatus): GitStatus {
  switch (s) {
    case 'added': return 'added';
    case 'deleted': return 'deleted';
    case 'renamed': return 'renamed';
    case 'modified':
    case 'typechange': return 'modified';
    case 'copied': return 'added';
  }
}

/** Write `text` to the clipboard, swallowing the rejection clipboard APIs throw
 * when the webview denies access (so a copy never surfaces an unhandled
 * rejection). */
export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text)?.catch((e) => console.warn('clipboard write failed', e));
}

// ─── public types ─────────────────────────────────────────────────────────

/** Right-click menu item — the same shape the app's ContextMenu consumes. */
export type TreeMenuItem = MenuItem;

/** Imperative handle so a host can open Pierre's in-tree search on demand. */
export interface PierreTreeHandle {
  openSearch(): void;
}

interface PierreTreeProps {
  /** Flat list of canonical file paths (e.g. `crates/strand-core/src/lib.rs`). */
  paths: readonly string[];
  /** Per-path git status — drives the colored name + status lane. */
  gitStatus?: readonly GitStatusEntry[];
  /**
   * The active selected path — drives the diff pane and the scroll/visible
   * highlight. `null` means this tree is *not* the active side, and its
   * selection is cleared (cross-tree exclusivity). Multi-selection itself is
   * owned by Pierre; this only tracks the active row.
   */
  selectedPath?: string | null;
  /** Fired with the active (last-selected) path, or `null` when the selection empties. */
  onSelect?: (path: string | null) => void;
  /**
   * Activate (double-click, or Enter on a focused file) — receives the resolved
   * file set to act on: the current multi-selection when a selected row is
   * activated, every file under a folder, or just the one file.
   */
  onActivate?: (paths: string[]) => void;
  /** Right-click menu items for the resolved target file set. Omit to disable. */
  menuItems?: (paths: string[]) => MenuItem[];
  /** Enable Pierre's in-tree fuzzy search (also bound to ⌘F / Ctrl+F). */
  search?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Shown (centered) when there are no paths. */
  emptyLabel?: string;
}

const pathsKeyOf = (paths: readonly string[]) => paths.join('\n');
const statusKeyOf = (entries: readonly GitStatusEntry[] | undefined) =>
  entries ? entries.map((e) => `${e.path}:${e.status}`).join('\n') : '';

/**
 * Walk an event's composed path (which crosses the shadow boundary) for the
 * nearest tree row — file *or* folder — and return it (carries the canonical
 * `data-item-path`).
 */
function rowFromEvent(native: Event): HTMLElement | null {
  for (const node of native.composedPath()) {
    if (node instanceof HTMLElement && node.dataset.itemPath != null) return node;
  }
  return null;
}

/**
 * React wrapper around `@pierre/trees`. The Pierre model owns tree state
 * (expansion, virtualization, search, icons, multi-selection) and renders into
 * a shadow root; this component bridges it to Strand's path-first data.
 *
 * Selection: Pierre handles Ctrl/⌘-click (toggle), Shift-click / Shift-arrow
 * (range), and plain click (replace) natively. This wrapper does not collapse
 * that — it surfaces only the *active* (last) path for the diff pane via
 * {@link PierreTreeProps.onSelect}, and reads the full selection from the model
 * when resolving an action's targets.
 *
 * The model is created once (Pierre's documented pattern). Later changes are
 * pushed imperatively: `resetPaths` only when the path *set* changes (it
 * preserves selection and re-opens folders), and `setGitStatus` for the far
 * more frequent status-only refreshes (preserves expansion + selection).
 */
export const PierreTree = forwardRef<PierreTreeHandle, PierreTreeProps>(function PierreTree(
  { paths, gitStatus, selectedPath = null, onSelect, onActivate, menuItems, search, className, style, emptyLabel },
  ref,
) {
  // Latest-value refs so the once-created model's callbacks never go stale.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;

  const pathsKey = useMemo(() => pathsKeyOf(paths), [paths]);
  const statusKey = useMemo(() => statusKeyOf(gitStatus), [gitStatus]);

  // Set of known file paths — used to tell a file row from a folder row when
  // resolving an action target (a folder row's path is not in this set).
  const fileSet = useMemo(() => new Set(paths), [pathsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;

  // Captured once by useFileTree; refs above keep behaviour current.
  const { model } = useFileTree({
    paths: paths as string[],
    gitStatus: gitStatus as GitStatusEntry[] | undefined,
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    itemHeight: 24,
    icons: { set: 'complete', colored: true },
    search: search ?? false,
    initialSelectedPaths: selectedPath ? [selectedPath] : undefined,
    onSelectionChange: (sel) => {
      const next = sel.length ? sel[sel.length - 1] : null;
      // Ignore the echo of our own reflection (covers null === null too).
      if (next === selectedRef.current) return;
      onSelectRef.current?.(next);
    },
  });

  useImperativeHandle(ref, () => ({ openSearch: () => model.openSearch() }), [model]);

  // Resolve the file set an action targets, given the row it was invoked on:
  // a selected file row with a multi-selection → the whole selection; a folder
  // row → every known file beneath it; otherwise → just that file.
  const resolveTargets = useCallback(
    (rowPath: string): string[] => {
      const files = fileSetRef.current;
      if (files.has(rowPath)) {
        const selected = model.getSelectedPaths();
        if (selected.length > 1 && selected.includes(rowPath)) {
          return selected.filter((p) => files.has(p));
        }
        return [rowPath];
      }
      const prefix = rowPath.replace(/\/+$/, '') + '/';
      const out: string[] = [];
      for (const p of files) if (p.startsWith(prefix)) out.push(p);
      return out;
    },
    [model],
  );

  // Sync data into the once-created model. The model already holds the
  // first-render values, so both keys start "unchanged" and the first run
  // no-ops. `resetPaths` (a coarse whole-tree reset that preserves selection
  // and re-opens folders) is reserved for actual path-set changes; the far
  // more frequent status-only refresh goes through `setGitStatus`, which keeps
  // expansion and selection intact.
  const prevPathsKey = useRef(pathsKey);
  const prevStatusKey = useRef(statusKey);
  useEffect(() => {
    const pathsChanged = prevPathsKey.current !== pathsKey;
    const statusChanged = prevStatusKey.current !== statusKey;
    prevPathsKey.current = pathsKey;
    prevStatusKey.current = statusKey;
    if (pathsChanged) {
      model.resetPaths(paths as string[]);
      model.setGitStatus(gitStatus as GitStatusEntry[] | undefined);
    } else if (statusChanged) {
      model.setGitStatus(gitStatus as GitStatusEntry[] | undefined);
    }
  }, [pathsKey, statusKey, paths, gitStatus, model]);

  // Reflect the active selection. When `selectedPath` is set, ensure it is
  // selected (additively — never clobbering a Ctrl/Shift multi-selection) and
  // scrolled into view. When it is null, this tree is the inactive side, so
  // clear its selection (so only one side is ever highlighted at a time).
  useEffect(() => {
    const current = model.getSelectedPaths();
    if (selectedPath) {
      if (!current.includes(selectedPath)) model.getItem(selectedPath)?.select();
      model.scrollToPath(selectedPath, { offset: 'nearest' });
    } else {
      for (const p of current) model.getItem(p)?.deselect();
    }
  }, [selectedPath, pathsKey, model]);

  // Double-click a row to activate it (stage / unstage). Single-click still
  // just selects via Pierre + onSelectionChange.
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onActivateRef.current) return;
      const row = rowFromEvent(e.nativeEvent);
      if (!row) return;
      const targets = resolveTargets(row.dataset.itemPath!);
      if (targets.length) onActivateRef.current(targets);
    },
    [resolveTargets],
  );

  // Keyboard equivalent of double-click: Enter on a focused *file* row (Enter
  // on a folder stays Pierre's expand/collapse).
  const onKeyDownCapture = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!onActivateRef.current || e.key !== 'Enter') return;
      const onRow = e.nativeEvent
        .composedPath()
        .some((n) => n instanceof HTMLElement && n.dataset.type === 'item');
      if (!onRow) return; // focus is in the search box, not a row
      const focused = model.getFocusedPath();
      if (focused && fileSetRef.current.has(focused)) {
        e.preventDefault();
        e.stopPropagation();
        onActivateRef.current(resolveTargets(focused));
      }
    },
    [model, resolveTargets],
  );

  // ── Right-click menu (the app's own viewport-clamped ContextMenu) ──
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!menuItems) return;
      const row = rowFromEvent(e.nativeEvent);
      if (!row) return;
      const targets = resolveTargets(row.dataset.itemPath!);
      if (targets.length === 0) return;
      e.preventDefault();
      // Keyboard-triggered menus (Shift+F10 / Menu key) report 0,0; the menu
      // clamps itself into the viewport either way.
      const x = e.clientX || row.getBoundingClientRect().left + 16;
      const y = e.clientY || row.getBoundingClientRect().bottom;
      setMenu({ x, y, items: menuItems(targets) });
    },
    [menuItems, resolveTargets],
  );

  const hostStyle: CSSProperties = { height: '100%', width: '100%', minHeight: 0, ...style };

  if (paths.length === 0 && emptyLabel) {
    return <div className="tree-empty">{emptyLabel}</div>;
  }

  return (
    <div
      // Theme variables live on the wrap (see features.css): React 18 doesn't
      // forward `className` onto Pierre's custom-element host, but CSS custom
      // properties set here inherit across the shadow boundary regardless.
      className={'tree-host-wrap' + (className ? ` ${className}` : '')}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDownCapture={onKeyDownCapture}
    >
      <FileTree model={model} style={hostStyle} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
});
