import type { GitStatusEntry } from '@pierre/trees';
import { diffStatusToGit } from '../components/PierreTree';
import type { FileDiff, WorkTreeEntry } from './types';

/** Full revision inventory, with badges only for paths changed by the comparison. */
export function compareRefsTree(
  from: readonly Pick<WorkTreeEntry, 'path'>[],
  to: readonly Pick<WorkTreeEntry, 'path'>[],
  diffs: readonly Pick<FileDiff, 'path' | 'old_path' | 'status'>[],
): { paths: string[]; gitStatus: GitStatusEntry[] } {
  const paths = new Set([...from, ...to].map((entry) => entry.path));
  const statuses = new Map<string, GitStatusEntry['status']>();
  for (const diff of diffs) {
    paths.add(diff.path);
    if (diff.status === 'renamed' && diff.old_path) {
      paths.add(diff.old_path);
      statuses.set(diff.old_path, diffStatusToGit(diff.status));
    }
  }
  // A path's own diff takes precedence over a rename's old-path alias.
  for (const diff of diffs) statuses.set(diff.path, diffStatusToGit(diff.status));
  return {
    paths: [...paths].sort(),
    gitStatus: [...statuses].map(([path, status]) => ({ path, status })),
  };
}
