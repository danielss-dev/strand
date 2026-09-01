import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Virtualizer, useWorkerPool } from '@pierre/diffs/react';
import type { GitStatusEntry } from '@pierre/trees';

import { Diff, parsePatchCached } from '../components/Diff';
import { DiffMinimap } from '../components/DiffMinimap';
import { DiffSearchBar, focusDiffSearchInput } from '../components/DiffSearchBar';
import { Icon } from '../components/Icon';
import { PaneHeader } from '../components/PaneHeader';
import { ImageDiff } from '../components/ImageDiff';
import { isImagePath } from '../lib/image';
import {
  copyToClipboard,
  diffStatusToGit,
  PierreTree,
  type TreeMenuItem,
  type TreeRowDecoration,
} from '../components/PierreTree';
import { EDITABLE_SELECTOR, eventInside } from '../lib/keys';
import { hashFileDiff as hashOf } from '../lib/patch';
import { matchTarget, scrollToDiffLine, type DiffLineTarget } from '../lib/diffJump';
import { aiCoverageLabel, aiRequestMatches, otherAiProvider } from '../lib/aiGeneration';
import { useSettled } from '../lib/useSettled';
import { concatPatches, patchesToMarkdown } from '../lib/patchExport';
import { buildReviewFeedback, collectFeedbackFiles } from '../lib/reviewExport';
import { AI_AUTH_REQUIRED, gitErrorHint, isCancelled, tauri } from '../lib/tauri';
import type {
  AiInputCoverage,
  AiProvider,
  AiSensitiveDecision,
  AiSensitiveFile,
  CodeReviewFinding,
  FileDiff,
} from '../lib/types';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import { treeFileOrder } from '../lib/treeOrder';
import { HunkAnnotatedDiff, scrollDiff, stepChangeBlock } from './LocalChanges';

/**
 * The Review view — the surface for reviewing an AI agent's changes, built
 * around a verdict loop instead of a staging loop (PRD-adjacent; see
 * docs/improvements.md §1). Unlike Local Changes (the staging workbench),
 * diffs here carry *whole-file* context — the agent's edits read inside the
 * entire file — and the queue is a Pierre file tree.
 *
 * Two modes, decided by whether a baseline is pinned:
 *
 * - **Inbox** (no baseline): the review set is every uncommitted change,
 *   staged + unstaged. Staging never removes work from review; safe unstaged-
 *   only diffs keep their per-hunk Stage / Discard actions.
 * - **Session** (baseline pinned at a commit): the review set is everything
 *   since that commit — committed + staged + unstaged — so an agent that
 *   commits as it goes can't slip work past the review. Diffs render
 *   read-only (the changes may already be committed; stage/discard don't
 *   apply uniformly), with file-level actions where they do.
 *
 * One file at a time on the right, the queue on the left: `j`/`k` (or ↑/↓ in
 * the tree, which follows focus) walk it, Space toggles the reviewed mark and
 * *stays on the file*, `s` stages, `d`-`d` discards, `n`/`p` step change
 * blocks, `c` jumps to the commit form.
 */
const REVIEW_DIFF_HOST = '.rv-single .rv-diff-scroll';

