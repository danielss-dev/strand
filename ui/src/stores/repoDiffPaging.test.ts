import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffSummary, FileDiff } from '../lib/types';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('window', { localStorage });
vi.stubGlobal('navigator', { userAgent: '' });
vi.stubGlobal('document', { documentElement: { dataset: {} } });
const { tauri } = await import('../lib/tauri');
const { useRepo } = await import('./repo');
const { reviewSession } = await import('../lib/db');
const initial = useRepo.getState();
const summary = (path: string, revision = path): DiffSummary => ({ path, old_path: null, status: 'modified', revision });
const page = (path: string, revision = path): FileDiff => ({
  ...summary(path, revision), patch: `@@ -1 +1 @@\n-old\n+${revision}\n`, adds: 1, dels: 1, binary: false,
});
afterEach(() => { useRepo.setState(initial, true); vi.restoreAllMocks(); });

describe('repository patch demand', () => {
  it('persists file notes while summaries load, without inventing a line anchor', () => {
    const persist = vi.spyOn(reviewSession, 'setNotes').mockResolvedValue(undefined);
    useRepo.setState({ activePath: '/notes', reviewUnstagedDiffs: [{ ...page('a.ts'), patch: '', patchLoaded: false }] });
    useRepo.getState().addReviewNote('a.ts', 'Review the design', null);
    expect(useRepo.getState().reviewNotes['a.ts']).toHaveLength(1);
    expect(useRepo.getState().reviewNotes['a.ts'][0].text).toBe('Review the design');
    expect(useRepo.getState().reviewNotes['a.ts'][0].anchor).toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
    useRepo.getState().addReviewNote('a.ts', 'Unknown line', 3);
    expect(useRepo.getState().reviewNotes['a.ts']).toHaveLength(1);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('opens a large review with summaries and reads only demanded files until complete traversal is requested', async () => {
    const summaries = Array.from({ length: 70 }, (_, index) => summary(`file-${index}.ts`));
    vi.spyOn(tauri, 'repoDiffSummary').mockResolvedValue(summaries);
    const full = vi.spyOn(tauri, 'repoDiffSinceFull');
    const read = vi.spyOn(tauri, 'repoDiffFiles').mockImplementation(async (_, __, files) => files.map((file) => page(file)));
    useRepo.setState({ activePath: '/large' });
    await useRepo.getState().refreshReviewDiffs();
    expect(useRepo.getState().reviewUnstagedDiffs).toHaveLength(70);
    expect(read).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(useRepo.getState().reviewUnstagedDiffs.every((diff) => diff.patchLoaded === false)).toBe(true);
    await useRepo.getState().loadDiffFiles('review', ['file-0.ts', 'file-1.ts']);
    expect(read.mock.calls.map((call) => call[2])).toEqual([['file-0.ts', 'file-1.ts']]);
    await useRepo.getState().ensureAllDiffs('review');
    expect(read.mock.calls.map((call) => call[2].length)).toEqual([2, 32, 32, 4]);
    expect(useRepo.getState().reviewUnstagedDiffs.every((diff) => diff.patchLoaded)).toBe(true);
    const complete = useRepo.getState().reviewUnstagedDiffs;
    await useRepo.getState().refreshReviewDiffs();
    expect(useRepo.getState().reviewUnstagedDiffs).toBe(complete);
    await useRepo.getState().ensureAllDiffs('review');
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('does not publish an older page after a newer summary invalidates it', async () => {
    const readSummary = vi.spyOn(tauri, 'repoDiffSummary').mockResolvedValue([summary('a.ts', 'old')]);
    let resolve!: (files: FileDiff[]) => void;
    vi.spyOn(tauri, 'repoDiffFiles').mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue([page('a.ts', 'new')]);
    useRepo.setState({ activePath: '/race' });
    await useRepo.getState().refreshReviewDiffs();
    const pending = useRepo.getState().loadDiffFiles('review', ['a.ts']);
    const rejected = expect(pending).rejects.toThrow('comparison changed');
    readSummary.mockResolvedValue([summary('a.ts', 'new')]);
    await useRepo.getState().refreshReviewDiffs();
    resolve([page('a.ts', 'old')]);
    await rejected;
    expect(useRepo.getState().reviewUnstagedDiffs[0].patchLoaded).toBe(false);
    expect(useRepo.getState().reviewDiffsError).toBeNull();
    await useRepo.getState().loadDiffFiles('review', ['a.ts']);
    expect(useRepo.getState().reviewUnstagedDiffs[0].patch).toContain('+new');
  });

  it('refuses complete traversal after a page failure while retaining already inspected text', async () => {
    vi.spyOn(tauri, 'repoDiffSummary').mockResolvedValue([summary('a.ts', 'new')]);
    vi.spyOn(tauri, 'repoDiffFiles').mockRejectedValue(new Error('Patch exceeds the 4 MiB page limit. Open the file.'));
    useRepo.setState({ activePath: '/failed', reviewUnstagedDiffs: [page('a.ts', 'old')] });
    await useRepo.getState().refreshReviewDiffs();
    await expect(useRepo.getState().ensureAllDiffs('review')).rejects.toThrow('4 MiB');
    expect(useRepo.getState().reviewUnstagedDiffs[0].patch).toContain('+old');
    expect(useRepo.getState().reviewUnstagedDiffs[0].patchLoaded).toBe(false);
    expect(useRepo.getState().reviewDiffsError).toContain('4 MiB');
  });
});
