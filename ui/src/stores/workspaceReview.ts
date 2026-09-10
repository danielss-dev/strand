import { create } from 'zustand';
import { backgroundRead } from '../lib/backgroundReads';
import { RefreshQueue } from '../lib/refreshQueue';
import { stableRows } from '../lib/stable';
import { diffLoaded, diffReviewable, mergeDiffSummaries, readDiffPages } from '../lib/diffPages';

import { reviewSession, type StoredBaseline } from '../lib/db';
import { pathKey, repoFamilyName, tabWorktreeName } from '../lib/repoIdentity';
import { reviewNoteScope } from '../lib/reviewExport';
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
 * (`diff_since_full("HEAD")` — staged + unstaged). Reviewed marks are read from and written to the same
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
   * file-level Stage / Discard applies to. Always fetched separately from
   * the combined review pool so historical rename paths cannot become targets.
   */
  unstaged: { path: string; old_path: string | null }[];
  /** Current staged paths: combined inbox patches for these are not safe hunks. */
  staged: string[];
  /** Reviewed marks (`path → reviewed diff hash`), shared with the repo's own
   * Review session persistence. */
  reviewed: Record<string, string>;
  /** Reviewer notes (`path → notes`), shared with the repo's own Review
   * session persistence — feed for the repo-grouped feedback export. */
  notes: Record<string, ReviewNote[]>;
  /** Comparison identity used to keep notes out of unrelated baselines/refs. */
  noteScope: string;
  loading: boolean;
  /** Human-readable fetch failure for this member, or `null`. */
  error: string | null;
}

/** Combined review hunks are index patches only when neither side is staged. */
export function workspaceHunkActionsAllowed(member: MemberReview, file: string): boolean {
  if (member.error || member.baseline) return false;
  const unstaged = member.unstaged.find((diff) => diff.path === file);
  if (!unstaged) return false;
  const diff = member.diffs.find((diff) => diff.path === file);
  if (!diff || !diffLoaded(diff)) return false;
  return !member.staged.some((path) => path === file || path === unstaged.old_path || path === diff?.old_path);
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
  summaryTick: number;

  setActive(on: boolean): void;
  select(sel: QueueEntry | null): void;
  /** Re-resolve the active workspace's members and refresh every slice. */
  refreshAll(): Promise<void>;
  /** Refresh one member's slice (watcher-driven, and the write-op tail). */
  refreshMember(path: string): Promise<void>;
  loadFiles(repoPath: string, files: string[]): Promise<FileDiff[]>;
  ensureAllFiles(): Promise<void>;
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
    sourcePatch?: string,
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
    file: string,
    slice: string,
    target: 'index' | 'index_reverse' | 'workdir_reverse',
    discardLabel: string,
  ): Promise<void>;
}

/** Stale-response guard: bumped on every {@link WorkspaceReviewState.refreshAll}. */
let generation = 0;
const memberRefreshes = new RefreshQueue();
const memberGenerations = new Map<string, number>();

/**
 * Member paths whose discovery failed — the directory is gone (deleted,
 * moved, or no longer a repository), so there is nothing to review. Their
 * slices are dropped instead of rendering a dead error section, and
 * {@link WorkspaceReviewState.refreshAll} revalidates them so a path that
 * comes back rejoins the review.
 */
