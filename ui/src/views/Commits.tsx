import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { computeGraph } from '../lib/graph';
import { pickCommitPatchDestination } from '../lib/dialog';
import { EDITABLE_SELECTOR, eventInside } from '../lib/keys';
import { selectedCommitsOldestFirst } from '../lib/historySelection';
import { errMessage, tauri } from '../lib/tauri';
import type { Commit, Refs, Stash } from '../lib/types';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import { useWork } from '../stores/work';
import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { copyToClipboard } from '../components/PierreTree';
import { CommitDetail } from './CommitDetail';
import { CommitGraphCell, graphColWidth } from './CommitGraphCell';
import { CommitTimeline } from './CommitTimeline';
import { CompareRefsDialog } from './CompareRefsDialog';
import { MainlineDialog, type MainlineOperation } from './MainlineDialog';

/**
 * Row heights per density — must match `.graph-table tbody tr` in
 * features.css. The table is virtualized (only the viewport slice renders),
 * so the spacer math needs the exact row height.
 */
const ROW_PX: Record<string, number> = { compact: 26, default: 32, relaxed: 38 };
/** `.graph-table thead th` height (features.css). */
const HEADER_PX = 28;
/** Rows rendered beyond each viewport edge so fast scrolls meet content. */
const OVERSCAN = 12;

/**
 * Was this commit (co-)authored by an AI coding agent? Detected from the
 * `Co-Authored-By:` trailer agents append (Claude Code, Copilot, Cursor, …)
 * or an obviously bot-flavored author. Heuristic — a chip, not a judgment.
 */
export function isAgentCommit(c: Commit): boolean {
  const agents = /\b(claude|copilot|cursor|aider|devin|codex|gemini|chatgpt|gpt-?\d)\b/i;
  if (/^co-authored-by:.*$/im.test(c.body)) {
    const trailer = c.body.match(/^co-authored-by:(.*)$/gim)?.join('\n') ?? '';
    if (agents.test(trailer)) return true;
  }
  return agents.test(c.author_name) || /\[bot\]|noreply@anthropic\.com/i.test(c.author_email);
}

interface CommitsProps {
  /** Open the New-tag dialog targeting a commit (revspec + label). */
  onCreateTag: (target: string, label: string) => void;
  /** Open the interactive-rebase editor over `base..HEAD` (base null = root). */
  onInteractiveRebase: (base: string | null, label: string) => void;
  /** Open the Reset dialog targeting a commit (revspec + label). */
  onResetTo: (target: string, label: string) => void;
  /** Open the New-worktree dialog with a pre-picked start point. */
  onCreateWorktree: (start: { ref: string; label: string }) => void;
  /** Surface cherry-pick / revert feedback from the commit-detail panel. */
  onToast: (msg: string, kind?: 'success' | 'error') => void;
}

