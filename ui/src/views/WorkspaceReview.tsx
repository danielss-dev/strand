import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Virtualizer, useWorkerPool } from '@pierre/diffs/react';
import type { GitStatusEntry } from '@pierre/trees';

import { Diff, parsePatchCached } from '../components/Diff';
import { DiffMinimap } from '../components/DiffMinimap';
import { Icon } from '../components/Icon';
import { ImageDiff } from '../components/ImageDiff';
import { isImagePath } from '../lib/image';
import {
  copyToClipboard,
  diffStatusToGit,
  PierreTree,
  type TreeMenuItem,
  type TreeRowDecoration,
} from '../components/PierreTree';
import { hashFileDiff as hashOf } from '../lib/patch';
import { concatPatches, patchesToMarkdown } from '../lib/patchExport';
import { groupColor, pathKey } from '../lib/repoIdentity';
import { gitErrorHint } from '../lib/tauri';
import { treeFileOrder } from '../lib/treeOrder';
import type { FileDiff } from '../lib/types';
import { useSettled } from '../lib/useSettled';
import { workspaceQueueOrder, type QueueEntry } from '../lib/workspaceReview';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from '../stores/workspaces';
import { useWorkspaceReview, type MemberReview } from '../stores/workspaceReview';
import { HunkAnnotatedDiff, scrollDiff, stepChangeBlock } from './LocalChanges';

/**
 * Workspace Review — the aggregated cross-repo review surface (Workspaces
 * Phase 2). One queue over every member repo of the active workspace, grouped
 * repo → files: each member repo gets its own collapsible tree section, and
 * the right pane shows the selected file with whole-file context, exactly
 * like the single-repo Review.
 *
 * Each member reviews in the mode its own Review session is in — **session**
 * when that repo has a pinned baseline, **inbox** (unstaged) otherwise — and
 * reviewed marks are shared with the per-repo session, so the two views are
 * lenses on one review state.
 *
 * Inbox-mode diffs carry the same per-block Stage / Discard actions as the
 * single-repo Review, routed to the owning member repo via
 * `useWorkspaceReview.applyBlock` (the member may be a background tab);
 * session-mode diffs render read-only, exactly like the single-repo view.
 * File-level Stage / Discard fan out over the same path-parameterized IPC.
 * Notes and ⌘F stay per-repo — `o` (or the header button) jumps into the
 * file's own repo Review for those.
 */
