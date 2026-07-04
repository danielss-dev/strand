import { create } from 'zustand';

import { reviewSession, type StoredBaseline } from '../lib/db';
import { pathKey, repoFamilyName, tabWorktreeName } from '../lib/repoIdentity';
import { errMessage, tauri } from '../lib/tauri';
import type { FileDiff, ReviewNote } from '../lib/types';
import {
  activeWorkspaceMembers,
  type MemberResolution,
  type QueueEntry,
} from '../lib/workspaceReview';
import { makeReviewNote, useRepo } from './repo';
import { DEFAULT_WORKSPACE_ID, useWorkspaces } from './workspaces';

/**
 * The aggregated workspace review (Workspaces Phase 2): one review pool per
 * member repo of the active workspace — plus one per **open linked worktree**
 * of a member (Phase 3 "per-worktree members": a worktree is its own working
 * tree, so it reviews as its own slice) — fanned out over the same
 * path-parameterized diff IPC the single-repo Review uses. No Rust changes.
 *
 * Each member reviews in its own mode, exactly like its single-repo Review
 * would: **session** when that repo has a persisted baseline (`diff_since_full`
 * — committed + staged + unstaged since the pin) or **inbox** otherwise
 * (`diff_unstaged_full`). Reviewed marks are read from and written to the same
 * per-repo `reviewSession` records, so a checkmark set here is set in that
 * repo's own Review view too — one review state, two lenses.
 *
 * The single-repo engine in `repo.ts` stays untouched; the only coupling is
 * (a) preferring its in-memory `reviewed` map for the active repo (persistence
 * is async, the memory copy is newer) and (b) mirroring mark/stage/discard
 * effects back into it when the member *is* the active repo.
 */
export interface MemberReview {
  /** Resolved repo path — see {@link MemberResolution.path}. */
  path: string;
  /** Stable repo-family display name. */
  name: string;
  /** Worktree label when this slice is an open linked worktree of a member
   * repo (it reviews as its own section), `null` for the member repo itself. */
  worktree: string | null;
  /** Checked-out branch label, or `null` until meta resolves. */
  branch: string | null;
  /** Shared git dir — keys the section's stable group color. */
  commonDir: string | null;
  /** This repo's pinned review baseline (session mode), or `null` (inbox). */
  baseline: StoredBaseline | null;
  /** Whole-file-context pool: everything to review in this repo. */
  diffs: FileDiff[];
  /**
   * The repo's *unstaged* set (path + rename source) — the pool subset that
   * file-level Stage / Discard applies to. In inbox mode this mirrors `diffs`;
   * in session mode it's a separate cheap `diff_unstaged` fetch.
   */
  unstaged: { path: string; old_path: string | null }[];
  /** Reviewed marks (`path → reviewed diff hash`), shared with the repo's own
   * Review session persistence. */
  reviewed: Record<string, string>;
  /** Reviewer notes (`path → notes`), shared with the repo's own Review
   * session persistence — feed for the repo-grouped feedback export. */
  notes: Record<string, ReviewNote[]>;
  loading: boolean;
  /** Human-readable fetch failure for this member, or `null`. */
  error: string | null;
}

interface WorkspaceReviewState {
  /** True while the Workspace Review view is on screen — gates live-follow. */
  active: boolean;
  /** Member slices in workspace membership order. */
  members: MemberReview[];
  /** The file the diff pane shows, or `null` (view auto-selects). */
  selection: QueueEntry | null;
  /** Bumped on every member data refresh — remount/refetch key for children
   * that can't observe array identity (image blobs). */
  tick: number;

  setActive(on: boolean): void;
  select(sel: QueueEntry | null): void;
  /** Re-resolve the active workspace's members and refresh every slice. */
  refreshAll(): Promise<void>;
  /** Refresh one member's slice (watcher-driven, and the write-op tail). */
  refreshMember(path: string): Promise<void>;
  /**
   * `repo://changed` entry point for live-follow: while the view is active,
   * refresh the matching member — including background members whose events
   * the single-repo store ignores. No-op otherwise.
   */
  handleExternalChange(path: string): void;
  /** Toggle a file's reviewed mark within a member (same semantics as the
   * single-repo Review; persists to that repo's review session). */
  toggleReviewed(repoPath: string, file: string, hash: string): void;
  /** Attach a note to a member's file (`line` = anchor line, null = whole
   * file; `side` = which diff side the line counts on, default `'new'`).
   * Empty text is ignored. Persists to that repo's review session. */
  addNote(
    repoPath: string,
    file: string,
    text: string,
    line: number | null,
    side?: 'new' | 'old',
  ): void;
  /** Remove one note from a member's file by id. */
  removeNote(repoPath: string, file: string, id: string): void;
  /** Stage files in a member repo (rename-aware), then refresh its slice. */
  stageFiles(repoPath: string, files: string[]): Promise<void>;
  /** Discard files in a member repo, then refresh its slice. Destructive —
   * callers confirm first (matches `discardMany`: no automatic safety stash). */
  discardFiles(repoPath: string, files: string[]): Promise<void>;
  /**
   * Apply one sliced change block in a member repo (hunk-level Stage /
   * Discard from the aggregated view — inbox-mode diffs only), then refresh
   * its slice. A discard (`workdir_reverse`) records the global single-undo
   * handle pinned to the member's path, so the Undo toast recovers it even
   * while another repo is the active tab.
   */
  applyBlock(
    repoPath: string,
    slice: string,
    target: 'index' | 'index_reverse' | 'workdir_reverse',
    discardLabel: string,
  ): Promise<void>;
}

