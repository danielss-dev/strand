import type { FilesTreeMutation } from './types';

const withoutTrailingSlash = (path: string) => path.replace(/\/+$/, '');
const directoryPath = (path: string) => `${withoutTrailingSlash(path)}/`;

/** Preserve empty folders created in this session; Git file listings cannot
 * represent them because Git tracks files rather than directories. */
export function applyEmptyDirectoryMutation(
  current: ReadonlySet<string>,
  mutation: FilesTreeMutation,
): Set<string> {
  const next = new Set(current);

  if (mutation.kind === 'create') {
    if (mutation.directory) next.add(directoryPath(mutation.path));
    return next;
  }

  if (mutation.kind === 'delete') {
    for (const directory of current) {
      const path = withoutTrailingSlash(directory);
      if (mutation.paths.some((deleted) => path === deleted || path.startsWith(`${deleted}/`))) {
        next.delete(directory);
      }
    }
    return next;
  }

  if (mutation.kind === 'move') {
    for (const directory of current) {
      const path = withoutTrailingSlash(directory);
      for (const move of mutation.moves) {
        if (path !== move.from && !path.startsWith(`${move.from}/`)) continue;
        next.delete(directory);
        next.add(directoryPath(move.to + path.slice(move.from.length)));
        break;
      }
    }
  }

  return next;
}
