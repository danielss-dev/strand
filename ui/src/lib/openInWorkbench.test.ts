import { describe, expect, it, vi } from 'vitest';

import type { DiffStatus } from './types';
import {
  OPEN_IN_WORKBENCH_LABEL,
  diffStatusForMenuRow,
  openInWorkbenchMenuItem,
  type OpenFileInWorkbench,
} from './openInWorkbench';

const repoPath = '/repos/strand';

function itemFor(opts: {
  path: string;
  kind: 'file' | 'directory';
  targets: string[];
  diffs: { path: string; status: DiffStatus }[];
  repoPath?: string;
  unstagedDiffs?: { path: string; status: DiffStatus }[];
  checkPath?: (repoPath: string, paths: string[]) => Promise<unknown>;
  openFile?: OpenFileInWorkbench;
  showWork?: () => void;
}) {
  const openFile = opts.openFile ?? vi.fn();
  const showWork = opts.showWork ?? vi.fn();
  const checkPath = opts.checkPath ?? vi.fn().mockResolvedValue([]);
  const onError = vi.fn();
  const item = openInWorkbenchMenuItem({
    repoPath: opts.repoPath ?? repoPath,
    path: opts.path,
    kind: opts.kind,
    targetCount: opts.targets.length,
    status: diffStatusForMenuRow(opts.diffs, opts.path, opts.kind, opts.unstagedDiffs),
    openFile,
    showWork,
    checkPath,
    onError,
  });
  return { item, openFile, showWork, checkPath, onError };
}

const changedFile = [{ path: 'ui/src/views/LocalChanges.tsx', status: 'modified' as const }];
const deletedFile = [{ path: 'gone.ts', status: 'deleted' as const }];
const reviewPool = [
  { path: 'src/a.ts', status: 'modified' as const },
  { path: 'src/b.ts', status: 'added' as const },
  { path: 'src/gone.ts', status: 'deleted' as const },
];

describe('Local Changes Open in Workbench menu item', () => {
  it('is present for a file, opens a pinned working-tree tab, and switches to Work', async () => {
    const { item, openFile, showWork } = itemFor({
      path: 'ui/src/views/LocalChanges.tsx',
      kind: 'file',
      targets: ['ui/src/views/LocalChanges.tsx'],
      diffs: changedFile,
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    await item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(
      repoPath,
      'ui/src/views/LocalChanges.tsx',
      null,
      false,
      'pinned',
    );
    expect(showWork).toHaveBeenCalledOnce();
  });

  it('opens a folder row as a directory, matching Files → Open', async () => {
    const { item, openFile, showWork } = itemFor({
      path: 'ui/src',
      kind: 'directory',
      targets: ['ui/src/views/LocalChanges.tsx', 'ui/src/views/Review.tsx'],
      diffs: [
        { path: 'ui/src/views/LocalChanges.tsx', status: 'modified' },
        { path: 'ui/src/views/Review.tsx', status: 'modified' },
      ],
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    await item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(repoPath, 'ui/src', null, true, 'pinned');
    expect(showWork).toHaveBeenCalledOnce();
  });

  it('hides the item for a deleted file with no working-tree copy', async () => {
    const { item, openFile, showWork } = itemFor({
      path: 'gone.ts',
      kind: 'file',
      targets: ['gone.ts'],
      diffs: deletedFile,
    });
    expect(item).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    expect(showWork).not.toHaveBeenCalled();
  });

  it('hides the item for a multi-file selection, matching Open in editor', () => {
    const { item } = itemFor({
      path: 'a.ts',
      kind: 'file',
      targets: ['a.ts', 'b.ts'],
      diffs: [
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'modified' },
      ],
    });
    expect(item).toBeNull();
  });
});

describe('Review Open in Workbench menu item', () => {
  it('is present for a file, opens a pinned working-tree tab, and switches to Work', async () => {
    const { item, openFile, showWork } = itemFor({
      path: 'src/a.ts',
      kind: 'file',
      targets: ['src/a.ts'],
      diffs: reviewPool,
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    await item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(repoPath, 'src/a.ts', null, false, 'pinned');
    expect(showWork).toHaveBeenCalledOnce();
  });

  it('opens a folder row as a directory even when several files sit under it', async () => {
    const { item, openFile } = itemFor({
      path: 'src',
      kind: 'directory',
      targets: ['src/a.ts', 'src/b.ts'],
      diffs: reviewPool,
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    await item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(repoPath, 'src', null, true, 'pinned');
  });

  it('hides the item for a deleted file with no working-tree copy', async () => {
    const { item, openFile, showWork } = itemFor({
      path: 'src/gone.ts',
      kind: 'file',
      targets: ['src/gone.ts'],
      diffs: reviewPool,
    });
    expect(item).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    expect(showWork).not.toHaveBeenCalled();
  });

  it('hides the item for a multi-file selection, matching Open in editor', () => {
    const { item } = itemFor({
      path: 'src/a.ts',
      kind: 'file',
      targets: ['src/a.ts', 'src/b.ts'],
      diffs: reviewPool,
    });
    expect(item).toBeNull();
  });
});


describe('working-tree presence', () => {
  it('hides a staged modification deleted in the working tree', () => {
    const { item } = itemFor({
      path: 'src/a.ts', kind: 'file', targets: ['src/a.ts'],
      diffs: reviewPool,
      unstagedDiffs: [{ path: 'src/a.ts', status: 'deleted' }],
    });
    expect(item).toBeNull();
  });

  it('hides folders whose changed descendants are all absent', () => {
    for (const diffs of [
      [{ path: 'src/a.ts', status: 'deleted' as const }],
      [{ path: 'src/a.ts', status: 'modified' as const }],
    ]) {
      const { item } = itemFor({
        path: 'src', kind: 'directory', targets: ['src/a.ts'], diffs,
        unstagedDiffs: [{ path: 'src/a.ts', status: 'deleted' }],
      });
      expect(item).toBeNull();
    }
  });

  it('ignores deletions outside the clicked folder', () => {
    expect(diffStatusForMenuRow([
      { path: 'src/a.ts', status: 'deleted' },
      { path: 'src-other/a.ts', status: 'modified' },
    ], 'src', 'directory')).toBe('deleted');
  });

  it('checks presence before opening and reports missing files or folders', async () => {
    for (const kind of ['file', 'directory'] as const) {
      const error = new Error('src/a.ts does not exist');
      const checkPath = vi.fn().mockRejectedValue(error);
      const { item, openFile, showWork, onError } = itemFor({
        path: kind === 'file' ? 'src/a.ts' : 'src', kind,
        targets: ['src/a.ts'], diffs: reviewPool, checkPath,
      });
      const selecting = item?.onSelect?.();
      expect(openFile).not.toHaveBeenCalled();
      await selecting;
      expect(checkPath).toHaveBeenCalledWith(repoPath, [kind === 'file' ? 'src/a.ts' : 'src']);
      expect(onError).toHaveBeenCalledWith(error);
      expect(openFile).not.toHaveBeenCalled();
      expect(showWork).not.toHaveBeenCalled();
    }
  });
});
