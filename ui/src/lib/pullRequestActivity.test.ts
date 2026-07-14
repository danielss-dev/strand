import { describe, expect, it } from 'vitest';

import {
  isTerminalPullRequest,
  pullRequestActivityChanged,
  pullRequestActivityEvents,
  pullRequestFollowKey,
  pullRequestNotificationBody,
} from './pullRequestActivity';
import type { PullRequestActivitySnapshot } from './types';

function snapshot(overrides: Partial<PullRequestActivitySnapshot> = {}): PullRequestActivitySnapshot {
  return {
    repository: { provider: 'git_hub', remote: 'origin', label: 'acme/app' },
    id: 42,
    title: 'Ship it',
    url: 'https://github.com/acme/app/pull/42',
    state: 'open',
    source_branch: 'feature',
    source_commit: '1'.repeat(40),
    updated_at: '2026-07-14T10:00:00Z',
    comments: [],
    reviews: [],
    checks: [{ id: 'ci', name: 'CI', status: 'SUCCESS' }],
    checks_complete: true,
    ...overrides,
  };
}

describe('pull request activity', () => {
  it('uses hosted repository identity rather than a local worktree path', () => {
    const repo = snapshot().repository;
    expect(pullRequestFollowKey(repo, 42)).toBe('git_hub:acme/app:42');
  });

  it('does not notify for a first or unchanged snapshot or non-failing check transition', () => {
    const previous = snapshot({ checks: [{ id: 'ci', name: 'CI', status: 'RUNNING' }] });
    const next = snapshot({ checks: [{ id: 'ci', name: 'CI', status: 'SUCCESS' }] });
    expect(pullRequestActivityEvents(null, next)).toEqual([]);
    expect(pullRequestActivityEvents(previous, previous)).toEqual([]);
    expect(pullRequestActivityEvents(previous, next)).toEqual([]);
    expect(pullRequestActivityEvents(next, previous)).toEqual([]);
    expect(pullRequestActivityChanged(previous, next)).toBe(true);
  });

  it('coalesces new human comments, decisions, failures, and pushes', () => {
    const previous = snapshot({
      comments: [{ id: 'old', author: 'Ada', kind: 'comment', is_system: false }],
      reviews: [{ id: 'grace', author: 'Grace', state: 'PENDING' }],
      checks: [{ id: 'ci', name: 'CI', status: 'RUNNING' }],
    });
    const next = snapshot({
      source_commit: '2'.repeat(40),
      comments: [
        ...previous.comments,
        { id: 'new', author: 'Ada', kind: 'thread', is_system: false },
        { id: 'system', author: 'Build', kind: 'comment', is_system: true },
      ],
      reviews: [{ id: 'grace', author: 'Grace', state: 'APPROVED' }],
      checks: [{ id: 'ci', name: 'CI', status: 'FAILURE' }],
    });
    const events = pullRequestActivityEvents(previous, next);
    expect(events.map((event) => event.kind)).toEqual(['comments', 'reviews', 'failed-checks', 'push']);
    expect(pullRequestNotificationBody(events)).toContain('Ada added 1 new comment');
    expect(pullRequestNotificationBody(events)).toContain('Grace approved');
    expect(pullRequestNotificationBody(events)).toContain('Failed: CI');
  });

  it('notifies when a new check first appears failed', () => {
    const events = pullRequestActivityEvents(snapshot({ checks: [] }), snapshot({
      checks: [{ id: 'lint', name: 'Lint', status: 'broken' }],
    }));
    expect(events).toEqual([{ kind: 'failed-checks', names: ['Lint'] }]);
  });

  it('notifies for a newly submitted request for changes', () => {
    const events = pullRequestActivityEvents(snapshot(), snapshot({
      reviews: [{ id: 'review-1', author: 'Grace', state: 'CHANGES_REQUESTED' }],
    }));
    expect(events).toEqual([{ kind: 'reviews', decisions: ['Grace requested changes'] }]);
  });

  it('treats merged and closed states as terminal', () => {
    const merged = snapshot({ state: 'merged' });
    expect(pullRequestActivityEvents(snapshot(), merged)).toContainEqual({ kind: 'terminal', state: 'merged' });
    expect(isTerminalPullRequest(merged)).toBe(true);
    expect(isTerminalPullRequest(snapshot())).toBe(false);
  });
});
