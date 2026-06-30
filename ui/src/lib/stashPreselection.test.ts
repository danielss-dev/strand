import { describe, expect, it } from 'vitest';

import { computeStashPreselection, pathsForLocalSelection } from './stashPreselection';

describe('pathsForLocalSelection', () => {
  it('returns every path for show-all', () => {
    expect(
      pathsForLocalSelection({ file: '', staged: false, all: true }, ['a.ts', 'b.ts']),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('expands folder rows to descendants', () => {
    expect(
      pathsForLocalSelection({ file: 'src/', staged: false }, ['src/a.ts', 'src/b.ts', 'other.ts']),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('computeStashPreselection', () => {
  const unstaged = ['a.ts', 'b.ts', 'src/x.ts'];
  const staged = ['c.ts'];
  const all = [...unstaged, ...staged];

  it('defaults to every stashable path', () => {
    expect(computeStashPreselection(null, unstaged, staged, { unstaged: [], staged: [] }, all))
      .toEqual(new Set(all));
  });

  it('honours Pierre multi-select on the active side', () => {
    expect(
      computeStashPreselection(
        { file: 'a.ts', staged: false },
        unstaged,
        staged,
        { unstaged: ['a.ts', 'b.ts'], staged: [] },
        all,
      ),
    ).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('honours show-all on one side', () => {
    expect(
      computeStashPreselection(
        { file: '', staged: false, all: true },
        unstaged,
        staged,
        { unstaged: [], staged: [] },
        all,
      ),
    ).toEqual(new Set(unstaged));
  });

  it('honours a single selected file row', () => {
    expect(
      computeStashPreselection(
        { file: 'c.ts', staged: true },
        unstaged,
        staged,
        { unstaged: [], staged: ['c.ts'] },
        all,
      ),
    ).toEqual(new Set(['c.ts']));
  });
});
