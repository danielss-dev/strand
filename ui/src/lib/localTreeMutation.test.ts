import { describe, expect, it } from 'vitest';

import { applyLocalTreeMutation, retainLoadedIgnoredChildren } from './localTreeMutation';
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

  it('retains only descendants of loaded ignored directories', () => {
    const boundaries: WorkTreeEntry[] = [
      { path: 'node_modules/', status: null, ignored: true },
      { path: 'target/', status: null, ignored: true },
      { path: 'src/index.ts', status: null, ignored: false },
    ];
    const current: WorkTreeEntry[] = [
      ...boundaries,
      { path: 'node_modules/.bin/', status: null, ignored: true },
      { path: 'node_modules/.bin/vite', status: null, ignored: true },
      { path: 'target/debug/', status: null, ignored: true },
    ];

    expect(retainLoadedIgnoredChildren(
      boundaries,
      current,
      new Set(['node_modules']),
    ).map((entry) => entry.path)).toEqual([
      'node_modules/',
      'node_modules/.bin/',
      'node_modules/.bin/vite',
      'src/index.ts',
      'target/',
    ]);
  });
});
