import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, RepoMeta } from '../lib/types';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('window', { localStorage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });
const { tauri } = await import('../lib/tauri');
const { useRepo } = await import('./repo');
const initial = useRepo.getState();
const meta: RepoMeta = {
  name: 'repo', path: '/repo', branch: 'main', head_oid: 'abc', ahead: 0, behind: 0,
  detached: false, operation: null, common_dir: '/repo/.git', is_linked_worktree: false,
};
const snapshot = { meta, status: [], work_tree: [], refs: initial.refs, submodules: [] };
const diff: FileDiff = { path: 'a.ts', old_path: null, status: 'modified', adds: 1, dels: 1, binary: false, patch: 'old' };

afterEach(() => { useRepo.setState(initial, true); vi.restoreAllMocks(); });

describe('repository refresh lifecycle', () => {
  it('keeps hidden patches unloaded even with a pinned baseline', async () => {
    vi.spyOn(tauri, 'repoSnapshot').mockResolvedValue(snapshot);
    const local = vi.spyOn(tauri, 'repoDiffUnstaged').mockResolvedValue([]);
    const review = vi.spyOn(tauri, 'repoDiffSinceFull').mockResolvedValue([]);
    const log = vi.spyOn(tauri, 'repoLog').mockResolvedValue([]);
    useRepo.setState({ activePath: '/repo', meta, view: 'work', baseline: { oid: 'abc', short: 'abc', setAt: 0 } });
    await useRepo.getState().handleExternalChange('/repo');
    expect(local).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(useRepo.getState().localDiffsDirty).toBe(true);
  });

  it('refreshes a mounted composed Review pane and stops after it releases', async () => {
    vi.spyOn(tauri, 'repoSnapshot').mockResolvedValue(snapshot);
    const local = vi.spyOn(tauri, 'repoDiffUnstaged').mockResolvedValue([]);
    vi.spyOn(tauri, 'repoDiffStaged').mockResolvedValue([]);
    const review = vi.spyOn(tauri, 'repoDiffSinceFull').mockResolvedValue([]);
    useRepo.setState({ activePath: '/repo', meta, view: 'work' });
    const release = useRepo.getState().retainDiffs('/repo', 'review');
    try { await useRepo.getState().refreshLocalChanges(); } finally { release(); }
    await useRepo.getState().refreshLocalChanges();
    expect(local).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
  });

  it('does not publish an old snapshot after switching A → B → A', async () => {
    let resolve!: (value: typeof snapshot) => void;
    vi.spyOn(tauri, 'repoSnapshot').mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    useRepo.setState({ activePath: '/repo', meta });
    const pending = useRepo.getState().refreshSnapshot();
    await Promise.resolve();
    useRepo.setState({ activePath: '/other' });
    useRepo.setState({ activePath: '/repo' });
    resolve({ ...snapshot, meta: { ...meta, branch: 'obsolete' } });
    await pending;
    expect(useRepo.getState().meta?.branch).toBe('main');
  });

  it('drains changes arriving during a read without publishing the superseded snapshot', async () => {
    let resolve!: (value: typeof snapshot) => void;
    const read = vi.spyOn(tauri, 'repoSnapshot')
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ ...snapshot, meta: { ...meta, branch: 'newest' } });
    useRepo.setState({ activePath: '/repo', meta });
    const published: string[] = [];
    const stop = useRepo.subscribe((state) => { if (state.meta) published.push(state.meta.branch); });
    const first = useRepo.getState().refreshSnapshot();
    await Promise.resolve();
    const trailing = Array.from({ length: 10 }, () => useRepo.getState().refreshSnapshot());
    resolve({ ...snapshot, meta: { ...meta, branch: 'obsolete' } });
    await Promise.all([first, ...trailing]);
    stop();
    expect(read).toHaveBeenCalledTimes(2);
    expect(published).not.toContain('obsolete');
    expect(useRepo.getState().meta?.branch).toBe('newest');
  });

  it('keeps unchanged diff objects but updates the same modified path when content changes', async () => {
    const unchanged = { ...diff, path: 'b.ts' };
    const read = vi.spyOn(tauri, 'repoDiffUnstaged').mockResolvedValue([{ ...diff }, { ...unchanged }]);
    vi.spyOn(tauri, 'repoDiffStaged').mockResolvedValue([]);
    const rows = [diff, unchanged];
    useRepo.setState({ activePath: '/repo', unstagedDiffs: rows });
    await useRepo.getState().refreshDiffs();
    expect(useRepo.getState().unstagedDiffs).toBe(rows);
    read.mockResolvedValue([{ ...diff, patch: 'new' }, { ...unchanged }]);
    await useRepo.getState().refreshDiffs();
    expect(useRepo.getState().unstagedDiffs[0].patch).toBe('new');
    expect(useRepo.getState().unstagedDiffs[1]).toBe(unchanged);
  });

  it('loads only paths before hidden Stage all and includes rename sources', async () => {
    vi.spyOn(tauri, 'repoDiffUnstagedPaths').mockResolvedValue([{ path: diff.path, old_path: 'old.ts' }]);
    const patches = vi.spyOn(tauri, 'repoDiffUnstaged');
    vi.spyOn(tauri, 'repoSnapshot').mockResolvedValue(snapshot);
    const stage = vi.spyOn(tauri, 'repoStageMany').mockResolvedValue(undefined);
    useRepo.setState({ activePath: '/repo', meta, view: 'work', localDiffsDirty: true });
    await useRepo.getState().stageAll();
    expect(stage).toHaveBeenCalledWith('/repo', ['a.ts', 'old.ts']);
    expect(patches).not.toHaveBeenCalled();
  });

  it('refreshes loaded history after HEAD changes and preserves it on file-only refreshes', async () => {
    const next = { ...snapshot, meta: { ...meta, head_oid: 'next' } };
    vi.spyOn(tauri, 'repoSnapshot').mockResolvedValue(next);
    const commits = [{ hash: 'abc' }] as ReturnType<typeof useRepo.getState>['commits'];
    const log = vi.spyOn(tauri, 'repoLog').mockResolvedValue(commits);
    useRepo.setState({ activePath: '/repo', meta, commits, refs: snapshot.refs });
    await useRepo.getState().refreshSnapshot();
    await useRepo.getState().refreshSnapshot();
    expect(log).toHaveBeenCalledOnce();
    expect(useRepo.getState().commits).toBe(commits);
  });
});
