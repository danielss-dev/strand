import { describe, expect, it } from 'vitest';

// Pierre detects mobile Safari when its root module is evaluated. The app
// always runs in a webview, but Vitest runs in plain Node; Node 20 (used by CI)
// has no navigator global. Install the smallest browser contract before the
// dynamic import so this test exercises the parser under the same condition
// without switching the whole unit suite to a DOM environment.
if (typeof navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'vitest', platform: '', maxTouchPoints: 0 },
  });
}

const {
  buildPullRequestTimeline,
  canMarkPullRequestReady,
  checkTone,
  diffStats,
  filterPullRequests,
  isCompletedPullRequest,
  markdownUrl,
  parsePullRequestPatch,
  pullRequestReadiness,
  pullRequestForBranch,
  reconcilePullRequestSelection,
  relativeTimeLabel,
  withPullRequestThreadReply,
  withPullRequestThreadUpdate,
} = await import('./pullRequests');

import type { PullRequest, PullRequestComment, PullRequestReviewThread } from './types';

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 42,
    title: 'Ship it',
    state: 'open',
    is_draft: false,
    can_mark_ready: false,
    author: 'octo',
    source_branch: 'feature',
    source_commit: '1'.repeat(40),
    target_branch: 'main',
    created_at: '2026-07-13T10:00:00Z',
    updated_at: '2026-07-13T11:00:00Z',
    completed_at: null,
    url: 'https://github.com/acme/repo/pull/42',
    description: '',
    merge_status: 'CLEAN',
    review_status: 'APPROVED',
    comment_count: 0,
    commit_count: 1,
    additions: 10,
    deletions: 2,
    changed_files: 2,
    labels: [],
    reviewers: [],
    checks: [{ name: 'CI', status: 'SUCCESS' }],
    checks_complete: true,
    comments: [],
    review_threads: [],
    authored_by_viewer: true,
    commits: [],
    ...overrides,
  };
}

describe('canMarkPullRequestReady', () => {
  it('requires an active draft and a provider-confirmed viewer capability', () => {
    expect(canMarkPullRequestReady(
      pullRequest({ is_draft: true, can_mark_ready: true }),
    )).toBe(true);
    expect(canMarkPullRequestReady(
      pullRequest({ is_draft: true, can_mark_ready: false }),
    )).toBe(false);
    expect(canMarkPullRequestReady(
      pullRequest({ is_draft: false, can_mark_ready: true }),
    )).toBe(false);
    expect(canMarkPullRequestReady(
      pullRequest({ state: 'closed', is_draft: true, can_mark_ready: true }),
    )).toBe(false);
  });
});

describe('checkTone', () => {
  it('normalizes provider success, running, and failure states', () => {
    expect(checkTone('SUCCESS')).toBe('success');
    expect(checkTone('in progress')).toBe('running');
    expect(checkTone('queued')).toBe('running');
    expect(checkTone('timed-out')).toBe('failed');
    expect(checkTone('neutral')).toBe('neutral');
  });
});

describe('pullRequestReadiness', () => {
  it('reports a GitHub PR ready only when every reported signal is clear', () => {
    const readiness = pullRequestReadiness(pullRequest(), 'git_hub');
    expect(readiness.tone).toBe('ready');
    expect(readiness.label).toBe('Ready to merge');
    expect(readiness.checks).toMatchObject({ passed: 1, failed: 0, total: 1 });
  });

  it('collects explicit blockers and pending signals', () => {
    const readiness = pullRequestReadiness(pullRequest({
      merge_status: 'DIRTY',
      review_status: 'CHANGES_REQUESTED',
      checks: [
        { name: 'CI', status: 'FAILURE' },
        { name: 'Browser', status: 'IN_PROGRESS' },
      ],
    }), 'git_hub');
    expect(readiness.tone).toBe('blocked');
    expect(readiness.label).toBe('3 blockers');
    expect(readiness.details).toContain('The source branch has merge conflicts.');
    expect(readiness.details).toContain('1 check is still running.');
  });

  it('keeps incomplete Azure policy data neutral instead of ready', () => {
    const readiness = pullRequestReadiness(pullRequest({
      merge_status: 'succeeded',
      checks: [],
      checks_complete: false,
    }), 'azure_dev_ops');
    expect(readiness.tone).toBe('neutral');
    expect(readiness.label).toBe('Status incomplete');
    expect(readiness.details[0]).toContain('Azure policy');
  });

  it('treats a requested required reviewer as pending', () => {
    const readiness = pullRequestReadiness(pullRequest({
      review_status: 'REVIEW_REQUIRED',
      reviewers: [{ name: 'Ada', status: 'requested', required: true }],
    }), 'git_hub');
    expect(readiness.tone).toBe('pending');
    expect(readiness.details).toEqual(['A required review is still pending.']);
  });
});

