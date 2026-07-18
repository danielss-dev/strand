import { describe, expect, it } from 'vitest';

import {
  filterPullRequestReviewPaths,
  nextUnresolvedThreadTarget,
  pullRequestFileVerdict,
  pullRequestFilePatchHash,
  pullRequestReviewMark,
  unresolvedThreadCounts,
  unresolvedThreadTargets,
} from './pullRequestReview';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { PullRequestReviewThread } from './types';

const thread = (
  id: string,
  path: string,
  endLine: number,
  isResolved = false,
): PullRequestReviewThread => ({
  id,
  path,
  start_line: endLine,
  end_line: endLine,
  side: 'additions',
  is_resolved: isResolved,
  is_outdated: false,
  can_reply: true,
  can_resolve: true,
  can_unresolve: false,
  comments: [],
});

describe('pull request review ledger', () => {
  it('fingerprints only the rendered file evidence, not Pierre whole-patch cache keys', () => {
    const file = (line: string, cacheKey: string): FileDiffMetadata => ({
      name: 'a.ts',
      type: 'change',
      hunks: [],
      splitLineCount: 1,
      unifiedLineCount: 1,
      isPartial: true,
      deletionLines: ['old'],
      additionLines: [line],
      cacheKey,
    });
    expect(pullRequestFilePatchHash(file('new', 'whole-pr-a')))
      .toBe(pullRequestFilePatchHash(file('new', 'whole-pr-b')));
    expect(pullRequestFilePatchHash(file('changed', 'whole-pr-b')))
      .not.toBe(pullRequestFilePatchHash(file('new', 'whole-pr-a')));
  });

  it('invalidates a viewed mark when either the head or file patch changes', () => {
    const mark = pullRequestReviewMark('head-a', 'patch-a');
    expect(pullRequestFileVerdict(undefined, 'head-a', 'patch-a')).toBe('unviewed');
    expect(pullRequestFileVerdict(mark, 'head-a', 'patch-a')).toBe('viewed');
    expect(pullRequestFileVerdict(mark, 'head-b', 'patch-a')).toBe('changed');
    expect(pullRequestFileVerdict(mark, 'head-a', 'patch-b')).toBe('changed');
  });

  it('counts only unresolved threads and filters the file queue', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    const threads = [thread('1', 'b.ts', 4), thread('2', 'b.ts', 8), thread('3', 'c.ts', 2, true)];
    const counts = unresolvedThreadCounts(threads);
    const verdicts = new Map([
      ['a.ts', 'viewed' as const],
      ['b.ts', 'unviewed' as const],
      ['c.ts', 'changed' as const],
    ]);
    expect(counts).toEqual(new Map([['b.ts', 2]]));
    expect(filterPullRequestReviewPaths(paths, 'all', verdicts, counts)).toEqual(paths);
    expect(filterPullRequestReviewPaths(paths, 'unviewed', verdicts, counts)).toEqual(['b.ts', 'c.ts']);
    expect(filterPullRequestReviewPaths(paths, 'threads', verdicts, counts)).toEqual(['b.ts']);
  });

  it('orders unresolved threads by visible file order and cycles from an exact thread', () => {
    const targets = unresolvedThreadTargets(
      ['z.ts', 'a.ts'],
      [thread('a-9', 'a.ts', 9), thread('z-8', 'z.ts', 8), thread('z-2', 'z.ts', 2), thread('done', 'z.ts', 1, true)],
    );
    expect(targets).toEqual([
      { path: 'z.ts', threadId: 'z-2' },
      { path: 'z.ts', threadId: 'z-8' },
      { path: 'a.ts', threadId: 'a-9' },
    ]);
    const paths = ['z.ts', 'middle.ts', 'a.ts'];
    expect(nextUnresolvedThreadTarget(targets, paths, 'z.ts', null, 1)).toEqual(targets[0]);
    expect(nextUnresolvedThreadTarget(targets, paths, 'middle.ts', null, 1)).toEqual(targets[2]);
    expect(nextUnresolvedThreadTarget(targets, paths, 'middle.ts', null, -1)).toEqual(targets[1]);
    expect(nextUnresolvedThreadTarget(targets, paths, 'z.ts', 'z-8', 1)).toEqual(targets[2]);
    expect(nextUnresolvedThreadTarget(targets, paths, 'z.ts', 'z-2', -1)).toEqual(targets[2]);
    expect(nextUnresolvedThreadTarget([], paths, null, null, 1)).toBeNull();
  });
});
