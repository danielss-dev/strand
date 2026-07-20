import { describe, expect, it } from 'vitest';

import { canEditFileContent } from './fileEditing';

describe('file content editing', () => {
  it('keeps accepted working-tree text editable in every presentation', () => {
    expect(canEditFileContent(true, null)).toBe(true);
  });

  it('keeps revisions and backend-rejected content read-only', () => {
    expect(canEditFileContent(true, 'abc123')).toBe(false);
    expect(canEditFileContent(false, null)).toBe(false);
  });
});
