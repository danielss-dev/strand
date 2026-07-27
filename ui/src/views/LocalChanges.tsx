import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  type DiffLineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs';
import { FileDiff as PierreFileDiff, Virtualizer } from '@pierre/diffs/react';
import type { GitStatusEntry } from '@pierre/trees';

import { Diff, diffAppearanceOptions, parseCacheablePatch } from '../components/Diff';
import { DiffSearchBar, focusDiffSearchInput } from '../components/DiffSearchBar';
import { Icon } from '../components/Icon';
import { ImageDiff } from '../components/ImageDiff';
import { matchTarget, scrollToDiffLine } from '../lib/diffJump';
import { pierreThemeOptions } from '../lib/pierreTheme';
import { isImagePath } from '../lib/image';
import { copyToClipboard, diffStatusToGit, PierreTree, type TreeMenuItem } from '../components/PierreTree';
import { ignorePatterns } from '../lib/ignore';
import { repoAiStyle } from '../lib/db';
import { aiRequestMatches, otherAiProvider } from '../lib/aiGeneration';
import { EDITABLE_SELECTOR, eventInside, formatBinding } from '../lib/keys';
import { concatPatches, patchesToMarkdown } from '../lib/patchExport';
import { AI_AUTH_REQUIRED, gitErrorHint, isCancelled, tauri } from '../lib/tauri';
import {
  hashFileDiff,
  sliceChangeBlock,
  sliceSelectedLines,
  type ChangeLineSelection,
  type SliceDirection,
} from '../lib/patch';
import { treeFileOrder } from '../lib/treeOrder';
import type { LocalSelection } from '../stores/repo';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import type { AiProvider, AiSensitiveDecision, AiSensitiveFile, FileDiff } from '../lib/types';
import { MergeResolver } from './MergeResolver';
import { ConflictLanding } from './ConflictLanding';

/**
 * The staging workspace described in PRD §5: a left column with two file
 * trees (unstaged on top, staged on the bottom), a diff pane on the right,
 * and the commit form pinned to the bottom.
 *
 * Per-row Stage / Unstage shows on hover. Discard lives in the right-click
 * menu (to be wired) so it can't be hit by accident. Clicking a file
 * selects it; ⌘↵ in the subject field commits.
 */
