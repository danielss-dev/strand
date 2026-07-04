import { mainPathFromCommonDir, pathKey, tabWorktreeName } from './repoIdentity';
import { compareTreePaths } from './treeOrder';
import type { RepoMeta, Workspace } from './types';

/**
 * Pure helpers for the aggregated workspace review (Workspaces Phase 2) —
 * resolving the active workspace's member repos and ordering the combined
 * review queue. Kept out of the store so they're unit-testable without
 * zustand or Tauri.
 */

/** A member repo — or an open worktree of one — resolved against the open tab set. */
export interface MemberResolution {
  /**
   * The path to fan the per-repo IPC over and to key `reviewSession`
   * persistence by: the open tab's canonical path when the repo is open (so
   * reviewed marks land under the same key the single-repo Review uses), else
   * the workspace's stored path — the diff commands are path-parameterized,
   * so a member that failed to open still reviews.
   */
  path: string;
  /** The open tab's meta, or `null` when the member isn't open. */
  meta: RepoMeta | null;
  /**
   * Worktree display label when this resolution is an open linked worktree of
   * a member repo, `null` for the member repo itself. A worktree reviews as
   * its own section: it is its own working tree with its own baseline, so the
   * main repo's diff can never show what an agent changed there.
   */
  worktree: string | null;
}

/**
 * The active workspace's review members, in membership order: each member
 * repo resolved to its open main tab when there is one, followed by that
 * repo's **open linked-worktree tabs** (matched via the shared `.git` common
 * dir, in tab order) as their own resolutions. Membership itself stays
 * family-level — opening the worktree tab is the explicit act that puts it
 * in the review, mirroring how worktrees inherit rail visibility.
 */
export function activeWorkspaceMembers(
  workspaces: readonly Workspace[],
  activeWorkspaceId: string | null,
  tabs: readonly { path: string; meta: RepoMeta }[],
  defaultWorkspaceId: string,
): MemberResolution[] {
  const ws = workspaces.find((w) => w.id === (activeWorkspaceId ?? defaultWorkspaceId));
  if (!ws) return [];
  const out: MemberResolution[] = [];
  for (const p of ws.repoPaths) {
    const key = pathKey(p);
    const tab = tabs.find((t) => !t.meta.is_linked_worktree && pathKey(t.path) === key);
    out.push({ path: tab?.path ?? p, meta: tab?.meta ?? null, worktree: null });
    for (const t of tabs) {
      if (!t.meta.is_linked_worktree) continue;
      if (mainPathFromCommonDir(t.meta.common_dir) !== key) continue;
      out.push({ path: t.path, meta: t.meta, worktree: tabWorktreeName(t.meta) });
    }
  }
  return out;
}

/** One position in the combined review queue: a file within a member repo. */
export interface QueueEntry {
  /** The member's resolved repo path ({@link MemberResolution.path}). */
  repo: string;
  /** Repo-relative file path. */
  file: string;
}

/**
 * The combined queue in display order: members in workspace order, files
 * within each member in Pierre tree order (matching what the per-repo trees
 * show), so j/k walks straight down the visible list across repo boundaries.
 */
export function workspaceQueueOrder(
  members: readonly { path: string; diffs: readonly { path: string }[] }[],
): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const m of members) {
    const ordered = m.diffs.map((d) => d.path).sort(compareTreePaths);
    for (const file of ordered) out.push({ repo: m.path, file });
  }
  return out;
}
