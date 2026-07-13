import { describe, expect, it } from 'vitest';

import { searchFileText } from './fileSearch';

describe('searchFileText', () => {
  it('finds case-insensitive substrings and preserves line numbers', () => {
    expect(searchFileText('alpha\nBeta value\nbetatron\nomega', 'BETA').matches).toEqual([
      { line: 2, lineText: 'Beta value' },
      { line: 3, lineText: 'betatron' },
    ]);
  });

  it('trims the query and ignores blank searches', () => {
    expect(searchFileText('alpha\nbeta', '  beta  ').matches).toHaveLength(1);
    expect(searchFileText('alpha', '   ')).toEqual({ matches: [], truncated: false });
  });

  it('caps large result sets', () => {
    expect(searchFileText('hit\nhit\nhit', 'hit', 2)).toEqual({
      matches: [
        { line: 1, lineText: 'hit' },
        { line: 2, lineText: 'hit' },
      ],
      truncated: true,
    });
  });
});