export function LocalChanges({ onOpenFileInEditor }: { onOpenFileInEditor: (file: string) => void }) {
  const unstaged = useRepo((s) => s.unstagedDiffs);
  const staged = useRepo((s) => s.stagedDiffs);
  const status = useRepo((s) => s.status);
  const selection = useRepo((s) => s.localSelection);
  const stageMany = useRepo((s) => s.stageMany);
  const unstageMany = useRepo((s) => s.unstageMany);
  const discardMany = useRepo((s) => s.discardMany);
  const gitignoreAdd = useRepo((s) => s.gitignoreAdd);
  const openIgnoreDialog = useRepo((s) => s.openIgnoreDialog);
  const stageAll = useRepo((s) => s.stageAll);
  const unstageAll = useRepo((s) => s.unstageAll);
  const selectLocalFile = useRepo((s) => s.selectLocalFile);
  const setLocalTreeSelection = useRepo((s) => s.setLocalTreeSelection);
  const requestStashDialog = useRepo((s) => s.requestStashDialog);

  // Conflicted (unmerged) files, from status — drive the Conflicts bar + the
  // in-pane landing. Deduped (status can list a path on both sides).
  const conflicts = useMemo(() => {
    const set = new Set<string>();
    for (const s of status) if (s.kind === 'CONFLICTED') set.add(s.path);
    return [...set];
  }, [status]);
  const conflictSet = useMemo(() => new Set(conflicts), [conflicts]);

  // Untracked paths, also from status — FileSection's diffs don't carry
  // StatusKind, so the .gitignore quick actions key off this set instead.
  const untracked = useMemo(() => {
    const set = new Set<string>();
    for (const s of status) if (s.kind === 'UNTRACKED') set.add(s.path);
    return set;
  }, [status]);

  // Conflicted files are handled by the Conflicts bar + landing, so keep them
  // out of the normal Unstaged/Staged lists (git lists them on both sides,
  // which read as confusing duplicates).
  const unstagedView = useMemo(() => unstaged.filter((d) => !conflictSet.has(d.path)), [unstaged, conflictSet]);
  const stagedView = useMemo(() => staged.filter((d) => !conflictSet.has(d.path)), [staged, conflictSet]);

  // The conflicted file shown in the in-pane landing. Auto-opens the first
  // conflict *when conflicts first appear* (so the resolver isn't hidden behind
  // a click), but a file-list click can dismiss it — so we don't re-open on
  // every render. `prevConflictCount` tracks the 0 → >0 transition.
  const [activeConflict, setActiveConflict] = useState<string | null>(null);
  const prevConflictCount = useRef(0);
  useEffect(() => {
    if (activeConflict && !conflicts.includes(activeConflict)) setActiveConflict(null);
    if (prevConflictCount.current === 0 && conflicts.length > 0) setActiveConflict(conflicts[0]);
    prevConflictCount.current = conflicts.length;
  }, [activeConflict, conflicts]);
  // Selecting a normal changed file dismisses the conflict landing.
  const selectFileRow = useCallback(
    (sel: LocalSelection | null) => { setActiveConflict(null); selectLocalFile(sel); },
    [selectLocalFile],
  );

  // The conflicted file open in the full-screen merge editor, if any.
  const [resolverFile, setResolverFile] = useState<string | null>(null);
  const resolverOpen = useRef(false);
  useEffect(() => {
    if (resolverFile && !conflicts.includes(resolverFile)) setResolverFile(null);
  }, [resolverFile, conflicts]);
  // Mirror into a ref so the keyboard handler (stable listener) sees it.
  resolverOpen.current = resolverFile != null;

  // Default to showing *all* changes (unstaged, else staged) whenever nothing
  // is selected — on open, and after an operation clears the selection.
  useEffect(() => {
    if (selection) return;
    if (unstagedView.length) selectLocalFile({ file: '', staged: false, all: true });
    else if (stagedView.length) selectLocalFile({ file: '', staged: true, all: true });
  }, [selection, unstagedView, stagedView, selectLocalFile]);

  // ── In-diff text search (⌘F) ──────────────────────────────────────────
  // The bar floats over the diff pane and searches both sides at once; each
  // pool entry is tagged with its side, so a jump lands on the copy that
  // actually contains the match (a partially staged path sits on both sides
  // with different hunks in each).
  const [searchOpen, setSearchOpen] = useState(false);
  const diffSearchSignal = useRepo((s) => s.diffSearchSignal);
  const clearDiffSearch = useRepo((s) => s.clearDiffSearch);
  useEffect(() => {
    if (!diffSearchSignal) return;
    setSearchOpen(true);
    // The palette restores focus on close — claim it back for the input.
    focusDiffSearchInput();
    clearDiffSearch();
  }, [diffSearchSignal, clearDiffSearch]);
  // Tag each entry with its side so a jump lands on the diff that actually
  // contains the match — a path can appear on BOTH sides (partially staged)
  // with different hunks in each copy.
  const searchPool = useMemo(
    () => [
      ...unstagedView.map((d) => ({ ...d, tag: false })),
      ...stagedView.map((d) => ({ ...d, tag: true })),
    ],
    [unstagedView, stagedView],
  );
  // Closing the search unmounts its input, so focus drops to <body> — the
  // window-level j/k loop stays live from there (it only bails when focus is
  // in an input). Shift+J/K still scroll the pane directly, so nothing needs
  // to grab focus back. (The Virtualizer that hosts the diff can't take a
  // tabIndex to be focused anyway.)
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // The diff(s) the selection drives. "Show all" → the whole side. A file
  // row → just that file. A folder row (Pierre reports directory paths with
  // a trailing slash, no exact file match) → every changed file beneath it.
  const selectedDiffs = useMemo<FileDiff[]>(() => {
    if (!selection) return [];
    const pool = selection.staged ? stagedView : unstagedView;
    if (selection.all) return pool;
    const exact = pool.find((d) => d.path === selection.file);
    if (exact) return [exact];
    const prefix = selection.file.replace(/\/+$/, '') + '/';
    return pool.filter((d) => d.path.startsWith(prefix));
  }, [selection, unstagedView, stagedView]);

  // ── Staging keyboard loop ─────────────────────────────────────────────
  // j/k file step · n/p change-block step · s stage (unstage on the staged
  // side) · d-d discard · c focus the commit subject. Review marking lives
  // in the Review view. Inactive while typing, while a dialog/palette is
  // open, and while the merge resolver has the screen.
  // A failed write op (stage/unstage/discard) surfaces here as a persistent-
  // enough toast. These used to be fire-and-forget `void` calls, which made
  // failures (e.g. a stale .git/index.lock blocking every index write) look
  // like the buttons silently doing nothing.
  const [opError, setOpError] = useState<string | null>(null);
  useEffect(() => {
    if (!opError) return;
    const t = setTimeout(() => setOpError(null), 8000);
    return () => clearTimeout(t);
  }, [opError]);
  const fail = useCallback(
    (verb: string) => (e: unknown) => setOpError(`${verb} failed: ${gitErrorHint(e)}`),
    [],
  );

  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘F / Ctrl+F opens the in-diff search — checked before the mod-combo
      // guard below. Inert while a dialog/palette or the resolver is up.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        const ft = e.target as HTMLElement | null;
        if (ft?.closest('[role="dialog"], [role="combobox"], .palette-backdrop')) return;
        if (resolverOpen.current) return;
        e.preventDefault();
        setSearchOpen(true);
        focusDiffSearchInput(); // already open → refocus + select
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      // `eventInside` sees through shadow DOM — the Pierre tree's file-search
      // box lives in one, and `e.target` retargets to the host there.
      if (eventInside(e, `${EDITABLE_SELECTOR}, [role="dialog"], .recent-pop`)) return;
      if (resolverOpen.current) return;

      const state = useRepo.getState();
      const sel = state.localSelection;

      // Nav order: unstaged → staged, each in the tree's *display* order
      // (folders first, natural sort) so j/k step straight down the list the
      // user sees instead of the diff list's flat path order.
      const nav: { file: string; staged: boolean }[] = [
        ...treeFileOrder(state.unstagedDiffs.map((d) => d.path)).map((file) => ({ file, staged: false })),
        ...treeFileOrder(state.stagedDiffs.map((d) => d.path)).map((file) => ({ file, staged: true })),
      ];
      const curIdx =
        sel && !sel.all
          ? nav.findIndex((x) => x.file === sel.file && x.staged === sel.staged)
          : -1;

      const selectIdx = (i: number) => {
        const next = nav[Math.max(0, Math.min(nav.length - 1, i))];
        if (next) state.selectLocalFile(next);
      };

      switch (e.key) {
        case 'j':
          if (nav.length === 0) return;
          e.preventDefault();
          selectIdx(curIdx === -1 ? 0 : curIdx + 1);
          break;
        case 'k':
          if (nav.length === 0) return;
          e.preventDefault();
          selectIdx(curIdx === -1 ? 0 : curIdx - 1);
          break;
        case 'n':
        case 'p': {
          e.preventDefault();
          stepChangeBlock(e.key === 'n' ? 1 : -1);
          break;
        }
        // Shift+J / Shift+K scroll the diff pane itself (j/k stay file nav).
        case 'J':
        case 'K': {
          e.preventDefault();
          scrollDiff(e.key === 'J' ? 1 : -1);
          break;
        }
        case 's': {
          if (!sel || sel.all) return;
          e.preventDefault();
          const file = sel.file;
          if (sel.staged) void state.unstageMany([file]).catch(fail('Unstage'));
          else void state.stageMany([file]).catch(fail('Stage'));
          break;
        }
        case 'd': {
          if (!sel || sel.all || sel.staged) return;
          e.preventDefault();
          if (confirmDiscard === sel.file) {
            if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
            setConfirmDiscard(null);
            void state.discardMany([sel.file]).catch(fail('Discard'));
          } else {
            setConfirmDiscard(sel.file);
            if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
            confirmTimer.current = window.setTimeout(() => setConfirmDiscard(null), 2500);
          }
          break;
        }
        // Delete / Backspace discard the selected file in a single press — no
        // double-tap confirmation (that lives on the 'd' shortcut).
        case 'Delete':
        case 'Backspace': {
          if (!sel || sel.all || sel.staged) return;
          e.preventDefault();
          if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
          setConfirmDiscard(null);
          void state.discardMany([sel.file]).catch(fail('Discard'));
          break;
        }
        case 'c': {
          e.preventDefault();
          document
            .querySelector<HTMLInputElement>('.lc-commit-bar .subject')
            ?.focus();
          break;
        }
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmDiscard, fail]);

  return (
    <div className="lc-stack">
      {conflicts.length > 0 && (
        <ConflictBar
          files={conflicts}
          activeFile={activeConflict}
          onSelect={(file) => setActiveConflict(file)}
        />
      )}
      {confirmDiscard && (
        <div className="toast" role="status">
          <span style={{ color: 'var(--del, #e5534b)' }}><Icon name="trash" size={13} /></span>
          <span>Press <strong>d</strong> again to discard {confirmDiscard.split('/').pop()}</span>
        </div>
      )}
      {opError && (
        <div className="toast" role="alert">
          <span style={{ color: 'var(--del, #e5534b)' }}><Icon name="x" size={13} stroke={2} /></span>
          <span>{opError}</span>
          <button type="button" className="toast-action" onClick={() => setOpError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="lc-main">
        <PanelGroup direction="horizontal" autoSaveId="strand:lc-main">
          <Panel defaultSize={28} minSize={15} maxSize={60}>
            <div className="lc-files">
              <PanelGroup direction="vertical" autoSaveId="strand:lc-files">
                <Panel defaultSize={50} minSize={10}>
                  <FileSection
                    title="Unstaged"
                    files={unstagedView}
                    staged={false}
                    selection={selection}
                    onSelect={selectFileRow}
                    onMultiSelectionChange={(paths) => setLocalTreeSelection(false, paths)}
                    onStash={() => requestStashDialog({ snapshot: false })}
                    onAction={(files) => void stageMany(files).catch(fail('Stage'))}
                    actionLabel="Stage"
                    onOpenFileInEditor={onOpenFileInEditor}
                    onDiscard={(files) => void discardMany(files).catch(fail('Discard'))}
                    isUntracked={(p) => untracked.has(p)}
                    onIgnore={(pattern) => void gitignoreAdd(pattern).catch(fail('Ignore'))}
                    onIgnoreCustom={openIgnoreDialog}
                    onBulk={() => void stageAll().catch(fail('Stage all'))}
                    bulkLabel="Stage all"
                  />
                </Panel>
                <PanelResizeHandle className="rs-handle horiz" />
                <Panel defaultSize={50} minSize={10}>
                  <FileSection
                    title="Staged"
                    files={stagedView}
                    staged={true}
                    selection={selection}
                    onSelect={selectFileRow}
                    onMultiSelectionChange={(paths) => setLocalTreeSelection(true, paths)}
                    onStash={() => requestStashDialog({ snapshot: false })}
                    onAction={(files) => void unstageMany(files).catch(fail('Unstage'))}
                    actionLabel="Unstage"
                    onOpenFileInEditor={onOpenFileInEditor}
                    onBulk={() => void unstageAll().catch(fail('Unstage all'))}
                    bulkLabel="Unstage all"
                  />
                </Panel>
              </PanelGroup>
            </div>
          </Panel>
          <PanelResizeHandle className="rs-handle vert" />
          <Panel minSize={30}>
            <div className="diff-search-host">
              {activeConflict ? (
                <ConflictLanding
                  key={activeConflict}
                  path={activeConflict}
                  onOpenEditor={() => setResolverFile(activeConflict)}
                />
              ) : (
                <DiffPane diffs={selectedDiffs} staged={selection?.staged ?? false} />
              )}
              {searchOpen && (
                <DiffSearchBar
                  diffs={searchPool}
                  onJump={(m) => {
                    selectFileRow({ file: m.path, staged: m.tag === true });
                    const target = matchTarget(m);
                    if (!target) return;
                    // Selecting the match narrows the pane to just that file, so
                    // the Virtualizer's scroll maps 1:1 to it — hand over the
                    // patch + layout so scrollToDiffLine can seek proportionally
                    // to a row the Virtualizer hasn't mounted yet (rows past the
                    // window aren't in the DOM to find and center directly).
                    const entry = searchPool.find(
                      (d) => d.path === m.path && d.tag === (m.tag === true),
                    );
                    const layout =
                      useSettings.getState().diffMode === 'split' ? 'split' : 'unified';
                    scrollToDiffLine(
                      '.lc-diff-scroll',
                      target,
                      entry ? { patch: entry.patch, layout } : {},
                    );
                  }}
                  onClose={closeSearch}
                  placeholder="Search changes…"
                />
              )}
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <CommitBar canCommit={staged.length > 0} hasChanges={staged.length > 0 || unstaged.length > 0} />

      {resolverFile && (
        <MergeResolver path={resolverFile} onClose={() => setResolverFile(null)} />
      )}
    </div>
  );
}

/**
 * Scroll the diff pane to the next/previous change block (or, in read-only
 * views with no block markers, the next file header). Powers the n/p keys
 * here and in the Review view (which passes its own scroll-host selector).
 */
export function stepChangeBlock(dir: 1 | -1, hostSelector = '.lc-diff-scroll'): void {
  const host = document.querySelector<HTMLElement>(hostSelector);
  if (!host) return;
  const markers = Array.from(host.querySelectorAll<HTMLElement>('[data-block-marker]'));
  const anchors = markers.length
    ? markers
    : Array.from(host.querySelectorAll<HTMLElement>('.lc-hunkfile'));
  if (anchors.length === 0) {
    // Read-only renders (session diffs) expose no markers — page through.
    host.scrollBy({ top: dir * host.clientHeight * 0.8, behavior: 'smooth' });
    return;
  }

  const hostTop = host.getBoundingClientRect().top;
  const PAD = 60; // breathing room above the block after the jump
  const EPS = 6;
  const positions = anchors
    .map((el) => Math.max(0, el.getBoundingClientRect().top - hostTop + host.scrollTop - PAD))
    .sort((a, b) => a - b);
  const cur = host.scrollTop;
  const target =
    dir === 1
      ? positions.find((p) => p > cur + EPS)
      : [...positions].reverse().find((p) => p < cur - EPS);
  if (target != null) host.scrollTo({ top: target, behavior: 'smooth' });
}

/**
 * Smoothly scroll the diff pane down (`dir: 1`) or up (`dir: -1`) by most of a
 * viewport — powers Shift+J / Shift+K. Like {@link stepChangeBlock}, the host
 * selector defaults to Local Changes' scroller; the Review view passes its own.
 */
export function scrollDiff(dir: 1 | -1, hostSelector = '.lc-diff-scroll'): void {
  const host = document.querySelector<HTMLElement>(hostSelector);
  if (!host) return;
  host.scrollBy({ top: dir * host.clientHeight * 0.85, behavior: 'smooth' });
}

/**
 * Strip above the staging workspace listing the unmerged files during a
 * merge / rebase / cherry-pick. Clicking one shows it in the in-pane conflict
 * landing; the active file is highlighted. Keyboard-operable (each file is a
 * button in a horizontal toolbar).
 */
function ConflictBar({
  files,
  activeFile,
  onSelect,
}: {
  files: string[];
  activeFile: string | null;
  onSelect: (file: string) => void;
}) {
  const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return (
    <div className="lc-conflict-bar" role="toolbar" aria-label="Conflicted files">
      <span className="cb-label">
        <Icon name="rebase" size={12} />
        {files.length} conflicted {files.length === 1 ? 'file' : 'files'}
      </span>
      <div className="cb-files">
        {files.map((f) => (
          <button
            key={f}
            type="button"
            className={'cb-file' + (f === activeFile ? ' active' : '')}
            onClick={() => onSelect(f)}
            title={f}
          >
            {baseName(f)}
          </button>
        ))}
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  files: FileDiff[];
  staged: boolean;
  selection: LocalSelection | null;
  onSelect(sel: LocalSelection | null): void;
  onMultiSelectionChange?(paths: string[]): void;
  onStash?(): void;
  /** Stage (unstaged section) / Unstage (staged section) the given files. */
  onAction(files: string[]): void;
  actionLabel: string;
  /** Open a single file in the configured external editor. */
  onOpenFileInEditor(file: string): void;
  /** Discard the given files' working-tree changes — unstaged section only. */
  onDiscard?: (files: string[]) => void;
  /** Whether a path is untracked — gates the .gitignore quick actions
   * (FileDiff rows don't carry StatusKind). Unstaged section only. */
  isUntracked?: (path: string) => boolean;
  /** Append a pattern to the repo's root .gitignore. */
  onIgnore?: (pattern: string) => void;
  /** Open the custom ignore-pattern dialog, prefilled with the given path. */
  onIgnoreCustom?: (initial: string) => void;
  onBulk(): void;
  bulkLabel: string;
}

/**
 * One side of the staging workspace (Unstaged / Staged) rendered as a Pierre
 * tree. Double-clicking a file stages/unstages it (a folder → all files under
 * it; a multi-selection → all selected). The right-click menu carries the same
 * action plus Discard (unstaged) and Copy path, acting on the same target set.
 * Multi-select with Ctrl/⌘-click and Shift-click is handled by Pierre. Bulk
 * Stage-all / Unstage-all stays in the column header.
 */
function FileSection({
  title,
  files,
  staged,
  selection,
  onSelect,
  onMultiSelectionChange,
  onStash,
  onAction,
  actionLabel,
  onOpenFileInEditor,
  onDiscard,
  isUntracked,
  onIgnore,
  onIgnoreCustom,
  onBulk,
  bulkLabel,
}: SectionProps) {
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => files.map((f) => ({ path: f.path, status: diffStatusToGit(f.status) })),
    [files],
  );
  // A row is highlighted only for a concrete file selection on this side — not
  // for a "show all" selection (the column header carries that highlight).
  const selectedPath =
    selection && !selection.all && selection.staged === staged ? selection.file : null;
  const allActive = selection?.all === true && selection.staged === staged;

  const menuItems = useCallback(
    (targets: string[]): TreeMenuItem[] => {
      const n = targets.length;
      const suffix = n > 1 ? ` ${n} files` : '';
      const items: TreeMenuItem[] = [];
      if (n === 1) {
        items.push({
          label: 'Open in editor',
          icon: 'external',
          onSelect: () => onOpenFileInEditor(targets[0]),
        });
      }
      items.push({
        label: actionLabel + suffix,
        icon: staged ? 'minus' : 'plus',
        onSelect: () => onAction(targets),
      });
      if (onStash) {
        items.push({
          label: (n > 1 ? `Stash${suffix}` : 'Stash') + '…',
          icon: 'stash',
          onSelect: onStash,
        });
      }
      if (onDiscard) {
        items.push({
          label: (n > 1 ? `Discard${suffix}` : 'Discard') + '…',
          icon: 'trash',
          danger: true,
          confirm: true,
          onSelect: () => onDiscard(targets),
        });
      }
      if (n === 1 && onIgnore && isUntracked?.(targets[0])) {
        const target = targets[0];
        const base = target.slice(target.lastIndexOf('/') + 1);
        const { exact, extension } = ignorePatterns(target);
        const submenu: TreeMenuItem[] = [
          { label: `Ignore “${base}”`, onSelect: () => onIgnore(exact) },
        ];
        if (extension) {
          submenu.push({ label: `Ignore all ${extension} files`, onSelect: () => onIgnore(extension) });
        }
        if (onIgnoreCustom) {
          submenu.push({ label: 'Custom pattern…', onSelect: () => onIgnoreCustom(target) });
        }
        items.push({ label: 'Ignore', icon: 'file', submenu });
      }
      items.push({
        label: n > 1 ? 'Copy paths' : 'Copy path',
        icon: 'file',
        onSelect: () => copyToClipboard(targets.join('\n')),
      });
      const diffs = targets
        .map((p) => files.find((f) => f.path === p))
        .filter((f): f is FileDiff => f != null);
      if (diffs.some((f) => f.patch.length > 0)) {
        items.push(
          { label: 'Copy diff', icon: 'file', onSelect: () => copyToClipboard(concatPatches(diffs)) },
          { label: 'Copy diff as Markdown', icon: 'file', onSelect: () => copyToClipboard(patchesToMarkdown(diffs)) },
        );
      }
      return items;
    },
    [
      actionLabel,
      staged,
      onAction,
      onOpenFileInEditor,
      onStash,
      onDiscard,
      isUntracked,
      onIgnore,
      onIgnoreCustom,
      files,
    ],
  );

  return (
    <div className="lc-files-section">
      <div className="lc-col-head">
        <button
          type="button"
          className={'lc-col-title' + (allActive ? ' active' : '')}
          onClick={() => onSelect({ file: '', staged, all: true })}
          disabled={files.length === 0}
          title={`Show all ${title.toLowerCase()} changes`}
          aria-pressed={allActive}
        >
          {title}
          <span className="count">{files.length}</span>
        </button>
        <div className="h-actions">
          {files.length > 0 && (
            <button type="button" className="h-link" onClick={onBulk}>
              {bulkLabel}
            </button>
          )}
        </div>
      </div>
      <PierreTree
        paths={paths}
        gitStatus={gitStatus}
        selectedPath={selectedPath}
        onSelect={(p) => onSelect(p ? { file: p, staged } : null)}
        onMultiSelectionChange={onMultiSelectionChange}
        onActivate={onAction}
        menuItems={menuItems}
        onDiscard={onDiscard}
        toggleDirOnRowClick={false}
        emptyLabel={staged ? 'Nothing staged.' : 'No unstaged changes.'}
      />
    </div>
  );
}

// ─── Diff pane ──────────────────────────────────────────────────────────────

function DiffPane({ diffs, staged }: { diffs: FileDiff[]; staged: boolean }) {
  // The unified/split toggle lives in the main header (App.tsx → MainHeader)
  // and writes to `useSettings.diffMode`. Pierre talks 'unified' | 'split',
  // our setting is 'stacked' | 'split' — map at the boundary.
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  // `diffsCollapsed` (the header toggle) is the bulk default; `overrides` holds
  // the files the user has individually flipped away from it via their header.
  // A bulk toggle clears the overrides so "collapse/expand all" is absolute.
  // A lone file always defaults to expanded — collapse-all only makes sense for
  // the multi-file (folder / show-all) views.
  const diffsCollapsed = useSettings((s) => s.diffsCollapsed);
  const [overrides, setOverrides] = useState<Set<string>>(() => new Set());
  useEffect(() => setOverrides(new Set()), [diffsCollapsed]);

  const baseCollapsed = diffs.length > 1 && diffsCollapsed;
  const isCollapsed = (path: string) =>
    overrides.has(path) ? !baseCollapsed : baseCollapsed;
  const toggle = (path: string) =>
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="lc-diff">
      {diffs.length === 0 ? (
        <div className="lc-diff-scroll">
          <div className="lc-empty">
            <strong>Select a file</strong>
            Pick something on the left to see its diff.
          </div>
        </div>
      ) : (
        // Pierre's <Virtualizer> is the scroll container and window-renders each
        // file's rows: a whole-file diff (a 5,000-line agent change) mounts only
        // what's on screen instead of all ~7,500 line elements (~1.5s → bounded).
        // Every stacked <PierreFileDiff> auto-registers with this one Virtualizer
        // through context (useFileDiffInstance → useVirtualizer), same as Review.
        <Virtualizer className="lc-diff-scroll">
          {diffs.map((d) => (
            <FileDiffSection
              key={`${staged ? 's' : 'u'}:${d.path}`}
              diff={d}
              staged={staged}
              layout={layout}
              collapsed={isCollapsed(d.path)}
              onToggle={() => toggle(d.path)}
            />
          ))}
        </Virtualizer>
      )}
    </div>
  );
}

/**
 * One file in the diff pane: a sticky, clickable header that folds its diff
 * body, plus the body itself (Pierre diff with per-block actions, or a compact
 * note for binary / no-diff files). Collapsed → header only.
 */
function FileDiffSection({
  diff,
  staged,
  layout,
  collapsed,
  onToggle,
}: {
  diff: FileDiff;
  staged: boolean;
  layout: 'unified' | 'split';
  collapsed: boolean;
  onToggle: () => void;
}) {
  const empty = diff.binary || diff.patch.length === 0;
  const image = diff.binary && isImagePath(diff.path);

  // Viewport-lazy mount: the "show all" view can stack hundreds of files, and
  // mounting every Pierre diff at once froze the app on open / after a big
  // squash-merge. We only mount a file's diff body once its block scrolls near
  // the viewport, and keep it mounted thereafter (mounting is the cost, not
  // staying mounted). Until then a placeholder reserves the file's estimated
  // height so the scrollbar stays honest and far-off diffs aren't counted as
  // near. Empty/binary bodies are trivial, so they skip the gating — except
  // images, whose preview costs an IPC blob fetch per side: they gate like
  // text diffs so a "show all" stack doesn't fire N fetches on open.
  const blockRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || collapsed || (empty && !image)) return;
    const el = blockRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      // Pre-mount a screenful early so a fast scroll meets ready content.
      { rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, collapsed, empty, image]);

  // Rough body-height estimate (changed lines, no context) so the placeholder
  // reserves space close to the real diff height.
  const estHeight = useMemo(
    () => Math.min(1600, Math.max(80, (diff.adds + diff.dels) * 20)),
    [diff.adds, diff.dels],
  );

  return (
    <div className="lc-file-block" ref={blockRef}>
      <FileHeaderStrip diff={diff} collapsed={collapsed} onToggle={onToggle} />
      {!collapsed &&
        (image && !seen ? (
          <div className="lc-file-pending" style={{ height: 180 }} aria-hidden />
        ) : image ? (
          // Old side: the unstaged diff's base is the *index* (a partially
          // staged image's HEAD copy would lie); the staged diff's base is
          // HEAD. An added file has no old side.
          // New side: the working tree (unstaged) or the index (staged).
          <ImageDiff
            path={diff.path}
            oldSrc={
              diff.status === 'added'
                ? null
                : staged
                  ? { rev: 'HEAD' }
                  : { rev: null, index: true }
            }
            newSrc={
              diff.status === 'deleted' ? null : staged ? { rev: null, index: true } : { rev: null }
            }
          />
        ) : empty ? (
          <div className="lc-file-note">
            {diff.binary ? 'Binary file — no diff shown.' : 'No textual diff.'}
          </div>
        ) : seen ? (
          // Keyed by content hash so a content change remounts the instance
          // rather than re-propping it: inside the Virtualizer this renders a
          // VirtualizedFileDiff, which pins the first fileDiff it sees
          // (`this.fileDiff ??=`). Without the remount, staging a block (which
          // shrinks this file's unstaged patch) would leave the pane showing
          // the pre-stage diff. (The non-virtual path updated on re-prop.)
          <HunkAnnotatedDiff
            key={hashFileDiff(diff)}
            diff={diff}
            layout={layout}
            side={staged ? 'staged' : 'unstaged'}
          />
        ) : (
          <div className="lc-file-pending" style={{ height: estHeight }} aria-hidden />
        ))}
    </div>
  );
}

