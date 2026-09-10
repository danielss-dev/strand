import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffSummary, FileDiff, RepoMeta } from '../lib/types';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('window', { localStorage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });
const { tauri } = await import('../lib/tauri');
const { reviewSession } = await import('../lib/db');
const { useRepo } = await import('./repo');
const initial = useRepo.getState();
const meta: RepoMeta = {
  name: 'repo', path: '/repo', branch: 'main', head_oid: 'abc', ahead: 0, behind: 0,
  detached: false, operation: null, common_dir: '/repo/.git', is_linked_worktree: false,
};
const diff: FileDiff = { path: 'a.ts', old_path: null, status: 'modified', adds: 1, dels: 1, binary: false, patch: 'previous comparison' };

afterEach(() => { useRepo.setState(initial, true); vi.restoreAllMocks(); });

describe('review refresh failures', () => {
  it('preserves the pinned baseline, comparison, and notes until a successful retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const persist = vi.spyOn(reviewSession, 'setBaseline').mockResolvedValue(undefined);
    const notesRead = vi.spyOn(reviewSession, 'getNotes').mockResolvedValue(null);
    const read = vi.spyOn(tauri, 'repoDiffSummary').mockRejectedValue(new Error('pinned object unavailable'));
    const baseline = { oid: 'baseline', short: 'baselin', setAt: 1 };
    const diffs = [diff];
    const notes = { 'a.ts': [{ id: 'one', text: 'check this', line: null, createdAt: 1 }] };
    useRepo.setState({ activePath: '/repo', meta, baseline, baselineDiffs: diffs, reviewNotes: notes });
    await useRepo.getState().refreshReviewDiffs();
    const failed = useRepo.getState();
    expect(failed.baseline).toBe(baseline);
    expect(failed.baselineDiffs).toBe(diffs);
    expect(failed.reviewNotes).toBe(notes);
    expect(failed.reviewDiffsError).toContain('pinned object unavailable');
    expect(failed.reviewDiffsLoading).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(notesRead).not.toHaveBeenCalled();

    let resolve!: (diffs: DiffSummary[]) => void;
    read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const retry = useRepo.getState().refreshReviewDiffs();
    await Promise.resolve();
    expect(useRepo.getState().reviewDiffsLoading).toBe(true);
    expect(useRepo.getState().reviewDiffsError).toContain('pinned object unavailable');
    resolve([{ path: diff.path, old_path: null, status: diff.status, revision: 'updated' }]);
    await retry;
    vi.spyOn(tauri, 'repoDiffFiles').mockResolvedValue([{ ...diff, patch: 'updated comparison', revision: 'updated' }]);
    await useRepo.getState().loadDiffFiles('review', [diff.path]);
    expect(useRepo.getState().baseline).toBe(baseline);
    expect(useRepo.getState().baselineDiffs[0].patch).toBe('updated comparison');
    expect(useRepo.getState().reviewDiffsError).toBeNull();
    expect(useRepo.getState().reviewDiffsLoading).toBe(false);
    expect(read).toHaveBeenLastCalledWith('/repo', { kind: 'review', baseline: 'baseline' });
  });

  it('distinguishes a failed unborn inbox read from a successful empty comparison', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.spyOn(tauri, 'repoDiffSummary').mockRejectedValue(new Error('index unreadable'));
    useRepo.setState({ activePath: '/repo', meta: { ...meta, head_oid: null } });
    await useRepo.getState().refreshReviewDiffs();
    expect(read).toHaveBeenCalledWith('/repo', { kind: 'review', baseline: 'HEAD' });
    expect(useRepo.getState().reviewDiffsError).toContain('index unreadable');
    read.mockResolvedValue([]);
    await useRepo.getState().refreshReviewDiffs();
    expect(useRepo.getState().reviewUnstagedDiffs).toEqual([]);
    expect(useRepo.getState().reviewDiffsError).toBeNull();
  });

  it('does not publish a failed read into another active repository', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    vi.spyOn(tauri, 'repoDiffSummary').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    useRepo.setState({ activePath: '/repo', meta });
    const pending = useRepo.getState().refreshReviewDiffs();
    await Promise.resolve();
    useRepo.setState({ activePath: '/other', reviewDiffsError: null, reviewDiffsLoading: false });
    reject(new Error('old repository failed'));
    await pending;
    expect(useRepo.getState().reviewDiffsError).toBeNull();
  });
});
