import { describe, expect, it } from 'vitest';

import { SEARCH_ACTION_CSS, SEARCH_ACTION_SPACE } from './PierreTree';

describe('PierreTree searchAction layout contract', () => {
  it('lets the search input shrink below its intrinsic min size', () => {
    // Flex items default to min-width:auto; Pierre's search <input> would
    // otherwise refuse to shrink and paint under the absolutely positioned
    // create control when the Files pane is narrow (DAN-66).
    expect(SEARCH_ACTION_CSS).toMatch(
      /\[data-file-tree-search-input\]\s*\{[^}]*min-width:\s*0/,
    );
    expect(SEARCH_ACTION_CSS).toMatch(
      /\[data-file-tree-search-container\]\s*\{[^}]*min-width:\s*0/,
    );
  });

  it('reserves trailing space for the content-box create control plus a 2px gap', () => {
    expect(SEARCH_ACTION_CSS).toContain('var(--strand-tree-search-action-space');
    // row-height + 1px pad*2 + 1px border*2 + 2px gap
    expect(SEARCH_ACTION_SPACE).toBe('calc(var(--trees-row-height, 30px) + 6px)');
  });

  it('pins the header-slot action to the trailing edge of the search row', () => {
    expect(SEARCH_ACTION_CSS).toMatch(
      /\[data-type='header-slot'\]\s*\{[^}]*position:\s*absolute/,
    );
    expect(SEARCH_ACTION_CSS).toContain('inset-inline-end: var(--trees-padding-inline)');
  });
});
