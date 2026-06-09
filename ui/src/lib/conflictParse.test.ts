import { describe, expect, it } from 'vitest';

import {
  buildViews,
  conflictAtLine,
  parseConflicts,
  toLineRange,
  type Resolution,
} from './conflictParse';

/**
 * The resolver writes `buildViews(...).resultText` back to the working tree
 * and stages it — these tests pin the parsing and assembly rules it relies on.
 */

const SIMPLE = [
  'before',
  '<<<<<<< HEAD',
  'ours line',
  '=======',
  'theirs line',
  '>>>>>>> feature',
  'after',
].join('\n');

describe('parseConflicts', () => {
  it('splits common and conflict segments and reads both labels', () => {
    const p = parseConflicts(SIMPLE);
    expect(p.total).toBe(1);
    expect(p.oursLabel).toBe('HEAD');
    expect(p.theirsLabel).toBe('feature');
    expect(p.segs).toHaveLength(3);
    expect(p.segs[0]).toEqual({ kind: 'common', lines: ['before'] });
    expect(p.segs[1]).toEqual({ kind: 'conflict', ours: ['ours line'], theirs: ['theirs line'] });
    expect(p.segs[2]).toEqual({ kind: 'common', lines: ['after'] });
  });

  it('skips a diff3 base section', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base — must not leak into either side',
      '=======',
      'theirs',
      '>>>>>>> topic',
    ].join('\n');
    const p = parseConflicts(text);
    expect(p.total).toBe(1);
    expect(p.segs[0]).toEqual({ kind: 'conflict', ours: ['ours'], theirs: ['theirs'] });
  });

  it('treats a marker-free file as one common segment', () => {
    const p = parseConflicts('a\nb\n');
    expect(p.total).toBe(0);
    expect(p.segs).toHaveLength(1);
  });
});

describe('buildViews', () => {
  it('keeps a placeholder for unresolved conflicts', () => {
    const views = buildViews(parseConflicts(SIMPLE), new Map());
    expect(views.resultText).toContain('unresolved merge conflict');
    expect(views.ranges[0].resolved).toBe(false);
    // Side views always show their full side, resolved or not.
    expect(views.oursText.split('\n')).toEqual(['before', 'ours line', 'after']);
    expect(views.theirsText.split('\n')).toEqual(['before', 'theirs line', 'after']);
  });

  it.each<[Resolution, string[]]>([
    ['ours', ['before', 'ours line', 'after']],
    ['theirs', ['before', 'theirs line', 'after']],
    ['both', ['before', 'ours line', 'theirs line', 'after']],
  ])('assembles the result for %s', (res, expected) => {
    const views = buildViews(parseConflicts(SIMPLE), new Map([[0, res]]));
    expect(views.resultText.split('\n')).toEqual(expected);
    expect(views.resultText).not.toContain('<<<<<<<');
    expect(views.ranges[0].resolved).toBe(true);
  });

  it('tracks per-conflict spans across multiple conflicts', () => {
    const text = [
      '<<<<<<< HEAD',
      'A-ours',
      '=======',
      'A-theirs',
      '>>>>>>> x',
      'mid',
      '<<<<<<< HEAD',
      'B-ours-1',
      'B-ours-2',
      '=======',
      'B-theirs',
      '>>>>>>> x',
    ].join('\n');
    const views = buildViews(parseConflicts(text), new Map([[0, 'ours']]));
    expect(views.total).toBe(2);
    // Second conflict's ours-span covers its two lines in the ours view:
    // [A-ours, mid, B-ours-1, B-ours-2] → lines 2..4 (half-open).
    expect(views.ranges[1].ours).toEqual([2, 4]);
    expect(conflictAtLine(views.ranges, 'ours', 3)).toBe(1);
    expect(conflictAtLine(views.ranges, 'ours', 1)).toBe(0);
    expect(conflictAtLine(views.ranges, 'ours', 2)).toBe(-1); // 'mid'
  });
});

describe('toLineRange', () => {
  it('converts half-open 0-based spans to 1-based inclusive ranges', () => {
    expect(toLineRange([0, 2])).toEqual({ start: 1, end: 2 });
  });
  it('clamps an empty span to a single line', () => {
    expect(toLineRange([4, 4])).toEqual({ start: 5, end: 5 });
  });
});
