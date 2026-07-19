import type { FilesTreeMutation, WorkTreeEntry } from './types';

function matchesPath(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/** Apply an in-app path mutation to an already-loaded local Files listing.
 * The authoritative ignored-inclusive scan still follows in the background. */
export function applyLocalTreeMutation(
  current: readonly WorkTreeEntry[],
  mutation: FilesTreeMutation,
  gitEntries: readonly WorkTreeEntry[],
): WorkTreeEntry[] {
  if (mutation.kind === 'refresh') return [...current];

  const next = new Map(current.map((entry) => [entry.path, entry]));

  if (mutation.kind === 'create' && !mutation.directory) {
    const gitEntry = gitEntries.find((entry) => entry.path === mutation.path);
    next.set(mutation.path, gitEntry ?? {
      path: mutation.path,
      status: null,
      ignored: true,
    });
  }

  if (mutation.kind === 'delete') {
    for (const path of next.keys()) {
      if (mutation.paths.some((deleted) => matchesPath(path, deleted))) next.delete(path);
    }
  }

  if (mutation.kind === 'move') {
    for (const move of mutation.moves) {
      for (const [path, entry] of [...next]) {
        if (!matchesPath(path, move.from)) continue;
        next.delete(path);
        const destination = move.to + path.slice(move.from.length);
        next.set(destination, { ...entry, path: destination });
      }
    }
  }

  // The snapshot is cheap and current. Merge its tracked/untracked paths into
  // the local cache so creates and Git-visible deletes update immediately.
  for (const entry of gitEntries) next.set(entry.path, entry);

  return [...next.values()].sort((a, b) => a.path.localeCompare(b.path));
}
