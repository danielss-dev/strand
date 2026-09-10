import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffLoaded, diffReviewable, mergeDiffSummaries, readDiffPages, reviewDiffPoolKey } from './diffPages';
import { aiRequestMatches } from './aiGeneration';
import { tauri } from './tauri';
import type { FileDiff } from './types';

const file = (path: string, revision: string | null = path): FileDiff => ({
  path, old_path: null, status: 'modified', patch: `patch:${path}`, adds: 1, dels: 1,
  binary: false, revision, patchLoaded: true,
});
afterEach(() => vi.restoreAllMocks());

describe('bounded diff cache', () => {
  it('reuses only a loaded matching non-null content revision', () => {
    const loaded = file('a.ts', 'content-a');
    const pool = [loaded];
    const summary = { path: loaded.path, old_path: null, status: loaded.status, revision: 'content-a' };
    expect(mergeDiffSummaries(pool, [summary])).toBe(pool);
    const changed = mergeDiffSummaries(pool, [{ ...summary, revision: 'content-b' }])[0];
    expect(changed.patchLoaded).toBe(false);
    expect(changed.patch).toBe(loaded.patch);
    expect(diffReviewable(changed)).toBe(false);
    expect(mergeDiffSummaries([file('a.ts', null)], [{ ...summary, revision: null }])[0].patchLoaded).toBe(false);
  });

  it('keeps the revision from the actual returned patch rather than its earlier summary', async () => {
    const loaded = file('a.ts', 'page-content');
    vi.spyOn(tauri, 'repoDiffFiles').mockResolvedValue([loaded]);
    let result: FileDiff[] = [];
    await readDiffPages('/repo', { kind: 'review', baseline: 'HEAD' }, ['a.ts'], true, 1, (page) => { result = page; });
    expect(result[0].revision).toBe('page-content');
    const next = mergeDiffSummaries(result, [{ path: 'a.ts', old_path: null, status: 'modified', revision: 'earlier-summary' }]);
    expect(next[0].patchLoaded).toBe(false);
  });

  it('fetches no more than 32 files per page and publishes each completed page', async () => {
    const files = Array.from({ length: 70 }, (_, index) => `file-${index}.ts`);
    const read = vi.spyOn(tauri, 'repoDiffFiles').mockImplementation(async (_, __, paths) => paths.map((path) => file(path)));
    const pages: FileDiff[][] = [];
    await readDiffPages('/many', { kind: 'unstaged' }, files, false, 1, (page) => pages.push(page));
    expect(read.mock.calls.map((call) => call[2].length)).toEqual([32, 32, 6]);
    expect(pages.map((page) => page.length)).toEqual([32, 32, 6]);
    expect(pages.flat().every(diffLoaded)).toBe(true);
  });

  it('splits an oversized multi-file page and stops on an oversized single file', async () => {
    const read = vi.spyOn(tauri, 'repoDiffFiles').mockImplementation(async (_, __, paths) => {
      if (paths.length > 1) throw { message: 'Patch exceeds the 4 MiB page limit. Open the file.' };
      return paths.map((path) => file(path));
    });
    const pages: FileDiff[][] = [];
    await readDiffPages('/large', { kind: 'staged' }, ['a', 'b', 'c'], false, 1, (page) => pages.push(page));
    expect(read.mock.calls.map((call) => call[2])).toEqual([['a', 'b', 'c'], ['a', 'b'], ['a'], ['b'], ['c']]);
    expect(pages.flat().map((diff) => diff.path)).toEqual(['a', 'b', 'c']);
    read.mockRejectedValue(new Error('Patch exceeds the 4 MiB page limit. Open the file.'));
    const publish = vi.fn();
    await expect(readDiffPages('/too-large', { kind: 'staged' }, ['huge'], false, 1, publish)).rejects.toThrow('4 MiB');
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses missing files and does not split ordinary read failures', async () => {
    const read = vi.spyOn(tauri, 'repoDiffFiles').mockResolvedValue([]);
    const publish = vi.fn();
    await expect(readDiffPages('/removed', { kind: 'unstaged' }, ['gone'], false, 1, publish)).rejects.toThrow('Changes moved');
    expect(publish).not.toHaveBeenCalled();
    read.mockRejectedValue(new Error('index unreadable'));
    await expect(readDiffPages('/broken', { kind: 'unstaged' }, ['a', 'b'], false, 1, publish)).rejects.toThrow('index unreadable');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never marks unknown binary content or unloaded summaries reviewed', () => {
    expect(diffReviewable({ ...file('a.png'), binary: true })).toBe(true);
    expect(diffReviewable({ ...file('a.png', null), binary: true })).toBe(false);
    expect(diffReviewable({ ...file('a.ts'), patchLoaded: false })).toBe(false);
  });

  it('keeps AI requests bound to the live hydrated pool while later edits invalidate them', () => {
    const loaded = file('a.ts', 'one');
    const pending = { ...loaded, patchLoaded: false };
    const request = { opId: 'review', path: '/repo', provider: 'openai' as const, target: reviewDiffPoolKey(null, [loaded]) };
    expect(reviewDiffPoolKey(null, [pending])).not.toBe(request.target);
    // A render of the formerly pending pool must compare the request with
    // the live store's hydrated identity, rather than cancelling it itself.
    expect(aiRequestMatches(request, { ...request, target: reviewDiffPoolKey(null, [loaded]) })).toBe(true);
    const edited = { ...loaded, patch: '+agent edited again', revision: 'two' };
    expect(aiRequestMatches(request, { ...request, target: reviewDiffPoolKey(null, [edited]) })).toBe(false);
  });
});
