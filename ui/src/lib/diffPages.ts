import { errMessage, tauri } from './tauri';
import { hashFileDiff } from './patch';
import type { DiffSummary, FileDiff, WorkingDiffSource } from './types';

export const diffLoaded = (diff: FileDiff): boolean => diff.patchLoaded !== false;
export const diffReviewable = (diff: FileDiff): boolean => diffLoaded(diff) && (!diff.binary || diff.revision != null);

export function reviewDiffPoolKey(baselineOid: string | null, pool: FileDiff[]): string {
  return `${baselineOid ?? 'uncommitted'}\0${pool.map((diff) => `${diff.path}:${diffLoaded(diff) ? hashFileDiff(diff) : `pending:${diff.revision}`}`).join('\0')}`;
}

/** Status rows never establish content equality. Only native content tokens do. */
export function mergeDiffSummaries(previous: FileDiff[], summaries: DiffSummary[]): FileDiff[] {
  const byPath = new Map(previous.map((diff) => [diff.path, diff]));
  const next = summaries.map((summary) => {
    const old = byPath.get(summary.path);
    if (old && diffLoaded(old) && old.revision != null && old.revision === summary.revision
      && old.old_path === summary.old_path && old.status === summary.status) return old;
    return {
      ...summary,
      adds: old?.adds ?? 0,
      dels: old?.dels ?? 0,
      binary: old?.binary ?? false,
      patch: old?.patch ?? '',
      patchLoaded: false,
      patchError: null,
    };
  });
  return next.length === previous.length && next.every((diff, index) => diff === previous[index]) ? previous : next;
}

/** Reuse one request for every consumer of the same source, generation and page. */
const pending = new Map<string, Promise<FileDiff[]>>();

async function readBoundedPage(path: string, source: WorkingDiffSource, files: string[], fullContext: boolean): Promise<FileDiff[]> {
  try {
    return await tauri.repoDiffFiles(path, source, files, fullContext);
  } catch (error) {
    const message = errMessage(error);
    if (files.length < 2 || !message.startsWith('Patch exceeds the 4 MiB page limit.')) throw error;
    const middle = Math.ceil(files.length / 2);
    const first = await readBoundedPage(path, source, files.slice(0, middle), fullContext);
    const second = await readBoundedPage(path, source, files.slice(middle), fullContext);
    return [...first, ...second];
  }
}

export async function readDiffPages(
  path: string,
  source: WorkingDiffSource,
  files: string[],
  fullContext: boolean,
  generation: number,
  publish: (page: FileDiff[]) => void,
): Promise<void> {
  const unique = [...new Set(files)];
  for (let offset = 0; offset < unique.length; offset += 32) {
    const batch = unique.slice(offset, offset + 32);
    const key = JSON.stringify([path, source, fullContext, generation, batch]);
    let request = pending.get(key);
    if (!request) {
      request = readBoundedPage(path, source, batch, fullContext);
      pending.set(key, request);
      void request.finally(() => pending.delete(key)).catch(() => {});
    }
    const page = await request;
    if (batch.some((file) => !page.some((diff) => diff.path === file))) {
      throw new Error('Changes moved while loading a patch. Refresh the comparison and retry.');
    }
    publish(page.map((diff) => ({ ...diff, patchLoaded: true, patchError: null })));
  }
}
