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
 * and for deleted files (no working-tree copy). Folder rows always offer it.
 */
export function openInWorkbenchMenuItem(args: {
  repoPath: string | undefined;
  path: string;
  kind: 'file' | 'directory';
  targetCount: number;
  status?: DiffStatus | null;
  openFile: OpenFileInWorkbench;
  showWork: () => void;
}): MenuItem | null {
  const { repoPath, path, kind, targetCount, status, openFile, showWork } = args;
  if (!repoPath) return null;
  switch (kind) {
    case 'file':
      if (targetCount !== 1 || status === 'deleted') return null;
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
    onSelect: () => {
      openFile(repoPath, path, null, kind === 'directory', 'pinned');
      showWork();
    },
  };
}

/** Status of the clicked file row; folder rows have no FileDiff of their own. */
export function diffStatusForMenuRow(
  diffs: readonly { path: string; status: DiffStatus }[],
  path: string,
  kind: 'file' | 'directory',
): DiffStatus | null {
  switch (kind) {
    case 'directory':
      return null;
    case 'file':
      return diffs.find((diff) => diff.path === path)?.status ?? null;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
