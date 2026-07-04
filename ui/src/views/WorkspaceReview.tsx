import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Virtualizer, useWorkerPool } from '@pierre/diffs/react';
import type { GitStatusEntry } from '@pierre/trees';

import { Diff, parsePatchCached } from '../components/Diff';
import { DiffMinimap } from '../components/DiffMinimap';
import { DiffSearchBar, focusDiffSearchInput } from '../components/DiffSearchBar';
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
import { matchTarget, scrollToDiffLine, type DiffLineTarget } from '../lib/diffJump';
import type { DiffMatch } from '../lib/diffSearch';
import { hashFileDiff as hashOf } from '../lib/patch';
import { concatPatches, patchesToMarkdown } from '../lib/patchExport';
import { buildWorkspaceReviewFeedback, collectFeedbackFiles } from '../lib/reviewExport';
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
 *
 * Notes work here too — `m` (or the header / per-block Note buttons) attaches
 * a note to the selected file, persisted to the owning repo's review session
 * (one note store, two lenses). "Copy feedback" exports every member's notes
 * as one repo-grouped Markdown prompt (`buildWorkspaceReviewFeedback`).
 * ⌘F searches every member's pool at once — each match is tagged with its
 * owning repo, and stepping through matches crosses repo boundaries.
 */
export function WorkspaceReview() {
  const members = useWorkspaceReview((s) => s.members);
  const selection = useWorkspaceReview((s) => s.selection);
  const select = useWorkspaceReview((s) => s.select);
  const setActive = useWorkspaceReview((s) => s.setActive);
  const refreshAll = useWorkspaceReview((s) => s.refreshAll);
  const toggleReviewed = useWorkspaceReview((s) => s.toggleReviewed);
  const addNote = useWorkspaceReview((s) => s.addNote);
  const removeNote = useWorkspaceReview((s) => s.removeNote);
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
  // A ⌘F jump whose file isn't displayed yet parks its line target here until
  // the settled pane catches up; consumed — or dropped as stale — below.
  const pendingJumpRef = useRef<{ repo: string; file: string; target: DiffLineTarget } | null>(
    null,
  );
  useEffect(() => {
    const pending = pendingJumpRef.current;
    pendingJumpRef.current = null;
    if (
      pending &&
      displayed &&
      pathKey(displayed.member.path) === pathKey(pending.repo) &&
      displayed.diff.path === pending.file
    ) {
      scrollToDiffLine('.rv-diff-scroll', pending.target, {
        patch: displayed.diff.patch,
        layout,
      });
    } else {
      document.querySelector<HTMLElement>('.rv-diff-scroll')?.scrollTo({ top: 0 });
    }
  }, [displayed, layout]);

  // Read the displayed file's notes off the LIVE member slice, not the
  // settled snapshot — a note added just now must paint without waiting for
  // the settle window (the snapshot's member object is stale by then).
  const displayedNotes = useMemo(() => {
    if (!displayed) return [];
    const mem = members.find((m) => pathKey(m.path) === pathKey(displayed.member.path));
    return mem?.notes[displayed.diff.path] ?? [];
  }, [members, displayed]);

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

  // In-diff text search (⌘F): floats over the diff pane and searches EVERY
  // member's pool at once — a jump selects the matched file, crossing repo
  // boundaries. Each pool entry is tagged with its owning repo path, since a
  // file path alone is ambiguous across members.
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
  const searchPool = useMemo(
    () =>
      members.flatMap((m) =>
        m.diffs.map((d) => ({ path: d.path, patch: d.patch, binary: d.binary, tag: m.path })),
      ),
    [members],
  );
  const memberNameByKey = useMemo(
    () => new Map(members.map((m) => [pathKey(m.path), m.name])),
    [members],
  );
  const searchPathLabel = useCallback(
    (m: DiffMatch) => {
      const name = typeof m.tag === 'string' ? memberNameByKey.get(pathKey(m.tag)) : undefined;
      return name ? `${name} · ${m.path}` : m.path;
    },
    [memberNameByKey],
  );

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

  // ── Review notes (the agent feedback loop, workspace-wide) ────────────
  // The m editor: which member+file the note attaches to and the optional
  // line it anchors at (pre-set by a per-hunk "Note" button).
  const [noteEditor, setNoteEditor] = useState<{
    repo: string;
    path: string;
    line: number | null;
    /** Diff side `line` counts on — 'old' for deletion-only blocks. */
    side: 'new' | 'old';
  } | null>(null);
  const closeNoteEditor = useCallback((el?: HTMLTextAreaElement) => {
    // Blur before unmounting so focus falls back to the window and the
    // j/k/space loop resumes immediately, no click needed.
    el?.blur();
    setNoteEditor(null);
  }, []);

  // Success notice ("Copied feedback …"); opError takes the toast slot first.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  // Per member, the union of pool files with notes and noted paths that left
  // the pool (staged away in inbox mode, …) — a stored note must never
  // silently drop from the feedback. Members without notes export nothing.
  const feedbackRepos = useMemo(
    () =>
      members
        .map((m) => ({
          repoName: m.name,
          branch: m.branch,
          baselineShort: m.baseline?.short ?? null,
          files: collectFeedbackFiles(m.diffs, m.notes),
        }))
        .filter((r) => r.files.length > 0),
    [members],
  );
  const noteCount = useMemo(
    () => feedbackRepos.reduce((n, r) => n + r.files.reduce((k, f) => k + f.notes.length, 0), 0),
    [feedbackRepos],
  );
  const copyFeedback = useCallback(() => {
    if (feedbackRepos.length === 0) return;
    copyToClipboard(buildWorkspaceReviewFeedback({ workspaceName, repos: feedbackRepos }));
    const fileCount = feedbackRepos.reduce((n, r) => n + r.files.length, 0);
    setNotice(
      `Copied feedback — ${noteCount} note${noteCount === 1 ? '' : 's'} across ` +
        `${fileCount} file${fileCount === 1 ? '' : 's'} in ` +
        `${feedbackRepos.length} repo${feedbackRepos.length === 1 ? '' : 's'}`,
    );
  }, [feedbackRepos, noteCount, workspaceName]);

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
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        const ft = e.target as HTMLElement | null;
        if (ft?.closest('[role="dialog"], [role="combobox"], .palette-backdrop')) return;
        e.preventDefault();
        setSearchOpen(true);
        focusDiffSearchInput(); // already open → refocus + select
        return;
      }
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
        case 'm':
          // The input/textarea guard above keeps this inert while the note
          // editor itself (or any other field) has focus.
          if (current) {
            e.preventDefault();
            setNoteEditor({
              repo: current.member.path,
              path: current.diff.path,
              line: null,
              side: 'new',
            });
          }
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

  /** ⌘F jump: select the match's file (landing on the matched line — right
   * away when the file is already displayed, else via the pending target the
   * settle effect consumes) and un-collapse its member section so the
   * selected row is actually visible in the queue column. */
  const jumpToMatch = useCallback(
    (m: DiffMatch) => {
      if (typeof m.tag !== 'string') return;
      const repo = m.tag;
      setCollapsed((cur) => {
        const key = pathKey(repo);
        if (!cur.has(key)) return cur;
        const next = new Set(cur);
        next.delete(key);
        return next;
      });
      const target = matchTarget(m);
      if (target) {
        if (
          displayed &&
          pathKey(displayed.member.path) === pathKey(repo) &&
          displayed.diff.path === m.path
        ) {
          scrollToDiffLine('.rv-diff-scroll', target, {
            patch: displayed.diff.patch,
            layout,
          });
        } else {
          pendingJumpRef.current = { repo, file: m.path, target };
        }
      }
      select({ repo, file: m.path });
    },
    [select, displayed, layout],
  );

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
        extra={
          noteCount > 0 && (
            <button
              type="button"
              className="h-link"
              onClick={copyFeedback}
              title="Copy every member repo's notes as one repo-grouped Markdown prompt for the agent"
            >
              Copy feedback ({noteCount})
            </button>
          )
        }
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
            <div className="diff-search-host">
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
                    <button
                      type="button"
                      className="h-link"
                      onClick={() =>
                        setNoteEditor({
                          repo: displayed.member.path,
                          path: displayed.diff.path,
                          line: null,
                          side: 'new',
                        })
                      }
                      title="Add a review note to this file (m)"
                    >
                      Note
                    </button>
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
                {noteEditor && (
                  <div className="rv-note-editor">
                    <textarea
                      rows={2}
                      autoFocus
                      placeholder={
                        (noteEditor.line != null
                          ? `Note on ${noteEditor.side === 'old' ? 'old ' : ''}L${noteEditor.line} of ${noteEditor.path}`
                          : `Note ${noteEditor.path}`) + ' — Enter saves, Esc cancels'
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const text = e.currentTarget.value;
                          closeNoteEditor(e.currentTarget);
                          addNote(noteEditor.repo, noteEditor.path, text, noteEditor.line, noteEditor.side);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          closeNoteEditor(e.currentTarget);
                        }
                      }}
                    />
                  </div>
                )}
                {displayedNotes.length > 0 && (
                  <div className="rv-notes">
                    {displayedNotes.map((n) => (
                      <div key={n.id} className="rv-note">
                        {n.line != null && (
                          <span
                            className="rv-note-line"
                            title={n.side === 'old' ? 'Old-side line (deleted block)' : undefined}
                          >
                            {n.side === 'old' ? '−' : ''}L{n.line}
                          </span>
                        )}
                        <span className="rv-note-text" title={n.text}>
                          {n.text}
                        </span>
                        <button
                          type="button"
                          className="rv-note-x"
                          aria-label="Remove note"
                          onClick={() => removeNote(displayed.member.path, displayed.diff.path, n.id)}
                        >
                          <Icon name="x" size={11} stroke={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
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
                      onNoteBlock={(m) =>
                        // A deletion-only block has no new-side line — its
                        // anchor counts on the OLD side, and the exporter
                        // locates the excerpt with the matching counter.
                        setNoteEditor({
                          repo: displayed.member.path,
                          path: displayed.diff.path,
                          line: m.addRange?.start ?? m.delRange?.start ?? null,
                          side: m.addRange ? 'new' : m.delRange ? 'old' : 'new',
                        })
                      }
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
            {searchOpen && (
              <DiffSearchBar
                diffs={searchPool}
                onJump={jumpToMatch}
                onClose={() => setSearchOpen(false)}
                placeholder="Search workspace diffs…"
                pathLabel={searchPathLabel}
              />
            )}
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <div className="rv-foot" aria-hidden="true">
        <span className="kbd-inline">↑ ↓ j k</span> files
        <span className="kbd-inline">space</span> reviewed
        <span className="kbd-inline">m</span> note
        <span className="kbd-inline">n p</span> blocks
        <span className="kbd-inline">s</span> stage
        <span className="kbd-inline">d d</span> discard
        <span className="kbd-inline">o</span> open in repo
        <span className="kbd-inline">⌘F</span> search
      </div>

      {opError ? (
        <div className="toast" role="alert">
          <span style={{ color: 'var(--del, #e5534b)' }}><Icon name="x" size={13} stroke={2} /></span>
          <span>{opError}</span>
          <button type="button" className="toast-action" onClick={() => setOpError(null)}>
            Dismiss
          </button>
        </div>
      ) : notice ? (
        <div className="toast" role="status">
          <span style={{ color: 'var(--add, #57ab5a)' }}><Icon name="check" size={13} stroke={2} /></span>
          <span>{notice}</span>
        </div>
      ) : null}
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
      const notes = member.notes[path]?.length ?? 0;
      const pen = notes > 0 ? ` ✎${notes}` : '';
      const penTitle = notes > 0 ? ` · ${notes} note${notes === 1 ? '' : 's'}` : '';
      switch (verdictFor(path)) {
        case 'reviewed':
          return { text: '✓' + pen, title: 'Reviewed' + penTitle };
        case 'stale':
          return { text: 'changed' + pen, title: 'Changed since reviewed — review again' + penTitle };
        default:
          return notes > 0
            ? { text: `✎${notes}`, title: `${notes} note${notes === 1 ? '' : 's'}` }
            : null;
      }
    },
    [verdictFor, member.notes],
  );
  // Note counts feed the decoration, so they're folded into the key — Pierre
  // only repaints rows when this fingerprint moves (see docs/learnings.md).
  const decorationKey = useMemo(
    () =>
      member.diffs
        .map((d) => `${d.path}:${verdictFor(d.path)}:${member.notes[d.path]?.length ?? 0}`)
        .join('|'),
    [member.diffs, verdictFor, member.notes],
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
  extra,
}: {
  workspaceName: string;
  repoCount: number;
  reviewedCount: number;
  total: number;
  loading?: boolean;
  onRefresh: () => void;
  extra?: React.ReactNode;
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
        {extra}
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