interface LineRange {
  start: number;
  end: number;
}

interface BlockMeta {
  hunkIndex: number;
  /** Position in Pierre's `hunkContent[]` array — matches `DiffAcceptRejectHunkConfig.changeIndex`. */
  contentIndex: number;
  /** Pre-computed range Pierre needs to tint the affected lines on hover. */
  range: SelectedLineRange;
  /** Inclusive line range on the deletions side (undefined for pure-add blocks). */
  delRange?: LineRange;
  /** Inclusive line range on the additions side (undefined for pure-del blocks). */
  addRange?: LineRange;
  /** Changed lines shown by the keyboard-operable line picker. */
  lines: { side: 'deletions' | 'additions'; number: number; text: string }[];
}

interface ActiveLineSelection {
  blockId: string;
  range: SelectedLineRange | null;
  lines: ChangeLineSelection;
  count: number;
}

const blockKey = (m: { hunkIndex: number; contentIndex: number }): string =>
  `${m.hunkIndex}:${m.contentIndex}`;

function changedLinesFromRange(meta: BlockMeta, range: SelectedLineRange): ChangeLineSelection | null {
  const startSide = range.side ?? 'additions';
  const endSide = range.endSide ?? startSide;
  const start = meta.lines.findIndex((line) => line.side === startSide && line.number === range.start);
  const end = meta.lines.findIndex((line) => line.side === endSide && line.number === range.end);
  if (start === -1 || end === -1) return null;
  const selected = meta.lines.slice(Math.min(start, end), Math.max(start, end) + 1);
  return {
    deletions: selected.filter((line) => line.side === 'deletions').map((line) => line.number),
    additions: selected.filter((line) => line.side === 'additions').map((line) => line.number),
  };
}

