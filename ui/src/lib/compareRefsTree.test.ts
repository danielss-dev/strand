import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DiffStatus } from './types';

// Pierre reads navigator at import time, including on Node 20.
vi.stubGlobal('navigator', { userAgent: 'node' });
const { compareRefsTree } = await import('./compareRefsTree');
afterAll(() => vi.unstubAllGlobals());

const entries = (...paths: string[]) => paths.map((path) => ({ path }));
const diff = (path: string, status: DiffStatus, old_path: string | null = null) => ({ path, status, old_path });

describe('compareRefsTree', () => {
  it('sorts and deduplicates the full union, retaining unchanged files without badges', () => {
    expect(compareRefsTree(
      entries('src/same.ts', 'deleted.txt', 'README.md'),
      entries('added.txt', 'src/same.ts', 'README.md'),
      [diff('added.txt', 'added'), diff('deleted.txt', 'deleted')],
    )).toEqual({
      paths: ['README.md', 'added.txt', 'deleted.txt', 'src/same.ts'],
      gitStatus: [{ path: 'added.txt', status: 'added' }, { path: 'deleted.txt', status: 'deleted' }],
    });
  });

  it('keeps identical nonempty trees visible with no status entries', () => {
    expect(compareRefsTree(entries('a', 'dir/b'), entries('dir/b', 'a'), []))
      .toEqual({ paths: ['a', 'dir/b'], gitStatus: [] });
  });

  it('supports empty revisions', () => {
    expect(compareRefsTree([], [], [])).toEqual({ paths: [], gitStatus: [] });
  });

  it('includes missing diff paths and both sides of a rename', () => {
    expect(compareRefsTree([], entries('new.txt'), [diff('new.txt', 'renamed', 'old.txt'), diff('gone.txt', 'deleted')]))
      .toEqual({
        paths: ['gone.txt', 'new.txt', 'old.txt'],
        gitStatus: [
          { path: 'old.txt', status: 'renamed' },
          { path: 'new.txt', status: 'renamed' },
          { path: 'gone.txt', status: 'deleted' },
        ],
      });
  });

  it('prefers a path’s own status over a rename alias regardless of diff order', () => {
    for (const diffs of [
      [diff('old', 'added'), diff('new', 'renamed', 'old')],
      [diff('new', 'renamed', 'old'), diff('old', 'added')],
    ]) {
      expect(compareRefsTree([], [], diffs).gitStatus).toContainEqual({ path: 'old', status: 'added' });
    }
  });

  it.each([
    ['modified', 'modified'], ['typechange', 'modified'], ['copied', 'added'],
  ] as const)('uses the shared status mapping for %s', (status, expected) => {
    const tree = compareRefsTree(entries('source'), entries('target'), [diff('target', status, 'source')]);
    expect(tree.gitStatus).toEqual([{ path: 'target', status: expected }]);
  });
});
