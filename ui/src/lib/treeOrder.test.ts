import { describe, expect, it } from 'vitest';

import { compareTreePaths, treeFileOrder } from './treeOrder';

describe('treeFileOrder', () => {
  it('puts files in nested directories before sibling files (dirs-first)', () => {
    // This is the exact case that made j/k "dive into folders": a flat path
    // sort yields [app.ts, lib/keys.ts, lib/menu.ts, zebra.ts], but the tree
    // shows the lib/ folder (and its files) before app.ts and zebra.ts.
    const input = ['src/app.ts', 'src/lib/keys.ts', 'src/lib/menu.ts', 'src/zebra.ts'];
    expect(treeFileOrder(input)).toEqual([
      'src/lib/keys.ts',
      'src/lib/menu.ts',
      'src/app.ts',
      'src/zebra.ts',
    ]);
  });

  it('orders top-level directories before top-level files', () => {
    expect(treeFileOrder(['readme.md', 'src/a.ts', 'LICENSE'])).toEqual([
      'src/a.ts',
      'LICENSE',
      'readme.md',
    ]);
  });

  it('sorts case-insensitively', () => {
    expect(treeFileOrder(['src/Zebra.ts', 'src/apple.ts'])).toEqual([
      'src/apple.ts',
      'src/Zebra.ts',
    ]);
  });

  it('sorts numbers naturally (a2 before a10)', () => {
    expect(treeFileOrder(['f10.ts', 'f2.ts', 'f1.ts'])).toEqual(['f1.ts', 'f2.ts', 'f10.ts']);
  });

  it('keeps a shorter (prefix) path before a deeper sibling chain', () => {
    // Within src/: the `core` directory sorts before the `core.ts` file.
    const input = ['src/core.ts', 'src/core/mod.ts'];
    expect(treeFileOrder(input)).toEqual(['src/core/mod.ts', 'src/core.ts']);
  });

  it('is a pure sort (does not mutate input)', () => {
    const input = ['b.ts', 'a.ts'];
    const copy = [...input];
    treeFileOrder(input);
    expect(input).toEqual(copy);
  });
});

describe('compareTreePaths', () => {
  it('returns 0 for identical paths', () => {
    expect(compareTreePaths('src/a.ts', 'src/a.ts')).toBe(0);
  });

  it('is sign-consistent when swapped', () => {
    const a = 'src/lib/x.ts';
    const b = 'src/y.ts';
    expect(Math.sign(compareTreePaths(a, b))).toBe(-Math.sign(compareTreePaths(b, a)));
  });
});
