import type { MenuItem } from '../components/ContextMenu';
import type { DiffStatus } from './types';
import type { WorkFileMode } from './workTabs';

/** Matches Files → Open. Neighboring Local Changes / Review items are hardcoded. */
export const OPEN_IN_WORKBENCH_LABEL = 'Open in Workbench';

export type OpenFileInWorkbench = (
  repoPath: string,
  path: string,
  revision: string | null,
  isDirectory: boolean,
  disposition?: 'preview' | 'pinned',
  mode?: WorkFileMode,
  paneId?: string,
) => void;

/**
 * Local Changes and Review tree-menu entry that opens the clicked row as a
 * pinned Work tab (working-tree revision), matching Files → Open.
 *
 * Hidden for multi-file selections (same single-target rule as Open in editor)
 * and for paths with no surviving working-tree copy.
 */
export function openInWorkbenchMenuItem(args: {
  repoPath: string | undefined;
  path: string;
  kind: 'file' | 'directory';
  targetCount: number;
  status?: DiffStatus | null;
  openFile: OpenFileInWorkbench;
  showWork: () => void;
  checkPath: (repoPath: string, paths: string[]) => Promise<unknown>;
  onError: (error: unknown) => void;
}): MenuItem | null {
  const { repoPath, path, kind, targetCount, status, openFile, showWork, checkPath, onError } = args;
  if (!repoPath) return null;
  if (status === 'deleted') return null;
  switch (kind) {
    case 'file':
      if (targetCount !== 1) return null;
      break;
    case 'directory':
      break;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
  return {
    label: OPEN_IN_WORKBENCH_LABEL,
    icon: 'content',
    onSelect: async () => {
      try {
        await checkPath(repoPath, [path]);
        openFile(repoPath, path, null, kind === 'directory', 'pinned');
        showWork();
      } catch (error) {
        onError(error);
      }
    },
  };
}

/** Deletions on the working-tree side override the displayed diff status. */
export function diffStatusForMenuRow(
  diffs: readonly { path: string; status: DiffStatus }[],
  path: string,
  kind: 'file' | 'directory',
  unstagedDiffs: readonly { path: string; status: DiffStatus }[] = [],
): DiffStatus | null {
  const deleted = new Set(unstagedDiffs.filter((diff) => diff.status === 'deleted').map((diff) => diff.path));
  const absent = (diff: { path: string; status: DiffStatus }) =>
    diff.status === 'deleted' || deleted.has(diff.path);
  switch (kind) {
    case 'directory': {
      const descendants = diffs.filter((diff) => diff.path.startsWith(`${path}/`));
      return descendants.length > 0 && descendants.every(absent) ? 'deleted' : null;
    }
    case 'file':
      return deleted.has(path) ? 'deleted' : diffs.find((diff) => diff.path === path)?.status ?? null;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