/** All Commits view: graph + selectable rows + right-side detail panel. */
export function Commits({ onCreateTag, onInteractiveRebase, onResetTo, onCreateWorktree, onToast }: CommitsProps) {
  const commits = useRepo((s) => s.commits);
  const meta = useRepo((s) => s.meta);
  const stashes = useRepo((s) => s.stashes);
  const refs = useRepo((s) => s.refs);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const selectCommit = useRepo((s) => s.selectCommit);
  const stashApply = useRepo((s) => s.stashApply);
  const stashPop = useRepo((s) => s.stashPop);
  const stashDrop = useRepo((s) => s.stashDrop);
  const checkoutCommit = useRepo((s) => s.checkoutCommit);
  const cherryPick = useRepo((s) => s.cherryPick);
  const revert = useRepo((s) => s.revert);
  // "Create fixup! commit" commits the staged set against a graph commit.
  // Boolean selector, not the array — the graph must not re-render on every
  // diff-content refresh just to gate one menu item.
  const hasStaged = useRepo((s) => s.stagedDiffs.length > 0);
  const commit = useRepo((s) => s.commit);
  const revealCommit = useRepo((s) => s.revealCommit);
  const clearReveal = useRepo((s) => s.clearReveal);
  // After a blame/history → commit jump, offer a way back to the file (at the
  // tab it was on). Lives inline in the toolbar so it doesn't add a second row.
  const fileReturn = useRepo((s) => s.fileReturn);
  const workFileReturn = useRepo((s) => s.workFileReturn);
  const setWorkFileReturn = useRepo((s) => s.setWorkFileReturn);
  const setActiveTab = useRepo((s) => s.setActiveTab);
  const returnToFile = useRepo((s) => s.returnToFile);
  // One-shot signal from the command palette's "Search commits…" action.
  const commitSearchFocus = useRepo((s) => s.commitSearchFocus);
  const commitSearchModeSignal = useRepo((s) => s.commitSearchMode);
  const clearCommitSearchFocus = useRepo((s) => s.clearCommitSearchFocus);
  // Review baseline — when pinned, the toolbar offers one-click selection of
  // every commit since it (the agent session), and the palette's "Select
  // commits since baseline" raises the matching one-shot signal.
  const baseline = useRepo((s) => s.baseline);
  const setBaseline = useRepo((s) => s.setBaseline);
  const selectSinceBaselineSignal = useRepo((s) => s.selectSinceBaseline);
  const clearSelectSinceBaseline = useRepo((s) => s.clearSelectSinceBaseline);
  const setView = useRepo((s) => s.setView);
  const selectFile = useRepo((s) => s.selectFile);
  // Full-history search (message / author / diff content): the backend reach
  // beyond the loaded window. Results live in the store so the detail panel can
  // render a surfaced commit that isn't a loaded graph row.
  const commitSearchResults = useRepo((s) => s.commitSearchResults);
  const searchLog = useRepo((s) => s.searchLog);

  const graphMainRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);
  const didInitialFocus = useRef(false);
  const [focusedCommit, setFocusedCommit] = useState<string | null>(null);
  // Multi-selection stays distinct from the detail-panel selection. The
  // anchor is the fixed end of a Shift range.
  const [multi, setMulti] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  // Right-click (or Menu / Shift+F10) on a commit row opens this — the same
  // actions as the detail panel, reachable straight from the graph.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [mainlineAction, setMainlineAction] = useState<{
    commit: Commit;
    operation: MainlineOperation;
  } | null>(null);
  const [compareCommits, setCompareCommits] = useState<Commit[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // The graph is newest→oldest; Git must receive a selected series in the
  // opposite direction so exported/cherry-picked commits retain dependency order.
  const bulkSelection = useMemo(
    () => selectedCommitsOldestFirst(commits, multi),
    [commits, multi],
  );

  const exportCommits = useCallback(
    async (selection: Commit[]) => {
      if (!meta || selection.length === 0 || bulkBusy) return;
      const destination = await pickCommitPatchDestination(
        meta.path,
        patchFileName(selection),
      );
      if (!destination) return;
      setBulkBusy(true);
      try {
        await tauri.repoCommitExportPatch(
          meta.path,
          selection.map((candidate) => candidate.hash),
          destination,
        );
        onToast(
          selection.length === 1
            ? `Exported patch for ${selection[0].short_hash}`
            : `Exported ${selection.length} commits as one patch series`,
        );
      } catch (caught) {
        onToast(`Patch export failed: ${errMessage(caught)}`, 'error');
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, meta, onToast],
  );

  const runBulkCherryPick = useCallback(
    async (selection: Commit[] = bulkSelection) => {
      if (bulkBusy || selection.length < 2) return;
      const merge = selection.find((candidate) => candidate.parents.length > 1);
      if (merge) {
        onToast(
          `Selection includes merge ${merge.short_hash} — apply merge commits individually so you can choose a mainline parent`,
          'error',
        );
        return;
      }
      setBulkBusy(true);
      try {
        const conflicted = await cherryPick(selection.map((candidate) => candidate.hash));
        onToast(
          conflicted
            ? `Cherry-pick of ${selection.length} commits has conflicts — resolve in Local Changes`
            : `Cherry-picked ${selection.length} commits in oldest-to-newest order`,
        );
      } catch (caught) {
        onToast(`Cherry-pick failed: ${errMessage(caught)}`, 'error');
      } finally {
        setBulkBusy(false);
      }
    },
    [bulkBusy, bulkSelection, cherryPick, onToast],
  );

  const openCommitMenu = useCallback(
    (c: Commit, x: number, y: number) => {
      const fail = (verb: string, e: unknown) =>
        onToast(`${verb} failed: ${errMessage(e)}`, 'error');
      const contextSelection = multi.has(c.hash) ? bulkSelection : [c];
      if (contextSelection.length > 1) {
        const count = contextSelection.length;
        const items: MenuItem[] = [
          {
            label: `Cherry-pick ${count} selected commits`,
            icon: 'arrow-down',
            disabled: bulkBusy,
            onSelect: () => void runBulkCherryPick(contextSelection),
          },
          {
            label: 'Compare selected commits',
            icon: 'compare',
            disabled: count !== 2 || bulkBusy,
            onSelect: () => setCompareCommits(contextSelection),
          },
          {
            label: `Export ${count} commits as patch…`,
            icon: 'external',
            disabled: bulkBusy,
            onSelect: () => void exportCommits(contextSelection),
          },
          {
            label: 'Copy selected commit metadata',
            icon: 'file',
            submenu: [
              {
                label: 'Copy SHAs',
                onSelect: () => {
                  copyToClipboard(contextSelection.map((candidate) => candidate.hash).join('\n'));
                  onToast(`Copied ${count} commit hashes`);
                },
              },
              {
                label: 'Copy subjects',
                onSelect: () => {
                  copyToClipboard(contextSelection.map((candidate) => candidate.subject).join('\n'));
                  onToast(`Copied ${count} commit subjects`);
                },
              },
              {
                label: 'Copy full messages',
                onSelect: () => {
                  copyToClipboard(contextSelection.map(commitMessage).join('\n\n---\n\n'));
                  onToast(`Copied ${count} commit messages`);
                },
              },
            ],
          },
        ];
        setMenu({ x, y, items });
        return;
      }
      const items: MenuItem[] = [
        {
          label: 'Checkout',
          icon: 'branch',
          onSelect: () => void (async () => {
            try { await checkoutCommit(c.hash); } catch (e) { fail('Checkout', e); }
          })(),
        },
        { label: 'Tag…', icon: 'tag', onSelect: () => onCreateTag(c.hash, c.short_hash) },
        {
          label: c.parents.length > 1 ? 'Cherry-pick merge…' : 'Cherry-pick',
          icon: 'arrow-down',
          onSelect: () => void (async () => {
            if (c.parents.length > 1) {
              setMainlineAction({ commit: c, operation: 'cherry-pick' });
              return;
            }
            try {
              const conflicted = await cherryPick([c.hash]);
              onToast(conflicted
                ? `Cherry-pick of ${c.short_hash} has conflicts — resolve in Local Changes`
                : `Cherry-picked ${c.short_hash}`);
            } catch (e) { fail('Cherry-pick', e); }
          })(),
        },
        {
          label: c.parents.length > 1 ? 'Revert merge…' : 'Revert',
          icon: 'history',
          onSelect: () => void (async () => {
            if (c.parents.length > 1) {
              setMainlineAction({ commit: c, operation: 'revert' });
              return;
            }
            try {
              const conflicted = await revert([c.hash]);
              onToast(conflicted
                ? `Revert of ${c.short_hash} has conflicts — resolve in Local Changes`
                : `Reverted ${c.short_hash}`);
            } catch (e) { fail('Revert', e); }
          })(),
        },
        {
          label: hasStaged
            ? 'Create fixup! commit'
            : 'Create fixup! commit (stage changes first)',
          icon: 'plus',
          disabled: !hasStaged,
          onSelect: () => void (async () => {
            try {
              await commit(`fixup! ${c.subject}`, null, false);
              onToast(`Fixup of ${c.short_hash} committed — run interactive rebase to fold it`);
            } catch (e) { fail('Fixup commit', e); }
          })(),
        },
        {
          label: 'Rebase from here…',
          icon: 'rebase',
          // Edit this commit and everything newer: base is its parent (or root
          // when it has none, so the commit itself is still editable).
          onSelect: () =>
            onInteractiveRebase(c.parents.length ? `${c.hash}^` : null, c.short_hash),
        },
        {
          label: `Reset ${meta && !meta.detached ? meta.branch : 'HEAD'} to here…`,
          icon: 'history',
          onSelect: () => onResetTo(c.hash, c.short_hash),
        },
        {
          // A task branch cut from this exact commit, in its own directory.
          label: 'New worktree from here…',
          icon: 'worktree',
          onSelect: () => onCreateWorktree({ ref: c.hash, label: c.short_hash }),
        },
        {
          // Pin the review baseline here and jump to the Review view — review
          // everything (commits + working tree) done since this commit.
          label: 'Review changes since this',
          icon: 'check',
          onSelect: () => void (async () => {
            try {
              await setBaseline(c.hash);
              setView('review');
              selectFile(null);
            } catch (e) { fail('Set baseline', e); }
          })(),
        },
        {
          label: 'Copy SHA',
          icon: 'file',
          onSelect: () => { copyToClipboard(c.hash); onToast('Copied commit hash'); },
        },
        {
          label: 'Copy subject',
          icon: 'file',
          onSelect: () => { copyToClipboard(c.subject); onToast('Copied commit subject'); },
        },
        {
          label: 'Copy body',
          icon: 'file',
          disabled: !c.body,
          onSelect: () => { copyToClipboard(c.body); onToast('Copied commit body'); },
        },
        {
          label: 'Export patch…',
          icon: 'external',
          disabled: bulkBusy,
          onSelect: () => void exportCommits([c]),
        },
      ];
      setMenu({ x, y, items });
    },
    [bulkBusy, bulkSelection, cherryPick, checkoutCommit, commit, exportCommits,
      hasStaged, meta, multi, onCreateTag, onCreateWorktree, onInteractiveRebase,
      onResetTo, onToast, revert, runBulkCherryPick, selectFile, setBaseline, setView],
  );

  // Clicking a stash node shows its changes (base→stash diff) in the detail
  // panel — it doesn't touch arrow-key focus or the multi-selection, which
  // stay over real commits only.
  const onStashClick = useCallback(
    (s: Stash) => void selectCommit(selectedCommit === s.oid ? null : s.oid),
    [selectCommit, selectedCommit],
  );

  // Right-click (or Menu / Shift+F10) on a stash node — the same actions the
  // sidebar Stashes section offers, reachable straight from the graph.
  const openStashMenu = useCallback(
    (s: Stash, x: number, y: number) => {
      // `removes` ops (pop / drop) take the stash off the stack; if it was the
      // one open in the detail panel, close the now-stale panel.
      const run = (verb: string, op: () => Promise<void>, removes: boolean) =>
        void (async () => {
          try {
            await op();
            onToast(`${verb} stash@{${s.index}}`);
            if (removes && selectedCommit === s.oid) void selectCommit(null);
          } catch (e) {
            onToast(`${verb} failed: ${errMessage(e)}`, 'error');
          }
        })();
      const items: MenuItem[] = [
        { label: 'Apply', icon: 'arrow-down', onSelect: () => run('Applied', () => stashApply(s.index), false) },
        { label: 'Pop', icon: 'stash', onSelect: () => run('Popped', () => stashPop(s.index), true) },
        {
          label: 'Drop',
          icon: 'trash',
          danger: true,
          confirm: true,
          onSelect: () => run('Dropped', () => stashDrop(s.index), true),
        },
        {
          label: 'Copy SHA',
          icon: 'file',
          onSelect: () => { void copyToClipboard(s.oid); onToast('Copied stash hash'); },
        },
      ];
      setMenu({ x, y, items });
    },
    [stashApply, stashPop, stashDrop, onToast, selectedCommit, selectCommit],
  );
  // Commit search. We highlight matches in place and step through them with
  // ‹/› rather than filtering the list — filtering would break the graph's
  // lane continuity (every parent must stay present; see lib/graph.ts). Search
  // covers the loaded log (message / author / hash), not full history.
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('message');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Full-history results dropdown state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [resultFocus, setResultFocus] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const focusedResultRef = useRef<HTMLDivElement>(null);

  // Inject stash nodes inline: each stash becomes a synthetic row right above
  // the commit it was taken on, so it visibly hangs off that point. The merged
  // list feeds both the graph layout and the row map so they stay index-aligned.
  // Navigation, multi-selection, and search still run over the real `commits`
  // (stash rows are mouse-reachable; their actions live in the right-click menu
  // and the sidebar Stashes section) — see mergeStashRows.
  const rows = useMemo(() => mergeStashRows(commits, stashes), [commits, stashes]);
  const graph = useMemo(() => computeGraph(rows), [rows]);

  // ── Virtualization ────────────────────────────────────────────────────
  // Only the viewport slice (plus overscan) renders; spacer rows keep the
  // scrollbar honest. 500 rows was fine un-virtualized, but "load more" /
  // full-history graphs aren't. Slices `rows` (commits + stash rows), which
  // is what the table body renders.
  const density = useSettings((s) => s.density);
  const showTimeline = useSettings((s) => s.showTimeline);
  const setSetting = useSettings((s) => s.set);
  const rowH = ROW_PX[density] ?? ROW_PX.default;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  useEffect(() => {
    const host = graphMainRef.current;
    if (!host) return;
    const onScroll = () => setScrollTop(host.scrollTop);
    const ro = new ResizeObserver(() => setViewH(host.clientHeight));
    setViewH(host.clientHeight);
    host.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(host);
    return () => {
      host.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);
  const firstRow = Math.max(0, Math.floor((scrollTop - HEADER_PX) / rowH) - OVERSCAN);
  const lastRow = Math.min(rows.length, Math.ceil((scrollTop - HEADER_PX + viewH) / rowH) + OVERSCAN);
  // Inclusive range of hashes between two commits, by their row order.
  const rangeBetween = useCallback(
    (a: string, b: string): string[] => {
      const ia = commits.findIndex((c) => c.hash === a);
      const ib = commits.findIndex((c) => c.hash === b);
      if (ia === -1 || ib === -1) return b ? [b] : [];
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
      return commits.slice(lo, hi + 1).map((c) => c.hash);
    },
    [commits],
  );
  // Timeline scrub target: scroll the list so row `idx` sits ~a quarter down
  // from the top (leaving a little newer context above). Drives the rail's
  // click/drag seek without touching focus or selection — it's pure navigation.
  const seekToRow = useCallback(
    (idx: number) => {
      const host = graphMainRef.current;
      if (!host) return;
      const top = HEADER_PX + idx * rowH;
      host.scrollTop = Math.max(0, top - host.clientHeight * 0.25);
    },
    [rowH],
  );
  const refsByOid = useMemo(() => indexRefs(refs), [refs]);
  const currentCommit = useMemo(() => currentCommitHash(refs, commits), [commits, refs]);
  const colWidth = graphColWidth(graph.laneCount);

  // Hashes of the commits since the review baseline (`baseline..HEAD` over
  // the loaded log) — the agent session's commits. Empty when no baseline.
  const sinceBaseline = useMemo(
    () => (baseline ? commitsSinceBaseline(commits, currentCommit, baseline.oid) : []),
    [commits, currentCommit, baseline],
  );

  // One-click "select the agent session": put `baseline..HEAD` in the
  // multi-selection (ready for bulk ops) and focus the newest commit.
  const applySinceBaseline = useCallback(() => {
    if (!baseline) return;
    if (sinceBaseline.length === 0) {
      onToast(`No commits since baseline ${baseline.short}`);
      return;
    }
    const newest = sinceBaseline[0]; // the walk starts at HEAD
    setMulti(new Set(sinceBaseline));
    setFocusedCommit(newest);
    anchorRef.current = newest;
    graphMainRef.current?.focus();
  }, [baseline, sinceBaseline, onToast]);

  // Hashes of commits matching the query, in row order. Empty when the query
  // is blank — no highlighting, full graph as usual.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as string[];
    return commits.filter((c) => commitMatches(c, q, searchMode)).map((c) => c.hash);
  }, [commits, query, searchMode]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  // Hashes in the loaded graph window — lets a search result mark whether
  // clicking it can scroll the graph or only open the detail panel.
  const loadedSet = useMemo(() => new Set(commits.map((c) => c.hash)), [commits]);
  // The "current" match is derived from the focused row, so the counter and
  // ‹/› stepping can't drift out of sync with a separate index.
  const matchPos = focusedCommit ? matches.indexOf(focusedCommit) : -1;

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      const cur = focusedCommit ? matches.indexOf(focusedCommit) : -1;
      const next =
        cur === -1
          ? dir === 1
            ? 0
            : matches.length - 1
          : (cur + dir + matches.length) % matches.length;
      // Focusing the row scrolls it into view via the existing effect; DOM
      // focus stays in the input so the user can keep typing / press Enter.
      setFocusedCommit(matches[next]);
    },
    [matches, focusedCommit],
  );

  const clearSearch = useCallback(() => {
    setQuery('');
    setSearchOpen(false);
    // Leave `commitSearchResults` in the store: they're invisible once the
    // dropdown is closed, keep any open detail panel valid (a panel may show an
    // out-of-window result), and reset on tab switch.
    searchInputRef.current?.focus();
  }, []);

  // Escalate to a backend full-history search. The loaded-window highlight
  // stays for instant feedback; this reaches commits past the window and — in
  // Content mode — searches the diffs the client never loads. Explicit (a
  // button / ⌘↵ / ↵ in Content), never per-keystroke: `git log -G` over full
  // history can be slow on a big repo.
  const runHistorySearch = useCallback(async () => {
    const q = query.trim();
    if (!q || searchMode === 'hash') return;
    setSearching(true);
    setSearchOpen(true);
    try {
      await searchLog(q, searchMode);
      setResultFocus(0);
    } catch (e) {
      onToast(`Search failed: ${errMessage(e)}`, 'error');
      setSearchOpen(false);
    } finally {
      setSearching(false);
      // The button click moves focus off the field; restore it so ↑/↓/↵ drive
      // the dropdown.
      searchInputRef.current?.focus();
    }
  }, [query, searchMode, searchLog, onToast]);

  // Open a search result: scroll + focus it in the graph when it's a loaded
  // row, and open the detail panel either way (its diff loads by oid, and the
  // store keeps the result so the panel can render an out-of-window commit).
  const openResult = useCallback(
    (c: Commit) => {
      setSearchOpen(false);
      if (loadedSet.has(c.hash)) {
        setFocusedCommit(c.hash);
        setMulti(new Set([c.hash]));
        anchorRef.current = c.hash;
        graphMainRef.current?.focus();
      }
      void selectCommit(c.hash);
    },
    [loadedSet, selectCommit],
  );

  const onSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // While the results dropdown is open, the arrow keys drive it.
      if (searchOpen && commitSearchResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setResultFocus((i) => Math.min(commitSearchResults.length - 1, i + 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setResultFocus((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const c = commitSearchResults[resultFocus];
          if (c) openResult(c);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setSearchOpen(false);
          return;
        }
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // ⌘↵ — or plain ↵ in Content mode, which has no in-window matches —
        // runs the full-history search; otherwise ↵ steps the loaded matches.
        if (e.metaKey || e.ctrlKey || searchMode === 'content') void runHistorySearch();
        else stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (query) clearSearch();
        else searchInputRef.current?.blur();
      }
    },
    [searchOpen, commitSearchResults, resultFocus, openResult, searchMode, runHistorySearch, stepMatch, query, clearSearch],
  );

  const openModeMenu = useCallback(
    (x: number, y: number) => {
      const opt = (m: SearchMode): MenuItem => ({
        label: MODE_LABEL[m],
        icon: searchMode === m ? 'check' : undefined,
        onSelect: () => {
          setSearchMode(m);
          // Old results belong to the previous field — close the dropdown so a
          // mode switch doesn't show stale hits until the next search.
          setSearchOpen(false);
          // ContextMenu restores focus to its opener (the mode button) on
          // close; defer past that so the field gets focus for typing.
          requestAnimationFrame(() => searchInputRef.current?.focus());
        },
      });
      setMenu({ x, y, items: [opt('message'), opt('author'), opt('hash'), opt('content')] });
    },
    [searchMode],
  );

  const onRowClick = (hash: string, e: React.MouseEvent) => {
    graphMainRef.current?.focus();
    setFocusedCommit(hash);
    if (e.metaKey || e.ctrlKey) {
      // Toggle membership; leave the detail panel untouched.
      setMulti((prev) => {
        const next = new Set(prev);
        if (next.has(hash)) next.delete(hash);
        else next.add(hash);
        return next;
      });
      anchorRef.current = hash;
      return;
    }
    if (e.shiftKey) {
      const anchor = anchorRef.current ?? focusedCommit ?? hash;
      setMulti(new Set(rangeBetween(anchor, hash)));
      return;
    }
    // Plain click: single-select + toggle the detail panel.
    setMulti(new Set([hash]));
    anchorRef.current = hash;
    void selectCommit(selectedCommit === hash ? null : hash);
  };

  const moveFocus = useCallback(
    (direction: 1 | -1, extend: boolean) => {
      if (commits.length === 0) return;

      const currentIndex = commits.findIndex((c) => c.hash === focusedCommit);
      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : commits.length - 1
          : Math.max(0, Math.min(commits.length - 1, currentIndex + direction));
      const nextHash = commits[nextIndex]?.hash;
      if (!nextHash || nextHash === focusedCommit) return;

      setFocusedCommit(nextHash);
      if (extend) {
        const anchor = anchorRef.current ?? focusedCommit ?? nextHash;
        setMulti(new Set(rangeBetween(anchor, nextHash)));
      } else {
        setMulti(new Set([nextHash]));
        anchorRef.current = nextHash;
        if (selectedCommit) void selectCommit(nextHash);
      }
    },
    [commits, focusedCommit, selectedCommit, selectCommit, rangeBetween],
  );

  const clearMulti = useCallback(() => {
    const keep = focusedCommit;
    setMulti(keep ? new Set([keep]) : new Set());
    anchorRef.current = keep;
  }, [focusedCommit]);

  const onGraphKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setMulti(new Set(commits.map((c) => c.hash)));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (focusedCommit) void selectCommit(focusedCommit);
        return;
      }
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        const c = commits.find((x) => x.hash === focusedCommit);
        const r = focusedRowRef.current?.getBoundingClientRect();
        if (c && r) {
          e.preventDefault();
          openCommitMenu(c, r.left + 24, r.bottom - 6);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (selectedCommit) {
          e.preventDefault();
          void selectCommit(null);
        } else if (multi.size > 1) {
          e.preventDefault();
          clearMulti();
        }
      }
    },
    [commits, focusedCommit, moveFocus, selectedCommit, selectCommit, multi, clearMulti, openCommitMenu],
  );

  useEffect(() => {
    if (didInitialFocus.current || !currentCommit) return;
    didInitialFocus.current = true;
    setFocusedCommit(currentCommit);
    setMulti(new Set([currentCommit]));
    anchorRef.current = currentCommit;
    graphMainRef.current?.focus();
    if (selectedCommit) void selectCommit(null);
  }, [currentCommit, selectedCommit, selectCommit]);

  // Prune the selection to commits that still exist after a log refresh
  // (e.g. a checkout swapped the visible history), and re-anchor focus if the
  // focused row vanished — otherwise the highlight, scroll, and the next
  // arrow press all lose their place.
  useEffect(() => {
    setMulti((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(commits.map((c) => c.hash));
      let changed = false;
      const next = new Set<string>();
      for (const h of prev) {
        if (present.has(h)) next.add(h);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (focusedCommit && !commits.some((c) => c.hash === focusedCommit)) {
      const fallback = currentCommit ?? commits[0]?.hash ?? null;
      setFocusedCommit(fallback);
      anchorRef.current = fallback;
    }
  }, [commits, focusedCommit, currentCommit]);

  // A single-click on a sidebar ref or stash asks the graph to scroll to and
  // highlight that row. Stash inspection also opens its detail panel; a stash
  // whose base is outside the loaded window can still be inspected even though
  // it has no visible graph row. Wait for the log to load before consuming so a
  // view switch (which renders an empty graph for a beat) doesn't drop it.
  useEffect(() => {
    if (!revealCommit || commits.length === 0) return;
    const visible = rows.some((c) => c.hash === revealCommit);
    if (visible) {
      setFocusedCommit(revealCommit);
      if (commits.some((c) => c.hash === revealCommit)) {
        setMulti(new Set([revealCommit]));
        anchorRef.current = revealCommit;
      }
      graphMainRef.current?.focus();
    }
    if (stashes.some((stash) => stash.oid === revealCommit)) {
      void selectCommit(revealCommit);
    }
    clearReveal();
  }, [revealCommit, commits, rows, stashes, selectCommit, clearReveal]);

  useEffect(() => {
    // With virtualization the focused row may not be mounted; fall back to
    // scrolling the container by index so reveal/search jumps still land.
    const el = focusedRowRef.current;
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (!focusedCommit) return;
    const host = graphMainRef.current;
    // Index into `rows` (commits + injected stash rows) — that's the visual
    // order the spacer math uses.
    const idx = rows.findIndex((c) => c.hash === focusedCommit);
    if (!host || idx === -1) return;
    const top = HEADER_PX + idx * rowH;
    if (top < host.scrollTop || top + rowH > host.scrollTop + host.clientHeight) {
      host.scrollTop = Math.max(0, top - host.clientHeight / 2);
    }
  }, [focusedCommit, rows, rowH]);

  // `/` focuses the search field (unless the user is typing somewhere else).
  // Scoped to this view: the listener only exists while the graph is mounted.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/') return;
      // `eventInside` sees through shadow DOM (Pierre's file-search box).
      if (eventInside(e, `${EDITABLE_SELECTOR}, [role="dialog"]`)) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close the results dropdown on an outside click. Escape is handled by the
  // input's own keydown (which also clears the query), so this watches the
  // pointer only.
  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!searchWrapRef.current?.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [searchOpen]);

  // Keep the keyboard-focused result scrolled into view in the dropdown.
  useEffect(() => {
    if (searchOpen) focusedResultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [resultFocus, searchOpen]);

  // The command palette's "Search commits…" sets a one-shot store flag; consume
  // it once the graph is mounted (handles the palette switching the view in).
  useEffect(() => {
    if (!commitSearchFocus) return;
    // "Search file contents…" carries a target field so it lands in Content mode.
    if (commitSearchModeSignal) setSearchMode(commitSearchModeSignal);
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
    clearCommitSearchFocus();
  }, [commitSearchFocus, commitSearchModeSignal, clearCommitSearchFocus]);

  // The palette's "Select commits since baseline" sets a one-shot store flag;
  // wait for the log to load before consuming so a view switch (which renders
  // an empty graph for a beat) doesn't apply it against nothing.
  useEffect(() => {
    if (!selectSinceBaselineSignal || commits.length === 0) return;
    applySinceBaseline();
    clearSelectSinceBaseline();
  }, [selectSinceBaselineSignal, commits, applySinceBaseline, clearSelectSinceBaseline]);

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        {fileReturn && (
          <button
            type="button"
            className="file-back-bar"
            onClick={() => returnToFile()}
            title={`Back to ${fileReturn}`}
          >
            <Icon name="chev-left" size={13} />
            <span>Back to {fileReturn.split(/[\\/]/).filter(Boolean).pop() ?? fileReturn}</span>
          </button>
        )}
        <div className="graph-toolbar-spacer" />
        {baseline && (
          <button
            type="button"
            className="since-baseline-btn"
            onClick={applySinceBaseline}
            title={`Select all commits since the review baseline (${baseline.short})`}
          >
            <Icon name="graph" size={13} />
            <span>Select since {baseline.short}</span>
          </button>
        )}
        {multi.size > 1 && (
          <div className="graph-bulk-actions">
            <button
              type="button"
              className="since-baseline-btn"
              disabled={bulkBusy}
              onClick={() => void runBulkCherryPick()}
              title="Cherry-pick selected commits onto the current branch, oldest first"
            >
              <Icon name="arrow-down" size={12} />
              <span>{bulkBusy ? 'Cherry-picking…' : 'Cherry-pick selected'}</span>
            </button>
            <button
              type="button"
              className="since-baseline-btn"
              disabled={multi.size !== 2 || bulkBusy}
              onClick={() => setCompareCommits(bulkSelection)}
              title={multi.size === 2 ? 'Compare the two selected commits' : 'Select exactly two commits to compare'}
            >
              <Icon name="compare" size={12} />
              <span>Compare</span>
            </button>
            <button
              type="button"
              className="since-baseline-btn"
              disabled={bulkBusy}
              onClick={() => void exportCommits(bulkSelection)}
              title="Export selected commits as one mbox-compatible patch series"
            >
              <Icon name="external" size={12} />
              <span>Export patches…</span>
            </button>
            <div className="graph-sel-count" role="status">
              <span>{multi.size} selected</span>
              <button type="button" className="clear" onClick={clearMulti} title="Clear selection">
                Clear
              </button>
            </div>
          </div>
        )}
        {!fileReturn && workFileReturn && (
          <button
            type="button"
            className="file-back-bar"
            onClick={() => {
              const target = workFileReturn;
              void setActiveTab(target.repoPath).then(() => {
                useWork.getState().activate(target.repoPath, target.tabId);
                setWorkFileReturn(null);
                setView('work');
              });
            }}
            title={`Back to ${workFileReturn.path}`}
          >
            <Icon name="chev-left" size={13} />
            <span>Back to {workFileReturn.path.split(/[\\/]/).filter(Boolean).pop() ?? workFileReturn.path}</span>
          </button>
        )}
        <button
          type="button"
          className={`timeline-toggle${showTimeline ? ' on' : ''}`}
          onClick={() => setSetting('showTimeline', !showTimeline)}
          aria-pressed={showTimeline}
          aria-label="Toggle activity timeline"
          title="Toggle activity timeline"
        >
          <Icon name="history" size={14} />
        </button>
        <div className="graph-search" role="search" ref={searchWrapRef}>
          <button
            type="button"
            className="search-mode"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openModeMenu(r.left, r.bottom + 4);
            }}
            aria-label={`Search field: ${MODE_LABEL[searchMode]}`}
            title="Choose search field"
          >
            {MODE_LABEL[searchMode]}
            <Icon name="chev-down" size={11} />
          </button>
          <Icon name="search" size={13} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Editing the query staled any open results — re-trigger to refresh.
              setSearchOpen(false);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder={
              searchMode === 'content'
                ? 'Search file contents — ↵'
                : `Search ${MODE_LABEL[searchMode].toLowerCase()}…`
            }
            aria-label={`Search commits by ${MODE_LABEL[searchMode].toLowerCase()}`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? 'commit-search-results' : undefined}
            aria-activedescendant={
              searchOpen && commitSearchResults[resultFocus]
                ? `csr-${commitSearchResults[resultFocus].hash}`
                : undefined
            }
          />
          {query && (
            <>
              {/* In-window highlight nav — meaningless for Content (no loaded
                  rows match), so it's hidden there. */}
              {searchMode !== 'content' && (
                <>
                  <span className="search-count" role="status" aria-live="polite">
                    {matches.length === 0
                      ? 'No results'
                      : matchPos >= 0
                        ? `${matchPos + 1}/${matches.length}`
                        : `${matches.length} found`}
                  </span>
                  <button
                    type="button"
                    className="search-nav"
                    onClick={() => stepMatch(-1)}
                    disabled={matches.length === 0}
                    aria-label="Previous match"
                    title="Previous match (⇧↵)"
                  >
                    <Icon name="chev-up" size={13} />
                  </button>
                  <button
                    type="button"
                    className="search-nav"
                    onClick={() => stepMatch(1)}
                    disabled={matches.length === 0}
                    aria-label="Next match"
                    title="Next match (↵)"
                  >
                    <Icon name="chev-down" size={13} />
                  </button>
                </>
              )}
              {/* Escalate to a backend full-history search. Hash stays
                  loaded-window only (no backend prefix search). */}
              {searchMode !== 'hash' && (
                <button
                  type="button"
                  className={`search-nav${searching ? ' busy' : ''}`}
                  onClick={() => void runHistorySearch()}
                  disabled={searching}
                  aria-label="Search all history"
                  title={
                    searchMode === 'content'
                      ? 'Search file contents across all history (↵)'
                      : 'Search all history (⌘↵)'
                  }
                >
                  <Icon name="history" size={13} />
                </button>
              )}
              <button
                type="button"
                className="search-clear"
                onClick={clearSearch}
                aria-label="Clear search"
                title="Clear search (Esc)"
              >
                <Icon name="x" size={12} />
              </button>
            </>
          )}
          {searchOpen && (
            <div
              className="search-results"
              role="listbox"
              id="commit-search-results"
              aria-label="Search results"
            >
              {searching && commitSearchResults.length === 0 ? (
                <div className="search-result empty">Searching all history…</div>
              ) : commitSearchResults.length === 0 ? (
                <div className="search-result empty">No matches in history.</div>
              ) : (
                commitSearchResults.map((c, i) => {
                  const inWindow = loadedSet.has(c.hash);
                  return (
                    <div
                      key={c.hash}
                      id={`csr-${c.hash}`}
                      ref={i === resultFocus ? focusedResultRef : undefined}
                      role="option"
                      aria-selected={i === resultFocus}
                      className={`search-result${i === resultFocus ? ' focused' : ''}`}
                      onMouseMove={() => setResultFocus(i)}
                      onClick={() => openResult(c)}
                    >
                      <span className="sr-subject" title={c.subject}>
                        {c.subject}
                      </span>
                      <span className="sr-meta">
                        {c.author_name ? <span className="sr-author">{c.author_name}</span> : null}
                        <span className="sr-hash">{c.short_hash}</span>
                        <span className="sr-date">{relativeDate(c.time_unix)}</span>
                        {!inWindow ? (
                          <span className="sr-out" title="Older than the loaded graph">
                            ·
                          </span>
                        ) : null}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
      <div className="graph-split">
        <PanelGroup direction="horizontal" autoSaveId="strand:commits-split">
          <Panel defaultSize={selectedCommit ? 62 : 100} minSize={40}>
            <div className="graph-pane">
            <div
              ref={graphMainRef}
              className="graph-main"
              tabIndex={0}
              role="grid"
              aria-multiselectable
              aria-label="Commit graph"
              aria-activedescendant={focusedCommit ? `commit-row-${focusedCommit}` : undefined}
              onKeyDown={onGraphKeyDown}
            >
              <table className="graph-table">
                <thead role="rowgroup">
                  <tr role="row">
                    <th role="columnheader" style={{ width: colWidth }}></th>
                    <th role="columnheader">Message</th>
                    <th role="columnheader" style={{ width: 160 }}>Author</th>
                    <th role="columnheader" style={{ width: 100 }}>Date</th>
                    <th role="columnheader" style={{ width: 80 }}>Hash</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {firstRow > 0 && (
                    <tr aria-hidden="true" style={{ height: firstRow * rowH }} />
                  )}
                  {rows.slice(firstRow, lastRow).map((c, sliceIdx) => {
                    const i = firstRow + sliceIdx;
                    const row = graph.rows[i];
                    const stash = c.stash;
                    const chips = stash ? undefined : refsByOid.get(c.hash);
                    const active = selectedCommit === c.hash;
                    const focused = focusedCommit === c.hash;
                    const selected = multi.has(c.hash);
                    const isMatch = matchSet.has(c.hash);
                    const agent = isAgentCommit(c);
                    return (
                      <tr
                        key={c.hash}
                        id={`commit-row-${c.hash}`}
                        role="row"
                        ref={focused ? focusedRowRef : undefined}
                        className={[
                          stash ? 'stash-row' : null,
                          active ? 'active' : null,
                          focused ? 'focused' : null,
                          selected ? 'selected' : null,
                          isMatch ? 'match' : null,
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined}
                        aria-selected={selected}
                        onClick={(e) => (stash ? onStashClick(stash) : onRowClick(c.hash, e))}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (stash) {
                            openStashMenu(stash, e.clientX, e.clientY);
                          } else {
                            setFocusedCommit(c.hash);
                            openCommitMenu(c, e.clientX, e.clientY);
                          }
                        }}
                      >
                        <td role="gridcell" className="graph-col" style={{ width: colWidth }}>
                          {row ? <CommitGraphCell row={row} laneCount={graph.laneCount} /> : null}
                        </td>
                        <td role="gridcell" className="msg">
                          {stash ? (
                            <span className="ref-chips">
                              <span className="ref-chip stash">stash@{`{${stash.index}}`}</span>
                            </span>
                          ) : chips && chips.length > 0 ? (
                            <span className="ref-chips">
                              {chips.map((chip) => (
                                <span
                                  key={chip.key}
                                  className={`ref-chip ${chip.kind}${chip.merged ? ' merged' : ''}`}
                                  title={chip.title}
                                >
                                  {chip.label}
                                  {chip.merged && <span className="ref-chip-merged" aria-label="merged">✓</span>}
                                </span>
                              ))}
                            </span>
                          ) : null}
                          {agent ? (
                            <span
                              className="ref-chip agent"
                              title="Co-authored by an AI coding agent"
                              aria-label="Co-authored by an AI coding agent"
                            >
                              ai
                            </span>
                          ) : null}
                          {row?.isMerge ? <span className="merge">⊕</span> : null}
                          <span className="msg-text">
                            {stash ? c.subject : highlight(c.subject, query, searchMode === 'message')}
                          </span>
                        </td>
                        <td role="gridcell" className="author">
                          {stash ? null : highlight(c.author_name, query, searchMode === 'author')}
                        </td>
                        <td role="gridcell" className="date">{relativeDate(c.time_unix)}</td>
                        <td role="gridcell" className="hash">
                          {stash ? c.short_hash : highlight(c.short_hash, query, searchMode === 'hash')}
                        </td>
                      </tr>
                    );
                  })}
                  {lastRow < rows.length && (
                    <tr aria-hidden="true" style={{ height: (rows.length - lastRow) * rowH }} />
                  )}
                </tbody>
              </table>
            </div>
            {showTimeline && (
              <CommitTimeline
                rows={rows}
                rowH={rowH}
                headerPx={HEADER_PX}
                scrollTop={scrollTop}
                viewH={viewH}
                onSeekToRow={seekToRow}
              />
            )}
            </div>
          </Panel>
          {selectedCommit ? (
            <>
              <PanelResizeHandle className="rs-handle vert" />
              <Panel defaultSize={38} minSize={25} maxSize={55}>
                <CommitDetail
                  onCreateTag={onCreateTag}
                  onInteractiveRebase={onInteractiveRebase}
                  onExportPatch={(candidate) => void exportCommits([candidate])}
                  onToast={onToast}
                />
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {mainlineAction && (
        <MainlineDialog
          commit={mainlineAction.commit}
          operation={mainlineAction.operation}
          onClose={() => setMainlineAction(null)}
          onToast={onToast}
        />
      )}
      {compareCommits && meta && compareCommits.length === 2 && (
        <CompareRefsDialog
          repoPath={meta.path}
          title="Compare selected commits"
          choices={compareCommits.map((candidate) => ({
            value: candidate.hash,
            label: `${candidate.short_hash} · ${candidate.subject}`,
          }))}
          initialFrom={compareCommits[0].hash}
          initialTo={compareCommits[1].hash}
          onClose={() => setCompareCommits(null)}
        />
      )}
    </div>
  );
}

function commitMessage(commit: Commit): string {
  return commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
}

function patchFileName(selection: Commit[]): string {
  if (selection.length > 1) {
    return `${selection.length}-commits-${selection[0].short_hash}-${selection[selection.length - 1].short_hash}.patch`;
  }
  const commit = selection[0];
  const slug = commit.subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${commit.short_hash}${slug ? `-${slug}` : ''}.patch`;
}

/**
 * Which field the commit search matches against. `message` / `author` / `hash`
 * highlight in place over the loaded window (client-side); `content` has no
 * client-side equivalent (the diffs aren't loaded) and is backend-only —
 * pressing ↵ runs the full-history `git log -G` pickaxe.
 */
type SearchMode = 'message' | 'author' | 'hash' | 'content';

const MODE_LABEL: Record<SearchMode, string> = {
  message: 'Message',
  author: 'Author',
  hash: 'Hash',
  content: 'Content',
};

/**
 * Does `c` match `q` (already trimmed + lowercased) under `mode`?
 *
 * Message matches the **subject only**, not the body: the body isn't shown in
 * the row (so a body-only hit looks like a phantom match), and it routinely
 * carries trailers like `Co-Authored-By:` / `Signed-off-by:` that turn a search
 * for a common substring ("auth") into a match on nearly every commit.
 */
function commitMatches(c: Commit, q: string, mode: SearchMode): boolean {
  switch (mode) {
    case 'message':
      return c.subject.toLowerCase().includes(q);
    case 'author':
      return c.author_name.toLowerCase().includes(q) || c.author_email.toLowerCase().includes(q);
    case 'hash':
      return c.hash.toLowerCase().startsWith(q);
    case 'content':
      // No client-side equivalent — content search runs against the backend.
      return false;
  }
}

/**
 * Accent-bold the first case-insensitive occurrence of `query` in `text` (the
 * same `.hl` convention the command palette uses). `enabled` is false for
 * columns the active search mode doesn't target, so only the searched field
 * lights up. Every match is against a visible field (subject / author / short
 * hash), so a matched row always shows where it hit.
 */
function highlight(text: string, query: string, enabled: boolean): ReactNode {
  const q = query.trim();
  if (!enabled || !q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="search-hl">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * Hashes of the commits since the review baseline: walk parents from HEAD
 * over the loaded log, stopping at (and excluding) the baseline commit —
 * the client-side view of `baseline..HEAD`. Commits below the loaded window
 * aren't walked (they aren't selectable rows anyway); if the baseline was
 * rebased away, the walk selects every loaded ancestor of HEAD, which is the
 * honest upper bound. First element is HEAD — the natural focus target.
 */
function commitsSinceBaseline(
  commits: Commit[],
  head: string | null,
  baselineOid: string,
): string[] {
  if (!head) return [];
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const out: string[] = [];
  const seen = new Set<string>([baselineOid]);
  const queue = [head];
  for (let i = 0; i < queue.length; i++) {
    const hash = queue[i];
    if (seen.has(hash)) continue;
    seen.add(hash);
    const c = byHash.get(hash);
    if (!c) continue; // beyond the loaded window
    out.push(hash);
    queue.push(...c.parents);
  }
  return out;
}

/** A graph row: a real commit, or a synthetic stash node (`stash` set). */
type Row = Commit & { stash?: Stash; isStash?: boolean };

/**
 * Splice stash nodes into the commit list. Each stash becomes a synthetic row
 * placed immediately above the commit it was taken on (its `base`), with that
 * base as its only parent — so the graph draws it hanging off that point, and
 * the topological invariant the lane algo needs (every parent below its child)
 * holds without re-sorting. Stashes whose base isn't in the loaded window are
 * dropped (they still show in the sidebar). Newest-first order is preserved, so
 * `stash@{0}` sits above `stash@{1}` when they share a base.
 */
function mergeStashRows(commits: Commit[], stashes: Stash[]): Row[] {
  if (stashes.length === 0) return commits;
  const byBase = new Map<string, Stash[]>();
  for (const s of stashes) {
    if (!s.base) continue;
    const arr = byBase.get(s.base);
    if (arr) arr.push(s);
    else byBase.set(s.base, [s]);
  }
  if (byBase.size === 0) return commits;
  const out: Row[] = [];
  for (const c of commits) {
    const here = byBase.get(c.hash);
    if (here) for (const s of here) out.push(stashRow(s));
    out.push(c);
  }
  return out;
}

function stashRow(s: Stash): Row {
  return {
    hash: s.oid,
    short_hash: s.oid.slice(0, 7),
    subject: s.message,
    body: '',
    author_name: '',
    author_email: '',
    time_unix: s.time_unix,
    parents: s.base ? [s.base] : [],
    isStash: true,
    stash: s,
  };
}

interface RefChip {
  key: string;
  label: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
  merged?: boolean;
  title?: string;
}

function indexRefs(refs: Refs): Map<string, RefChip[]> {
  const m = new Map<string, RefChip[]>();
  const push = (oid: string, chip: RefChip) => {
    const arr = m.get(oid);
    if (arr) arr.push(chip);
    else m.set(oid, [chip]);
  };
  for (const b of refs.branches) {
    push(b.target, {
      key: `b:${b.full_name}`,
      label: b.name,
      kind: b.is_head ? 'head' : 'local',
      merged: b.merged,
      title: b.merged
        ? `Merged into ${refs.primary_branch ?? 'the primary branch'}; safe to delete`
        : undefined,
    });
  }
  for (const rb of refs.remote_branches) {
    push(rb.target, {
      key: `rb:${rb.full_name}`,
      label: `${rb.remote}/${rb.branch}`,
      kind: 'remote',
    });
  }
  for (const t of refs.tags) {
    push(t.target, { key: `t:${t.full_name}`, label: t.name, kind: 'tag' });
  }
  return m;
}

function currentCommitHash(refs: Refs, commits: { hash: string }[]): string | null {
  const head = refs.branches.find((b) => b.is_head)?.target;
  if (head && commits.some((c) => c.hash === head)) return head;
  return commits[0]?.hash ?? null;
}

function relativeDate(unix: number): string {
  const delta = Date.now() / 1000 - unix;
  if (delta < 60) return `${Math.round(delta)}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  return `${Math.round(delta / 86400)}d`;
}