describe('relativeTimeLabel', () => {
  it('formats provider freshness without baking time into the component', () => {
    expect(relativeTimeLabel('2026-07-13T11:52:00Z', Date.parse('2026-07-13T12:00:00Z')))
      .toBe('8m ago');
    expect(relativeTimeLabel('')).toBe('Update time unavailable');
  });
});

describe('parsePullRequestPatch', () => {
  it('returns provider patch files and line totals', () => {
    const [file] = parsePullRequestPatch(`diff --git a/a.txt b/a.txt
index 5626abf..f719efd 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1,2 @@
 one
+two
`);
    expect(file.name).toBe('a.txt');
    expect(diffStats(file)).toEqual({ additions: 1, deletions: 0 });
  });
});

describe('markdownUrl', () => {
  it('resolves safe relative links and rejects executable protocols', () => {
    expect(markdownUrl('/acme/repo/issues/1', 'https://github.com/acme/repo/pull/2'))
      .toBe('https://github.com/acme/repo/issues/1');
    expect(markdownUrl('javascript:alert(1)', 'https://github.com/acme/repo/pull/2')).toBeNull();
  });
});

describe('pullRequestForBranch', () => {
  const pullRequests = [
    { id: 3, source_branch: 'feature', state: 'merged' },
    { id: 2, source_branch: 'refs/heads/feature', state: 'open' },
    { id: 1, source_branch: 'other', state: 'active' },
  ];

  it('finds the active PR for the checked-out branch', () => {
    expect(pullRequestForBranch(pullRequests, 'feature')?.id).toBe(2);
  });

  it('does not auto-open historical or unrelated PRs', () => {
    expect(pullRequestForBranch(pullRequests, 'missing')).toBeNull();
    expect(pullRequestForBranch([{ id: 3, source_branch: 'feature', state: 'merged' }], 'feature'))
      .toBeNull();
  });
});

describe('pull request inbox', () => {
  const rows = [
    pullRequest({ id: 1, title: 'Fix authentication', author: 'ada', source_branch: 'auth/fix' }),
    pullRequest({
      id: 2,
      title: 'Release 1.0',
      author: 'grace',
      source_branch: 'release',
      state: 'merged',
      completed_at: '2026-07-15T12:00:00Z',
      authored_by_viewer: false,
    }),
    pullRequest({
      id: 3,
      title: 'Retire experiment',
      author: 'linus',
      source_branch: 'experiment',
      state: 'closed',
      completed_at: '2026-07-15T13:00:00Z',
      authored_by_viewer: true,
    }),
  ];

  it('filters authored and completed rows with merged and closed kept distinct', () => {
    expect(filterPullRequests(rows, 'authored', '').map((pr) => pr.id)).toEqual([1, 3]);
    expect(filterPullRequests(rows, 'completed', '').map((pr) => [pr.id, pr.state]))
      .toEqual([[2, 'merged'], [3, 'closed']]);
    expect(isCompletedPullRequest(rows[1])).toBe(true);
    expect(isCompletedPullRequest(rows[2])).toBe(true);
    expect(isCompletedPullRequest(rows[0])).toBe(false);
  });

  it('fuzzy searches number, title, author, and branch context', () => {
    expect(filterPullRequests(rows, 'all', '#2').map((pr) => pr.id)).toEqual([2]);
    expect(filterPullRequests(rows, 'all', 'authentication').map((pr) => pr.id)).toEqual([1]);
    expect(filterPullRequests(rows, 'all', 'grace').map((pr) => pr.id)).toEqual([2]);
    expect(filterPullRequests(rows, 'all', 'experiment').map((pr) => pr.id)).toEqual([3]);
  });

  it('retains a visible selection and otherwise selects the first filtered row', () => {
    expect(reconcilePullRequestSelection(rows, 2)).toBe(2);
    expect(reconcilePullRequestSelection([rows[2]], 2)).toBe(3);
    expect(reconcilePullRequestSelection([], 2)).toBeNull();
  });
});