export function Review({
  onOpenFileInEditor,
  onToast,
  active = true,
  embedded = false,
}: {
  onOpenFileInEditor: (file: string) => void;
  onToast: (msg: string, kind?: 'success' | 'error') => void;
  /** Only the focused Custom-view pane owns window-level single-key actions. */
  active?: boolean;
  /** Custom stays mounted under a different global view id, so follow ordinary
   * local-diff refreshes explicitly while this surface is embedded. */
  embedded?: boolean;
}) {
  const baseline = useRepo((s) => s.baseline);
  const baselineDiffs = useRepo((s) => s.baselineDiffs);
  const reviewUnstagedDiffs = useRepo((s) => s.reviewUnstagedDiffs);
  const unstagedDiffs = useRepo((s) => s.unstagedDiffs);
  const reviewed = useRepo((s) => s.reviewed);
  const toggleReviewed = useRepo((s) => s.toggleReviewed);
  const reviewNotes = useRepo((s) => s.reviewNotes);
  const addReviewNote = useRepo((s) => s.addReviewNote);
  const removeReviewNote = useRepo((s) => s.removeReviewNote);
  const addAiReviewFindings = useRepo((s) => s.addAiReviewFindings);
  const activePath = useRepo((s) => s.activePath);
  const meta = useRepo((s) => s.meta);
  const setBaseline = useRepo((s) => s.setBaseline);
  const setBranchBaseline = useRepo((s) => s.setBranchBaseline);
  const clearBaseline = useRepo((s) => s.clearBaseline);
  const refreshReviewDiffs = useRepo((s) => s.refreshReviewDiffs);
  const stageReviewed = useRepo((s) => s.stageReviewed);
  const stageMany = useRepo((s) => s.stageMany);
  const unstageMany = useRepo((s) => s.unstageMany);
  const discardMany = useRepo((s) => s.discardMany);
  const selected = useRepo((s) => s.reviewSelection);
  const selectReviewFile = useRepo((s) => s.selectReviewFile);
  const setView = useRepo((s) => s.setView);
  const stagedDiffs = useRepo((s) => s.stagedDiffs);
  const diffMode = useSettings((s) => s.diffMode);
  const aiProvider = useSettings((s) => s.aiProvider);
  const openaiModel = useSettings((s) => s.openaiModel);
  const anthropicModel = useSettings((s) => s.anthropicModel);
  const openaiCli = useSettings((s) => s.openaiCli);
  const anthropicCli = useSettings((s) => s.anthropicCli);
  const layout = diffMode === 'split' ? 'split' : 'unified';

  // The pool only auto-refreshes while this view is open (or a baseline is
  // pinned) — pull it on entry, and again whenever the baseline moves.
  useEffect(() => {
    void refreshReviewDiffs();
  }, [baseline, refreshReviewDiffs]);

  const embeddedUnstagedRef = useRef(unstagedDiffs);
  useEffect(() => {
    const changed = embeddedUnstagedRef.current !== unstagedDiffs;
    embeddedUnstagedRef.current = unstagedDiffs;
    if (embedded && baseline == null && changed) void refreshReviewDiffs();
  }, [baseline, embedded, refreshReviewDiffs, unstagedDiffs]);

  const sessionMode = baseline != null;
  const pool: FileDiff[] = sessionMode ? baselineDiffs : reviewUnstagedDiffs;
  const aiReviewKey = useMemo(() => reviewPoolKey(baseline?.oid ?? null, pool), [baseline, pool]);

  // Review state per file, derived once per pool/marks change.
  type Verdict = 'pending' | 'reviewed' | 'stale';
  const verdicts = useMemo(() => {
    const m = new Map<string, { hash: string; verdict: Verdict }>();
    for (const d of pool) {
      const hash = hashOf(d);
      const mark = reviewed[d.path];
      m.set(d.path, {
        hash,
        verdict: mark === hash ? 'reviewed' : mark !== undefined ? 'stale' : 'pending',
      });
    }
    return m;
  }, [pool, reviewed]);
  const pendingCount = useMemo(
    () => pool.filter((d) => verdicts.get(d.path)?.verdict !== 'reviewed').length,
    [pool, verdicts],
  );

  const stagedSet = useMemo(() => new Set(stagedDiffs.map((d) => d.path)), [stagedDiffs]);
  const unstagedSet = useMemo(() => new Set(unstagedDiffs.map((d) => d.path)), [unstagedDiffs]);

  // Keep the selection valid: default to the first pending file, fall back
  // to the first file, clear when the pool empties.
  useEffect(() => {
    if (pool.length === 0) {
      if (selected) selectReviewFile(null);
      return;
    }
    if (selected && pool.some((d) => d.path === selected)) return;
    const firstPending = pool.find((d) => verdicts.get(d.path)?.verdict !== 'reviewed');
    selectReviewFile((firstPending ?? pool[0]).path);
  }, [pool, selected, verdicts, selectReviewFile]);

  const current = useMemo(
    () => pool.find((d) => d.path === selected) ?? null,
    [pool, selected],
  );
  // The pane renders whole files, which is too heavy to mount per keystroke —
  // while j/k is scrubbing, the selection (tree highlight, verdict actions)
  // tracks `current` instantly and the diff pane swaps on `displayed` once
  // the queue position settles.
  const displayed = useSettled(current);
  // A ⌘F jump whose file isn't displayed yet parks its line target here until
  // the settled pane catches up; consumed — or dropped as stale — below.
  const pendingJumpRef = useRef<{ path: string; target: DiffLineTarget } | null>(null);
  // Each file starts at its top (without this, the virtualized pane keeps the
  // previous file's scroll offset — deep into bun.lock, then a short file
  // lands in an empty window) — unless a ⌘F jump is waiting for this file,
  // which lands on the matched line instead.
  useEffect(() => {
    const pending = pendingJumpRef.current;
    pendingJumpRef.current = null;
    if (pending && displayed && displayed.path === pending.path) {
      scrollToDiffLine(REVIEW_DIFF_HOST, pending.target, { patch: displayed.patch, layout });
    } else {
      document.querySelector<HTMLElement>(REVIEW_DIFF_HOST)?.scrollTo({ top: 0 });
    }
  }, [displayed, layout]);

  // While the reviewer reads the displayed file, pre-highlight the next few
  // queue entries in Pierre's worker pool, so landing on them paints with
  // syntax colors already cached. Delayed past the settle window and
  // cancelled while scrubbing.
  const workerPool = useWorkerPool();
  useEffect(() => {
    if (!workerPool?.isWorkingPool() || pool.length < 2) return;
    const idx = Math.max(0, pool.findIndex((d) => d.path === selected));
    // Huge patches (lockfiles…) are excluded: parsing them here would jank
    // the main thread, and the worker renders them plain-text anyway.
    const primable = (d: FileDiff) =>
      !d.binary && d.patch.length > 0 && d.patch.length < 1_000_000;
    const targets: FileDiff[] = [];
    for (let i = 1; i < pool.length && targets.length < 3; i++) {
      const d = pool[(idx + i) % pool.length];
      if (primable(d)) targets.push(d);
    }
    const prev = pool[(idx - 1 + pool.length) % pool.length];
    if (prev && primable(prev)) targets.push(prev);
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
  }, [workerPool, pool, selected]);

  // Walk the queue in the same top-to-bottom order the tree *shows* (folders
  // first, natural sort) — not the diff list's flat path order, which made j/k
  // appear to jump into nested folders out of sequence. Matches the ↑/↓ arrows.
  const navOrder = useMemo(() => treeFileOrder(pool.map((d) => d.path)), [pool]);
  const step = useCallback(
    (dir: 1 | -1) => {
      if (navOrder.length === 0) return;
      const idx = selected ? navOrder.indexOf(selected) : -1;
      const next = navOrder[Math.max(0, Math.min(navOrder.length - 1, idx === -1 ? 0 : idx + dir))];
      if (next) selectReviewFile(next);
    },
    [navOrder, selected, selectReviewFile],
  );

  /** Toggle the current file's reviewed mark — and stay on the file, so the
   * verdict can be double-checked before moving on with j/k or the arrows. */
  const markReviewed = useCallback(() => {
    if (!current) return;
    const v = verdicts.get(current.path);
    if (v) toggleReviewed(current.path, v.hash);
  }, [current, verdicts, toggleReviewed]);

  // In-diff text search (⌘F): floats over the diff pane, searches the whole
  // pool, and a jump selects the matched file in the queue.
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

  // Failed write ops surface here instead of vanishing into the console.
  const fail = useCallback(
    (verb: string) => (e: unknown) => onToast(`${verb} failed: ${gitErrorHint(e)}`, 'error'),
    [onToast],
  );

  // ── Review notes (the agent feedback loop) ────────────────────────────
  // The m editor: which file the note attaches to and the optional new-file
  // line it anchors at (pre-set by a per-hunk "Note" button).
  const [noteEditor, setNoteEditor] = useState<{
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

  const pinBaseline = useCallback(() => {
    const action = sessionMode ? setBaseline() : setBranchBaseline();
    void action
      .then((hit) => {
        if (hit) onToast(`Reviewing from the fork point with ${hit.name}.`);
      })
      .catch(fail(sessionMode ? 'Move baseline' : 'Find branch start'));
  }, [sessionMode, setBaseline, setBranchBaseline, fail, onToast]);

  // ── AI code review ───────────────────────────────────────────────────
  const [reviewingWithAi, setReviewingWithAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiCoverage, setAiCoverage] = useState<{
    coverage: AiInputCoverage;
    provider: AiProvider;
  } | null>(null);
  // Provider output stays transient until the reviewer explicitly accepts a
  // finding. Running AI review never edits files or persists review notes.
  const [pendingAiFindings, setPendingAiFindings] = useState<CodeReviewFinding[]>([]);
  const [aiSensitivePrompt, setAiSensitivePrompt] = useState<{
    fingerprint: string;
    files: AiSensitiveFile[];
  } | null>(null);
  const [aiRetryProvider, setAiRetryProvider] = useState<AiProvider | null>(null);
  const aiRequestRef = useRef<{
    opId: string;
    path: string;
    provider: AiProvider;
    target: string;
    model: string;
  } | null>(null);
  const reviewingWithAiRef = useRef(false);

  const cancelAiReview = useCallback(() => {
    const request = aiRequestRef.current;
    aiRequestRef.current = null;
    reviewingWithAiRef.current = false;
    setReviewingWithAi(false);
    if (request) void tauri.repoCancelOp(request.opId);
  }, []);

  useEffect(
    () => cancelAiReview,
    [
      activePath,
      aiProvider,
      openaiCli,
      anthropicCli,
      openaiModel,
      anthropicModel,
      aiReviewKey,
      cancelAiReview,
    ],
  );

  useEffect(() => {
    setPendingAiFindings([]);
    setAiCoverage(null);
  }, [aiReviewKey]);

  const runAiReview = useCallback(
    async (
      sensitiveDecision: AiSensitiveDecision = { mode: 'scan' },
      provider: AiProvider = aiProvider,
    ) => {
      const repoState = useRepo.getState();
      const requestPool = repoState.baseline
        ? repoState.baselineDiffs
        : repoState.reviewUnstagedDiffs;
      if (!repoState.activePath || reviewingWithAiRef.current) return;
      if (requestPool.length === 0) {
        onToast('Nothing changed — there is no code to review.');
        return;
      }
      const opId = `ai-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const model = provider === 'openai' ? openaiModel : anthropicModel;
      const request = {
        opId,
        path: repoState.activePath,
        provider,
        target: currentReviewPoolKey(repoState),
        model,
      };
      aiRequestRef.current = request;
      reviewingWithAiRef.current = true;
      setReviewingWithAi(true);
      setAiError(null);
      setAiCoverage(null);
      setPendingAiFindings([]);
      setAiSensitivePrompt(null);
      setAiRetryProvider(null);
      try {
        const outcome = await tauri.repoReviewChanges(
          request.path,
          repoState.baseline?.oid ?? null,
          provider,
          model,
          { opId, sensitiveDecision, styleInstruction: null },
          openaiCli,
          anthropicCli,
        );
        const current = useRepo.getState();
        if (
          aiRequestRef.current !== request
          || !aiRequestMatches(request, {
            path: current.activePath ?? '',
            provider,
            target: currentReviewPoolKey(current),
          })
        ) return;
        if (outcome.status === 'needs_confirmation') {
          setAiSensitivePrompt({
            fingerprint: outcome.fingerprint,
            files: outcome.sensitiveFiles,
          });
          return;
        }
        if (outcome.provider !== provider) return;
        setPendingAiFindings(outcome.suggestion.findings);
        setAiCoverage({ coverage: outcome.coverage, provider: outcome.provider });
        const count = outcome.suggestion.findings.length;
        const providerLabel = provider === 'openai' ? 'Codex' : 'Claude Code';
        onToast(
          count === 0
            ? `${providerLabel} found no actionable issues in the included changes.`
            : `${providerLabel} found ${count} possible issue${count === 1 ? '' : 's'} for you to review.`,
        );
      } catch (error) {
        if (aiRequestRef.current !== request || isCancelled(error)) return;
        const message = gitErrorHint(error);
        if (message.startsWith(AI_AUTH_REQUIRED)) {
          try {
            await tauri.aiProviderLogin(provider, openaiCli, anthropicCli);
            setAiError('Sign-in started — complete it in the browser or CLI window, then review again.');
          } catch (loginError) {
            setAiError(`Sign-in failed: ${gitErrorHint(loginError)}`);
          }
        } else {
          setAiError(`AI review failed: ${message}`);
          setAiRetryProvider(otherAiProvider(provider));
        }
      } finally {
        if (aiRequestRef.current === request) {
          aiRequestRef.current = null;
          reviewingWithAiRef.current = false;
          setReviewingWithAi(false);
        }
      }
    },
    [
      aiProvider,
      openaiModel,
      anthropicModel,
      openaiCli,
      anthropicCli,
      onToast,
    ],
  );

  const acceptAiFindings = useCallback((findings: CodeReviewFinding[]) => {
    if (findings.length === 0) return;
    addAiReviewFindings(findings);
    const accepted = new Set(findings);
    setPendingAiFindings((current) => current.filter((finding) => !accepted.has(finding)));
    onToast(
      `Added ${findings.length} AI finding${findings.length === 1 ? '' : 's'} as review ` +
      `note${findings.length === 1 ? '' : 's'} — no files were changed.`,
    );
  }, [addAiReviewFindings, onToast]);

  const dismissAiFindings = useCallback((findings: CodeReviewFinding[]) => {
    const dismissed = new Set(findings);
    setPendingAiFindings((current) => current.filter((finding) => !dismissed.has(finding)));
  }, []);

  useEffect(() => {
    const onRequest = () => {
      void refreshReviewDiffs().then(() => runAiReview());
    };
    window.addEventListener('strand:review-with-ai', onRequest);
    return () => window.removeEventListener('strand:review-with-ai', onRequest);
  }, [refreshReviewDiffs, runAiReview]);

  const displayedNotes = displayed ? (reviewNotes[displayed.path] ?? []) : [];
  // The export is the UNION of pool files with notes and noted paths that
  // left the pool (committed/reverted in inbox mode, …) — a stored note must never
  // silently drop from the feedback. Counts follow the same union.
  const feedbackFiles = useMemo(
    () => collectFeedbackFiles(pool, reviewNotes),
    [pool, reviewNotes],
  );
  const noteCount = useMemo(
    () => feedbackFiles.reduce((n, f) => n + f.notes.length, 0),
    [feedbackFiles],
  );
  const copyFeedback = useCallback(() => {
    if (!activePath || feedbackFiles.length === 0) return;
    copyToClipboard(
      buildReviewFeedback({
        repoName: basename(activePath),
        branch: meta?.branch ?? null,
        baselineShort: baseline?.short ?? null,
        files: feedbackFiles,
      }),
    );
    onToast(
      `Copied feedback — ${noteCount} note${noteCount === 1 ? '' : 's'} across ` +
        `${feedbackFiles.length} file${feedbackFiles.length === 1 ? '' : 's'}`,
    );
  }, [activePath, feedbackFiles, noteCount, meta, baseline, onToast]);

  // Two-step confirms for the destructive actions.
  const [armDiscardAll, setArmDiscardAll] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  useEffect(() => {
    if (!armDiscardAll) return;
    const t = setTimeout(() => setArmDiscardAll(false), 3000);
    return () => clearTimeout(t);
  }, [armDiscardAll]);
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => setConfirmDiscard(null), 2500);
    return () => clearTimeout(t);
  }, [confirmDiscard]);

  const discardFile = useCallback(
    (path: string) => {
      if (!unstagedSet.has(path)) return;
      if (confirmDiscard === path) {
        setConfirmDiscard(null);
        void discardMany([path]).catch(fail('Discard'));
      } else {
        setConfirmDiscard(path);
      }
    },
    [unstagedSet, confirmDiscard, discardMany, fail],
  );
  const discardCurrent = useCallback(() => {
    if (current) discardFile(current.path);
  }, [current, discardFile]);

  // ── File queue (Pierre tree) ──────────────────────────────────────────
  const treePaths = useMemo(() => pool.map((d) => d.path), [pool]);
  const treeStatus = useMemo<GitStatusEntry[]>(
    () => pool.map((d) => ({ path: d.path, status: diffStatusToGit(d.status) })),
    [pool],
  );
  // Verdicts render as a row decoration; bump the key so the tree repaints
  // when a mark (or a file's diff) changes.
  const rowDecoration = useCallback(
    (path: string, kind: 'file' | 'directory'): TreeRowDecoration | null => {
      if (kind !== 'file') return null;
      const notes = reviewNotes[path]?.length ?? 0;
      const pen = notes > 0 ? ` ✎${notes}` : '';
      const penTitle = notes > 0 ? ` · ${notes} note${notes === 1 ? '' : 's'}` : '';
      switch (verdicts.get(path)?.verdict) {
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
    [verdicts, reviewNotes],
  );
  // Note counts feed the decoration, so they're folded into the key — Pierre
  // only repaints rows when this fingerprint moves (see docs/learnings.md).
  const decorationKey = useMemo(
    () =>
      pool
        .map((d) => `${d.path}:${verdicts.get(d.path)?.verdict}:${reviewNotes[d.path]?.length ?? 0}`)
        .join('|'),
    [pool, verdicts, reviewNotes],
  );

  // Activate (double-click / Enter): one file toggles its reviewed mark; a
  // folder or multi-selection marks everything under it reviewed.
  const activateFiles = useCallback(
    (paths: string[]) => {
      if (paths.length === 1) {
        const v = verdicts.get(paths[0]);
        if (v) toggleReviewed(paths[0], v.hash);
        return;
      }
      for (const p of paths) {
        const v = verdicts.get(p);
        if (v && v.verdict !== 'reviewed') toggleReviewed(p, v.hash);
      }
    },
    [verdicts, toggleReviewed],
  );

  const treeMenuItems = useCallback(
    (targets: string[]): TreeMenuItem[] => {
      const known = targets.filter((p) => verdicts.has(p));
      if (known.length === 0) return [];
      const n = known.length;
      const suffix = n > 1 ? ` ${n} files` : '';
      const allReviewed = known.every((p) => verdicts.get(p)!.verdict === 'reviewed');
      const items: TreeMenuItem[] = [];
      if (n === 1) {
        items.push({
          label: 'Open in editor',
          icon: 'external',
          onSelect: () => onOpenFileInEditor(known[0]),
        });
      }
      items.push({
        label: (allReviewed ? 'Mark not reviewed' : 'Mark reviewed') + suffix,
        icon: 'check',
        onSelect: () => {
          for (const p of known) {
            const v = verdicts.get(p)!;
            if (allReviewed || v.verdict !== 'reviewed') toggleReviewed(p, v.hash);
          }
        },
      });
      const unstagedTargets = known.filter((p) => unstagedSet.has(p));
      if (unstagedTargets.length > 0) {
        const un = unstagedTargets.length;
        items.push(
          {
            label: 'Stage' + (un > 1 ? ` ${un} files` : ''),
            icon: 'plus',
            onSelect: () => void stageMany(unstagedTargets).catch(fail('Stage')),
          },
          {
            label: (un > 1 ? `Discard ${un} files` : 'Discard') + '…',
            icon: 'trash',
            danger: true,
            confirm: true,
            onSelect: () => void discardMany(unstagedTargets).catch(fail('Discard')),
          },
        );
      }
      items.push({
        label: n > 1 ? 'Copy paths' : 'Copy path',
        icon: 'file',
        onSelect: () => copyToClipboard(known.join('\n')),
      });
      const diffs = known
        .map((p) => pool.find((d) => d.path === p))
        .filter((d): d is FileDiff => d != null);
      if (diffs.some((d) => d.patch.length > 0)) {
        items.push(
          { label: 'Copy diff', icon: 'file', onSelect: () => copyToClipboard(concatPatches(diffs)) },
          { label: 'Copy diff as Markdown', icon: 'file', onSelect: () => copyToClipboard(patchesToMarkdown(diffs)) },
        );
      }
      return items;
    },
    [verdicts, unstagedSet, toggleReviewed, stageMany, discardMany, fail, pool, onOpenFileInEditor],
  );

  // ── Keyboard loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      // ⌘F / Ctrl+F opens the in-diff search — checked before the mod-combo
      // guard below. Inert while a dialog or the palette is up.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        const ft = e.target as HTMLElement | null;
        if (ft?.closest('[role="dialog"], [role="combobox"], .palette-backdrop')) return;
        e.preventDefault();
        setSearchOpen(true);
        focusDiffSearchInput(); // already open → refocus + select
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      // `eventInside` sees through shadow DOM — the Pierre tree's file-search
      // box lives in one, and `e.target` retargets to the host there.
      if (eventInside(e, `${EDITABLE_SELECTOR}, [role="dialog"]`)) return;
      // Arrow keys stay with the Pierre tree (its own focus model handles
      // them); j/k walk the queue from anywhere.
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
          stepChangeBlock(e.key === 'n' ? 1 : -1, REVIEW_DIFF_HOST);
          break;
        // Shift+J / Shift+K scroll the diff pane (j/k stay queue nav).
        case 'J':
        case 'K':
          e.preventDefault();
          scrollDiff(e.key === 'J' ? 1 : -1, REVIEW_DIFF_HOST);
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
            setNoteEditor({ path: current.path, line: null, side: 'new' });
          }
          break;
        case 's':
          if (current && unstagedSet.has(current.path)) {
            e.preventDefault();
            void stageMany([current.path]).catch(fail('Stage'));
          }
          break;
        case 'd':
          e.preventDefault();
          discardCurrent();
          break;
        case 'c':
          e.preventDefault();
          setView('local');
          requestAnimationFrame(() =>
            document.querySelector<HTMLInputElement>('.lc-commit-bar .subject')?.focus(),
          );
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, step, markReviewed, current, unstagedSet, stageMany, discardCurrent, setView]);

  // Marks hash the pool's whole-file patches; both bulk actions only touch
  // files that are actually unstaged right now.
  const stageableReviewed = useMemo(
    () =>
      pool.filter(
        (d) => unstagedSet.has(d.path) && verdicts.get(d.path)?.verdict === 'reviewed',
      ).length,
    [pool, unstagedSet, verdicts],
  );
  const unreviewedUnstaged = useMemo(
    () =>
      pool
        .filter((d) => unstagedSet.has(d.path) && verdicts.get(d.path)?.verdict !== 'reviewed')
        .map((d) => d.path),
    [pool, unstagedSet, verdicts],
  );

  const when = baseline
    ? new Date(baseline.setAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  if (pool.length === 0) {
    return (
      <div className="rv-wrap rv-single">
        <ReviewToolbar
          sessionMode={sessionMode}
          baselineShort={baseline?.short ?? null}
          when={when}
          reviewedCount={0}
          total={0}
          onPin={pinBaseline}
          onClear={() => void clearBaseline()}
        />
        <div className="lc-empty">
          <strong>{sessionMode ? 'Session is clean' : 'Nothing to review'}</strong>
          {sessionMode
            ? `No changes since ${baseline!.short}. Let the agent work — this view follows along live.`
            : 'No uncommitted changes. Start a branch baseline to review its committed work too.'}
        </div>
      </div>
    );
  }

  return (
    <div className="rv-wrap rv-single">
      <ReviewToolbar
        sessionMode={sessionMode}
        baselineShort={baseline?.short ?? null}
        when={when}
        reviewedCount={pool.length - pendingCount}
        total={pool.length}
        onPin={pinBaseline}
        onClear={() => void clearBaseline()}
        extra={
          <>
            <button
              type="button"
              className="h-link rv-ai-action"
              aria-busy={reviewingWithAi}
              disabled={reviewingWithAi}
              onClick={() => void runAiReview()}
              title="Find possible issues without editing files or adding notes automatically"
            >
              <Icon
                name={reviewingWithAi ? 'refresh' : 'sparkle'}
                size={11}
                className={reviewingWithAi ? 'spin' : undefined}
              />
              {reviewingWithAi
                ? 'Reviewing…'
                : `Review with ${aiProvider === 'openai' ? 'Codex' : 'Claude Code'}`}
            </button>
            {reviewingWithAi && (
              <button type="button" className="h-link" onClick={cancelAiReview}>
                Cancel
              </button>
            )}
            {noteCount > 0 && (
              <button
                type="button"
                className="h-link"
                onClick={copyFeedback}
                title="Copy every note as one Markdown prompt for the agent"
              >
                Copy feedback ({noteCount})
              </button>
            )}
            {stageableReviewed > 0 && (
              <button type="button" className="h-link" onClick={() => void stageReviewed().catch(fail('Stage reviewed'))}>
                Stage reviewed ({stageableReviewed})
              </button>
            )}
            {unreviewedUnstaged.length > 1 && (
              <button
                type="button"
                className={armDiscardAll ? 'btn danger' : 'h-link'}
                onClick={() => {
                  if (!armDiscardAll) {
                    setArmDiscardAll(true);
                    return;
                  }
                  setArmDiscardAll(false);
                  void discardMany(unreviewedUnstaged).catch(fail('Discard unreviewed'));
                }}
              >
                {armDiscardAll
                  ? `Really discard ${unreviewedUnstaged.length} files?`
                  : `Discard unreviewed (${unreviewedUnstaged.length})`}
              </button>
            )}
          </>
        }
      />

      {(aiSensitivePrompt || aiError || aiCoverage || pendingAiFindings.length > 0) && (
        <div className="rv-ai-review">
          <div className="rv-ai-panel" role={aiError || aiSensitivePrompt ? 'alert' : 'status'}>
            {aiSensitivePrompt ? (
              <>
                <span>
                  Potentially sensitive files require confirmation:{' '}
                  {aiSensitivePrompt.files.map((file) => file.path).join(', ')}
                </span>
                <button
                  type="button"
                  className="h-link"
                  onClick={() => void runAiReview({ mode: 'exclude', fingerprint: aiSensitivePrompt.fingerprint })}
                >
                  Review without them
                </button>
                <button
                  type="button"
                  className="h-link"
                  onClick={() => void runAiReview({ mode: 'include', fingerprint: aiSensitivePrompt.fingerprint })}
                >
                  Include and review
                </button>
                <button type="button" className="h-link" onClick={() => setAiSensitivePrompt(null)}>
                  Cancel
                </button>
              </>
            ) : aiError ? (
              <>
                <span>{aiError}</span>
                {aiRetryProvider && (
                  <button
                    type="button"
                    className="h-link"
                    onClick={() => void runAiReview({ mode: 'scan' }, aiRetryProvider)}
                  >
                    Retry with {aiRetryProvider === 'openai' ? 'Codex' : 'Claude Code'}
                  </button>
                )}
                <button type="button" className="h-link" onClick={() => setAiError(null)}>
                  Dismiss
                </button>
              </>
            ) : pendingAiFindings.length > 0 ? (
              <>
                <span>
                  {pendingAiFindings.length} suggested issue{pendingAiFindings.length === 1 ? '' : 's'}
                  {' · '}review before adding as notes; no files are changed
                  {aiCoverage ? ` · ${aiCoverageLabel(aiCoverage.coverage, aiCoverage.provider)}` : ''}
                </span>
                <button
                  type="button"
                  className="h-link"
                  onClick={() => acceptAiFindings(pendingAiFindings)}
                >
                  Add all as notes
                </button>
                <button
                  type="button"
                  className="h-link"
                  onClick={() => dismissAiFindings(pendingAiFindings)}
                >
                  Dismiss all
                </button>
              </>
            ) : aiCoverage ? (
              <span>{aiCoverageLabel(aiCoverage.coverage, aiCoverage.provider)} · no files were changed</span>
            ) : null}
          </div>
          {pendingAiFindings.length > 0 && !aiSensitivePrompt && !aiError && (
            <div className="rv-ai-findings" aria-label="AI review suggestions">
              {pendingAiFindings.map((finding, index) => (
                <article
                  key={`${finding.path}:${finding.line ?? 'file'}:${finding.title}:${index}`}
                  className="rv-ai-finding"
                >
                  <span className={`rv-ai-severity ${finding.severity}`}>{finding.severity}</span>
                  <div className="rv-ai-finding-copy">
                    <div className="rv-ai-finding-title">{finding.title}</div>
                    <div className="rv-ai-finding-body">{finding.body}</div>
                    <button
                      type="button"
                      className="rv-ai-location"
                      onClick={() => selectReviewFile(finding.path)}
                    >
                      {finding.path}{finding.line == null ? '' : `:${finding.line}`}
                    </button>
                  </div>
                  <div className="rv-ai-finding-actions">
                    <button
                      type="button"
                      className="h-link"
                      onClick={() => acceptAiFindings([finding])}
                    >
                      Add note
                    </button>
                    <button
                      type="button"
                      className="h-link"
                      onClick={() => dismissAiFindings([finding])}
                    >
                      Dismiss
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rv-main">
        <PanelGroup direction="horizontal" autoSaveId="strand:review">
          <Panel defaultSize={26} minSize={15} maxSize={50}>
            <div className="rv-tree">
              <PierreTree
                paths={treePaths}
                gitStatus={treeStatus}
                selectedPath={selected}
                onSelect={(p) => {
                  // Ignore the tree's "selection emptied" — the view always
                  // keeps a current file.
                  if (p) selectReviewFile(p);
                }}
                onActivate={activateFiles}
                menuItems={treeMenuItems}
                followFocus
                rowDecoration={rowDecoration}
                rowDecorationKey={decorationKey}
                toggleDirOnRowClick={false}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="rs-handle vert" />
          <Panel minSize={30}>
            <div className="diff-search-host">
              {displayed ? (
                <div className="rv-diff">
                  <div className="rv-file-head">
                    <span className="path">{displayed.path}</span>
                    <span className="stat-del">−{displayed.dels}</span>
                    <span className="stat-add">+{displayed.adds}</span>
                    <span className="rv-head-actions">
                      <button
                        type="button"
                        className="h-link"
                        onClick={() => setNoteEditor({ path: displayed.path, line: null, side: 'new' })}
                        title="Add a review note to this file (m)"
                      >
                        Note
                      </button>
                      {unstagedSet.has(displayed.path) && (
                        <>
                          <button
                            type="button"
                            className="h-link"
                            onClick={() => void stageMany([displayed.path]).catch(fail('Stage'))}
                            title="Stage this file (s)"
                          >
                            Stage
                          </button>
                          <button
                            type="button"
                            className={'h-link' + (confirmDiscard === displayed.path ? ' danger' : '')}
                            onClick={() => discardFile(displayed.path)}
                            title="Discard this file's working-tree changes (d d)"
                          >
                            {confirmDiscard === displayed.path ? 'Really discard?' : 'Discard'}
                          </button>
                        </>
                      )}
                      {stagedSet.has(displayed.path) && (
                        <button
                          type="button"
                          className="h-link"
                          onClick={() => void unstageMany([displayed.path]).catch(fail('Unstage'))}
                          title="Unstage this file"
                        >
                          Unstage
                        </button>
                      )}
                      <button
                        type="button"
                        className={
                          'rv-check wide' + (verdicts.get(displayed.path)?.verdict === 'reviewed' ? ' on' : '')
                        }
                        aria-pressed={verdicts.get(displayed.path)?.verdict === 'reviewed'}
                        onClick={markReviewed}
                        title="Mark reviewed (Space)"
                      >
                        <Icon name="check" size={12} stroke={2.2} />
                        {verdicts.get(displayed.path)?.verdict === 'reviewed' ? 'Reviewed' : 'Mark reviewed'}
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
                            addReviewNote(noteEditor.path, text, noteEditor.line, noteEditor.side);
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
                          {n.source === 'ai' && (
                            <span className={`rv-note-source ${n.severity ?? 'medium'}`}>
                              AI · {n.severity ?? 'medium'}
                            </span>
                          )}
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
                            onClick={() => removeReviewNote(displayed.path, n.id)}
                          >
                            <Icon name="x" size={11} stroke={2} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Pierre's Virtualizer makes it the scroll container and
                      window-renders the diff rows — whole-file patches of any
                      size (lockfiles…) mount only what's on screen. The change
                      map rides beside it as an overview ruler. */}
                  <div className="rv-diff-body">
                    <Virtualizer className="rv-diff-scroll">
                    {displayed.binary && isImagePath(displayed.path) ? (
                      // Old side: the session baseline, or HEAD in inbox mode.
                      // The inbox combines staged + unstaged changes against
                      // HEAD, matching the textual diff. New side: worktree.
                      <ImageDiff
                        path={displayed.path}
                        oldSrc={
                          displayed.status === 'added'
                            ? null
                            : sessionMode
                              ? { rev: baseline!.oid }
                              : { rev: 'HEAD' }
                        }
                        newSrc={displayed.status === 'deleted' ? null : { rev: null }}
                      />
                    ) : displayed.binary || displayed.patch.length === 0 ? (
                      <div className="lc-file-note">
                        {displayed.binary ? 'Binary file — no diff shown.' : 'No textual diff.'}
                      </div>
                    ) : sessionMode || stagedSet.has(displayed.path) ? (
                      // Session diffs can span commits, while an inbox file
                      // with staged content is a combined HEAD→worktree patch.
                      // Neither is a safe per-hunk index patch, so render it
                      // read-only and keep the explicit file-level controls.
                      <Diff
                        key={`${displayed.path}:${hashOf(displayed)}`}
                        patch={displayed.patch}
                        layout={layout}
                        hideFileHeader
                      />
                    ) : (
                      // No staged content means HEAD = index for this file, so
                      // the combined inbox patch is safe for hunk actions.
                      <HunkAnnotatedDiff
                        key={`${displayed.path}:${hashOf(displayed)}`}
                        diff={displayed}
                        layout={layout}
                        side="unstaged"
                        onNoteBlock={(m) =>
                          // A deletion-only block has no new-side line — its
                          // anchor counts on the OLD side, and the exporter
                          // locates the excerpt with the matching counter.
                          setNoteEditor({
                            path: displayed.path,
                            line: m.addRange?.start ?? m.delRange?.start ?? null,
                            side: m.addRange ? 'new' : m.delRange ? 'old' : 'new',
                          })
                        }
                      />
                    )}
                    </Virtualizer>
                    {!displayed.binary && displayed.patch.length > 0 && (
                      <DiffMinimap
                        patch={displayed.patch}
                        layout={layout}
                        hostSelector={REVIEW_DIFF_HOST}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="lc-empty">
                  <strong>Pick a file</strong>
                  Select something on the left to review its diff.
                </div>
              )}
              {searchOpen && (
                <DiffSearchBar
                  diffs={pool}
                  onJump={(m) => {
                    const target = matchTarget(m);
                    if (target && displayed?.path === m.path) {
                      // Same file: the pane won't remount, scroll right away.
                      scrollToDiffLine(REVIEW_DIFF_HOST, target, {
                        patch: displayed.patch,
                        layout,
                      });
                    } else if (target) {
                      pendingJumpRef.current = { path: m.path, target };
                    }
                    selectReviewFile(m.path);
                  }}
                  onClose={() => setSearchOpen(false)}
                  placeholder="Search review diffs…"
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
        <span className="kbd-inline">c</span> commit
        <span className="kbd-inline">⌘F</span> search
      </div>

    </div>
  );
}
/** Last path segment — the repo's directory name from its absolute path. */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function reviewPoolKey(baselineOid: string | null, pool: FileDiff[]): string {
  return `${baselineOid ?? 'uncommitted'}\0${pool.map((diff) => `${diff.path}:${hashOf(diff)}`).join('\0')}`;
}

function currentReviewPoolKey(state: ReturnType<typeof useRepo.getState>): string {
  const pool = state.baseline ? state.baselineDiffs : state.reviewUnstagedDiffs;
  return reviewPoolKey(state.baseline?.oid ?? null, pool);
}

function ReviewToolbar({
  sessionMode,
  baselineShort,
  when,
  reviewedCount,
  total,
  onPin,
  onClear,
  extra,
}: {
  sessionMode: boolean;
  baselineShort: string | null;
  when: string | null;
  reviewedCount: number;
  total: number;
  onPin: () => void;
  onClear: () => void;
  extra?: React.ReactNode;
}) {
  const pct = total > 0 ? Math.round((reviewedCount / total) * 100) : 0;
  return (
    <div role="toolbar" aria-label="Review session">
    <PaneHeader
      title={
        <span className="rv-chip">
          <Icon name="history" size={12} />
          {sessionMode ? (
            <>
              Session since <code>{baselineShort}</code>
              {when ? ` · ${when}` : ''}
            </>
          ) : (
            'Uncommitted changes'
          )}
        </span>
      }
      meta={
        total > 0 ? (
        <span className="rv-progress" title={`${reviewedCount} of ${total} files reviewed`}>
          <span className="rv-progress-bar" aria-hidden="true">
            <span className="fill" style={{ width: `${pct}%` }} />
          </span>
          {reviewedCount}/{total} reviewed
        </span>
        ) : null
      }
      actions={
        <div className="rv-actions">
          {extra}
          <button
            type="button"
            className="h-link"
            onClick={onPin}
            title={
              sessionMode
                ? 'Re-pin the baseline at the current HEAD'
                : 'Detect this branch\'s fork point and review every commit since it was created'
            }
          >
            {sessionMode ? 'Move baseline to HEAD' : 'Review from branch start'}
          </button>
          {sessionMode && (
            <button type="button" className="h-link" onClick={onClear}>
              Clear baseline
            </button>
          )}
        </div>
      }
    />
    </div>
  );
}
