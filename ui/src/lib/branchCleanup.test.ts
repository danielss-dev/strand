import { describe, expect, it } from 'vitest';

import { mergedBranchCleanupPlan } from './branchCleanup';
import type { Branch, Refs, RemoteBranch, Worktree } from './types';

function branch(name: string, overrides: Partial<Branch> = {}): Branch {
  return {
    name,
    full_name: `refs/heads/${name}`,
    target: name.padEnd(40, '0').slice(0, 40),
    is_head: false,
    merged: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

function remote(remoteName: string, name: string, merged = true): RemoteBranch {
  return {
    name: `${remoteName}/${name}`,
    remote: remoteName,
    branch: name,
    full_name: `refs/remotes/${remoteName}/${name}`,
    target: name.padEnd(40, '1').slice(0, 40),
    merged,
  };
}

function refs(branches: Branch[], remoteBranches: RemoteBranch[] = []): Refs {
  return {
    branches,
    primary_branch: 'main',
    remotes: [{
      name: 'origin',
      url: null,
      push_url: null,
      fetch_refspecs: [],
      push_refspecs: [],
      is_default: false,
    }],
    remote_branches: remoteBranches,
    tags: [],
  };
}

function worktree(name: string): Worktree {
  return {
    path: `C:/repo.worktrees/${name}`,
    branch: name,
    head: null,
    is_bare: false,
    is_detached: false,
    is_locked: false,
    lock_reason: null,
    is_prunable: false,
    prune_reason: null,
    is_main: false,
    is_current: false,
  };
}

describe('mergedBranchCleanupPlan', () => {
  it('keeps only merged non-primary, non-current branches', () => {
    const plan = mergedBranchCleanupPlan(refs([
      branch('main'),
      branch('current', { is_head: true }),
      branch('open', { merged: false }),
      branch('done'),
    ]), []);

    expect(plan.candidates.map((candidate) => candidate.local.name)).toEqual(['done']);
    expect(plan.checkedOut).toEqual([]);
  });

  it('excludes a merged branch checked out by another worktree', () => {
    const plan = mergedBranchCleanupPlan(refs([branch('done'), branch('in-use')]), [worktree('in-use')]);

    expect(plan.candidates.map((candidate) => candidate.local.name)).toEqual(['done']);
    expect(plan.checkedOut).toEqual(['in-use']);
  });

  it('includes an exact provider-confirmed squash merge without offering an unproven remote', () => {
    const local = branch('squashed', { merged: false });
    const plan = mergedBranchCleanupPlan(
      refs([local], [remote('origin', 'squashed', false)]),
      [],
      new Set(['squashed']),
    );

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({ providerMerged: true, remote: null });
  });

  it('uses the configured upstream even when the remote branch has another name', () => {
    const upstream = remote('fork', 'published-name');
    const local = branch('local-name', {
      upstream: { name: upstream.name, remote: upstream.remote },
    });
    const plan = mergedBranchCleanupPlan(refs([local], [remote('origin', 'local-name'), upstream]), []);

    expect(plan.candidates[0].remote?.name).toBe('fork/published-name');
  });

  it('falls back to an origin branch with the same name when no upstream is configured', () => {
    const origin = remote('origin', 'done');
    const plan = mergedBranchCleanupPlan(refs([branch('done')], [remote('fork', 'done'), origin]), []);

    expect(plan.candidates[0].remote?.name).toBe('origin/done');
  });

  it('does not guess another remote when a configured upstream ref is gone', () => {
    const local = branch('done', {
      upstream: { name: 'fork/published-name', remote: 'fork' },
    });
    const plan = mergedBranchCleanupPlan(refs([local], [remote('origin', 'done')]), []);

    expect(plan.candidates[0].remote).toBeNull();
  });

  it('does not offer a remote tip that is unmerged or names the primary branch', () => {
    const moved = remote('origin', 'moved', false);
    const tracksMoved = branch('moved', {
      upstream: { name: moved.name, remote: moved.remote },
    });
    const tracksPrimary = branch('odd-upstream', {
      upstream: { name: 'origin/main', remote: 'origin' },
    });
    const plan = mergedBranchCleanupPlan(
      refs([tracksMoved, tracksPrimary], [moved, remote('origin', 'main')]),
      [],
    );

    expect(plan.candidates.map((candidate) => candidate.remote)).toEqual([null, null]);
  });
});
