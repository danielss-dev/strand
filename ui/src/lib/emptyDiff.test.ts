import { describe, expect, it } from 'vitest';
import { emptyDiffMessage, hasNoHunks } from './emptyDiff';

describe('emptyDiffMessage', () => {
  it('explains line-ending-only and mode-only empty diffs', () => {
    expect(emptyDiffMessage({ binary: false, note: 'Only line endings differ' }))
      .toBe('Only line endings differ');
    expect(emptyDiffMessage({ binary: false, note: 'File mode changed 100644 → 100755' }))
      .toBe('File mode changed 100644 → 100755');
    expect(emptyDiffMessage({ binary: false })).toBe('No textual diff.');
    expect(emptyDiffMessage({ binary: true, note: 'Only line endings differ' }))
      .toBe('Binary file — no diff shown.');
  });
});

describe('hasNoHunks', () => {
  it('treats mode-only and empty patches as having no hunks', () => {
    expect(hasNoHunks({ binary: false, adds: 0, dels: 0 })).toBe(true);
    expect(hasNoHunks({ binary: true, adds: 0, dels: 0 })).toBe(true);
    expect(hasNoHunks({ binary: false, adds: 1, dels: 0 })).toBe(false);
  });
});