/**
 * Renders a file's diff as one `<PierreFileDiff/>` with all action UI
 * lifted into a sibling overlay. The trade-off: Pierre's per-annotation
 * slot is anchored to one column (additions or deletions), so a slotted
 * button drifts horizontally based on which side it lives on. Instead,
 * `renderAnnotation` plants an invisible marker that we measure with
 * `getBoundingClientRect`, and the overlay positions a real button at
 * that Y, pinned to the diff's right edge for consistent X.
 *
 * Hovering a button sets `selectedLines` to that block's range, so
 * Pierre tints the affected lines using its built-in selection
 * background. The user sees what will be staged/discarded before they
 * click.
 *
 * Each annotation acts on a specific change block (`hunkContent[N]`,
 * matching Pierre's `DiffAcceptRejectHunkConfig.changeIndex` semantics).
 * Clicking calls `sliceChangeBlock` to build a synthetic single-hunk
 * patch and routes through `useRepo.applyPatch`:
 * - Stage   → `apply --cached` (`index`)            slices forward
 * - Discard → `apply --reverse` (`workdir_reverse`) slices reverse
 * - Unstage → `apply --cached --reverse` (`index_reverse`) slices reverse
 */
export function HunkAnnotatedDiff({
  diff,
  layout,
  side,
  onNoteBlock,
  onApplyBlock,
}: {
  diff: FileDiff;
  layout: 'unified' | 'split';
  side: 'unstaged' | 'staged';
  /** When provided (the Review view), each change block grows a "Note"
   * action that hands its meta back for a line-anchored review note. */
  onNoteBlock?: (meta: BlockMeta) => void;
  /** When provided (Workspace Review), sliced patches route here instead of
   * the active repo's `useRepo.applyPatch` / `discardPatch` — the diff may
   * belong to a background member repo. The override owns the follow-up
   * refresh and, for discards, the single-undo handle. */
  onApplyBlock?: (slice: string, target: ApplyTarget) => Promise<void>;
}) {
  const applyPatch = useRepo((s) => s.applyPatch);
  const discardPatch = useRepo((s) => s.discardPatch);
  const resolvedTheme = useSettings((s) => s.resolvedTheme);
  const [pending, setPending] = useState<string | null>(null);
  const [lineSelection, setLineSelection] = useState<ActiveLineSelection | null>(null);
  const [linePicker, setLinePicker] = useState<string | null>(null);
  const linePickerOpenRef = useRef(false);
  linePickerOpenRef.current = linePicker != null;
  // Hunk-level apply failures render inline above the diff (this component
  // is shared with the Review view, so it carries its own error surface).
  const [applyError, setApplyError] = useState<string | null>(null);
  // Two independent hover sources. `lineHovered` follows Pierre's
  // onLineEnter (set when the cursor is on a block line, null on a
  // context line); `slotHovered` follows the overlay button's own
  // mouse-enter/leave. The effective hovered block is `slot ?? line` —
  // line-hover gives the live "what's under the cursor" signal, and
  // slot-hover pins the highlight while the cursor is on the button
  // (which sits in the row above the block, where Pierre would
  // otherwise report a context line and clear the highlight).
  const [lineHovered, setLineHovered] = useState<string | null>(null);
  const [slotHovered, setSlotHovered] = useState<string | null>(null);
  const hovered = slotHovered ?? lineHovered;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<Map<string, number>>(() => new Map());

  // Parse once per patch string. The cacheKey lets the worker pool reuse the
  // highlighted AST across remounts (see parseCacheablePatch).
  const fileDiff = useMemo(() => {
    try {
      return parseCacheablePatch(diff.patch);
    } catch (e) {
      // Mode-only changes, binary, or otherwise unparseable patches: let
      // the fallback `<Diff/>` branch below render them.
      console.warn('parseCacheablePatch failed', e);
      return null;
    }
  }, [diff.patch]);

  const { annotations, metaById, lineToId } = useMemo(() => {
    const list: DiffLineAnnotation<BlockMeta>[] = [];
    const byId = new Map<string, BlockMeta>();
    // Two side-keyed maps so onLineEnter can do an O(1) lookup instead of
    // walking the annotation list on every line-boundary crossing.
    const lineMap = {
      additions: new Map<number, string>(),
      deletions: new Map<number, string>(),
    };
    if (!fileDiff) return { annotations: list, metaById: byId, lineToId: lineMap };

    for (let h = 0; h < fileDiff.hunks.length; h++) {
      const hunk = fileDiff.hunks[h];
      // Cursors track the next addition/deletion line *number* (1-based,
      // matching the hunk header) as we walk the hunk's content groups.
      let addLine = hunk.additionStart;
      let delLine = hunk.deletionStart;
      for (let c = 0; c < hunk.hunkContent.length; c++) {
        const item = hunk.hunkContent[c];
        if (item.type === 'context') {
          addLine += item.lines;
          delLine += item.lines;
          continue;
        }
        const delRange: LineRange | undefined =
          item.deletions > 0
            ? { start: delLine, end: delLine + item.deletions - 1 }
            : undefined;
        const addRange: LineRange | undefined =
          item.additions > 0
            ? { start: addLine, end: addLine + item.additions - 1 }
            : undefined;
        // Range Pierre tints on hover. Span from the first deletion (if
        // any) through the last addition (if any), so a mixed `-foo /
        // +FOO` block highlights as one region; pure-add/pure-delete
        // reduce to one side. Derived from delRange + addRange so
        // there's only one source of truth for the block's lines.
        const range: SelectedLineRange = delRange
          ? addRange
            ? { start: delRange.start, side: 'deletions', end: addRange.end, endSide: 'additions' }
            : { start: delRange.start, side: 'deletions', end: delRange.end, endSide: 'deletions' }
          : {
              start: addRange!.start,
              side: 'additions',
              end: addRange!.end,
              endSide: 'additions',
            };
        // Anchor on the first deleted line if the block has any, else
        // the first added line. In unified mode the deletions stack
        // *above* the additions, so the deletion line is the visual
        // top of the block; anchoring there puts the button above the
        // whole change region rather than between the - and + halves.
        // In split mode both sides start at the same Y, so the choice
        // doesn't matter visually.
        const annSide: 'deletions' | 'additions' = delRange ? 'deletions' : 'additions';
        const annLine = delRange ? delRange.start : addRange!.start;
        const lines: BlockMeta['lines'] = [];
        if (delRange) {
          for (let offset = 0; offset < item.deletions; offset++) {
            lines.push({
              side: 'deletions',
              number: delRange.start + offset,
              text: fileDiff.deletionLines[item.deletionLineIndex + offset] ?? '',
            });
          }
        }
        if (addRange) {
          for (let offset = 0; offset < item.additions; offset++) {
            lines.push({
              side: 'additions',
              number: addRange.start + offset,
              text: fileDiff.additionLines[item.additionLineIndex + offset] ?? '',
            });
          }
        }
        const meta: BlockMeta = { hunkIndex: h, contentIndex: c, range, delRange, addRange, lines };
        const id = blockKey(meta);
        list.push({ side: annSide, lineNumber: annLine, metadata: meta });
        byId.set(id, meta);
        if (delRange) {
          for (let n = delRange.start; n <= delRange.end; n++) lineMap.deletions.set(n, id);
        }
        if (addRange) {
          for (let n = addRange.start; n <= addRange.end; n++) lineMap.additions.set(n, id);
        }
        addLine += item.additions;
        delLine += item.deletions;
      }
    }
    return { annotations: list, metaById: byId, lineToId: lineMap };
  }, [fileDiff]);

  const onLineSelected = useCallback(
    (range: SelectedLineRange | null) => {
      // The picker owns selection while it is open. Pierre may emit the last
      // drag range when controlled `selectedLines` changes to null; accepting
      // that callback would silently re-check lines the user just cleared.
      if (linePickerOpenRef.current) return;
      if (!range) {
        setLineSelection(null);
        return;
      }
      const startSide = range.side ?? 'additions';
      const endSide = range.endSide ?? startSide;
      const startId = lineToId[startSide].get(range.start);
      const endId = lineToId[endSide].get(range.end);
      if (!startId || startId !== endId) {
        setLineSelection(null);
        return;
      }
      const meta = metaById.get(startId);
      const lines = meta ? changedLinesFromRange(meta, range) : null;
      const count = (lines?.deletions.length ?? 0) + (lines?.additions.length ?? 0);
      setLineSelection(lines && count > 0 ? { blockId: startId, range, lines, count } : null);
    },
    [lineToId, metaById],
  );

  // After Pierre renders (and on scroll / resize / annotation change),
  // measure each marker's Y so the overlay can position buttons there.
  // Markers live in the *light DOM* as direct children of
  // `<diffs-container>` (Pierre slots them into its shadow root for
  // display); `getBoundingClientRect` returns their visual position
  // either way, so we read from the light-DOM nodes directly.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let frame = 0;
    let observer: ResizeObserver | null = null;
    let scrollHost: Element | null = null;

    function measure() {
      if (!wrapper) return;
      const markers = wrapper.querySelectorAll<HTMLElement>('[data-block-marker]');
      if (markers.length === 0) {
        // Pierre may not have rendered yet — try again next frame.
        frame = requestAnimationFrame(measure);
        return;
      }
      const wRect = wrapper.getBoundingClientRect();
      const next = new Map<string, number>();
      for (const m of markers) {
        const id = m.dataset.blockMarker;
        if (!id) continue;
        const r = m.getBoundingClientRect();
        next.set(id, r.top - wRect.top);
      }
      setTops((prev) => (mapsEqual(prev, next) ? prev : next));
    }

    // Pierre renders asynchronously via its worker pool; the markers
    // appear a frame or two after this effect runs. The RAF loop in
    // `measure` retries until they show up. `ResizeObserver` then
    // catches subsequent layout shifts.
    frame = requestAnimationFrame(measure);
    observer = new ResizeObserver(measure);
    observer.observe(wrapper);

    // The diff scrolls inside `.lc-diff-scroll` (here) or `.rv-diff-scroll`
    // (the Review view reuses this component) — listen on whichever hosts
    // us. The container itself doesn't scroll.
    scrollHost = wrapper.closest('.lc-diff-scroll, .rv-diff-scroll');
    if (scrollHost) scrollHost.addEventListener('scroll', measure, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (scrollHost) scrollHost.removeEventListener('scroll', measure);
    };
  }, [annotations]);

  const selectedLines: SelectedLineRange | null = lineSelection
    ? lineSelection.range
    : hovered
      ? (metaById.get(hovered)?.range ?? null)
      : null;

  // Stabilize the callbacks Pierre stores in `options`. `useFileDiffInstance`
  // runs `setOptions` on every render and uses shallow equality
  // (`areOptionsEqual` → `areObjectsEqual`) to decide whether to force a
  // full re-render. A fresh `onLineEnter` lambda each render would flip
  // that comparison every time `hovered` changes → forceRender →
  // re-virtualization → the Virtualizer's `applyScrollFix` snaps the
  // scroll to its anchor, which can land at the top of the diff.
  const onLineEnter = useCallback(
    (props: { lineNumber: number; annotationSide: 'additions' | 'deletions' }) => {
      // Set unconditionally — context lines map to `undefined` which we
      // store as `null`, so leaving a block into surrounding context
      // clears `lineHovered`. The slot's own pointer events keep the
      // button visible (`slotHovered`) when the cursor is over it.
      const id = lineToId[props.annotationSide].get(props.lineNumber) ?? null;
      setLineHovered(id);
    },
    [lineToId],
  );
  const renderAnnotation = useCallback(
    (a: DiffLineAnnotation<BlockMeta>) => (
      <span className="lc-block-marker" data-block-marker={blockKey(a.metadata)} />
    ),
    [],
  );
  // Appearance settings (Settings → Diff) — subscribed individually and kept
  // inside the memo deps so the options object stays referentially stable
  // (see the onLineEnter note above: unstable options force re-virtualization).
  const diffIndicators = useSettings((s) => s.diffIndicators);
  const diffLineNumbers = useSettings((s) => s.diffLineNumbers);
  const diffWordHighlight = useSettings((s) => s.diffWordHighlight);
  const fileDiffOptions = useMemo(
    () => ({
      diffStyle: layout,
      ...pierreThemeOptions(resolvedTheme),
      disableBackground: true,
      disableFileHeader: true,
      ...diffAppearanceOptions({ diffIndicators, diffLineNumbers, diffWordHighlight }),
      onLineEnter,
      enableLineSelection: true,
      onLineSelected,
    }),
    [layout, resolvedTheme, diffIndicators, diffLineNumbers, diffWordHighlight, onLineEnter, onLineSelected],
  );

  async function run(meta: BlockMeta, direction: SliceDirection, target: ApplyTarget) {
    const key = `${blockKey(meta)}:${target}`;
    if (pending != null) return;
    setPending(key);
    setApplyError(null);
    try {
      const selected = lineSelection?.blockId === blockKey(meta) ? lineSelection : null;
      const slice = selected
        ? sliceSelectedLines(
            diff.patch,
            meta.hunkIndex,
            meta.contentIndex,
            direction,
            selected.lines,
          )
        : sliceChangeBlock(diff.patch, meta.hunkIndex, meta.contentIndex, direction);
      if (onApplyBlock) {
        await onApplyBlock(slice, target);
      } else if (target === 'workdir_reverse') {
        // Discard routes through discardPatch so it records a single-undo
        // handle; stage / unstage are non-destructive and don't need one.
        const name = diff.path.split('/').pop() ?? diff.path;
        await discardPatch(slice, `Discarded a change in ${name}`);
      } else {
        await applyPatch(slice, target);
      }
      setLineSelection(null);
      setLinePicker(null);
    } catch (e) {
      console.error('apply patch failed', e);
      setApplyError(gitErrorHint(e));
    } finally {
      setPending(null);
    }
  }

  function setPickedLines(meta: BlockMeta, lines: BlockMeta['lines']) {
    const deletions = lines.filter((line) => line.side === 'deletions').map((line) => line.number);
    const additions = lines.filter((line) => line.side === 'additions').map((line) => line.number);
    const count = deletions.length + additions.length;
    setLineSelection(
      count > 0
        ? { blockId: blockKey(meta), range: null, lines: { deletions, additions }, count }
        : null,
    );
  }

  function togglePickedLine(meta: BlockMeta, side: 'deletions' | 'additions', number: number) {
    const active = lineSelection?.blockId === blockKey(meta) ? lineSelection.lines : null;
    const selected = new Set([
      ...(active?.deletions.map((line) => `deletions:${line}`) ?? []),
      ...(active?.additions.map((line) => `additions:${line}`) ?? []),
    ]);
    const key = `${side}:${number}`;
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    setPickedLines(meta, meta.lines.filter((line) => selected.has(`${line.side}:${line.number}`)));
  }

  // Patches we can't structurally parse (mode-only, binary stubs that
  // slip past the binary check) fall back to read-only rendering — there
  // are no change blocks to act on anyway.
  if (!fileDiff || fileDiff.hunks.length === 0) {
    return <Diff patch={diff.patch} layout={layout} hideFileHeader />;
  }

  return (
    <>
      {applyError && (
        <div className="lc-file-note" role="alert">
          Couldn’t apply the change: {applyError}
        </div>
      )}
      <div
        className="lc-diff-wrap"
        ref={wrapperRef}
        onMouseLeave={() => {
          setLineHovered(null);
          setSlotHovered(null);
        }}
      >
        <PierreFileDiff<BlockMeta>
          fileDiff={fileDiff}
          lineAnnotations={annotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
          options={fileDiffOptions}
        />
        <div className="lc-actions-overlay" aria-hidden="false">
          {annotations
            .map((a) => ({ a, id: blockKey(a.metadata), top: tops.get(blockKey(a.metadata)) }))
            .filter((s): s is { a: typeof s.a; id: string; top: number } => s.top != null)
            .map(({ a, id, top }) => (
              <div
                key={id}
                className="lc-overlay-slot"
                data-active={hovered === id ? '' : undefined}
                style={{ top }}
                onMouseEnter={() => setSlotHovered(id)}
                onMouseLeave={() =>
                  setSlotHovered((cur) => (cur === id ? null : cur))
                }
                onFocus={() => setSlotHovered(id)}
                onBlur={() =>
                  setSlotHovered((cur) => (cur === id ? null : cur))
                }
                onPointerDownCapture={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <BlockActions
                  meta={a.metadata}
                  side={side}
                  pending={pending}
                  selectionCount={lineSelection?.blockId === id ? lineSelection.count : 0}
                  onRun={(d, t) => void run(a.metadata, d, t)}
                  onNote={onNoteBlock && (() => onNoteBlock(a.metadata))}
                  onChooseLines={() => {
                    setLineSelection(null);
                    setLinePicker((current) => (current === id ? null : id));
                  }}
                />
                {linePicker === id && (
                  <LinePicker
                    meta={a.metadata}
                    side={side}
                    selected={lineSelection?.blockId === id ? lineSelection.lines : null}
                    pending={pending != null}
                    onToggle={(lineSide, number) => togglePickedLine(a.metadata, lineSide, number)}
                    onSelectAll={() => setPickedLines(a.metadata, a.metadata.lines)}
                    onClear={() => setPickedLines(a.metadata, [])}
                    onApply={(direction, target) => void run(a.metadata, direction, target)}
                    onClose={() => setLinePicker(null)}
                  />
                )}
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

export type ApplyTarget = 'index' | 'index_reverse' | 'workdir_reverse';

function FileHeaderStrip({
  diff,
  collapsed,
  onToggle,
}: {
  diff: FileDiff;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="lc-hunkfile"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expand diff' : 'Collapse diff'}
    >
      <Icon name={collapsed ? 'chev-right' : 'chev-down'} size={12} className="chev" />
      <span className="path">{diff.path}</span>
      <span className="stat-del">−{diff.dels}</span>
      <span className="stat-add">+{diff.adds}</span>
    </button>
  );
}

function BlockActions({
  meta,
  side,
  pending,
  selectionCount,
  onRun,
  onNote,
  onChooseLines,
}: {
  meta: BlockMeta;
  side: 'unstaged' | 'staged';
  pending: string | null;
  selectionCount: number;
  onRun(direction: SliceDirection, target: ApplyTarget): void;
  onNote?: () => void;
  onChooseLines: () => void;
}) {
  const busy = pending != null;
  const myKey = (target: ApplyTarget) => `${blockKey(meta)}:${target}`;
  if (side === 'staged') {
    const isMe = pending === myKey('index_reverse');
    return (
      <div className="lc-block-actions">
        <button
          type="button"
          className="hbtn accept"
          disabled={busy}
          onClick={() => onRun('reverse', 'index_reverse')}
          title={selectionCount > 0 ? 'Unstage selected lines' : 'Unstage this change'}
        >
          {isMe ? 'Unstaging…' : selectionCount > 0 ? `Unstage ${selectionCount}` : 'Unstage'}
        </button>
        <button type="button" className="hbtn" disabled={busy} onClick={onChooseLines} title="Choose individual lines">
          Lines…
        </button>
      </div>
    );
  }
  const stagingMe = pending === myKey('index');
  const discardingMe = pending === myKey('workdir_reverse');
  return (
    <div className="lc-block-actions">
      <button
        type="button"
        className="hbtn accept"
        disabled={busy}
        onClick={() => onRun('forward', 'index')}
        title={selectionCount > 0 ? 'Stage selected lines' : 'Stage this change'}
      >
        {stagingMe ? 'Staging…' : selectionCount > 0 ? `Stage ${selectionCount}` : 'Stage'}
      </button>
      <button
        type="button"
        className="hbtn reject"
        disabled={busy}
        onClick={() => onRun('reverse', 'workdir_reverse')}
        title={selectionCount > 0 ? 'Discard selected lines from the working tree' : 'Discard this change from the working tree'}
      >
        {discardingMe ? 'Discarding…' : selectionCount > 0 ? `Discard ${selectionCount}` : 'Discard'}
      </button>
      <button type="button" className="hbtn" disabled={busy} onClick={onChooseLines} title="Choose individual lines">
        Lines…
      </button>
      {onNote && (
        <button
          type="button"
          className="hbtn"
          disabled={busy}
          onClick={onNote}
          title="Attach a review note to this change"
        >
          Note
        </button>
      )}
    </div>
  );
}

function LinePicker({
  meta,
  side,
  selected,
  pending,
  onToggle,
  onSelectAll,
  onClear,
  onApply,
  onClose,
}: {
  meta: BlockMeta;
  side: 'unstaged' | 'staged';
  selected: ChangeLineSelection | null;
  pending: boolean;
  onToggle: (side: 'deletions' | 'additions', number: number) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onApply: (direction: SliceDirection, target: ApplyTarget) => void;
  onClose: () => void;
}) {
  const selectedKeys = new Set([
    ...(selected?.deletions.map((line) => `deletions:${line}`) ?? []),
    ...(selected?.additions.map((line) => `additions:${line}`) ?? []),
  ]);
  const count = selectedKeys.size;
  return (
    <div
      className="lc-line-picker"
      role="group"
      aria-label="Choose changed lines"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="lc-line-picker-head">
        <strong>Choose lines</strong>
        <span>{count} selected</span>
        <button type="button" className="cd-close" aria-label="Close line picker" onClick={onClose}>×</button>
      </div>
      <div className="lc-line-picker-list">
        {meta.lines.map((line, index) => {
          const key = `${line.side}:${line.number}`;
          const deletion = line.side === 'deletions';
          return (
            <label className="lc-line-picker-row" key={key}>
              <input
                autoFocus={index === 0}
                type="checkbox"
                checked={selectedKeys.has(key)}
                disabled={pending}
                onChange={() => onToggle(line.side, line.number)}
              />
              <span className={deletion ? 'del' : 'add'}>{deletion ? '−' : '+'}{line.number}</span>
              <code title={line.text}>{line.text || ' '}</code>
            </label>
          );
        })}
      </div>
      <div className="lc-line-picker-foot">
        <button type="button" className="hbtn" disabled={pending} onClick={onSelectAll}>All</button>
        <button type="button" className="hbtn" disabled={pending || count === 0} onClick={onClear}>Clear</button>
        <span className="spacer" />
        {side === 'staged' ? (
          <button
            type="button"
            className="hbtn accept"
            disabled={pending || count === 0}
            onClick={() => onApply('reverse', 'index_reverse')}
          >
            Unstage selected
          </button>
        ) : (
          <>
            <button
              type="button"
              className="hbtn accept"
              disabled={pending || count === 0}
              onClick={() => onApply('forward', 'index')}
            >
              Stage selected
            </button>
            <button
              type="button"
              className="hbtn reject"
              disabled={pending || count === 0}
              onClick={() => onApply('reverse', 'workdir_reverse')}
            >
              Discard selected
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Commit bar ─────────────────────────────────────────────────────────────

function CommitBar({ canCommit, hasChanges }: { canCommit: boolean; hasChanges: boolean }) {
  const activePath = useRepo((s) => s.activePath);
  const commonDir = useRepo((s) => s.meta?.common_dir ?? null);
  const commit = useRepo((s) => s.commit);
  const suggestCommitSignal = useRepo((s) => s.suggestCommitSignal);
  const clearSuggestCommitMessage = useRepo((s) => s.clearSuggestCommitMessage);
  const aiProvider = useSettings((s) => s.aiProvider);
  const openaiModel = useSettings((s) => s.openaiModel);
  const anthropicModel = useSettings((s) => s.anthropicModel);
  const openaiCli = useSettings((s) => s.openaiCli);
  const anthropicCli = useSettings((s) => s.anthropicCli);
  const platform = useSettings((s) => s.platform);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [sensitivePrompt, setSensitivePrompt] = useState<{
    fingerprint: string;
    files: AiSensitiveFile[];
  } | null>(null);
  const [retryProvider, setRetryProvider] = useState<AiProvider | null>(null);

  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const requestRef = useRef<{ opId: string; path: string; provider: typeof aiProvider; model: string } | null>(null);
  const suggestingRef = useRef(false);

  const fitBody = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    node.style.height = '32px';
    const height = Math.min(120, Math.max(32, node.scrollHeight));
    node.style.height = `${height}px`;
    node.style.overflowY = node.scrollHeight > 120 ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => fitBody(bodyRef.current), [body, fitBody]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - width) < 1) return;
      width = entry.contentRect.width;
      fitBody(node);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fitBody]);

  const cancelSuggestion = useCallback(() => {
    const request = requestRef.current;
    requestRef.current = null;
    suggestingRef.current = false;
    setSuggesting(false);
    if (request) void tauri.repoCancelOp(request.opId);
  }, []);

  useEffect(() => cancelSuggestion, [activePath, aiProvider, openaiCli, anthropicCli, openaiModel, anthropicModel, cancelSuggestion]);

  const suggest = useCallback(async (
    sensitiveDecision: AiSensitiveDecision = { mode: 'scan' },
    provider: AiProvider = aiProvider,
  ) => {
    if (!activePath || !hasChanges || suggestingRef.current) return;
    const opId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const model = provider === 'openai' ? openaiModel : anthropicModel;
    const request = { opId, path: activePath, provider, model };
    requestRef.current = request;
    suggestingRef.current = true;
    setSuggesting(true);
    setCommitError(null);
    setSensitivePrompt(null);
    setRetryProvider(null);
    try {
      const styleInstruction = commonDir ? await repoAiStyle.get(commonDir) : null;
      if (requestRef.current !== request) return;
      const outcome = await tauri.repoSuggestCommitMessage(
        activePath,
        provider,
        model,
        { opId, sensitiveDecision, styleInstruction },
        openaiCli,
        anthropicCli,
      );
      if (requestRef.current !== request || !aiRequestMatches(request, {
        path: useRepo.getState().activePath ?? '',
        provider,
      })) return;
      if (outcome.status === 'needs_confirmation') {
        setSensitivePrompt({ fingerprint: outcome.fingerprint, files: outcome.sensitiveFiles });
        return;
      }
      if (outcome.provider !== provider) return;
      setSubject(outcome.suggestion.subject);
      setBody(outcome.suggestion.body ?? '');
      subjectRef.current?.focus();
    } catch (e) {
      if (requestRef.current !== request || isCancelled(e)) return;
      const msg = gitErrorHint(e);
      if (msg.startsWith(AI_AUTH_REQUIRED)) {
        try {
          await tauri.aiProviderLogin(provider, openaiCli, anthropicCli);
          setCommitError('Sign-in started — complete it in the browser or CLI window, then click Suggest again.');
        } catch (loginErr) {
          console.error('ai provider login failed', loginErr);
          setCommitError(`Sign-in failed: ${gitErrorHint(loginErr)}`);
        }
        return;
      }
      console.error('suggest commit message failed', e);
      setCommitError(`Suggestion failed: ${msg}`);
      setRetryProvider(otherAiProvider(provider));
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        suggestingRef.current = false;
        setSuggesting(false);
      }
    }
  }, [activePath, aiProvider, anthropicCli, anthropicModel, commonDir, hasChanges, openaiCli, openaiModel]);

  useEffect(() => {
    if (!suggestCommitSignal) return;
    clearSuggestCommitMessage();
    void suggest();
  }, [suggestCommitSignal, clearSuggestCommitMessage, suggest]);

  async function submit() {
    const trimmed = subject.trim();
    if (!trimmed || submitting) return;
    if (!canCommit && !amend) return;
    setSubmitting(true);
    setCommitError(null);
    try {
      await commit(trimmed, body.trim() || null, amend);
      setSubject('');
      setBody('');
      setAmend(false);
    } catch (e) {
      console.error('commit failed', e);
      setCommitError(`Commit failed: ${gitErrorHint(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || !subject.trim() || (!canCommit && !amend);
  // Missing CLI does not disable the button: clicking surfaces the backend's
  // install/sign-in hint inline, instead of a dead control (DAN-11).
  const suggestDisabled = suggesting || submitting || !hasChanges;
  const suggestTitle = suggesting
    ? 'Generating commit message…'
    : !hasChanges
      ? 'Make changes to suggest a commit message'
      : !canCommit
        ? 'Suggest commit message from all unstaged changes'
      : 'Suggest commit message from staged changes';

  return (
    <div className="lc-commit-bar">
      <div className="cb-top">
        <div className="subject-row">
          <input
            ref={subjectRef}
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
          <button
            type="button"
            className={suggesting ? 'suggest-btn is-busy' : 'suggest-btn'}
            aria-label="Suggest commit message"
            aria-busy={suggesting}
            title={suggestTitle}
            disabled={suggestDisabled}
            onClick={() => void suggest()}
          >
            {suggesting ? (
              <span className="icon-spin">
                <Icon name="refresh" size={13} />
              </span>
            ) : (
              <Icon name="sparkle" size={13} />
            )}
          </button>
          {suggesting && (
            <button type="button" className="btn" onClick={cancelSuggestion}>Cancel</button>
          )}
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
          type="button"
          className="btn primary cb-commit"
          disabled={disabled}
          onClick={() => void submit()}
        >
          {amend ? 'Amend' : 'Commit'}
          {platform === 'mac' ? (
            <span className="kbd-inline" aria-hidden="true">
              {formatBinding('Mod+Enter', platform)}
            </span>
          ) : (
            <span className="commit-chord" aria-hidden="true">
              <kbd>Ctrl</kbd>
              <span className="chord-plus">+</span>
              <kbd className="enter-key">↵</kbd>
            </span>
          )}
        </button>
      </div>
      <textarea
        ref={bodyRef}
        className="cb-body"
        placeholder="Description (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {sensitivePrompt && (
        <div className="cb-error" role="alert">
          <div>Potentially sensitive files were excluded pending confirmation:</div>
          <ul>{sensitivePrompt.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul>
          <div className="settings-row">
            <button type="button" className="btn primary" onClick={() => void suggest({ mode: 'exclude', fingerprint: sensitivePrompt.fingerprint })}>
              Generate without them
            </button>
            <button type="button" className="btn" onClick={() => void suggest({ mode: 'include', fingerprint: sensitivePrompt.fingerprint })}>
              Include and generate
            </button>
            <button type="button" className="btn" onClick={() => setSensitivePrompt(null)}>Cancel</button>
          </div>
        </div>
      )}
      {commitError && (
        <div className="cb-error" role="alert">
          {commitError}
          {retryProvider && (
            <div><button type="button" className="h-link" onClick={() => void suggest({ mode: 'scan' }, retryProvider)}>
              Retry with {retryProvider === 'openai' ? 'Codex' : 'Claude Code'}
            </button></div>
          )}
        </div>
      )}
    </div>
  );
}
