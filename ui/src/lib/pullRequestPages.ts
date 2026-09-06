import type { PullRequest, PullRequestDataPage, PullRequestPageCursor } from './types';

export const pageKey = (page: PullRequestPageCursor) => `${page.kind}:${page.thread_id ?? ''}`;

export function uniqueBy<T>(old: readonly T[], incoming: readonly T[], key: (item: T) => string | number): T[] {
  const result = new Map(old.map((item) => [key(item), item]));
  for (const item of incoming) result.set(key(item), item);
  return [...result.values()];
}

/** Reject both stale heads and out-of-order/replayed cursor responses. */
export function appendPullRequestPage(pr: PullRequest, page: PullRequestDataPage): PullRequest {
  const pending = pr.data_pages ?? [];
  if (pr.source_commit !== page.source_commit || !pending.some((p) =>
    pageKey(p) === pageKey(page.request) && p.cursor === page.request.cursor)) return pr;
  const data_pages = uniqueBy(pending.filter((p) => pageKey(p) !== pageKey(page.request)), page.pending, pageKey);
  let review_threads = uniqueBy(pr.review_threads, page.review_threads, (t) => t.id);
  if (page.request.kind === 'replies') {
    review_threads = review_threads.map((thread) => thread.id === page.request.thread_id ? {
      ...thread, comments: uniqueBy(thread.comments, page.comments.map((c) => ({ ...c, path: thread.path })), (c) => c.id),
    } : thread);
  }
  const comments = uniqueBy(pr.comments, [
    ...(page.request.kind === 'comments' ? page.comments : []),
    ...review_threads.flatMap((thread) => thread.comments),
  ], (c) => c.id);
  const commits = uniqueBy(pr.commits, page.commits, (c) => c.id);
  return {
    ...pr, data_pages, review_threads, comments, commits,
    comment_count: comments.length, commit_count: commits.length,
    reviews: uniqueBy(pr.reviews, page.reviews, (r) => r.id),
    checks: uniqueBy(pr.checks, page.checks, (c) => c.id || c.name),
    checks_complete: !data_pages.some((p) => p.kind === 'checks'),
  };
}

export function incompleteLabel(pr: PullRequest): string {
  const kinds = [...new Set((pr.data_pages ?? []).map((p) => p.kind))];
  return kinds.length ? `Partial data: ${kinds.join(', ')}. Counts show loaded items.` : '';
}
