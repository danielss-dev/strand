import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../lib/types';
import type { ReviewedStageState } from '../lib/reviewedStage';
import { hashPatch } from '../lib/patch';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('window', { localStorage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });
const { tauri } = await import('../lib/tauri');
const { useRepo } = await import('./repo');
const initial = useRepo.getState();
const file: FileDiff = { path: 'new.ts', old_path: 'historic.ts', status: 'renamed', adds: 1, dels: 1, binary: false, patch: 'inspected complete patch' };
const state: ReviewedStageState = { workdir: '/repo', git_dir: '/repo/.git', common_dir: '/repo/.git', head_ref: 'refs/heads/main', head_oid: 'head', index_hash: 'index' };
beforeEach(() => { useRepo.setState({ loadDiffFiles: async () => [] }); });
afterEach(() => { useRepo.setState(initial, true); vi.restoreAllMocks(); });

describe('Stage reviewed native content contract', () => {
  it('captures identity before refresh and sends complete inspected patches to native staging', async () => {
    const calls: string[] = [];
    vi.spyOn(tauri, 'repoReviewedStageState').mockImplementation(async () => { calls.push('identity'); return state; });
    const stage = vi.spyOn(tauri, 'repoStageReviewed').mockImplementation(async () => { calls.push('stage'); });
    const oldStage = vi.spyOn(tauri, 'repoStageMany');
    useRepo.setState({
      activePath: '/repo', baseline: { oid: 'baseline', short: 'base', setAt: 0 }, baselineDiffs: [file], reviewed: { [file.path]: hashPatch(file.patch) },
      reviewDiffsError: null,
      refreshReviewDiffs: async () => { calls.push('refresh'); },
      refreshLocalChanges: async () => { calls.push('after'); },
    });
    await useRepo.getState().stageReviewed();
    expect(calls).toEqual(['identity', 'refresh', 'stage', 'after']);
    expect(stage).toHaveBeenCalledWith('/repo', state, 'baseline', [file]);
    expect(oldStage).not.toHaveBeenCalled();
  });

  it('never stages retained patches after a failed refresh', async () => {
    vi.spyOn(tauri, 'repoReviewedStageState').mockResolvedValue(state);
    const stage = vi.spyOn(tauri, 'repoStageReviewed');
    useRepo.setState({ activePath: '/repo', baseline: null, reviewUnstagedDiffs: [file], reviewed: { [file.path]: hashPatch(file.patch) },
      refreshReviewDiffs: async () => { useRepo.setState({ reviewDiffsError: 'temporary read failure' }); } });
    await expect(useRepo.getState().stageReviewed()).rejects.toThrow('temporary read failure');
    expect(stage).not.toHaveBeenCalled();
  });

  it('does not stage a mark invalidated by the refreshed content', async () => {
    vi.spyOn(tauri, 'repoReviewedStageState').mockResolvedValue(state);
    const stage = vi.spyOn(tauri, 'repoStageReviewed');
    useRepo.setState({ activePath: '/repo', baseline: null, reviewDiffsError: null, reviewUnstagedDiffs: [file], reviewed: { [file.path]: hashPatch(file.patch) },
      refreshReviewDiffs: async () => { useRepo.setState({ reviewUnstagedDiffs: [{ ...file, patch: 'changed' }] }); } });
    await useRepo.getState().stageReviewed();
    expect(stage).not.toHaveBeenCalled();
  });

  it('loads only marked paths and never accepts an unloaded placeholder', async () => {
    vi.spyOn(tauri, 'repoReviewedStageState').mockResolvedValue(state);
    const stage = vi.spyOn(tauri, 'repoStageReviewed');
    const load = vi.fn(async () => []);
    useRepo.setState({ activePath: '/repo', baseline: null, reviewDiffsError: null, reviewUnstagedDiffs: [{ ...file, patchLoaded: false }], reviewed: { [file.path]: hashPatch(file.patch) },
      refreshReviewDiffs: async () => {}, loadDiffFiles: load });
    await useRepo.getState().stageReviewed();
    expect(load).toHaveBeenCalledWith('review', [file.path]);
    expect(stage).not.toHaveBeenCalled();
  });

  it('stops when the active repository changes while native identity loads', async () => {
    vi.spyOn(tauri, 'repoReviewedStageState').mockImplementation(async () => { useRepo.setState({ activePath: '/other' }); return state; });
    const refresh = vi.fn(async () => {});
    const stage = vi.spyOn(tauri, 'repoStageReviewed');
    useRepo.setState({ activePath: '/repo', baseline: null, refreshReviewDiffs: refresh });
    await useRepo.getState().stageReviewed();
    expect(refresh).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('propagates native stale-state rejection without falling back to ordinary Stage', async () => {
    vi.spyOn(tauri, 'repoReviewedStageState').mockResolvedValue(state);
    vi.spyOn(tauri, 'repoStageReviewed').mockRejectedValue(new Error('The index changed'));
    const oldStage = vi.spyOn(tauri, 'repoStageMany');
    useRepo.setState({ activePath: '/repo', baseline: null, reviewDiffsError: null, reviewUnstagedDiffs: [file], reviewed: { [file.path]: hashPatch(file.patch) }, refreshReviewDiffs: async () => {} });
    await expect(useRepo.getState().stageReviewed()).rejects.toThrow('The index changed');
    expect(oldStage).not.toHaveBeenCalled();
  });
});