describe('pull request timeline', () => {
  const comment: PullRequestComment = {
    id: 'comment-1',
    author: 'ada',
    avatar_url: null,
    body: 'Ready to go.',
    created_at: '2026-07-15T10:30:00Z',
    url: '',
    is_system: false,
    path: null,
  };

  it('orders lifecycle, commits, and comments oldest-first with stable ties', () => {
    const events = buildPullRequestTimeline(pullRequest({
      state: 'merged',
      created_at: '2026-07-15T09:00:00Z',
      completed_at: '2026-07-15T11:00:00Z',
      commits: [
        {
          id: 'b'.repeat(40),
          title: 'Second alphabetical commit',
          author: 'grace',
          avatar_url: null,
          committed_at: '2026-07-15T10:00:00Z',
          url: null,
        },
        {
          id: 'a'.repeat(40),
          title: 'First alphabetical commit',
          author: 'ada',
          avatar_url: null,
          committed_at: '2026-07-15T10:00:00Z',
          url: null,
        },
      ],
      comments: [comment],
    }));
    expect(events.map((event) => event.id)).toEqual([
      'opened:42',
      `commit:${'a'.repeat(40)}`,
      `commit:${'b'.repeat(40)}`,
      'comment:comment-1',
      'completed:42',
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'completed', state: 'merged' });
  });

  it('deduplicates flattened review comments and emits a closed marker', () => {
    const events = buildPullRequestTimeline(pullRequest({
      state: 'closed',
      completed_at: '2026-07-15T11:00:00Z',
      comments: [comment, { ...comment }],
    }));
    expect(events.filter((event) => event.kind === 'comment')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'completed', state: 'closed' });
  });
});

describe('review thread state updates', () => {
  const firstComment: PullRequestComment = {
    id: 'comment-1',
    author: 'octo',
    avatar_url: null,
    body: 'Please fix this.',
    created_at: '2026-07-15T10:00:00Z',
    url: 'https://github.com/acme/repo/pull/42#discussion_r1',
    is_system: false,
    path: 'src/lib.rs',
  };
  const thread: PullRequestReviewThread = {
    id: 'thread-1',
    path: 'src/lib.rs',
    start_line: 10,
    end_line: 12,
    side: 'additions',
    is_resolved: false,
    is_outdated: false,
    can_reply: true,
    can_resolve: true,
    can_unresolve: false,
    comments: [firstComment],
  };

  it('adds a reply to its thread and the chronological Conversation timeline', () => {
    const reply: PullRequestComment = {
      ...firstComment,
      id: 'comment-2',
      author: 'ada',
      body: 'Fixed.',
      created_at: '2026-07-15T09:55:00Z',
      path: null,
    };
    const updated = withPullRequestThreadReply(pullRequest({
      comments: [firstComment],
      review_threads: [thread],
      comment_count: 1,
    }), thread.id, reply);
    expect(updated.review_threads[0].comments.map((comment) => comment.id))
      .toEqual(['comment-2', 'comment-1']);
    expect(updated.comments.map((comment) => comment.id)).toEqual(['comment-2', 'comment-1']);
    expect(updated.comments[0].path).toBe('src/lib.rs');
    expect(updated.comment_count).toBe(2);
  });

  it('deduplicates a repeated provider reply outcome', () => {
    const pr = pullRequest({ comments: [firstComment], review_threads: [thread], comment_count: 1 });
    const once = withPullRequestThreadReply(pr, thread.id, firstComment);
    const twice = withPullRequestThreadReply(once, thread.id, firstComment);
    expect(twice.review_threads[0].comments).toHaveLength(1);
    expect(twice.comments).toHaveLength(1);
    expect(twice.comment_count).toBe(1);
  });

  it('updates only the matching thread state and capabilities', () => {
    const other = { ...thread, id: 'thread-2' };
    const pr = pullRequest({ review_threads: [thread, other] });
    const updated = withPullRequestThreadUpdate(pr, {
      id: thread.id,
      is_resolved: true,
      is_outdated: false,
      can_reply: true,
      can_resolve: false,
      can_unresolve: true,
    });
    expect(updated.review_threads[0]).toMatchObject({
      is_resolved: true,
      can_resolve: false,
      can_unresolve: true,
    });
    expect(updated.review_threads[1]).toBe(other);
    expect(updated.comments).toBe(pr.comments);
  });
});
