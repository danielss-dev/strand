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
  type ReactNode,
} from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { FileTreeDirectoryHandle, FileTreeItemHandle, GitStatus, GitStatusEntry } from '@pierre/trees';

import { ContextMenu, type MenuItem } from './ContextMenu';
import { TREE_ICONS } from '../lib/treeIcons';
import type { DiffStatus } from '../lib/types';

// ─── status mapping ───────────────────────────────────────────────────────
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

export interface TreeMenuContext {
  path: string;
  kind: 'file' | 'directory';
}

/** Per-row text badge rendered in Pierre's decoration lane (before the git
 * status lane). */
export interface TreeRowDecoration {
  text: string;
  title?: string;
}

/** Imperative handle so a host can open Pierre's in-tree search on demand. */
export interface PierreTreeHandle {
  openSearch(): void;
  /** Current Pierre multi-selection (file paths only). */
  getSelectedPaths(): string[];
  /** Expand a mounted directory after lazy children have been added. */
  expandPath(path: string): void;
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
  /** Fired with the active (last-selected) path and its kind, or `null` when the selection empties. */
  onSelect?: (path: string | null, kind: 'file' | 'directory' | null) => void;
  /** Fired whenever Pierre's multi-selection changes (file paths only). */
  onMultiSelectionChange?: (paths: string[]) => void;
  /** Fired when a closed directory is activated so hosts can load children. */
  onDirectoryExpand?: (path: string) => void;
  /**
   * Make plain ↑/↓/Home/End keyboard focus *select* the file it lands on
   * (firing {@link onSelect}), instead of just moving Pierre's focus ring.
   * Modified arrows (Shift-extend, etc.) keep Pierre's native behavior.
   * Used by Review, where walking the queue should drive the diff pane.
   */
  followFocus?: boolean;
  /**
   * Activate (double-click, or Enter on a focused file) — receives the resolved
   * file set to act on: the current multi-selection when a selected row is
   * activated, every file under a folder, or just the one file.
   */
  onActivate?: (paths: string[], context: TreeMenuContext) => void;
  /** Right-click menu items for the resolved target file set plus the exact
   * row invoked (folder rows otherwise collapse to their descendant files). */
  menuItems?: (paths: string[], context: TreeMenuContext) => MenuItem[];
  /**
   * Discard the resolved target file set — bound to the Delete / Backspace
   * keys while a file row is focused. Resolves the same way the context menu
   * does: a focused row inside a multi-selection discards the *whole*
   * selection, not just the active row. Omit to disable.
   */
  onDiscard?: (paths: string[]) => void;
  /** Enable Pierre's in-tree fuzzy search (also bound to ⌘F / Ctrl+F). */
  search?: boolean;
  /** Optional action placed inline at the trailing edge of the search row. */
  searchAction?: ReactNode;
  /**
   * Enable drag-to-move: rows can be dragged onto a folder row — or a file
   * row's containing folder, or the tree's bare space for the repo root —
   * and dropping calls this with the resolved source set and the target
   * directory (`''` = root). Dragging a file that is part of the current
   * multi-selection moves the whole selection; dragging a folder row moves
   * that folder. Omit to disable dragging entirely.
   */
  onMove?: (sources: string[], targetDir: string) => void;
  /**
   * Per-row decoration (e.g. the Review view's reviewed ✓). Called for every
   * visible row; return `null` for none. Pair with {@link rowDecorationKey} —
   * Pierre only repaints rows on data pushes, so decoration-only changes need
   * the key to bump.
   */
  rowDecoration?: (path: string, kind: 'file' | 'directory') => TreeRowDecoration | null;
  /** Fingerprint of the decoration inputs; a change forces a row repaint. */
  rowDecorationKey?: string;
  /**
   * Whether folders start expanded or collapsed. Defaults to `'open'`. Pierre
   * re-applies this on every `resetPaths`, so a `'closed'` tree stays collapsed
   * even after the path set loads asynchronously.
   */
  initialExpansion?: 'open' | 'closed';
  /**
   * When `false`, clicking a folder row only selects it — expansion is driven
   * solely by the disclosure chevron. Defaults to `true` (Pierre's native
   * "click the whole row to toggle"). Used by Local Changes, where a folder
   * click drives the aggregated diff and shouldn't also fold the tree.
   */
  toggleDirOnRowClick?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Shown (centered) when there are no paths. */
  emptyLabel?: string;
}

const pathsKeyOf = (paths: readonly string[]) => paths.join('\n');
const statusKeyOf = (entries: readonly GitStatusEntry[] | undefined) =>
  entries ? entries.map((e) => `${e.path}:${e.status}`).join('\n') : '';

