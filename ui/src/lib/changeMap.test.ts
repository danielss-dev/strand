import { describe, expect, it } from 'vitest';

import { computeChangeMap, lineToRow } from './changeMap';

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

describe('lineToRow', () => {
  // MIXED rendered rows (unified): ctx1(0) -old(1) +new(2) +added(3) ctx2(4)
  // ctx3(5) ctx4(6). Old lines: ctx1=1 old=2 ctx2=3 ctx3=4 ctx4=5.
  // New lines: ctx1=1 new=2 added=3 ctx2=4 ctx3=5 ctx4=6.
  it('locates context, deletion, and addition rows in unified layout', () => {
    expect(lineToRow(MIXED, 'unified', 1, 'new')).toEqual({ row: 0, total: 7 });
    expect(lineToRow(MIXED, 'unified', 2, 'old')).toEqual({ row: 1, total: 7 });
    expect(lineToRow(MIXED, 'unified', 2, 'new')).toEqual({ row: 2, total: 7 });
    expect(lineToRow(MIXED, 'unified', 3, 'new')).toEqual({ row: 3, total: 7 });
    // Context lines resolve on either side (old ctx2 = 3, new ctx2 = 4).
    expect(lineToRow(MIXED, 'unified', 3, 'old')).toEqual({ row: 4, total: 7 });
    expect(lineToRow(MIXED, 'unified', 4, 'new')).toEqual({ row: 4, total: 7 });
  });

  it('aligns deletions and additions side-by-side in split layout', () => {
    // Split rows: ctx1(0) [-old | +new](1) [ | +added](2 — taller add column)
    // ctx2(3) ctx3(4) ctx4(5).
    expect(lineToRow(MIXED, 'split', 2, 'old')).toEqual({ row: 1, total: 6 });
    expect(lineToRow(MIXED, 'split', 2, 'new')).toEqual({ row: 1, total: 6 });
    expect(lineToRow(MIXED, 'split', 3, 'new')).toEqual({ row: 2, total: 6 });
    expect(lineToRow(MIXED, 'split', 4, 'new')).toEqual({ row: 3, total: 6 });
  });

  it('tracks line counters across multiple hunks', () => {
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
      '',
    ].join('\n');
    // Second hunk: old ctx3=10 gone=11 ctx4=12; new ctx3=11 ctx4=12.
    expect(lineToRow(patch, 'unified', 11, 'old')).toEqual({ row: 4, total: 6 });
    expect(lineToRow(patch, 'unified', 12, 'new')).toEqual({ row: 5, total: 6 });
    expect(lineToRow(patch, 'unified', 2, 'new')).toEqual({ row: 1, total: 6 });
  });

  it('matches computeChangeMap totals so fractions agree with the minimap', () => {
    for (const layout of ['unified', 'split'] as const) {
      expect(lineToRow(MIXED, layout, 1, 'new')!.total).toBe(
        computeChangeMap(MIXED, layout)!.total,
      );
    }
  });

  it('returns null for absent lines and empty patches', () => {
    expect(lineToRow(MIXED, 'unified', 99, 'new')).toBeNull();
    // Line 6 exists on the new side (ctx4) but not the old (file has 5).
    expect(lineToRow(MIXED, 'unified', 6, 'old')).toBeNull();
    expect(lineToRow('', 'unified', 1, 'new')).toBeNull();
  });
});
