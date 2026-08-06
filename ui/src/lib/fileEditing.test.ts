import { describe, expect, it } from 'vitest';

import {
  canEditFileContent,
  normalizeEditorText,
  reconcileWorkFileDrafts,
  workFileDraftKey,
  type WorkFileDraft,
} from './fileEditing';

describe('file content editing', () => {
  it('keeps accepted working-tree text editable in every presentation', () => {
    expect(canEditFileContent(true, null)).toBe(true);
  });

  it('keeps revisions and backend-rejected content read-only', () => {
    expect(canEditFileContent(true, 'abc123')).toBe(false);
    expect(canEditFileContent(false, null)).toBe(false);
  });

  it('normalizes editable buffers without changing their optimistic-write base', () => {
    expect(normalizeEditorText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });

  it('keeps drafts repository-scoped and follows file mutations', () => {
    const repo = 'C:\\code\\strand';
    const otherRepo = 'C:\\code\\other';
    const draft: WorkFileDraft = { original: 'before\r\n', text: 'after\n' };
    const otherDraft: WorkFileDraft = { original: 'x', text: 'y' };
    const drafts = {
      [workFileDraftKey(repo, 'src/app.ts')]: draft,
      [workFileDraftKey(otherRepo, 'src/app.ts')]: otherDraft,
    };

    const moved = reconcileWorkFileDrafts(drafts, repo, {
      kind: 'move',
      moves: [{ from: 'src', to: 'client' }],
    });
    expect(moved[workFileDraftKey(repo, 'src/app.ts')]).toBeUndefined();
    expect(moved[workFileDraftKey(repo, 'client/app.ts')]).toBe(draft);
    expect(moved[workFileDraftKey(otherRepo, 'src/app.ts')]).toBe(otherDraft);

    const removed = reconcileWorkFileDrafts(moved, repo, {
      kind: 'delete',
      paths: ['client'],
    });
    expect(removed[workFileDraftKey(repo, 'client/app.ts')]).toBeUndefined();
    expect(removed[workFileDraftKey(otherRepo, 'src/app.ts')]).toBe(otherDraft);
  });
});
