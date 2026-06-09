import { describe, expect, it } from 'vitest';

import { match, subsequence } from './fuzzy';

describe('subsequence', () => {
  it('finds contiguous runs and counts the gaps between them', () => {
    const r = subsequence('lc', 'local changes');
    expect(r).not.toBeNull();
    // 'l' at 0, 'c' at 2 ("lo*c*al") — two runs, one gap.
    expect(r!.ranges).toEqual([[0, 1], [2, 3]]);
    expect(r!.gaps).toBe(1);
  });

  it('returns one range for a contiguous hit and null for a miss', () => {
    expect(subsequence('loc', 'local')!.ranges).toEqual([[0, 3]]);
    expect(subsequence('xyz', 'local')).toBeNull();
  });
});

describe('match', () => {
  it('matches everything with an empty query at score 0', () => {
    expect(match('', 'anything')).toEqual({ score: 0, ranges: [] });
  });

  it('scores a substring above a scattered subsequence', () => {
    const substr = match('stash', 'Apply stash: wip')!;
    const scattered = match('sash', 'Apply stash: wip')!;
    expect(substr.score).toBeGreaterThan(scattered.score);
  });

  it('gives a word-boundary hit a bonus over a mid-word hit', () => {
    const boundary = match('tag', 'create tag')!; // after a space
    const midWord = match('tag', 'vantage')!; // inside a word
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });

  it('prefers earlier matches', () => {
    const early = match('a', 'abc')!;
    const late = match('a', 'zzz a')!;
    // Both are boundary hits; the earlier index wins.
    expect(early.score).toBeGreaterThan(late.score);
  });

  it('falls back to keywords without highlighting the label', () => {
    const m = match('reflog', 'Show: History', 'reflog head recover')!;
    expect(m.score).toBe(80);
    expect(m.ranges).toEqual([]);
  });

  it('returns null when neither label nor keywords match', () => {
    expect(match('q', 'label', 'keywords')).toBeNull();
  });
});
