import { describe, expect, it } from 'vitest';

import { applyLocalTreeMutation } from './localTreeMutation';
import type { FilesTreeMutation, FilesTreeMutationChange, WorkTreeEntry } from './types';

const mutation = (change: FilesTreeMutationChange): FilesTreeMutation => ({
  ...change,
  revision: 1,
  repoPath: 'D:/repo',
});

describe('applyLocalTreeMutation', () => {
  it('adds Git-visible and ignored files immediately', () => {
    const added: WorkTreeEntry = { path: 'src/new.ts', status: 'ADDED', ignored: false };

    expect(applyLocalTreeMutation([], mutation({
      kind: 'create',
      path: added.path,
      directory: false,
    }), [added])).toEqual([added]);

    expect(applyLocalTreeMutation([], mutation({
      kind: 'create',
      path: '.cache/state.json',
      directory: false,
    }), [])).toEqual([
      { path: '.cache/state.json', status: null, ignored: true },
    ]);
  });

  it('moves ignored descendants and removes deleted local paths', () => {
    const current: WorkTreeEntry[] = [
      { path: '.cache/a.json', status: null, ignored: true },
      { path: '.cache/nested/b.json', status: null, ignored: true },
    ];
    const moved = applyLocalTreeMutation(current, mutation({
      kind: 'move',
      moves: [{ from: '.cache', to: '.local' }],
    }), []);

    expect(moved.map((entry) => entry.path)).toEqual([
      '.local/a.json',
      '.local/nested/b.json',
    ]);
    expect(applyLocalTreeMutation(moved, mutation({
      kind: 'delete',
      paths: ['.local'],
    }), [])).toEqual([]);
  });
});
