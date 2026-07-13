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
  checkTone,
  diffStats,
  markdownUrl,
  parsePullRequestPatch,
  pullRequestReadiness,
  pullRequestForBranch,
  relativeTimeLabel,
} = await import('./pullRequests');

import type { PullRequest } from './types';

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 42,
    title: 'Ship it',
    state: 'open',
    is_draft: false,
    author: 'octo',
    source_branch: 'feature',
    source_commit: '1'.repeat(40),
    target_branch: 'main',
    created_at: '2026-07-13T10:00:00Z',
    updated_at: '2026-07-13T11:00:00Z',
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
    comments: [],
    ...overrides,
  };
}

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
