import type { GitStatus, GitStatusEntry } from '@pierre/trees';

import type { StatusKind, WorkTreeEntry } from './types';

function workStatusToGit(status: StatusKind | null): GitStatus | null {
  switch (status) {
    case 'MODIFIED': return 'modified';
    case 'ADDED': return 'added';
    case 'DELETED': return 'deleted';
    case 'RENAMED': return 'renamed';
    case 'UNTRACKED': return 'untracked';
    case 'CONFLICTED': return 'modified';
    default: return null;
  }
}

function hasAncestor(path: string, directories: ReadonlySet<string>): boolean {
  let separator = path.indexOf('/');
  while (separator >= 0) {
    if (directories.has(path.slice(0, separator))) return true;
    separator = path.indexOf('/', separator + 1);
  }
  return false;
}

/**
 * Project working-tree metadata into Pierre statuses. Fully ignored subtrees
 * become one explicit directory status so their rows inherit the muted color
 * without every ignored descendant creating an ancestor change dot.
 */
export function workTreeGitStatus(
  entries: readonly WorkTreeEntry[],
  currentEntries: readonly WorkTreeEntry[] = entries,
): GitStatusEntry[] {
  const currentByPath = currentEntries === entries
    ? null
    : new Map(currentEntries.map((entry) => [entry.path, entry]));
  const directoryCounts = new Map<string, { total: number; ignored: number }>();

  for (const entry of entries) {
    if (entry.excluded) continue;
    let separator = entry.path.indexOf('/');
    while (separator >= 0) {
      const directory = entry.path.slice(0, separator);
      const counts = directoryCounts.get(directory) ?? { total: 0, ignored: 0 };
      counts.total++;
      if (entry.ignored) counts.ignored++;
      directoryCounts.set(directory, counts);
      separator = entry.path.indexOf('/', separator + 1);
    }
  }

  const ignoredDirectories = new Set([...directoryCounts]
    .filter(([, counts]) => counts.total === counts.ignored)
    .map(([directory]) => directory));
  const ignoredRoots = new Set(
    [...ignoredDirectories].filter((directory) => !hasAncestor(directory, ignoredDirectories)),
  );

  const statuses: GitStatusEntry[] = [...ignoredRoots].map((path) => ({
    path: `${path}/`,
    status: 'ignored',
  }));

  for (const entry of entries) {
    if (entry.excluded) continue;
    if (entry.ignored) {
      if (!hasAncestor(entry.path, ignoredRoots)) {
        statuses.push({ path: entry.path, status: 'ignored' });
      }
      continue;
    }
    const current = currentByPath?.get(entry.path);
    const status = workStatusToGit(current ? current.status : entry.status);
    if (status) statuses.push({ path: entry.path, status });
  }

  return statuses;
}
