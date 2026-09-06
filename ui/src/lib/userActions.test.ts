import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => ({ repo: {} as Record<string, any>, work: { repos: {} } as any, settings: { userActions: [] } as any }));
vi.mock('../stores/repo', () => ({ useRepo: { getState: () => stores.repo } }));
vi.mock('../stores/work', () => ({ useWork: { getState: () => stores.work } }));
vi.mock('../stores/settings', () => ({ useSettings: { getState: () => stores.settings } }));
import { parseActionArgs, selectedActionContext, userActionMenu, userActionPalette, type UserAction } from './userActions';

const action: UserAction = { id: 'test', name: 'Inspect', scope: 'file', executable: 'git', args: ['show', '--', '{relativeFile}'], cwd: 'repository' };
beforeEach(() => {
  stores.repo = { meta: { path: 'C:/repo one & %PATH%' }, view: 'work', selectedFile: 'stale.txt', selectedFileRevision: null,
    selectedFileIsDirectory: false, selectedRef: null, refs: { branches: [], remote_branches: [], tags: [] } };
  stores.work = { repos: { [stores.repo.meta.path]: { activeTabId: 'a', tabs: [{ id: 'a', kind: 'file', path: 'a b & {repo}.txt', revision: null, isDirectory: false, missing: false }] } } };
  stores.settings = { userActions: [action] };
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
});

describe('personal user actions', () => {
  it('keeps argv boundaries, empties, spaces and metacharacters', () => {
    expect(parseActionArgs('["", "a b;&%PATH%", "--", "{relativeFile}"]')).toEqual(['', 'a b;&%PATH%', '--', '{relativeFile}']);
    for (const text of ['"git status"', '[1]', '["\\u0000"]', JSON.stringify(Array(129).fill('a'))]) expect(() => parseActionArgs(text)).toThrow();
  });
  it('uses the active Work document and hides historical/missing/directory/terminal targets', () => {
    expect(selectedActionContext('file')?.target).toEqual({ kind: 'file', file: 'a b & {repo}.txt' });
    const file = stores.work.repos[stores.repo.meta.path].tabs[0];
    for (const override of [{ revision: 'abc' }, { isDirectory: true }, { missing: true }, { kind: 'terminal' }]) {
      stores.work.repos[stores.repo.meta.path].tabs[0] = { ...file, ...override };
      expect(selectedActionContext('file')).toBeNull();
    }
  });
  it('uses qualified explicitly selected refs, never HEAD or a ref with a different target', () => {
    const ref = { full_name: 'refs/heads/topic', target: 'abc' };
    stores.repo = { ...stores.repo, view: 'commits', selectedRef: ref.full_name, selectedCommit: 'abc', refs: { branches: [ref], tags: [], remote_branches: [] } };
    expect(selectedActionContext('ref')?.target).toEqual({ kind: 'ref', reference: ref.full_name, oid: 'abc' });
    stores.repo.selectedCommit = 'def'; expect(selectedActionContext('ref')).toBeNull();
  });
  it('captures the clicked row even when another repository/file is selected', () => {
    const context = { path: 'C:/other repo', target: { kind: 'file' as const, file: 'clicked.txt' } };
    const item = userActionMenu(context);
    item.submenu?.[0].onSelect?.();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ init: { detail: { context, actionId: 'test' } } }));
  });
  it('refuses a superseded palette result instead of following new selection', () => {
    const stale = vi.fn();
    const result = userActionPalette([action], stale)[0];
    stores.work.repos[stores.repo.meta.path].activeTabId = 'another';
    result.run(); expect(window.dispatchEvent).not.toHaveBeenCalled(); expect(stale).toHaveBeenCalledOnce();
    stores.work.repos[stores.repo.meta.path].activeTabId = 'a';
    const repoResult = userActionPalette([{ ...action, scope: 'repository' }], stale)[0];
    stores.repo.meta.path = 'C:/new repo';
    repoResult.run(); expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});
