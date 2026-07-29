import { afterEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, value); },
};
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('window', { localStorage: storage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });

const { tauri } = await import('../lib/tauri');
const { useRepo } = await import('./repo');

const original = useRepo.getState();

afterEach(() => {
  useRepo.setState(original, true);
  vi.restoreAllMocks();
});

describe('repository navigation state', () => {
  it('drops historical Files context when leaving history views', () => {
    useRepo.setState({
      view: 'commits',
      selectedCommit: 'deadbeef',
      selectedCommitDiffs: [{
        path: 'old.txt',
        old_path: null,
        status: 'modified',
        adds: 1,
        dels: 0,
        patch: '',
        binary: false,
      }],
      selectedCommitDiffsLoading: true,
    });

    useRepo.getState().setView('work');

    expect(useRepo.getState()).toMatchObject({
      view: 'work',
      selectedCommit: null,
      selectedCommitDiffs: [],
      selectedCommitDiffsLoading: false,
    });
  });

  it('refreshes worktree branch labels after checkout', async () => {
    const refreshLocalChanges = vi.fn(async () => {});
    const refreshLog = vi.fn(async () => {});
    const refreshWorktrees = vi.fn(async () => {});
    const checkout = vi.spyOn(tauri, 'repoCheckout').mockResolvedValue({ branch: 'feature' });
    useRepo.setState({
      activePath: '/repo',
      refreshLocalChanges,
      refreshLog,
      refreshWorktrees,
    });

    await useRepo.getState().checkout('feature');

    expect(checkout).toHaveBeenCalledWith('/repo', 'feature');
    expect(refreshLocalChanges).toHaveBeenCalledOnce();
    expect(refreshLog).toHaveBeenCalledOnce();
    expect(refreshWorktrees).toHaveBeenCalledOnce();
  });
});