export function WorkspaceReview() {
  const members = useWorkspaceReview((s) => s.members);
  const selection = useWorkspaceReview((s) => s.selection);
  const select = useWorkspaceReview((s) => s.select);
  const setActive = useWorkspaceReview((s) => s.setActive);
  const refreshAll = useWorkspaceReview((s) => s.refreshAll);
  const toggleReviewed = useWorkspaceReview((s) => s.toggleReviewed);
  const stageFiles = useWorkspaceReview((s) => s.stageFiles);
  const discardFiles = useWorkspaceReview((s) => s.discardFiles);
  const applyBlock = useWorkspaceReview((s) => s.applyBlock);
  const tick = useWorkspaceReview((s) => s.tick);

  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaces((s) => s.activeWorkspaceId);
  const workspaceName =
    workspaces.find((w) => w.id === (activeWorkspaceId ?? DEFAULT_WORKSPACE_ID))?.name ??
    'Workspace';

  const diffMode = useSettings((s) => s.diffMode);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  // Membership fingerprint: re-run the fan-out when the active workspace, its
  // member list, or the tab set (path resolution) changes while we're open.
  const tabs = useRepo((s) => s.tabs);
  const memberFingerprint = useMemo(() => {
    const ws = workspaces.find((w) => w.id === (activeWorkspaceId ?? DEFAULT_WORKSPACE_ID));
    // Tab keys are part of the fingerprint because member resolution follows
    // the open tab set (a member's tab opening re-keys its slice).
    return (
      (ws?.repoPaths ?? []).map(pathKey).join('|') +
      '#' +
      tabs.map((t) => pathKey(t.path)).join('|')
    );
  }, [workspaces, activeWorkspaceId, tabs]);

  // Mark the view live (enables repo://changed live-follow for background
  // members) and pull everything on entry + membership change.
  useEffect(() => {
    setActive(true);
    void refreshAll();
    return () => setActive(false);
  }, [setActive, refreshAll, memberFingerprint]);

  // ── Verdicts (per member × file) ──────────────────────────────────────
  type Verdict = 'pending' | 'reviewed' | 'stale';
  const qk = (repo: string, file: string) => `${pathKey(repo)}\u0000${file}`;
  const verdicts = useMemo(() => {
    const m = new Map<string, { hash: string; verdict: Verdict }>();
    for (const mem of members) {
      for (const d of mem.diffs) {
        const hash = hashOf(d);
        const mark = mem.reviewed[d.path];
        m.set(qk(mem.path, d.path), {
          hash,
          verdict: mark === hash ? 'reviewed' : mark !== undefined ? 'stale' : 'pending',
        });
      }
    }
    return m;
  }, [members]);

  const queue = useMemo(() => workspaceQueueOrder(members), [members]);
  const total = queue.length;
  const reviewedCount = useMemo(
    () => queue.filter((e) => verdicts.get(qk(e.repo, e.file))?.verdict === 'reviewed').length,
    [queue, verdicts],
  );

  // Keep the selection valid: default to the first pending file, fall back to
  // the first file, clear when every pool empties.
  useEffect(() => {
    if (queue.length === 0) {
      if (selection) select(null);
      return;
    }
    if (selection && queue.some((e) => sameEntry(e, selection))) return;
    const firstPending = queue.find(
      (e) => verdicts.get(qk(e.repo, e.file))?.verdict !== 'reviewed',
    );
    select(firstPending ?? queue[0]);
  }, [queue, selection, verdicts, select]);

  const currentMember = useMemo(
    () =>
      selection
        ? (members.find((m) => pathKey(m.path) === pathKey(selection.repo)) ?? null)
        : null,
    [members, selection],
  );
  const current = useMemo(() => {
    if (!selection || !currentMember) return null;
    const diff = currentMember.diffs.find((d) => d.path === selection.file);
    return diff ? { member: currentMember, diff } : null;
  }, [selection, currentMember]);

  // Whole-file patches are too heavy to mount per keystroke — swap the pane
  // once the queue position settles (single steps stay instant).
  const displayed = useSettled(current);
  useEffect(() => {
    document.querySelector<HTMLElement>('.rv-diff-scroll')?.scrollTo({ top: 0 });
  }, [displayed]);

  // Pre-highlight the next few queue entries while the reviewer reads.
  const workerPool = useWorkerPool();
  useEffect(() => {
    if (!workerPool?.isWorkingPool() || queue.length < 2 || !selection) return;
    const byKey = new Map<string, FileDiff>();
    for (const mem of members) for (const d of mem.diffs) byKey.set(qk(mem.path, d.path), d);
    const idx = Math.max(0, queue.findIndex((e) => sameEntry(e, selection)));
    const primable = (d: FileDiff | undefined): d is FileDiff =>
      d != null && !d.binary && d.patch.length > 0 && d.patch.length < 1_000_000;
    const targets: FileDiff[] = [];
    for (let i = 1; i < queue.length && targets.length < 3; i++) {
      const e = queue[(idx + i) % queue.length];
      const d = byKey.get(qk(e.repo, e.file));
      if (primable(d)) targets.push(d);
    }
    const t = window.setTimeout(() => {
      for (const d of targets) {
        try {
          workerPool.primeDiffHighlightCache(parsePatchCached(d));
        } catch {
          // Unparseable patches fall back at render time; nothing to prime.
        }
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [workerPool, members, queue, selection]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (queue.length === 0) return;
      const idx = selection ? queue.findIndex((e) => sameEntry(e, selection)) : -1;
      const next =
        queue[Math.max(0, Math.min(queue.length - 1, idx === -1 ? 0 : idx + dir))];
      if (next) select(next);
    },
    [queue, selection, select],
  );

  const markReviewed = useCallback(() => {
    if (!current) return;
    const v = verdicts.get(qk(current.member.path, current.diff.path));
    if (v) toggleReviewed(current.member.path, current.diff.path, v.hash);
  }, [current, verdicts, toggleReviewed]);

  // Failed write ops surface here instead of vanishing into the console.
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

  // Two-step confirm for the destructive discard (d d, or double-click the
  // header button).
  const [confirmDiscard, setConfirmDiscard] = useState<QueueEntry | null>(null);
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => setConfirmDiscard(null), 2500);
    return () => clearTimeout(t);
  }, [confirmDiscard]);
  const discardCurrent = useCallback(() => {
    if (!current) return;
    const entry = { repo: current.member.path, file: current.diff.path };
    if (!isUnstaged(current.member, current.diff.path)) return;
    if (confirmDiscard && sameEntry(confirmDiscard, entry)) {
      setConfirmDiscard(null);
      void discardFiles(entry.repo, [entry.file]).catch(fail('Discard'));
    } else {
      setConfirmDiscard(entry);
    }
  }, [current, confirmDiscard, discardFiles, fail]);

  /** Jump into the file's own repo Review (full loop: notes, hunk actions). */
  const openInRepo = useCallback(async (repoPath: string, file: string | null) => {
    const repo = useRepo.getState();
    const tab = repo.tabs.find((t) => pathKey(t.path) === pathKey(repoPath));
    try {
      if (tab) await repo.setActiveTab(tab.path);
      else await repo.openRepo(repoPath);
      // Populate the Review pool *before* mounting the view — its
      // keep-selection-valid effect clears the selection while the pool is
      // empty, which would drop the file we're navigating to.
      if (file) await useRepo.getState().refreshReviewDiffs();
    } catch (e) {
      setOpError(`Open failed: ${gitErrorHint(e)}`);
      return;
    }
    if (file) useRepo.getState().selectReviewFile(file);
    useRepo.getState().setView('review');
  }, []);

  // ── Keyboard loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="combobox"]')) {
        return;
      }
      switch (e.key) {
        case 'j':
          e.preventDefault();
          step(1);
          break;
        case 'k':
          e.preventDefault();
          step(-1);
          break;
        case 'n':
        case 'p':
          e.preventDefault();
          stepChangeBlock(e.key === 'n' ? 1 : -1, '.rv-diff-scroll');
          break;
        case 'J':
        case 'K':
          e.preventDefault();
          scrollDiff(e.key === 'J' ? 1 : -1, '.rv-diff-scroll');
          break;
        case ' ':
          e.preventDefault();
          markReviewed();
          break;
        case 's':
          if (current && isUnstaged(current.member, current.diff.path)) {
            e.preventDefault();
            void stageFiles(current.member.path, [current.diff.path]).catch(fail('Stage'));
          }
          break;
        case 'd':
          e.preventDefault();
          discardCurrent();
          break;
        case 'o':
          if (current) {
            e.preventDefault();
            void openInRepo(current.member.path, current.diff.path);
          }
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, markReviewed, current, stageFiles, discardCurrent, openInRepo, fail]);

  // ── Per-member section plumbing ───────────────────────────────────────
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = useCallback((repoPath: string) => {
    setCollapsed((cur) => {
      const key = pathKey(repoPath);
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const activateFiles = useCallback(
    (member: MemberReview, paths: string[]) => {
      if (paths.length === 1) {
        const v = verdicts.get(qk(member.path, paths[0]));
        if (v) toggleReviewed(member.path, paths[0], v.hash);
        return;
      }
      for (const p of paths) {
        const v = verdicts.get(qk(member.path, p));
        if (v && v.verdict !== 'reviewed') toggleReviewed(member.path, p, v.hash);
      }
    },
    [verdicts, toggleReviewed],
  );

  const treeMenuItems = useCallback(
    (member: MemberReview, targets: string[]): TreeMenuItem[] => {
      const known = targets.filter((p) => verdicts.has(qk(member.path, p)));
      if (known.length === 0) return [];
      const n = known.length;
      const suffix = n > 1 ? ` ${n} files` : '';
      const allReviewed = known.every(
        (p) => verdicts.get(qk(member.path, p))!.verdict === 'reviewed',
      );
      const items: TreeMenuItem[] = [
        {
          label: (allReviewed ? 'Mark not reviewed' : 'Mark reviewed') + suffix,
          icon: 'check',
          onSelect: () => {
            for (const p of known) {
              const v = verdicts.get(qk(member.path, p))!;
              if (allReviewed || v.verdict !== 'reviewed') toggleReviewed(member.path, p, v.hash);
            }
          },
        },
      ];
      const unstagedTargets = known.filter((p) => isUnstaged(member, p));
      if (unstagedTargets.length > 0) {
        const un = unstagedTargets.length;
        items.push(
          {
            label: 'Stage' + (un > 1 ? ` ${un} files` : ''),
            icon: 'plus',
            onSelect: () => void stageFiles(member.path, unstagedTargets).catch(fail('Stage')),
          },
          {
            label: (un > 1 ? `Discard ${un} files` : 'Discard') + '…',
            icon: 'trash',
            danger: true,
            confirm: true,
            onSelect: () => void discardFiles(member.path, unstagedTargets).catch(fail('Discard')),
          },
        );
      }
      items.push({
        label: 'Open in repo Review',
        icon: 'external',
        onSelect: () => void openInRepo(member.path, known[0]),
      });
      items.push({
        label: n > 1 ? 'Copy paths' : 'Copy path',
        icon: 'file',
        onSelect: () => copyToClipboard(known.join('\n')),
      });
      const diffs = known
        .map((p) => member.diffs.find((d) => d.path === p))
        .filter((d): d is FileDiff => d != null);
      if (diffs.some((d) => d.patch.length > 0)) {
        items.push(
          { label: 'Copy diff', icon: 'file', onSelect: () => copyToClipboard(concatPatches(diffs)) },
          { label: 'Copy diff as Markdown', icon: 'file', onSelect: () => copyToClipboard(patchesToMarkdown(diffs)) },
        );
      }
      return items;
    },
    [verdicts, toggleReviewed, stageFiles, discardFiles, openInRepo, fail],
  );

  const anyLoading = members.some((m) => m.loading);

  if (members.length === 0) {
    return (
      <div className="rv-wrap">
        <WorkspaceReviewToolbar
          workspaceName={workspaceName}
          repoCount={0}
          reviewedCount={0}
          total={0}
          onRefresh={() => void refreshAll()}
        />
        <div className="lc-empty">
          <strong>No workspace members</strong>
          Add repositories to this workspace (workspace menu → Manage…) to review them together.
        </div>
      </div>
    );
  }

  return (
    <div className="rv-wrap">
      <WorkspaceReviewToolbar
        workspaceName={workspaceName}
        repoCount={members.length}
        reviewedCount={reviewedCount}
        total={total}
        loading={anyLoading}
        onRefresh={() => void refreshAll()}
      />

      <div className="rv-main">
        <PanelGroup direction="horizontal" autoSaveId="strand:ws-review">
          <Panel defaultSize={28} minSize={15} maxSize={50}>
            <div className="wsr-queue">
              {members.map((member) => (
                <MemberSection
                  key={pathKey(member.path)}
                  member={member}
                  collapsed={collapsed.has(pathKey(member.path))}
                  onToggleCollapsed={() => toggleCollapsed(member.path)}
                  selectedFile={
                    selection && pathKey(selection.repo) === pathKey(member.path)
                      ? selection.file
                      : null
                  }
                  onSelect={(file) => select({ repo: member.path, file })}
                  onActivate={(paths) => activateFiles(member, paths)}
                  menuItems={(targets) => treeMenuItems(member, targets)}
                  verdictFor={(file) => verdicts.get(qk(member.path, file))?.verdict ?? null}
                  onOpenInRepo={() => void openInRepo(member.path, null)}
                />
              ))}
            </div>
          </Panel>
          <PanelResizeHandle className="rs-handle vert" />
          <Panel minSize={30}>
            {displayed ? (
              <div className="rv-diff">
                <div className="rv-file-head">
                  <span
                    className="wsr-repo-chip"
                    style={{ color: groupColor(displayed.member.commonDir ?? displayed.member.path) }}
                    title={displayed.member.path}
                  >
                    {displayed.member.name}
                  </span>
                  <span className="path">{displayed.diff.path}</span>
                  <span className="stat-del">−{displayed.diff.dels}</span>
                  <span className="stat-add">+{displayed.diff.adds}</span>
                  <span className="rv-head-actions">
                    {isUnstaged(displayed.member, displayed.diff.path) && (
                      <>
                        <button
                          type="button"
                          className="h-link"
                          onClick={() =>
                            void stageFiles(displayed.member.path, [displayed.diff.path]).catch(fail('Stage'))
                          }
                          title="Stage this file (s)"
                        >
                          Stage
                        </button>
                        <button
                          type="button"
                          className={
                            'h-link' +
                            (confirmDiscard &&
                            sameEntry(confirmDiscard, { repo: displayed.member.path, file: displayed.diff.path })
                              ? ' danger'
                              : '')
                          }
                          onClick={discardCurrent}
                          title="Discard this file's working-tree changes (d d)"
                        >
                          {confirmDiscard &&
                          sameEntry(confirmDiscard, { repo: displayed.member.path, file: displayed.diff.path })
                            ? 'Really discard?'
                            : 'Discard'}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="h-link"
                      onClick={() => void openInRepo(displayed.member.path, displayed.diff.path)}
                      title="Open this file in the repo's own Review (o)"
                    >
                      Open in repo
                    </button>
                    <button
                      type="button"
                      className={
                        'rv-check wide' +
                        (verdicts.get(qk(displayed.member.path, displayed.diff.path))?.verdict === 'reviewed'
                          ? ' on'
                          : '')
                      }
                      aria-pressed={
                        verdicts.get(qk(displayed.member.path, displayed.diff.path))?.verdict === 'reviewed'
                      }
                      onClick={markReviewed}
                      title="Mark reviewed (Space)"
                    >
                      <Icon name="check" size={12} stroke={2.2} />
                      {verdicts.get(qk(displayed.member.path, displayed.diff.path))?.verdict === 'reviewed'
                        ? 'Reviewed'
                        : 'Mark reviewed'}
                    </button>
                  </span>
                </div>
                <div className="rv-diff-body">
                  <Virtualizer className="rv-diff-scroll">
                  {displayed.diff.binary && isImagePath(displayed.diff.path) ? (
                    // Old side: the member's session baseline, or its *index*
                    // in inbox mode (HEAD would lie for a partially staged
                    // image). Added files have no old side; new side: worktree.
                    <ImageDiff
                      path={displayed.diff.path}
                      repoPath={displayed.member.path}
                      refetch={tick}
                      oldSrc={
                        displayed.diff.status === 'added'
                          ? null
                          : displayed.member.baseline
                            ? { rev: displayed.member.baseline.oid }
                            : { rev: null, index: true }
                      }
                      newSrc={displayed.diff.status === 'deleted' ? null : { rev: null }}
                    />
                  ) : displayed.diff.binary || displayed.diff.patch.length === 0 ? (
                    <div className="lc-file-note">
                      {displayed.diff.binary ? 'Binary file — no diff shown.' : 'No textual diff.'}
                    </div>
                  ) : displayed.member.baseline ? (
                    // Session diffs span commits — render read-only, like the
                    // single-repo Review. Keyed by repo + file + content so
                    // swapping files remounts the virtualized instance.
                    <Diff
                      key={`${pathKey(displayed.member.path)}:${displayed.diff.path}:${hashOf(displayed.diff)}`}
                      patch={displayed.diff.patch}
                      layout={layout}
                      hideFileHeader
                    />
                  ) : (
                    // Inbox diffs are pure unstaged changes — full per-block
                    // Stage / Discard applies, routed to the owning member
                    // repo (which may be a background tab). Same remount key.
                    <HunkAnnotatedDiff
                      key={`${pathKey(displayed.member.path)}:${displayed.diff.path}:${hashOf(displayed.diff)}`}
                      diff={displayed.diff}
                      layout={layout}
                      side="unstaged"
                      onApplyBlock={(slice, target) => {
                        const name = displayed.diff.path.split('/').pop() ?? displayed.diff.path;
                        return applyBlock(
                          displayed.member.path,
                          slice,
                          target,
                          `Discarded a change in ${name} (${displayed.member.name})`,
                        );
                      }}
                    />
                  )}
                  </Virtualizer>
                  {!displayed.diff.binary && displayed.diff.patch.length > 0 && (
                    <DiffMinimap
                      patch={displayed.diff.patch}
                      layout={layout}
                      hostSelector=".rv-diff-scroll"
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="lc-empty">
                {total === 0 ? (
                  <>
                    <strong>{anyLoading ? 'Gathering changes…' : 'Workspace is clean'}</strong>
                    {anyLoading
                      ? 'Collecting diffs from every member repository.'
                      : 'No changes to review in any member repository. Let the agents work — this view follows along live.'}
                  </>
                ) : (
                  <>
                    <strong>Pick a file</strong>
                    Select something on the left to review its diff.
                  </>
                )}
              </div>
            )}
          </Panel>
        </PanelGroup>
      </div>

      <div className="rv-foot" aria-hidden="true">
        <span className="kbd-inline">↑ ↓ j k</span> files
        <span className="kbd-inline">space</span> reviewed
        <span className="kbd-inline">n p</span> blocks
        <span className="kbd-inline">s</span> stage
        <span className="kbd-inline">d d</span> discard
        <span className="kbd-inline">o</span> open in repo
      </div>

      {opError && (
        <div className="toast" role="alert">
          <span style={{ color: 'var(--del, #e5534b)' }}><Icon name="x" size={13} stroke={2} /></span>
          <span>{opError}</span>
          <button type="button" className="toast-action" onClick={() => setOpError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function sameEntry(a: QueueEntry, b: QueueEntry): boolean {
  return pathKey(a.repo) === pathKey(b.repo) && a.file === b.file;
}

function isUnstaged(member: MemberReview, file: string): boolean {
  return member.unstaged.some((u) => u.path === file);
}

/** One member repo's section in the queue column: header + its file tree. */
function MemberSection({
  member,
  collapsed,
  onToggleCollapsed,
  selectedFile,
  onSelect,
  onActivate,
  menuItems,
  verdictFor,
  onOpenInRepo,
}: {
  member: MemberReview;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedFile: string | null;
  onSelect: (file: string) => void;
  onActivate: (paths: string[]) => void;
  menuItems: (targets: string[]) => TreeMenuItem[];
  verdictFor: (file: string) => 'pending' | 'reviewed' | 'stale' | null;
  onOpenInRepo: () => void;
}) {
  const treePaths = useMemo(() => treeFileOrder(member.diffs.map((d) => d.path)), [member.diffs]);
  const treeStatus = useMemo<GitStatusEntry[]>(
    () => member.diffs.map((d) => ({ path: d.path, status: diffStatusToGit(d.status) })),
    [member.diffs],
  );
  const reviewedCount = useMemo(
    () => member.diffs.filter((d) => verdictFor(d.path) === 'reviewed').length,
    [member.diffs, verdictFor],
  );
  const rowDecoration = useCallback(
    (path: string, kind: 'file' | 'directory'): TreeRowDecoration | null => {
      if (kind !== 'file') return null;
      switch (verdictFor(path)) {
        case 'reviewed':
          return { text: '✓', title: 'Reviewed' };
        case 'stale':
          return { text: 'changed', title: 'Changed since reviewed — review again' };
        default:
          return null;
      }
    },
    [verdictFor],
  );
  const decorationKey = useMemo(
    () => member.diffs.map((d) => `${d.path}:${verdictFor(d.path)}`).join('|'),
    [member.diffs, verdictFor],
  );

  const empty = member.diffs.length === 0;
  const showTree = !collapsed && !empty;
  const mode = member.baseline ? `since ${member.baseline.short}` : 'unstaged';

  return (
    <section
      className={'wsr-section' + (showTree ? ' open' : '')}
      aria-label={`${member.name} review queue`}
    >
      <header className="wsr-section-head">
        <button
          type="button"
          className="wsr-fold"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={(collapsed ? 'Expand ' : 'Collapse ') + member.name}
        >
          <Icon name={collapsed ? 'chev-right' : 'chev-down'} size={11} />
        </button>
        <span
          className="wsr-dot"
          style={{ background: groupColor(member.commonDir ?? member.path) }}
          aria-hidden="true"
        />
        <span className="wsr-name" title={member.path}>{member.name}</span>
        {member.branch && <span className="wsr-branch">{member.branch}</span>}
        <span className="wsr-mode" title={member.baseline ? 'Session mode — everything since the pinned baseline' : 'Inbox mode — unstaged changes'}>
          {mode}
        </span>
        <span className="wsr-count">
          {member.loading && member.diffs.length === 0
            ? '…'
            : `${reviewedCount}/${member.diffs.length}`}
        </span>
        <button
          type="button"
          className="icon-btn wsr-open"
          onClick={onOpenInRepo}
          title={`Open ${member.name} in its own Review`}
          aria-label={`Open ${member.name} in its own Review`}
        >
          <Icon name="external" size={11} />
        </button>
      </header>
      {member.error ? (
        <div className="wsr-note danger" title={member.error}>
          Couldn’t load changes — {member.error}
        </div>
      ) : empty && !collapsed ? (
        <div className="wsr-note">{member.loading ? 'Loading…' : 'Clean — nothing to review.'}</div>
      ) : showTree ? (
        <div className="wsr-tree">
          <PierreTree
            paths={treePaths}
            gitStatus={treeStatus}
            selectedPath={selectedFile}
            onSelect={(p) => {
              // Ignore the tree's "selection emptied" — the view keeps a
              // current file (cross-section clears come from the reflection).
              if (p) onSelect(p);
            }}
            onActivate={onActivate}
            menuItems={menuItems}
            followFocus
            rowDecoration={rowDecoration}
            rowDecorationKey={decorationKey}
            toggleDirOnRowClick={false}
          />
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceReviewToolbar({
  workspaceName,
  repoCount,
  reviewedCount,
  total,
  loading,
  onRefresh,
}: {
  workspaceName: string;
  repoCount: number;
  reviewedCount: number;
  total: number;
  loading?: boolean;
  onRefresh: () => void;
}) {
  const pct = total > 0 ? Math.round((reviewedCount / total) * 100) : 0;
  return (
    <div className="rv-toolbar" role="toolbar" aria-label="Workspace review">
      <span className="rv-chip">
        <Icon name="workspace" size={12} />
        {workspaceName}
        <span className="wsr-chip-meta">
          · {repoCount} repo{repoCount === 1 ? '' : 's'}
        </span>
      </span>
      {total > 0 && (
        <span className="rv-progress" title={`${reviewedCount} of ${total} files reviewed across the workspace`}>
          <span className="rv-progress-bar" aria-hidden="true">
            <span className="fill" style={{ width: `${pct}%` }} />
          </span>
          {reviewedCount}/{total} reviewed
        </span>
      )}
      <div className="rv-actions">
        <button
          type="button"
          className="h-link"
          onClick={onRefresh}
          title="Re-collect changes from every member repository"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
