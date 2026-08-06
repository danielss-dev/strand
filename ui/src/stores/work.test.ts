import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db', () => ({
  settings: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('./settings', () => ({
  useSettings: { getState: () => ({ fileOpenTab: 'content' }) },
}));

import { workFileDraftKey } from '../lib/fileEditing';
import { useWork } from './work';

afterEach(() => useWork.setState({ fileDrafts: {} }));

describe('Work file drafts', () => {
  it('drops a session draft without changing other files', () => {
    const repo = 'C:\\code\\strand';
    const draft = { original: 'before', text: 'after' };
    useWork.getState().setFileDraft(repo, 'one.ts', draft);
    useWork.getState().setFileDraft(repo, 'two.ts', draft);

    useWork.getState().setFileDraft(repo, 'one.ts', null);

    expect(useWork.getState().fileDrafts[workFileDraftKey(repo, 'one.ts')]).toBeUndefined();
    expect(useWork.getState().fileDrafts[workFileDraftKey(repo, 'two.ts')]).toEqual(draft);
  });
});
