import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoMeta } from '../lib/types';

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
const { addAiReviewNoteSet, useRepo } = await import('./repo');

const original = useRepo.getState();

afterEach(() => {
  useRepo.setState(original, true);
  vi.restoreAllMocks();
});

describe('repository navigation state', () => {
  it('drops the explicit action ref when its repository is deactivated', () => {
    useRepo.setState({ activeTabPath: '/repo', activePath: '/repo' });
    useRepo.getState().selectRef('refs/heads/topic');
    useRepo.getState().deactivateTab();
    expect(useRepo.getState().selectedRef).toBeNull();
  });

  it('drops historical Files context when leaving history views', () => {
    useRepo.setState({
      view: 'commits',
      selectedCommit: 'deadbeef',
      selectedRef: 'refs/heads/topic',
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
      selectedRef: null,
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

  it('keeps staged files in the uncommitted Review pool', async () => {
    const diffs = [{
      path: 'staged.ts', old_path: null, status: 'modified', adds: 1, dels: 0,
      patch: '@@ -1 +1 @@\n-old\n+new\n', binary: false,
    }] as const;
    const diffSince = vi.spyOn(tauri, 'repoDiffSinceFull').mockResolvedValue([...diffs]);
    useRepo.setState({ activePath: '/repo', baseline: null, reviewUnstagedDiffs: [] });

    await useRepo.getState().refreshReviewDiffs();

    expect(diffSince).toHaveBeenCalledWith('/repo', 'HEAD');
    expect(useRepo.getState().reviewUnstagedDiffs).toEqual(diffs);
  });

  it('pins the initial baseline at the detected branch fork point', async () => {
    const setBaseline = vi.fn(async () => {});
    const detect = vi.spyOn(tauri, 'repoDetectBaseBranch').mockResolvedValue({
      name: 'main',
      merge_base: '1234567890',
    });
    useRepo.setState({
      activePath: '/repo',
      meta: { branch: 'feature', detached: false } as RepoMeta,
      setBaseline,
    });

    await expect(useRepo.getState().setBranchBaseline()).resolves.toEqual({
      name: 'main',
      merge_base: '1234567890',
    });
    expect(detect).toHaveBeenCalledWith('/repo', 'feature');
    expect(setBaseline).toHaveBeenCalledWith('1234567890');
  });
});

describe('AI review notes', () => {
  it('adds accepted AI findings without touching existing feedback', () => {
    const next = addAiReviewNoteSet(
      {
        'src/old.ts': [
          { id: 'human', text: 'Keep this', line: null, createdAt: 1 },
          { id: 'old-ai', text: 'Existing finding', line: 2, source: 'ai', severity: 'low', createdAt: 2 },
        ],
        'src/ai-only.ts': [
          { id: 'old-only', text: 'Keep this too', line: null, source: 'ai', severity: 'medium', createdAt: 3 },
        ],
      },
      [{
        path: 'src/new.ts',
        line: 7,
        side: 'new',
        severity: 'high',
        title: 'Possible race',
        body: 'The shared value is not synchronized.',
      }],
    );

    expect(next['src/old.ts']).toEqual([
      { id: 'human', text: 'Keep this', line: null, createdAt: 1 },
      { id: 'old-ai', text: 'Existing finding', line: 2, source: 'ai', severity: 'low', createdAt: 2 },
    ]);
    expect(next['src/ai-only.ts']).toEqual([
      { id: 'old-only', text: 'Keep this too', line: null, source: 'ai', severity: 'medium', createdAt: 3 },
    ]);
    expect(next['src/new.ts']).toMatchObject([{
      text: 'Possible race — The shared value is not synchronized.',
      line: 7,
      source: 'ai',
      severity: 'high',
    }]);
  });
});


describe('commit outcome boundary', () => {
  it('propagates a hook rejection and refreshes its index changes', async () => {
    const refresh = vi.fn(async () => {});
    const failure = { message: 'commit-msg rejected' };
    vi.spyOn(tauri, 'repoCommit').mockRejectedValue(failure);
    useRepo.setState({ activePath: '/repo', refreshLocalChanges: refresh });
    await expect(useRepo.getState().commit('draft', 'body', true)).rejects.toBe(failure);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps a completed commit successful if refresh fails', async () => {
    const outcome = { oid: 'abc', amended: false, output: 'hook accepted' };
    vi.spyOn(tauri, 'repoCommit').mockResolvedValue(outcome);
    const refresh = vi.fn(async () => { throw new Error('refresh failed'); });
    useRepo.setState({ activePath: '/repo', refreshLocalChanges: refresh,
      refreshLog: refresh, refreshStashes: refresh, refreshMeta: refresh, refreshRefs: refresh });
    await expect(useRepo.getState().commit('draft', null, false)).resolves.toEqual(outcome);
  });

  it('does not refresh a different checkout after a slow hook completes', async () => {
    const refresh = vi.fn(async () => {});
    vi.spyOn(tauri, 'repoCommit').mockImplementation(async () => {
      useRepo.setState({ activePath: '/other' });
      return { oid: 'abc', amended: false, output: '' };
    });
    useRepo.setState({ activePath: '/repo', refreshLocalChanges: refresh, refreshLog: refresh });
    await useRepo.getState().commit('draft', null, false);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('tag outcome boundary', () => {
  it('keeps a created signed tag successful if refresh fails', async () => {
    vi.spyOn(tauri, 'repoTagCreate').mockResolvedValue(undefined);
    const refresh = vi.fn(async () => { throw new Error('refresh failed'); });
    useRepo.setState({ activePath: '/repo', refreshRefs: refresh, refreshLog: refresh });
    await expect(useRepo.getState().createTag('release', null, 'annotation', 'sign')).resolves.toBeUndefined();
    expect(tauri.repoTagCreate).toHaveBeenCalledWith('/repo', 'release', null, 'annotation', false, 'sign');
  });

  it('does not refresh another checkout after the signer completes', async () => {
    const refresh = vi.fn(async () => {});
    vi.spyOn(tauri, 'repoTagCreate').mockImplementation(async () => {
      useRepo.setState({ activePath: '/other' });
    });
    useRepo.setState({ activePath: '/repo', refreshRefs: refresh, refreshLog: refresh });
    await useRepo.getState().createTag('release', null, 'annotation');
    expect(refresh).not.toHaveBeenCalled();
  });
});
