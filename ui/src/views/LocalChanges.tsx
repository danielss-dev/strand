import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  getSingularPatch,
  type DiffLineAnnotation,
  type SelectedLineRange,
} from '@pierre/diffs';
import { FileDiff as PierreFileDiff } from '@pierre/diffs/react';
import type { GitStatusEntry } from '@pierre/trees';

import { Diff } from '../components/Diff';
import { Icon } from '../components/Icon';
import { copyToClipboard, diffStatusToGit, PierreTree, type TreeMenuItem } from '../components/PierreTree';
import { sliceChangeBlock, type SliceDirection } from '../lib/patch';
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
  const stageMany = useRepo((s) => s.stageMany);
  const unstageMany = useRepo((s) => s.unstageMany);
  const discardMany = useRepo((s) => s.discardMany);
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
                    onAction={(files) => void stageMany(files)}
                    actionLabel="Stage"
                    onDiscard={(files) => void discardMany(files)}
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
                    onAction={(files) => void unstageMany(files)}
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
            <DiffPane diff={selectedDiff} staged={selection?.staged ?? false} />
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
  onSelect(sel: LocalSelection | null): void;
  /** Stage (unstaged section) / Unstage (staged section) the given files. */
  onAction(files: string[]): void;
  actionLabel: string;
  /** Discard the given files' working-tree changes — unstaged section only. */
  onDiscard?: (files: string[]) => void;
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
  onAction,
  actionLabel,
  onDiscard,
  onBulk,
  bulkLabel,
}: SectionProps) {
  const paths = useMemo(() => files.map((f) => f.path), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () => files.map((f) => ({ path: f.path, status: diffStatusToGit(f.status) })),
    [files],
  );
  const selectedPath = selection && selection.staged === staged ? selection.file : null;

  const menuItems = useCallback(
    (targets: string[]): TreeMenuItem[] => {
      const n = targets.length;
      const suffix = n > 1 ? ` ${n} files` : '';
      const items: TreeMenuItem[] = [
        { label: actionLabel + suffix, icon: staged ? 'minus' : 'plus', onSelect: () => onAction(targets) },
      ];
      if (onDiscard) {
        items.push({
          label: (n > 1 ? `Discard${suffix}` : 'Discard') + '…',
          icon: 'trash',
          danger: true,
          confirm: true,
          onSelect: () => onDiscard(targets),
        });
      }
      items.push({
        label: n > 1 ? 'Copy paths' : 'Copy path',
        icon: 'file',
        onSelect: () => copyToClipboard(targets.join('\n')),
      });
      return items;
    },
    [actionLabel, staged, onAction, onDiscard],
  );

  return (
    <div className="lc-files-section">
      <div className="lc-col-head">
        {title}
        <span className="count">{files.length}</span>
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
        onActivate={onAction}
        menuItems={menuItems}
        emptyLabel={staged ? 'Nothing staged.' : 'No unstaged changes.'}
      />
    </div>
  );
}

// ─── Diff pane ──────────────────────────────────────────────────────────────

function DiffPane({ diff, staged }: { diff: FileDiff | null; staged: boolean }) {
  // The unified/split toggle lives in the main header (App.tsx → MainHeader)
  // and writes to `useSettings.diffMode`. Pierre talks 'unified' | 'split',
  // our setting is 'stacked' | 'split' — map at the boundary.
  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  return (
    <div className="lc-diff">
      <div className="lc-diff-scroll">
        <DiffBody diff={diff} staged={staged} layout={layout} />
      </div>
    </div>
  );
}

function DiffBody({
  diff,
  staged,
  layout,
}: {
  diff: FileDiff | null;
  staged: boolean;
  layout: 'unified' | 'split';
}) {
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
  return <HunkAnnotatedDiff diff={diff} layout={layout} side={staged ? 'staged' : 'unstaged'} />;
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
}

