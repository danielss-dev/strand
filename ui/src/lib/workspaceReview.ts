import { pathKey } from './repoIdentity';
import { compareTreePaths } from './treeOrder';
import type { RepoMeta, Workspace } from './types';

/**
 * Pure helpers for the aggregated workspace review (Workspaces Phase 2) —
 * resolving the active workspace's member repos and ordering the combined
 * review queue. Kept out of the store so they're unit-testable without
 * zustand or Tauri.
 */

/** A member repo resolved against the open tab set. */
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
}

/**
 * The active workspace's member repos, in membership order, each resolved to
 * its open main tab when there is one (linked-worktree tabs are not members —
 * the aggregated review covers each member repo's own working tree).
 */
export function activeWorkspaceMembers(
  workspaces: readonly Workspace[],
  activeWorkspaceId: string | null,
  tabs: readonly { path: string; meta: RepoMeta }[],
  defaultWorkspaceId: string,
): MemberResolution[] {
  const ws = workspaces.find((w) => w.id === (activeWorkspaceId ?? defaultWorkspaceId));
  if (!ws) return [];
  return ws.repoPaths.map((p) => {
    const key = pathKey(p);
    const tab = tabs.find((t) => !t.meta.is_linked_worktree && pathKey(t.path) === key);
    return { path: tab?.path ?? p, meta: tab?.meta ?? null };
  });
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
