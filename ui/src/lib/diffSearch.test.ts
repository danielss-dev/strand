import { describe, expect, it } from 'vitest';

import { searchDiffs } from './diffSearch';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,4 +10,4 @@ function setup() {',
  ' const alpha = 1;',
  '-const beta = 2;',
  '+const beta = 3;',
  ' const gamma = 4;',
  '@@ -30,3 +30,4 @@',
  ' tail();',
  '+const delta = beta + 1;',
  ' end();',
  '\\ No newline at end of file',
  '',
].join('\n');

const FILE = { path: 'src/app.ts', patch: PATCH, binary: false };

describe('searchDiffs', () => {
  it('tracks old/new line numbers across hunks and classifies kinds', () => {
    const { matches, truncated } = searchDiffs([FILE], 'beta');
    expect(truncated).toBe(false);
    expect(matches).toEqual([
      { path: 'src/app.ts', lineText: 'const beta = 2;', newLine: null, oldLine: 11, kind: 'del' },
      { path: 'src/app.ts', lineText: 'const beta = 3;', newLine: 11, oldLine: null, kind: 'add' },
      { path: 'src/app.ts', lineText: 'const delta = beta + 1;', newLine: 31, oldLine: null, kind: 'add' },
    ]);
  });

  it('counts context lines on both sides, including after one-sided blocks', () => {
    const gamma = searchDiffs([FILE], 'gamma').matches;
    expect(gamma).toEqual([
      { path: 'src/app.ts', lineText: 'const gamma = 4;', newLine: 12, oldLine: 12, kind: 'ctx' },
    ]);
    // Second hunk, after an added line: new side is one ahead of the old.
    const end = searchDiffs([FILE], 'end()').matches;
    expect(end).toEqual([
      { path: 'src/app.ts', lineText: 'end();', newLine: 32, oldLine: 31, kind: 'ctx' },
    ]);
  });

  it('never matches patch metadata or hunk headers', () => {
    // The path only appears in `diff --git` / `---` / `+++` lines.
    expect(searchDiffs([FILE], 'src/app.ts').matches).toHaveLength(0);
    // `setup` only appears in the @@ header's trailing context.
    expect(searchDiffs([FILE], 'setup').matches).toHaveLength(0);
    expect(searchDiffs([FILE], 'No newline').matches).toHaveLength(0);
  });

  it('matches on the text without the +/-/space prefix, case-insensitively', () => {
    expect(searchDiffs([FILE], '+const').matches).toHaveLength(0);
    expect(searchDiffs([FILE], 'BETA').matches).toHaveLength(3);
  });

  it('stops at the limit and flags truncation only when matches were dropped', () => {
    const capped = searchDiffs([FILE], 'const', 2);
    expect(capped.matches).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    // Exactly at the limit — nothing dropped, so not truncated.
    const exact = searchDiffs([FILE], 'beta', 3);
    expect(exact.matches).toHaveLength(3);
    expect(exact.truncated).toBe(false);
  });

  it('trims the query; empty or whitespace-only queries match nothing', () => {
    expect(searchDiffs([FILE], '  beta ').matches).toHaveLength(3);
    expect(searchDiffs([FILE], '')).toEqual({ matches: [], truncated: false });
    expect(searchDiffs([FILE], '   ')).toEqual({ matches: [], truncated: false });
  });

  it('skips binary files and empty patches', () => {
    const pool = [
      { path: 'img.png', patch: 'beta', binary: true },
      { path: 'empty.txt', patch: '', binary: false },
      FILE,
    ];
    const { matches } = searchDiffs(pool, 'beta');
    expect(matches.every((m) => m.path === 'src/app.ts')).toBe(true);
    expect(matches).toHaveLength(3);
  });

  it('copies each entry tag onto its matches (mixed staged/unstaged pools)', () => {
    const pool = [
      { ...FILE, tag: false },
      { ...FILE, path: FILE.path, tag: true },
    ];
    const { matches } = searchDiffs(pool, 'beta');
    expect(matches.length).toBeGreaterThan(0);
    const tags = new Set(matches.map((m) => m.tag));
    expect(tags).toEqual(new Set([false, true]));
    // Same path on both sides — only the tag disambiguates.
    expect(matches.every((m) => m.path === FILE.path)).toBe(true);
  });
});