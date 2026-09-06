import { describe, expect, it } from 'vitest';
import { appendPullRequestPage, incompleteLabel, uniqueBy } from './pullRequestPages';
import type { PullRequest, PullRequestDataPage, PullRequestPageCursor } from './types';

const cursor = (kind: PullRequestPageCursor['kind'], after: string | null): PullRequestPageCursor =>
  ({ kind, cursor: after, thread_id: null, total: 101, error: null });
const pr = (kind: PullRequestPageCursor['kind']): PullRequest => ({
  source_commit: 'a'.repeat(40), data_pages: [cursor(kind, null)],
  comments: [], commits: [], reviews: [], checks: [], review_threads: [], checks_complete: false,
} as unknown as PullRequest);
const page = (request: PullRequestPageCursor): PullRequestDataPage => ({
  request, source_commit: 'a'.repeat(40), pending: [], comments: [], commits: [], reviews: [], checks: [], review_threads: [],
});

describe('provider pages', () => {
  it.each(['comments', 'commits', 'reviews', 'checks', 'threads'] as const)('loads 101 %s with overlapping pages exactly once', (kind) => {
    let current = pr(kind);
    const field = kind === 'threads' ? 'review_threads' : kind;
    for (const [start, end, after, next] of [[0, 50, null, '50'], [49, 100, '50', '100'], [99, 101, '100', null]] as const) {
      const incoming = page(cursor(kind, after));
      incoming.pending = next ? [cursor(kind, next)] : [];
      Object.assign(incoming, { [field]: Array.from({ length: end - start }, (_, i) => ({ id: `${start + i}`, comments: [] })) });
      current = appendPullRequestPage(current, incoming);
      expect(appendPullRequestPage(current, incoming)).toBe(current);
    }
    expect(current[field]).toHaveLength(101);
    expect(incompleteLabel(current)).toBe('');
    expect(current.checks_complete).toBe(true);
  });
  it('deduplicates inbox rows without losing existing selection objects', () => {
    const rows = Array.from({ length: 100 }, (_, id) => ({ id }));
    expect(uniqueBy(rows, [{ id: 99 }, { id: 100 }], (p) => p.id)).toHaveLength(101);
  });
  it('rejects an old head and preserves prior data on invalid cursor', () => {
    const current = pr('reviews');
    const incoming = page(cursor('reviews', null));
    incoming.source_commit = 'b'.repeat(40);
    expect(appendPullRequestPage(current, incoming)).toBe(current);
    incoming.source_commit = current.source_commit;
    incoming.request.cursor = 'unexpected';
    expect(appendPullRequestPage(current, incoming)).toBe(current);
    expect(incompleteLabel(current)).toContain('Counts show loaded items');
  });
  it('loads 101 replies into the original thread and timeline with file coordinates intact', () => {
    let current = pr('replies');
    current.data_pages![0].thread_id = 'thread';
    current.review_threads = [{ id: 'thread', path: 'src/a.ts', comments: [] }] as unknown as PullRequest['review_threads'];
    const incoming = page(current.data_pages![0]);
    incoming.comments = Array.from({ length: 101 }, (_, i) => ({ id: `${i}`, path: null })) as PullRequest['comments'];
    current = appendPullRequestPage(current, incoming);
    expect(current.review_threads[0].comments).toHaveLength(101);
    expect(current.comments).toHaveLength(101);
    expect(current.comments[100].path).toBe('src/a.ts');
  });
});
