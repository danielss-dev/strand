import type { StatusKind, WorkTreeEntry } from './types';

export interface DirectoryEntry {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  status: StatusKind | null;
  /** Number of files at or below this row (always 1 for a file). */
  fileCount: number;
  /** Number of changed files at or below this row. */
  changedCount: number;
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Project a repository's flat file listing into the immediate children of a
 * directory. Folder rows aggregate descendant file/change counts so the file
 * view can show useful context without another filesystem walk.
 */
export function directoryEntries(
  files: readonly WorkTreeEntry[],
  directory: string,
): DirectoryEntry[] {
  const prefix = directory.replace(/\/+$/, '');
  const base = prefix ? `${prefix}/` : '';
  const children = new Map<string, DirectoryEntry>();

  for (const file of files) {
    if (!file.path.startsWith(base)) continue;
    const relative = file.path.slice(base.length);
    if (!relative) continue;
    const slash = relative.indexOf('/');
    const name = slash === -1 ? relative : relative.slice(0, slash);
    const kind = slash === -1 ? 'file' : 'directory';
    const existing = children.get(name);

    if (existing) {
      existing.fileCount += 1;
      if (file.status) existing.changedCount += 1;
      continue;
    }

    children.set(name, {
      kind,
      name,
      path: base + name + (kind === 'directory' ? '/' : ''),
      status: kind === 'file' ? file.status : null,
      fileCount: 1,
      changedCount: file.status ? 1 : 0,
    });
  }

  return [...children.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return names.compare(a.name, b.name) || a.name.localeCompare(b.name);
  });
}