const missing = new Map<string, string>();

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
  const readMember = async (res: MemberResolution, gen: number, current: () => boolean): Promise<void> => {
    const { path } = res;
    if (gen !== generation || !current()) return;
    const memberKey = pathKey(path);
    memberGenerations.set(memberKey, (memberGenerations.get(memberKey) ?? 0) + 1);
    // Always read fresh meta — a background member's tab meta is frozen at
    // open time, so its branch label would lie after an agent checkout. A
    // failed read means the directory is gone (dropped below); the IPC is
    // path-parameterized so a member that isn't open at all still resolves.
    let meta = res.meta;
    try {
      meta = await tauri.repoMeta(path);
    } catch {
      // Discovery failed: the member's directory is gone, so even a stale
      // tab meta has nothing behind it to review. Drop the slice (and
      // remember the path so refreshes skip it) rather than rendering a
      // dead error section.
      if (gen !== generation || !current()) return;
      missing.set(pathKey(path), path);
      const key = pathKey(path);
      set((s) => ({
        members: s.members.filter((m) => pathKey(m.path) !== key),
        tick: s.tick + 1,
      }));
      return;
    }

    let baseline: StoredBaseline | null;
    try {
      baseline = (await reviewSession.getBaseline(path)) ?? null;
    } catch (error) {
      if (gen === generation && current()) patchMember(path, { loading: false, error: errMessage(error) });
      return;
    }
    if (gen !== generation || !current()) return;
    let diffs: FileDiff[] = [];
    let unstaged: { path: string; old_path: string | null }[] = [];
    let staged: string[] = [];
    try {
      const [since, paths, status] = await Promise.all([
        tauri.repoDiffSummary(path, { kind: 'review', baseline: baseline?.oid ?? 'HEAD' }),
        tauri.repoDiffUnstagedPaths(path),
        baseline ? Promise.resolve([]) : tauri.repoStatus(path),
      ]);
      const previous = get().members.find((member) => pathKey(member.path) === memberKey);
      diffs = mergeDiffSummaries(previous?.diffs ?? [], since);
      unstaged = paths;
      staged = status.filter((entry) => entry.staged).map((entry) => entry.path);
    } catch (e) {
      // Keep the last successful comparison, notes scope, and mutation
      // metadata together. A failed read must not erase work from the queue.
      if (gen === generation && current()) patchMember(path, { loading: false, error: errMessage(e) });
      return;
    }

    // Prefer the single-repo store's in-memory marks + notes for the active
    // repo — its persistence is fire-and-forget, so the DB read can be a
    // beat stale.
    const noteScope = reviewNoteScope({
      baselineOid: baseline?.oid ?? null,
      branch: meta.branch,
      detached: meta.detached,
      headOid: meta.head_oid,
    });
    const repoState = useRepo.getState();
    const active = isActiveRepo(path);
    const activeScope = repoState.meta
      ? reviewNoteScope({
          baselineOid: repoState.baseline?.oid ?? null,
          branch: repoState.meta.branch,
          detached: repoState.meta.detached,
          headOid: repoState.meta.head_oid,
        })
      : null;
    const reviewed = active
      ? repoState.reviewed
      : ((await reviewSession.getReviewed(path).catch(() => null)) ?? {});
    const notes = active && activeScope === noteScope
      ? repoState.reviewNotes
      : ((await reviewSession.getNotes(path, noteScope).catch(() => null)) ?? {});

    if (gen !== generation || !current()) return;
    const previous = get().members.find((member) => pathKey(member.path) === pathKey(path));
    patchMember(path, {
      name: repoFamilyName(meta),
      // Re-derive from fresh meta: an agent checkout in the worktree moves
      // its branch-derived label just like it moves `branch`.
      worktree: meta.is_linked_worktree ? tabWorktreeName(meta) : null,
      branch: meta.detached ? `${meta.branch} (detached)` : meta.branch,
      commonDir: meta.common_dir,
      baseline,
      diffs: stableRows(previous?.diffs ?? [], diffs, (diff) => diff.path),
      unstaged,
      staged,
      reviewed,
      notes,
      noteScope,
      loading: false,
      error: null,
    });
    set((state) => ({ summaryTick: state.summaryTick + 1 }));
  };

  const loadMember = (res: MemberResolution, gen: number) => memberRefreshes.run(
    pathKey(res.path),
    (current) => backgroundRead(() => readMember(res, gen, current)),
  );

  return {
    active: false,
    members: [],
    selection: null,
    tick: 0,
    summaryTick: 0,

    setActive: (active) => {
      if (!active) generation++;
      set({ active });
    },
    select: (selection) => set({ selection }),

    async refreshAll() {
      const gen = ++generation;
      let resolved = resolveMembers();
      // Revalidate previously-vanished member paths (cheap discovers): one
      // that resolves again leaves the cache and rejoins the review; the
      // rest stay out of the seeded list entirely.
      if (missing.size > 0) {
        await Promise.all(
          [...missing].map(([key, path]) => backgroundRead(async () => {
            if (gen !== generation) return;
            try {
              await tauri.repoMeta(path);
              missing.delete(key);
            } catch {
              // still gone
            }
          })),
        );
        resolved = resolved.filter((r) => !missing.has(pathKey(r.path)));
      }
      if (gen !== generation) return;
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
            staged: old?.staged ?? [],
            reviewed: old?.reviewed ?? {},
            notes: old?.notes ?? {},
            noteScope: old?.noteScope ?? '',
            loading: true,
            error: old?.error ?? null,
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

    async loadFiles(repoPath, files) {
      const key = pathKey(repoPath);
      let member = get().members.find((member) => pathKey(member.path) === key);
      if (member?.loading) {
        await get().refreshMember(repoPath);
        member = get().members.find((member) => pathKey(member.path) === key);
        if (member?.loading) throw new Error('The workspace comparison changed while loading patches. Retry the action.');
      }
      if (!member) return [];
      if (member.error) throw new Error(member.error);
      const gen = generation;
      const revision = memberGenerations.get(key) ?? 0;
      const valid = () => generation === gen && (memberGenerations.get(key) ?? 0) === revision;
      const wanted = new Set(files);
      const missing = member.diffs.filter((diff) => wanted.has(diff.path) && !diffLoaded(diff)).map((diff) => diff.path);
      try {
        await readDiffPages(member.path, { kind: 'review', baseline: member.baseline?.oid ?? 'HEAD' }, missing, true, revision, (page) => {
          if (!valid()) throw new Error('The workspace comparison changed while loading patches. Retry the action.');
          const current = get().members.find((member) => pathKey(member.path) === key);
          if (!current) return;
          const loaded = new Map(page.map((diff) => [diff.path, diff]));
          patchMember(member.path, { diffs: current.diffs.map((diff) => loaded.get(diff.path) ?? diff) });
        });
      } catch (error) {
        if (valid()) {
          const current = get().members.find((member) => pathKey(member.path) === key);
          if (current) patchMember(member.path, {
            error: errMessage(error),
            diffs: current.diffs.map((diff) => wanted.has(diff.path) && !diffLoaded(diff) ? { ...diff, patchError: errMessage(error) } : diff),
          });
        }
        throw error;
      }
      if (!valid()) throw new Error('The workspace comparison changed while loading patches. Retry the action.');
      return get().members.find((member) => pathKey(member.path) === key)?.diffs.filter((diff) => wanted.has(diff.path)) ?? [];
    },

    async ensureAllFiles() {
      const gen = generation;
      for (const member of get().members) {
        await get().loadFiles(member.path, member.diffs.map((diff) => diff.path));
        const current = get().members.find((row) => pathKey(row.path) === pathKey(member.path));
        if (current?.error) throw new Error(current.error);
      }
      if (gen !== generation || get().members.some((member) => member.diffs.some((diff) => !diffLoaded(diff)))) {
        throw new Error('The workspace comparison changed while loading patches. Retry the action.');
      }
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
      const diff = member.diffs.find((diff) => diff.path === file);
      if (!diff || !diffReviewable(diff)) return;
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

    addNote(repoPath, file, text, line, side, sourcePatch) {
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      const diff = member?.diffs.find((diff) => diff.path === file);
      if (line != null && sourcePatch === undefined && diff && !diffLoaded(diff)) return;
      const note = makeReviewNote(text, line, side, sourcePatch ?? (diff && diffLoaded(diff) ? diff.patch : undefined));
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
      if (member.error) throw new Error('Refresh this review before staging changes.');
      const targets = new Set(member.unstaged.map((diff) => diff.path));
      // A renamed file's diff carries old_path; stage both halves so the
      // rename lands atomically (mirrors the single-repo stageMany).
      const expand = new Set(files.filter((file) => targets.has(file)));
      for (const d of member.unstaged) {
        if (d.old_path && expand.has(d.path)) expand.add(d.old_path);
      }
      if (expand.size === 0) return;
      await tauri.repoStageMany(member.path, [...expand]);
      await afterWrite(get, member.path);
    },

    async discardFiles(repoPath, files) {
      if (files.length === 0) return;
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member) return;
      if (member.error) throw new Error('Refresh this review before discarding changes.');
      const targets = files.filter((file) => member.unstaged.some((diff) => diff.path === file));
      if (targets.length === 0) return;
      await tauri.repoDiscardMany(member.path, targets);
      await afterWrite(get, member.path);
    },

    async applyBlock(repoPath, file, slice, target, discardLabel) {
      const member = get().members.find((m) => pathKey(m.path) === pathKey(repoPath));
      if (!member) return;
      if (!workspaceHunkActionsAllowed(member, file)) {
        throw new Error('This comparison is not an unstaged patch. Refresh or use Local Changes for hunk actions.');
      }
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
  if (isActiveRepo(member.path) && activeRepoNoteScope() === member.noteScope) {
    useRepo.setState({ reviewNotes: next });
  }
  void reviewSession
    .setNotes(member.path, next, member.noteScope)
    .catch((e) => console.warn('workspace review: notes persist failed', e));
}

/** Scope currently shown by the single-repo Review lens, when available. */
function activeRepoNoteScope(): string | null {
  const state = useRepo.getState();
  if (!state.meta) return null;
  return reviewNoteScope({
    baselineOid: state.baseline?.oid ?? null,
    branch: state.meta.branch,
    detached: state.meta.detached,
    headOid: state.meta.head_oid,
  });
}

/** Write-op tail: refresh the touched member, and when it's the active repo
 * also run the single-repo refresh so Local Changes / topbar stay in sync. */
async function afterWrite(get: () => WorkspaceReviewState, repoPath: string): Promise<void> {
  const jobs: Promise<void>[] = [get().refreshMember(repoPath)];
  if (isActiveRepo(repoPath)) jobs.push(useRepo.getState().refreshLocalChanges());
  await Promise.all(jobs);
}