/** Stale-response guard: bumped on every {@link WorkspaceReviewState.refreshAll}. */
let generation = 0;

/** The active workspace's members resolved against the current tab set. */
function resolveMembers(): MemberResolution[] {
  const { workspaces, activeWorkspaceId } = useWorkspaces.getState();
  return activeWorkspaceMembers(
    workspaces,
    activeWorkspaceId,
    useRepo.getState().tabs,
    DEFAULT_WORKSPACE_ID,
  );
}

/** True when `repoPath` is the single-repo store's active tab. */
function isActiveRepo(repoPath: string): boolean {
  const active = useRepo.getState().activePath;
  return active != null && pathKey(active) === pathKey(repoPath);
}

export const useWorkspaceReview = create<WorkspaceReviewState>((set, get) => {
  /** Patch one member slice in place (matched by path key). */
  const patchMember = (repoPath: string, patch: Partial<MemberReview>) => {
    const key = pathKey(repoPath);
    set((s) => ({
      members: s.members.map((m) => (pathKey(m.path) === key ? { ...m, ...patch } : m)),
      tick: s.tick + 1,
    }));
  };

  /**
   * Fetch one member's data and patch it into the slice. `gen` pins the
   * refresh generation — a fan-out superseded by a newer `refreshAll` drops
   * its results instead of racing them into the fresh member list.
   */
  const loadMember = async (res: MemberResolution, gen: number): Promise<void> => {
    const { path } = res;
    // Always read fresh meta — a background member's tab meta is frozen at
    // open time, so its branch label would lie after an agent checkout. The
    // tab meta is only the fallback when the read fails (repo moved/deleted:
    // fall through to the diff error), and the IPC is path-parameterized so
    // a member that isn't open at all still resolves.
    let meta = res.meta;
    try {
      meta = await tauri.repoMeta(path);
    } catch (e) {
      if (!meta) {
        if (gen !== generation) return;
        patchMember(path, { loading: false, error: errMessage(e) });
        return;
      }
    }

    const baseline = await reviewSession.getBaseline(path).catch(() => null);
    let diffs: FileDiff[] = [];
    let unstaged: { path: string; old_path: string | null }[] = [];
    let error: string | null = null;
    try {
      if (baseline) {
        const [since, unstagedDiffs] = await Promise.all([
          tauri.repoDiffSinceFull(path, baseline.oid),
          tauri.repoDiffUnstaged(path),
        ]);
        diffs = since;
        unstaged = unstagedDiffs.map((d) => ({ path: d.path, old_path: d.old_path }));
      } else {
        diffs = await tauri.repoDiffUnstagedFull(path);
        unstaged = diffs.map((d) => ({ path: d.path, old_path: d.old_path }));
      }
    } catch (e) {
      // Typical session-mode cause: the baseline commit was rebased/gc'd away.
      // Surface per-member instead of failing the whole aggregation.
      error = errMessage(e);
    }

    // Prefer the single-repo store's in-memory marks + notes for the active
    // repo — its persistence is fire-and-forget, so the DB read can be a
    // beat stale.
    const repoState = useRepo.getState();
    const active = isActiveRepo(path);
    const reviewed = active
      ? repoState.reviewed
      : ((await reviewSession.getReviewed(path).catch(() => null)) ?? {});
    const notes = active
      ? repoState.reviewNotes
      : ((await reviewSession.getNotes(path).catch(() => null)) ?? {});

    if (gen !== generation) return;
    patchMember(path, {
      name: repoFamilyName(meta),
      // Re-derive from fresh meta: an agent checkout in the worktree moves
      // its branch-derived label just like it moves `branch`.
      worktree: meta.is_linked_worktree ? tabWorktreeName(meta) : null,
      branch: meta.detached ? `${meta.branch} (detached)` : meta.branch,
      commonDir: meta.common_dir,
      baseline,
      diffs,
      unstaged,
      reviewed,
      notes,
      loading: false,
      error,
    });
  };

  return {
    active: false,
    members: [],
    selection: null,
    tick: 0,

    setActive: (active) => set({ active }),
    select: (selection) => set({ selection }),

    async refreshAll() {
      const gen = ++generation;
      const resolved = resolveMembers();
      // Seed the next member list immediately (so the view lays out its
      // sections), carrying over the previous slice's data where the member
      // survives — a refresh repaints in place instead of flashing empty.
      const prev = new Map(get().members.map((m) => [pathKey(m.path), m]));
      set({
        members: resolved.map((r) => {
          const old = prev.get(pathKey(r.path));
          return {
            path: r.path,
            name: old?.name ?? repoFamilyName(r.meta),
            worktree: r.worktree,
            branch: old?.branch ?? r.meta?.branch ?? null,
            commonDir: old?.commonDir ?? r.meta?.common_dir ?? null,
            baseline: old?.baseline ?? null,
            diffs: old?.diffs ?? [],
            unstaged: old?.unstaged ?? [],
            reviewed: old?.reviewed ?? {},
            notes: old?.notes ?? {},
            loading: true,
            error: null,
          };
        }),
      });
      await Promise.all(resolved.map((r) => loadMember(r, gen)));
    },

    async refreshMember(path) {
      const key = pathKey(path);
      const member = get().members.find((m) => pathKey(m.path) === key);
      if (!member) return;
      patchMember(path, { loading: true });
      const tab = useRepo.getState().tabs.find((t) => pathKey(t.path) === key);
      await loadMember(
        { path: member.path, meta: tab?.meta ?? null, worktree: member.worktree },
        generation,
      );
    },

    handleExternalChange(path) {
      if (!get().active) return;
      const key = pathKey(path);
      if (!get().members.some((m) => pathKey(m.path) === key)) return;
      void get().refreshMember(path);
    },

    toggleReviewed(repoPath, file, hash) {
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member) return;
      const next = { ...member.reviewed };
      // Marked with a matching hash → unmark; anything else → (re)mark at the
      // current hash (covers both "not reviewed" and "stale review").
      if (next[file] === hash) delete next[file];
      else next[file] = hash;
      patchMember(repoPath, { reviewed: next });
      // One source of truth per repo: persist once here, and mirror the map
      // into the single-repo store when this member is the active tab so its
      // Review view shows the same marks without a reload.
      if (isActiveRepo(repoPath)) useRepo.setState({ reviewed: next });
      void reviewSession
        .setReviewed(member.path, next)
        .catch((e) => console.warn('workspace review: reviewed persist failed', e));
    },

    addNote(repoPath, file, text, line, side) {
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      const note = makeReviewNote(text, line, side);
      if (!member || !note) return;
      const next = { ...member.notes, [file]: [...(member.notes[file] ?? []), note] };
      persistNotes(patchMember, member, next);
    },

    removeNote(repoPath, file, id) {
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member || !member.notes[file]) return;
      const remaining = member.notes[file].filter((n) => n.id !== id);
      const next = { ...member.notes };
      if (remaining.length === 0) delete next[file];
      else next[file] = remaining;
      persistNotes(patchMember, member, next);
    },

    async stageFiles(repoPath, files) {
      if (files.length === 0) return;
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member) return;
      // A renamed file's diff carries old_path; stage both halves so the
      // rename lands atomically (mirrors the single-repo stageMany).
      const expand = new Set(files);
      for (const d of member.unstaged) {
        if (d.old_path && expand.has(d.path)) expand.add(d.old_path);
      }
      await tauri.repoStageMany(member.path, [...expand]);
      await afterWrite(get, member.path);
    },

    async discardFiles(repoPath, files) {
      if (files.length === 0) return;
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member) return;
      await tauri.repoDiscardMany(member.path, files);
      await afterWrite(get, member.path);
    },

    async applyBlock(repoPath, slice, target, discardLabel) {
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member) return;
      await tauri.repoApplyPatch(member.path, slice, target);
      // Mirror the single-repo discardPatch: stash the exact slice so
      // undoDiscard can forward-apply it back into this member repo.
      if (target === 'workdir_reverse') {
        useRepo.setState({ lastDiscard: { patch: slice, label: discardLabel, path: member.path } });
      }
      await afterWrite(get, member.path);
    },
  };
});

/** Note-write tail (add/remove): patch the slice, mirror the map into the
 * single-repo store when the member is the active tab (one review state, two
 * lenses), and persist to that repo's review session. */
function persistNotes(
  patchMember: (repoPath: string, patch: Partial<MemberReview>) => void,
  member: MemberReview,
  next: Record<string, ReviewNote[]>,
): void {
  patchMember(member.path, { notes: next });
  if (isActiveRepo(member.path)) useRepo.setState({ reviewNotes: next });
  void reviewSession
    .setNotes(member.path, next)
    .catch((e) => console.warn('workspace review: notes persist failed', e));
}

/** Write-op tail: refresh the touched member, and when it's the active repo
 * also run the single-repo refresh so Local Changes / topbar stay in sync. */
async function afterWrite(get: () => WorkspaceReviewState, repoPath: string): Promise<void> {
  const jobs: Promise<void>[] = [get().refreshMember(repoPath)];
  if (isActiveRepo(repoPath)) jobs.push(useRepo.getState().refreshLocalChanges());
  await Promise.all(jobs);
}