const blockKey = (m: { hunkIndex: number; contentIndex: number }): string =>
  `${m.hunkIndex}:${m.contentIndex}`;

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
function HunkAnnotatedDiff({
  diff,
  layout,
  side,
}: {
  diff: FileDiff;
  layout: 'unified' | 'split';
  side: 'unstaged' | 'staged';
}) {
  const applyPatch = useRepo((s) => s.applyPatch);
  const discardPatch = useRepo((s) => s.discardPatch);
  const [pending, setPending] = useState<string | null>(null);
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

  // Parse once per patch string. `getSingularPatch` is cheap, but keeping
  // a stable identity helps Pierre's worker pool cache the render.
  const fileDiff = useMemo(() => {
    try {
      return getSingularPatch(diff.patch);
    } catch (e) {
      // Mode-only changes, binary, or otherwise unparseable patches: let
      // the fallback `<Diff/>` branch below render them.
      console.warn('getSingularPatch failed', e);
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
        const meta: BlockMeta = { hunkIndex: h, contentIndex: c, range, delRange, addRange };
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

    // The diff scrolls inside `.lc-diff-scroll` (our wrapper's parent),
    // so listen there for scroll updates. The container itself doesn't
    // scroll.
    scrollHost = wrapper.closest('.lc-diff-scroll');
    if (scrollHost) scrollHost.addEventListener('scroll', measure, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      if (scrollHost) scrollHost.removeEventListener('scroll', measure);
    };
  }, [annotations]);

  const selectedLines: SelectedLineRange | null = hovered
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
  const fileDiffOptions = useMemo(
    () => ({
      diffStyle: layout,
      theme: 'pierre-dark' as const,
      disableBackground: true,
      disableFileHeader: true,
      onLineEnter,
    }),
    [layout, onLineEnter],
  );

  async function run(meta: BlockMeta, direction: SliceDirection, target: ApplyTarget) {
    const key = `${blockKey(meta)}:${target}`;
    if (pending != null) return;
    setPending(key);
    try {
      const slice = sliceChangeBlock(diff.patch, meta.hunkIndex, meta.contentIndex, direction);
      // Discard routes through discardPatch so it records a single-undo
      // handle; stage / unstage are non-destructive and don't need one.
      if (target === 'workdir_reverse') {
        const name = diff.path.split('/').pop() ?? diff.path;
        await discardPatch(slice, `Discarded a change in ${name}`);
      } else {
        await applyPatch(slice, target);
      }
    } catch (e) {
      console.error('apply patch failed', e);
    } finally {
      setPending(null);
    }
  }

  // Patches we can't structurally parse (mode-only, binary stubs that
  // slip past the binary check) fall back to read-only rendering — there
  // are no change blocks to act on anyway.
  if (!fileDiff || fileDiff.hunks.length === 0) {
    return (
      <>
        <FileHeaderStrip diff={diff} />
        <Diff patch={diff.patch} layout={layout} hideFileHeader />
      </>
    );
  }

  return (
    <>
      <FileHeaderStrip diff={diff} />
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
              >
                <BlockActions
                  meta={a.metadata}
                  side={side}
                  pending={pending}
                  onRun={(d, t) => void run(a.metadata, d, t)}
                />
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

type ApplyTarget = 'index' | 'index_reverse' | 'workdir_reverse';

function FileHeaderStrip({ diff }: { diff: FileDiff }) {
  return (
    <div className="lc-hunkfile">
      <span className="path">{diff.path}</span>
      <span className="stat-del">−{diff.dels}</span>
      <span className="stat-add">+{diff.adds}</span>
    </div>
  );
}

function BlockActions({
  meta,
  side,
  pending,
  onRun,
}: {
  meta: BlockMeta;
  side: 'unstaged' | 'staged';
  pending: string | null;
  onRun(direction: SliceDirection, target: ApplyTarget): void;
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
          title="Unstage this change"
        >
          {isMe ? 'Unstaging…' : 'Unstage'}
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
        title="Stage this change"
      >
        {stagingMe ? 'Staging…' : 'Stage'}
      </button>
      <button
        type="button"
        className="hbtn reject"
        disabled={busy}
        onClick={() => onRun('reverse', 'workdir_reverse')}
        title="Discard this change from the working tree"
      >
        {discardingMe ? 'Discarding…' : 'Discard'}
      </button>
    </div>
  );
}

// ─── Commit bar ─────────────────────────────────────────────────────────────

function CommitBar({ canCommit }: { canCommit: boolean }) {
  const commit = useRepo((s) => s.commit);
  const recentMessages = useRepo((s) => s.recentMessages);
  const refreshRecentMessages = useRepo((s) => s.refreshRecentMessages);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Recent-messages dropdown state.
  const [recentOpen, setRecentOpen] = useState(false);
  const [recentSel, setRecentSel] = useState(0);
  const subjectRef = useRef<HTMLInputElement>(null);
  const recentWrapRef = useRef<HTMLDivElement>(null);
  const recentPopRef = useRef<HTMLDivElement>(null);

  // Make sure the list is fresh the first time the form mounts (the store
  // also refreshes it on repo open / after each commit).
  useEffect(() => {
    void refreshRecentMessages();
  }, [refreshRecentMessages]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!recentOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!recentWrapRef.current?.contains(e.target as Node)) setRecentOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [recentOpen]);

  // Move focus into the popover once when it opens, so arrow keys drive it.
  useEffect(() => {
    if (recentOpen) recentPopRef.current?.focus();
  }, [recentOpen]);

  // Keep the highlight in range if the list shrinks under us (de-dupe, repo
  // switch, refresh). A stale index would leave aria-activedescendant
  // pointing at a missing option and make Enter a no-op.
  useEffect(() => {
    if (recentSel >= recentMessages.length) setRecentSel(0);
  }, [recentMessages.length, recentSel]);

  function openRecent() {
    if (recentMessages.length === 0) return;
    setRecentSel(0);
    setRecentOpen(true);
    void refreshRecentMessages();
  }

  function applyMessage(m: { subject: string; body: string }) {
    setSubject(m.subject);
    setBody(m.body);
    setRecentOpen(false);
    subjectRef.current?.focus();
  }

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
        <div className="subject-row" ref={recentWrapRef}>
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
              } else if (e.key === 'ArrowDown' && !recentOpen && recentMessages.length > 0) {
                e.preventDefault();
                openRecent();
              }
            }}
          />
          {recentMessages.length > 0 && (
            <button
              type="button"
              className="recent-btn"
              aria-label="Recent commit messages"
              aria-haspopup="listbox"
              aria-expanded={recentOpen}
              title="Recent commit messages"
              onClick={() => (recentOpen ? setRecentOpen(false) : openRecent())}
            >
              <Icon name="history" size={13} />
            </button>
          )}
          {recentOpen && recentMessages.length > 0 && (
            <div
              className="recent-pop"
              role="listbox"
              aria-label="Recent commit messages"
              aria-activedescendant={`recent-opt-${recentSel}`}
              tabIndex={-1}
              ref={recentPopRef}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setRecentSel((i) => (i + 1) % recentMessages.length);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setRecentSel((i) => (i - 1 + recentMessages.length) % recentMessages.length);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const m = recentMessages[recentSel];
                  if (m) applyMessage(m);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRecentOpen(false);
                  subjectRef.current?.focus();
                }
              }}
            >
              <div className="recent-head">Recent messages</div>
              {recentMessages.map((m, i) => (
                // Non-focusable option: focus stays on the listbox container
                // so ArrowUp/Down keep driving the aria-activedescendant
                // selection. mousedown is suppressed so a click doesn't pull
                // focus off the listbox before onClick runs.
                <div
                  key={`${i}:${m.subject}`}
                  id={`recent-opt-${i}`}
                  role="option"
                  aria-selected={i === recentSel}
                  className={'recent-item' + (i === recentSel ? ' selected' : '')}
                  title={m.body ? `${m.subject}\n\n${m.body}` : m.subject}
                  onMouseEnter={() => setRecentSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyMessage(m)}
                >
                  {m.subject}
                </div>
              ))}
            </div>
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
