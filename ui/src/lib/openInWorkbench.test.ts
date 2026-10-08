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
  openFile?: OpenFileInWorkbench;
  showWork?: () => void;
}) {
  const openFile = opts.openFile ?? vi.fn();
  const showWork = opts.showWork ?? vi.fn();
  const item = openInWorkbenchMenuItem({
    repoPath: opts.repoPath ?? repoPath,
    path: opts.path,
    kind: opts.kind,
    targetCount: opts.targets.length,
    status: diffStatusForMenuRow(opts.diffs, opts.path, opts.kind),
    openFile,
    showWork,
  });
  return { item, openFile, showWork };
}

const changedFile = [{ path: 'ui/src/views/LocalChanges.tsx', status: 'modified' as const }];
const deletedFile = [{ path: 'gone.ts', status: 'deleted' as const }];
const reviewPool = [
  { path: 'src/a.ts', status: 'modified' as const },
  { path: 'src/b.ts', status: 'added' as const },
  { path: 'src/gone.ts', status: 'deleted' as const },
];

describe('Local Changes Open in Workbench menu item', () => {
  it('is present for a file, opens a pinned working-tree tab, and switches to Work', () => {
    const { item, openFile, showWork } = itemFor({
      path: 'ui/src/views/LocalChanges.tsx',
      kind: 'file',
      targets: ['ui/src/views/LocalChanges.tsx'],
      diffs: changedFile,
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(
      repoPath,
      'ui/src/views/LocalChanges.tsx',
      null,
      false,
      'pinned',
    );
    expect(showWork).toHaveBeenCalledOnce();
  });

  it('opens a folder row as a directory, matching Files → Open', () => {
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
    item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(repoPath, 'ui/src', null, true, 'pinned');
    expect(showWork).toHaveBeenCalledOnce();
  });

  it('hides the item for a deleted file with no working-tree copy', () => {
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
  it('is present for a file, opens a pinned working-tree tab, and switches to Work', () => {
    const { item, openFile, showWork } = itemFor({
      path: 'src/a.ts',
      kind: 'file',
      targets: ['src/a.ts'],
      diffs: reviewPool,
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(repoPath, 'src/a.ts', null, false, 'pinned');
    expect(showWork).toHaveBeenCalledOnce();
  });

  it('opens a folder row as a directory even when several files sit under it', () => {
    const { item, openFile } = itemFor({
      path: 'src',
      kind: 'directory',
      targets: ['src/a.ts', 'src/b.ts'],
      diffs: reviewPool,
    });
    expect(item?.label).toBe(OPEN_IN_WORKBENCH_LABEL);
    item?.onSelect?.();
    expect(openFile).toHaveBeenCalledWith(repoPath, 'src', null, true, 'pinned');
  });

  it('hides the item for a deleted file with no working-tree copy', () => {
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