const SEARCH_ACTION_CSS = `
  [data-file-tree-virtualized-root='true'] {
    position: relative;
  }
  [data-type='header-slot'] {
    position: absolute;
    inset-block-start: 1px;
    inset-inline-end: var(--trees-padding-inline);
    z-index: 2;
  }
  [data-file-tree-search-container] {
    padding-inline-end: calc(
      var(--trees-padding-inline) + var(--strand-tree-search-action-space, 0px)
    );
  }
`;

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
 * True when the event originated inside a row's disclosure (icon) cell —
 * Pierre renders the folder chevron under `data-item-section="icon"`. We walk
 * the composed path outward and decide before reaching the row element itself.
 */
function isChevronEvent(native: Event): boolean {
  for (const node of native.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.dataset.itemSection === 'icon') return true;
    if (node.dataset.itemPath != null) return false; // reached the row, not via the icon cell
  }
  return false;
}

/** Narrow a Pierre item handle to a directory handle (else null). */
function asDir(handle: FileTreeItemHandle | null): FileTreeDirectoryHandle | null {
  return handle && handle.isDirectory() ? (handle as FileTreeDirectoryHandle) : null;
}

/** `a/b/c.txt` → `a/b`; a root-level path → `''`. */
function parentDirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
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
  {
    paths,
    gitStatus,
    selectedPath = null,
    onSelect,
    onMultiSelectionChange,
    onDirectoryExpand,
    onActivate,
    menuItems,
    onDiscard,
    onMove,
    search,
    searchAction,
    followFocus = false,
    rowDecoration,
    rowDecorationKey,
    initialExpansion = 'open',
    toggleDirOnRowClick = true,
    className,
    style,
    emptyLabel,
  },
  ref,
) {
  // Latest-value refs so the once-created model's callbacks never go stale.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onMultiSelectionChangeRef = useRef(onMultiSelectionChange);
  onMultiSelectionChangeRef.current = onMultiSelectionChange;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  const rowDecorationRef = useRef(rowDecoration);
  rowDecorationRef.current = rowDecoration;
  const onDirectoryExpandRef = useRef(onDirectoryExpand);
  onDirectoryExpandRef.current = onDirectoryExpand;
  // True while the reflection effect is rewriting Pierre's selection — the
  // intermediate selection-change events it causes must not echo to the host.
  const reflecting = useRef(false);

  const pathsKey = useMemo(() => pathsKeyOf(paths), [paths]);
  const statusKey = useMemo(() => statusKeyOf(gitStatus), [gitStatus]);

  // Set of known file paths — used to tell a file row from a folder row when
  // resolving an action target (a folder row's path is not in this set).
  const fileSet = useMemo(
    () => new Set(paths.filter((path) => !path.endsWith('/'))),
    [pathsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;

  // Captured once by useFileTree; refs above keep behaviour current.
  const { model } = useFileTree({
    paths: paths as string[],
    gitStatus: gitStatus as GitStatusEntry[] | undefined,
    initialExpansion,
    flattenEmptyDirectories: true,
    itemHeight: 24,
    icons: TREE_ICONS,
    search: search ?? false,
    unsafeCSS: SEARCH_ACTION_CSS,
    renderRowDecoration: (ctx) =>
      rowDecorationRef.current?.(ctx.item.path, ctx.item.kind) ?? null,
    initialSelectedPaths: selectedPath ? [selectedPath] : undefined,
    onSelectionChange: (sel) => {
      if (reflecting.current) return; // our own rewrite, not a user gesture
      const files = fileSetRef.current;
      const fileSel = sel.filter((p) => files.has(p));
      onMultiSelectionChangeRef.current?.(fileSel);
      const next = sel.length ? sel[sel.length - 1] : null;
      // Ignore the echo of our own reflection (covers null === null too).
      if (next === selectedRef.current) return;
      onSelectRef.current?.(next, next ? (files.has(next) ? 'file' : 'directory') : null);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      openSearch: () => model.openSearch(),
      getSelectedPaths: () => model.getSelectedPaths().filter((p) => fileSetRef.current.has(p)),
      expandPath: (path) => asDir(model.getItem(path))?.expand(),
    }),
    [model],
  );

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

  // ── Follow focus (Review) ──
  // Promote the keyboard-focused file to the active selection. Timing is the
  // hard part: Pierre moves its focus inside its own (shadow-root) keydown
  // listener, so reading `getFocusedPath` from our handler races it. Instead,
  // a nav keydown only *arms* a short window; the model subscription fires on
  // the focus mutation itself — strictly after the move — and reads the
  // settled focus. Folder rows are skipped (the pane keeps the last file).
  const followArmedAt = useRef(0);
  const followFromFocus = useCallback(() => {
    const focused = model.getFocusedPath();
    if (focused && fileSetRef.current.has(focused) && focused !== selectedRef.current) {
      onSelectRef.current?.(focused, 'file');
    }
  }, [model]);
  useEffect(() => {
    if (!followFocus) return;
    return model.subscribe(() => {
      if (performance.now() - followArmedAt.current > 300) return;
      followFromFocus();
    });
  }, [followFocus, model, followFromFocus]);

  // Sync data into the once-created model. The model already holds the
  // first-render values, so both keys start "unchanged" and the first run
  // no-ops. `resetPaths` (a coarse whole-tree reset that preserves selection
  // and re-opens folders) is reserved for actual path-set changes; the far
  // more frequent status-only refresh goes through `setGitStatus`, which keeps
  // expansion and selection intact.
  const prevPathsKey = useRef(pathsKey);
  const prevStatusKey = useRef(statusKey);
  const prevDecoKey = useRef(rowDecorationKey);
  useEffect(() => {
    const pathsChanged = prevPathsKey.current !== pathsKey;
    const statusChanged = prevStatusKey.current !== statusKey;
    const decoChanged = prevDecoKey.current !== rowDecorationKey;
    prevPathsKey.current = pathsKey;
    prevStatusKey.current = statusKey;
    prevDecoKey.current = rowDecorationKey;
    if (pathsChanged) {
      model.resetPaths(paths as string[]);
      model.setGitStatus(gitStatus as GitStatusEntry[] | undefined);
    } else if (statusChanged || decoChanged) {
      // setGitStatus repaints every visible row, which is also how a
      // decoration-only change (same paths, same statuses) lands on screen.
      model.setGitStatus(gitStatus as GitStatusEntry[] | undefined);
    }
  }, [pathsKey, statusKey, rowDecorationKey, paths, gitStatus, model]);

  // Reflect the active selection. When `selectedPath` lands on a path Pierre
  // doesn't already have selected (programmatic navigation: j/k, follow-
  // focus, auto-advance), it becomes the *only* selection — accumulating one
  // highlighted row per step looked like a runaway multi-select. A
  // `selectedPath` that is already inside a Ctrl/Shift multi-selection leaves
  // it untouched. When it is null, this tree is the inactive side, so clear
  // its selection (so only one side is ever highlighted at a time).
  useEffect(() => {
    const current = model.getSelectedPaths();
    reflecting.current = true;
    try {
      if (selectedPath) {
        if (!current.includes(selectedPath)) {
          model.getItem(selectedPath)?.select();
          for (const p of current) model.getItem(p)?.deselect();
        }
      } else {
        for (const p of current) model.getItem(p)?.deselect();
      }
    } finally {
      reflecting.current = false;
    }
    if (selectedPath) model.scrollToPath(selectedPath, { offset: 'nearest' });
  }, [selectedPath, pathsKey, model]);

  // Double-click a row to activate it (stage / unstage). Single-click still
  // just selects via Pierre + onSelectionChange. A double-click on the
  // disclosure chevron is left to toggle expansion only — never stages — so a
  // quick double-toggle of a folder doesn't accidentally stage everything under
  // it.
  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onActivateRef.current) return;
      if (isChevronEvent(e.nativeEvent)) return;
      const row = rowFromEvent(e.nativeEvent);
      if (!row) return;
      const path = row.dataset.itemPath!.replace(/\/+$/, '');
      const targets = resolveTargets(row.dataset.itemPath!);
      onActivateRef.current(targets, {
        path,
        kind: fileSetRef.current.has(path) ? 'file' : 'directory',
      });
    },
    [resolveTargets],
  );

  // When `toggleDirOnRowClick` is off, a click on a folder row's body should
  // select it without folding the tree — only the chevron toggles. Pierre
  // couples select+toggle on the whole row with no opt-out, so we let it run
  // and then restore the pre-click expansion in a microtask. Microtasks drain
  // before the next paint, so the toggle is neutralized with no flicker, while
  // Pierre's selection/focus/multi-select behaviour stays untouched.
  const onClickCapture = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const row = rowFromEvent(e.nativeEvent);
      if (!row || row.dataset.itemType !== 'folder') return;
      const path = row.dataset.itemPath!;
      const wasExpanded = asDir(model.getItem(path))?.isExpanded();
      if (wasExpanded == null) return;
      if (!wasExpanded) onDirectoryExpandRef.current?.(path.replace(/\/+$/, ''));
      if (toggleDirOnRowClick) return;
      if (isChevronEvent(e.nativeEvent)) return; // chevron is the one place toggling is allowed
      queueMicrotask(() => {
        const dir = asDir(model.getItem(path));
        if (!dir) return;
        if (wasExpanded) dir.expand();
        else dir.collapse();
      });
    },
    [toggleDirOnRowClick, model],
  );

  // Keyboard equivalent of double-click: Enter on a focused *file* row (Enter
  // on a folder stays Pierre's expand/collapse). With `followFocus`, plain
  // ↑/↓/Home/End also promote the row they land on to the active selection.
  const onKeyDownCapture = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        const onRow = e.nativeEvent
          .composedPath()
          .some((n) => n instanceof HTMLElement && n.dataset.type === 'item');
        if (!onRow) return; // focus is in the search box, not a row
        const focused = model.getFocusedPath();
        const directory = focused ? asDir(model.getItem(focused)) : null;
        if (directory && !directory.isExpanded()) {
          onDirectoryExpandRef.current?.(focused!.replace(/\/+$/, ''));
        }
        if (!onActivateRef.current) return;
        if (focused && fileSetRef.current.has(focused)) {
          e.preventDefault();
          e.stopPropagation();
          onActivateRef.current(resolveTargets(focused), { path: focused, kind: 'file' });
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        const onRow = e.nativeEvent
          .composedPath()
          .some((n) => n instanceof HTMLElement && n.dataset.type === 'item');
        const focused = onRow ? model.getFocusedPath() : null;
        const directory = focused ? asDir(model.getItem(focused)) : null;
        if (directory && !directory.isExpanded()) {
          onDirectoryExpandRef.current?.(focused!.replace(/\/+$/, ''));
        }
      }
      // Delete / Backspace discard the focused row in a single press, acting on
      // the whole multi-selection (resolveTargets) when the focused row is part
      // of one. stopPropagation keeps the window-level shortcut from also firing
      // and double-discarding. Guarded to file rows so Backspace in the search
      // box still edits text.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!onDiscardRef.current) return;
        const onRow = e.nativeEvent
          .composedPath()
          .some((n) => n instanceof HTMLElement && n.dataset.type === 'item');
        if (!onRow) return; // focus is in the search box, not a row
        const focused = model.getFocusedPath();
        if (focused && fileSetRef.current.has(focused)) {
          e.preventDefault();
          e.stopPropagation();
          onDiscardRef.current(resolveTargets(focused));
        }
        return;
      }
      if (
        followFocus &&
        !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey &&
        (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')
      ) {
        // Arm the follow window. Pierre moves the focus in its own listener;
        // the model subscription below fires right after and promotes the
        // newly focused file. The microtask is a fallback in case the move
        // produced no notification.
        followArmedAt.current = performance.now();
        queueMicrotask(followFromFocus);
      }
    },
    [model, resolveTargets, followFocus, followFromFocus],
  );

  // ── Drag-to-move (the Files tree's drag-and-drop rename) ──
  // Pointer-based rather than HTML5 DnD: the rows live in Pierre's shadow
  // root, where we can't mark elements draggable — but mouse events compose
  // across the boundary (same mechanism as the click/menu handlers above).
  // All bookkeeping is imperative refs + direct DOM: a 60Hz mousemove must
  // not re-render the tree.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sources: string[];
    label: string;
    startX: number;
    startY: number;
    active: boolean;
    ghost: HTMLDivElement | null;
    targetDir: string | null;
    targetRow: HTMLElement | null;
    targetRowBg: string;
    detach: () => void;
  } | null>(null);

  const endDrag = useCallback((commit: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    d.detach();
    d.ghost?.remove();
    if (d.targetRow) d.targetRow.style.background = d.targetRowBg;
    document.body.style.userSelect = '';
    if (commit && d.active && d.targetDir != null) {
      onMoveRef.current?.(d.sources, d.targetDir);
    }
  }, []);
  useEffect(() => () => endDrag(false), [endDrag]);

  const onDragMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onMoveRef.current || e.button !== 0 || dragRef.current) return;
      if (isChevronEvent(e.nativeEvent)) return;
      const row = rowFromEvent(e.nativeEvent);
      if (!row) return;
      const rowPath = row.dataset.itemPath!.replace(/\/+$/, '');
      const sources =
        row.dataset.itemType === 'folder' ? [rowPath] : resolveTargets(rowPath);
      if (sources.length === 0) return;
      const label =
        sources.length > 1
          ? `${sources.length} files`
          : sources[0].slice(sources[0].lastIndexOf('/') + 1);

      const onMouseMove = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        if (!d.active) {
          // A small threshold keeps plain clicks (select, chevron) intact.
          if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 5) return;
          d.active = true;
          document.body.style.userSelect = 'none';
          const ghost = document.createElement('div');
          ghost.className = 'tree-drag-ghost';
          document.body.appendChild(ghost);
          d.ghost = ghost;
        }
        ev.preventDefault();
        const composed = ev.composedPath();
        const insideTree = wrapRef.current != null && composed.includes(wrapRef.current);
        let over: HTMLElement | null = null;
        for (const node of composed) {
          if (node instanceof HTMLElement && node.dataset.itemPath != null) {
            over = node;
            break;
          }
        }
        // Resolve the drop directory: a folder row is itself the target; a
        // file row targets its containing folder; bare tree space is the root.
        let dir: string | null = null;
        let overIsDir = false;
        if (insideTree && over) {
          const p = over.dataset.itemPath!.replace(/\/+$/, '');
          overIsDir = over.dataset.itemType === 'folder';
          dir = overIsDir ? p : parentDirOf(p);
        } else if (insideTree) {
          dir = '';
        }
        // At least one source must actually change location — and a folder
        // can never move into itself or its own subtree.
        if (dir != null) {
          const target = dir;
          const movable = d.sources.some(
            (s) => parentDirOf(s) !== target && target !== s && !target.startsWith(s + '/'),
          );
          if (!movable) dir = null;
        }
        d.targetDir = dir;
        // Row wash on the hovered folder row only — a file row's parent isn't
        // the row under the cursor, so those drops read from the ghost label.
        const highlight = dir != null && overIsDir ? over : null;
        if (d.targetRow !== highlight) {
          if (d.targetRow) d.targetRow.style.background = d.targetRowBg;
          d.targetRow = highlight;
          d.targetRowBg = highlight?.style.background ?? '';
          // Inline style because outer CSS can't cross the shadow boundary;
          // the inherited token can (the diff-jump flash precedent).
          if (highlight) highlight.style.background = 'var(--bg-sel)';
        }
        if (d.ghost) {
          d.ghost.style.left = `${ev.clientX + 14}px`;
          d.ghost.style.top = `${ev.clientY + 10}px`;
          d.ghost.textContent =
            dir == null ? d.label : `${d.label} → ${dir === '' ? '/' : dir + '/'}`;
          d.ghost.classList.toggle('invalid', dir == null);
        }
      };
      const onMouseUp = () => endDrag(true);
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') endDrag(false);
      };
      window.addEventListener('mousemove', onMouseMove, true);
      window.addEventListener('mouseup', onMouseUp, true);
      window.addEventListener('keydown', onKeyDown, true);
      dragRef.current = {
        sources,
        label,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        ghost: null,
        targetDir: null,
        targetRow: null,
        targetRowBg: '',
        detach: () => {
          window.removeEventListener('mousemove', onMouseMove, true);
          window.removeEventListener('mouseup', onMouseUp, true);
          window.removeEventListener('keydown', onKeyDown, true);
        },
      };
    },
    [resolveTargets, endDrag],
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
      const path = row.dataset.itemPath!.replace(/\/+$/, '');
      setMenu({
        x,
        y,
        items: menuItems(targets, {
          path,
          kind: fileSetRef.current.has(path) ? 'file' : 'directory',
        }),
      });
    },
    [menuItems, resolveTargets],
  );

  const hostStyle = {
    height: '100%',
    width: '100%',
    minHeight: 0,
    '--strand-tree-search-action-space': searchAction ? '34px' : '0px',
    ...style,
  } as CSSProperties;

  if (paths.length === 0 && emptyLabel) {
    return <div className="tree-empty">{emptyLabel}</div>;
  }

  return (
    <div
      // Theme variables live on the wrap (see features.css): React 18 doesn't
      // forward `className` onto Pierre's custom-element host, but CSS custom
      // properties set here inherit across the shadow boundary regardless.
      className={'tree-host-wrap' + (className ? ` ${className}` : '')}
      ref={wrapRef}
      onMouseDown={onMove ? onDragMouseDown : undefined}
      onClickCapture={onClickCapture}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onKeyDownCapture={onKeyDownCapture}
    >
      <FileTree header={searchAction} model={model} style={hostStyle} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
});
