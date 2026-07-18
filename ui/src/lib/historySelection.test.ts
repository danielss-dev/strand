import { describe, expect, it } from 'vitest';

import { selectedCommitsOldestFirst } from './historySelection';

describe('selectedCommitsOldestFirst', () => {
  it('preserves graph topology while returning the selected commits oldest first', () => {
    const graph = [{ hash: 'new' }, { hash: 'middle' }, { hash: 'old' }];
    expect(selectedCommitsOldestFirst(graph, new Set(['new', 'old']))).toEqual([
      { hash: 'old' },
      { hash: 'new' },
    ]);
  });

  it('ignores stale selection hashes that are no longer in the graph', () => {
    expect(selectedCommitsOldestFirst([{ hash: 'present' }], new Set(['stale']))).toEqual([]);
  });
});
