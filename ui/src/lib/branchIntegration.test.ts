import { describe, expect, it } from 'vitest';

import { providerMergedBranchNames } from './branchIntegration';
import type { Branch, PullRequest, PullRequestList, Refs } from './types';

function branch(name: string, target: string, isHead = false): Branch {
  return {
    name,
    full_name: `refs/heads/${name}`,
    target,
    is_head: isHead,
    merged: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
}

function pullRequest(overrides: Partial<PullRequest>): PullRequest {
  return {
    id: 1,
    title: 'Merged change',
    state: 'completed',
    is_draft: false,
    can_mark_ready: false,
    author: 'Daniel',
    source_branch: 'feature',
    source_commit: 'a'.repeat(40),
    target_branch: 'main',
    created_at: '',
    updated_at: '',
    completed_at: '',
    url: '',
    description: '',
    merge_status: '',
    review_status: '',
    comment_count: 0,
    commit_count: 0,
    additions: null,
    deletions: null,
    changed_files: null,
    labels: [],
    reviewers: [],
    reviews: [],
    checks: [],
    checks_complete: false,
    comments: [],
    review_threads: [],
    authored_by_viewer: false,
    commits: [],
    ...overrides,
  };
}

function data(pullRequests: PullRequest[]): PullRequestList {
  return {
    repository: { provider: 'azure_dev_ops', remote: 'origin', label: 'repo', viewer: null },
    pull_requests: pullRequests,
  };
}

const refs: Refs = {
  primary_branch: 'main',
  branches: [branch('main', 'f'.repeat(40)), branch('feature', 'a'.repeat(40))],
  remotes: [],
  remote_branches: [],
  tags: [],
};

describe('providerMergedBranchNames', () => {
  it('marks a completed or merged PR source into the primary branch', () => {
    expect([...providerMergedBranchNames(refs, data([pullRequest({})]))]).toEqual(['feature']);
    expect([...providerMergedBranchNames(refs, data([pullRequest({ state: 'merged' })]))]).toEqual(['feature']);
  });

  it('marks squash merges even when the provider omits or rewrites the source tip', () => {
    expect([...providerMergedBranchNames(refs, data([pullRequest({ source_commit: '' })]))]).toEqual(['feature']);
    expect([
      ...providerMergedBranchNames(refs, data([pullRequest({ source_commit: 'b'.repeat(40) })])),
    ]).toEqual(['feature']);
  });

  it('rejects closed PRs, other targets, open reuse of the branch, and the checked-out branch', () => {
    expect(providerMergedBranchNames(refs, data([pullRequest({ state: 'closed' })])).size).toBe(0);
    expect(providerMergedBranchNames(refs, data([pullRequest({ target_branch: 'release' })])).size).toBe(0);
    expect(providerMergedBranchNames(
      refs,
      data([
        pullRequest({}),
        pullRequest({ id: 2, state: 'active', source_commit: 'c'.repeat(40) }),
      ]),
    ).size).toBe(0);
    expect(providerMergedBranchNames(
      refs,
      data([
        pullRequest({ state: 'merged' }),
        pullRequest({ id: 2, state: 'open', source_commit: 'c'.repeat(40) }),
      ]),
    ).size).toBe(0);
    const checkedOut = { ...refs, branches: [refs.branches[0], branch('feature', 'a'.repeat(40), true)] };
    expect(providerMergedBranchNames(checkedOut, data([pullRequest({})])).size).toBe(0);
  });

  it('does not mark a local branch with no matching completed PR source name', () => {
    expect(providerMergedBranchNames(
      refs,
      data([pullRequest({ source_branch: 'other-feature' })]),
    ).size).toBe(0);
  });
});
