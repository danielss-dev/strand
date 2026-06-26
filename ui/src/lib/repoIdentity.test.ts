import { describe, expect, it } from 'vitest';

import { repoFamilyName, repoTabLabel, tabWorktreeName, worktreeName } from './repoIdentity';
import type { RepoMeta, Worktree } from './types';

function meta(overrides: Partial<RepoMeta>): RepoMeta {
  return {
    name: 'strand',
    path: '/src/strand',
    branch: 'main',
    head_oid: 'abc',
    ahead: 0,
    behind: 0,
    detached: false,
    operation: null,
    common_dir: '/src/strand/.git',
    is_linked_worktree: false,
    ...overrides,
  };
}

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    path: '/src/strand.worktrees/feature-one',
    branch: 'feature/one',
    head: '1234567890abcdef',
    is_bare: false,
    is_detached: false,
    is_locked: false,
    lock_reason: null,
    is_prunable: false,
    is_main: false,
    is_current: false,
    ...overrides,
  };
}

describe('repo identity labels', () => {
  it('derives a stable repo family name from the shared git dir', () => {
    expect(repoFamilyName(meta({ name: 'feature-one', common_dir: '/src/strand/.git' }))).toBe('strand');
    expect(repoFamilyName(meta({ name: 'feature-one', common_dir: 'C:\\dev\\portal\\.git' }))).toBe('portal');
  });

  it('falls back to the common dir leaf for non-standard git dirs', () => {
    expect(repoFamilyName(meta({ common_dir: '/repos/bare.git' }))).toBe('bare.git');
  });

  it('uses branch, detached head, then path leaf for worktree names', () => {
    expect(worktreeName(worktree({ branch: 'agent/fix' }))).toBe('agent/fix');
    expect(worktreeName(worktree({ branch: null, is_detached: true, head: 'abcdef123456' }))).toBe('abcdef1');
    expect(worktreeName(worktree({ branch: null, head: null, path: '/tmp/agent-copy' }))).toBe('agent-copy');
  });

  it('keeps linked tab primary labels stable and branch labels secondary', () => {
    const label = repoTabLabel({
      meta: meta({
        name: 'agent-fix',
        path: '/src/strand.worktrees/agent-fix',
        branch: 'agent/fix',
        common_dir: '/src/strand/.git',
        is_linked_worktree: true,
      }),
    });

    expect(label.primary).toBe('strand');
    expect(label.secondary).toBe('agent/fix');
    expect(label.ariaLabel).toBe('strand, worktree agent/fix');
  });

  it('uses the path leaf for unborn linked worktree tabs', () => {
    expect(tabWorktreeName(meta({
      name: 'new-task',
      path: '/src/strand.worktrees/new-task',
      branch: 'HEAD',
      is_linked_worktree: true,
    }))).toBe('new-task');
  });
});
