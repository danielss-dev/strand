import { describe, expect, it } from 'vitest';

import { canEditFileContent, fileDraftKey } from './fileEditing';

describe('file content editing', () => {
  it('keeps accepted working-tree text editable in every presentation', () => {
    expect(canEditFileContent(true, null)).toBe(true);
  });

  it('keeps revisions and backend-rejected content read-only', () => {
    expect(canEditFileContent(true, 'abc123')).toBe(false);
    expect(canEditFileContent(false, null)).toBe(false);
  });

  it('keys unsaved drafts only for working-tree files', () => {
    expect(fileDraftKey('/repo', 'src/main.ts', null)).toBe('/repo\u0000src/main.ts');
    expect(fileDraftKey('/repo', 'src/main.ts', 'abc123')).toBe(null);
    expect(fileDraftKey(null, 'src/main.ts', null)).toBe(null);
  });
});
