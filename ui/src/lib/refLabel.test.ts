import { describe, expect, it } from 'vitest';

import { refChipLabel } from './refLabel';

describe('refChipLabel', () => {
  it('keeps a short name', () => {
    expect(refChipLabel('main')).toEqual({ label: 'main', title: 'main' });
  });
  it('truncates to the last path segment', () => {
    expect(refChipLabel('origin/developements/squash-merged-branch-cleanup-61da')).toEqual({
      label: 'squash-merged-branch-cleanup-61da',
      title: 'origin/developements/squash-merged-branch-cleanup-61da',
    });
  });
});
