import { describe, expect, it } from 'vitest';

import { applyEmptyDirectoryMutation } from './emptyDirectories';
import type { FilesTreeMutation, FilesTreeMutationChange } from './types';

const mutation = (change: FilesTreeMutationChange): FilesTreeMutation => ({
  ...change,
  revision: 1,
  repoPath: 'D:/repo',
});

describe('applyEmptyDirectoryMutation', () => {
  it('keeps a newly created empty directory visible', () => {
    expect(applyEmptyDirectoryMutation(new Set(), mutation({
      kind: 'create',
      path: 'docs/drafts',
      directory: true,
    }))).toEqual(new Set(['docs/drafts/']));
  });

  it('renames and deletes retained directory markers', () => {
    const moved = applyEmptyDirectoryMutation(new Set(['docs/drafts/', 'docs/drafts/nested/']), mutation({
      kind: 'move',
      moves: [{ from: 'docs/drafts', to: 'notes' }],
    }));
    expect(moved).toEqual(new Set(['notes/', 'notes/nested/']));

    expect(applyEmptyDirectoryMutation(moved, mutation({
      kind: 'delete',
      paths: ['notes'],
    }))).toEqual(new Set());
  });
});
