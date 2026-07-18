import type { FileDiffMetadata } from '@pierre/diffs';

import { hashPatch } from './patch';
import type { PullRequestReviewThread } from './types';

export type PullRequestReviewFilter = 'all' | 'unviewed' | 'threads';
export type PullRequestFileVerdict = 'unviewed' | 'viewed' | 'changed';

export interface PullRequestThreadTarget {
  path: string;
  threadId: string;
}

const filePatchHashCache = new WeakMap<FileDiffMetadata, string>();

/** Fingerprint only the provider evidence rendered for this file. Pierre's
 * cacheKey can contain the whole PR patch key, so it is deliberately omitted:
 * an unrelated file changing must not invalidate this file's viewed mark. */
export function pullRequestFilePatchHash(file: FileDiffMetadata): string {
  let hash = filePatchHashCache.get(file);
  if (hash !== undefined) return hash;
  hash = hashPatch(JSON.stringify({
    name: file.name,
    prevName: file.prevName,
    newObjectId: file.newObjectId,
    prevObjectId: file.prevObjectId,
    mode: file.mode,
    prevMode: file.prevMode,
    type: file.type,
    hunks: file.hunks,
    isPartial: file.isPartial,
    deletionLines: file.deletionLines,
    additionLines: file.additionLines,
  }));
  filePatchHashCache.set(file, hash);
  return hash;
}

export function pullRequestReviewMark(headSha: string, patchHash: string): string {
  return `${headSha}:${patchHash}`;
}

export function pullRequestFileVerdict(
  storedMark: string | undefined,
  headSha: string,
  patchHash: string,
): PullRequestFileVerdict {
  if (storedMark === undefined) return 'unviewed';
  return storedMark === pullRequestReviewMark(headSha, patchHash) ? 'viewed' : 'changed';
}

export function unresolvedThreadCounts(
  threads: readonly PullRequestReviewThread[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.is_resolved) continue;
    counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
  }
  return counts;
}

export function filterPullRequestReviewPaths(
  paths: readonly string[],
  filter: PullRequestReviewFilter,
  verdicts: ReadonlyMap<string, PullRequestFileVerdict>,
  unresolvedByPath: ReadonlyMap<string, number>,
): string[] {
  if (filter === 'all') return [...paths];
  return paths.filter((path) => filter === 'unviewed'
    ? verdicts.get(path) !== 'viewed'
    : (unresolvedByPath.get(path) ?? 0) > 0);
}

export function unresolvedThreadTargets(
  paths: readonly string[],
  threads: readonly PullRequestReviewThread[],
): PullRequestThreadTarget[] {
  const pathOrder = new Map(paths.map((path, index) => [path, index]));
  return threads
    .filter((thread) => !thread.is_resolved && pathOrder.has(thread.path))
    .sort((left, right) => {
      const byPath = pathOrder.get(left.path)! - pathOrder.get(right.path)!;
      if (byPath !== 0) return byPath;
      const byLine = left.end_line - right.end_line;
      return byLine !== 0 ? byLine : left.id.localeCompare(right.id);
    })
    .map((thread) => ({ path: thread.path, threadId: thread.id }));
}

export function nextUnresolvedThreadTarget(
  targets: readonly PullRequestThreadTarget[],
  paths: readonly string[],
  currentPath: string | null,
  currentThreadId: string | null,
  direction: 1 | -1,
): PullRequestThreadTarget | null {
  if (targets.length === 0) return null;
  const exact = currentThreadId
    ? targets.findIndex((target) => target.threadId === currentThreadId)
    : -1;
  if (exact >= 0) return targets[(exact + direction + targets.length) % targets.length];

  if (currentPath) {
    const pathOrder = new Map(paths.map((path, index) => [path, index]));
    const currentOrder = pathOrder.get(currentPath);
    if (currentOrder === undefined) {
      return direction === 1 ? targets[0] : targets[targets.length - 1];
    }
    if (direction === 1) {
      const sameOrLater = targets.find((target) => pathOrder.get(target.path)! >= currentOrder);
      if (sameOrLater) return sameOrLater;
    } else {
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        if (pathOrder.get(targets[index].path)! <= currentOrder) return targets[index];
      }
    }
  }
  return direction === 1 ? targets[0] : targets[targets.length - 1];
}
