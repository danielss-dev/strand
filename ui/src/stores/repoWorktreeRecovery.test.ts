import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoMeta } from '../lib/types';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('window', { localStorage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });
const { tauri } = await import('../lib/tauri');
const { useRepo } = await import('./repo');
const initial = useRepo.getState();
const meta: RepoMeta = {
  name: 'repo', path: '/feature', branch: 'feature', head_oid: 'abc', ahead: 0, behind: 0,
  detached: false, operation: null, common_dir: '/repo/.git', is_linked_worktree: true,
};

afterEach(() => { useRepo.setState(initial, true); vi.restoreAllMocks(); });

describe('worktree recovery before removal', () => {
  it('propagates the native archive refusal and leaves the open worktree intact', async () => {
    const error = new Error('Worktree was not removed because its recovery archive failed: filter failed. Fix the archive error and retry.');
    vi.spyOn(tauri, 'repoWorktreeRemove').mockRejectedValue(error);
    const closeTab = vi.fn();
    const refreshWorktrees = vi.fn();
    const tabs = [{ path: '/feature', meta }];
    useRepo.setState({ activePath: '/repo', tabs, closeTab, refreshWorktrees });

    await expect(useRepo.getState().removeWorktree('/feature', true)).rejects.toThrow(error);

    expect(useRepo.getState().tabs).toBe(tabs);
    expect(closeTab).not.toHaveBeenCalled();
    expect(refreshWorktrees).not.toHaveBeenCalled();
  });

  it('closes the removed worktree only after the native archive and removal succeed', async () => {
    let complete!: () => void;
    vi.spyOn(tauri, 'repoWorktreeRemove').mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const closeTab = vi.fn();
    const refreshWorktrees = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ activePath: '/repo', tabs: [{ path: '/feature', meta }], closeTab, refreshWorktrees });
    const removal = useRepo.getState().removeWorktree('/feature', true);
    expect(closeTab).not.toHaveBeenCalled();
    complete();
    await removal;
    expect(closeTab).toHaveBeenCalledWith('/feature');
    expect(refreshWorktrees).toHaveBeenCalledOnce();
  });
});
