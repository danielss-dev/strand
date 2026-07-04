import { describe, expect, it } from 'vitest';

import { computeChangeMap } from './changeMap';

const MIXED = [
  'diff --git a/f b/f',
  '--- a/f',
  '+++ b/f',
  '@@ -1,5 +1,6 @@',
  ' ctx1',
  '-old',
  '+new',
  '+added',
  ' ctx2',
  ' ctx3',
  ' ctx4',
  '',
].join('\n');

describe('computeChangeMap', () => {
  it('maps a mixed block in unified layout (dels stack above adds)', () => {
    const map = computeChangeMap(MIXED, 'unified');
    expect(map).toEqual({
      blocks: [{ row: 1, rows: 3, kind: 'mixed' }],
      total: 7,
    });
  });

  it('collapses a mixed block to the taller column in split layout', () => {
    const map = computeChangeMap(MIXED, 'split');
    expect(map).toEqual({
      blocks: [{ row: 1, rows: 2, kind: 'mixed' }],
      total: 6,
    });
  });

  it('handles multiple hunks, pure blocks, and no-newline markers', () => {
    const patch = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,3 @@',
      ' ctx1',
      '+added',
      ' ctx2',
      '@@ -10,3 +11,2 @@',
      ' ctx3',
      '-gone',
      ' ctx4',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const map = computeChangeMap(patch, 'unified');
    // Rows: ctx1(0) +added(1) ctx2(2) | ctx3(3) -gone(4) ctx4(5)
    expect(map).toEqual({
      blocks: [
        { row: 1, rows: 1, kind: 'add' },
        { row: 4, rows: 1, kind: 'del' },
      ],
      total: 6,
    });
  });

  it('splits change blocks separated by a hunk boundary', () => {
    const patch = [
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1 @@',
      '+top',
      '@@ -10 +11 @@',
      '+bottom',
      '',
    ].join('\n');
    expect(computeChangeMap(patch, 'unified')).toEqual({
      blocks: [
        { row: 0, rows: 1, kind: 'add' },
        { row: 1, rows: 1, kind: 'add' },
      ],
      total: 2,
    });
  });

  it('returns null for empty or change-free patches', () => {
    expect(computeChangeMap('', 'unified')).toBeNull();
    expect(computeChangeMap('diff --git a/f b/f\n', 'unified')).toBeNull();
  });
});
