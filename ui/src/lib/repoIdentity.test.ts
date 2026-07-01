import { describe, expect, it } from 'vitest';

import {
  mainPathFromCommonDir,
  pathKey,
  repoFamilyName,
  repoTabLabel,
  tabWorktreeName,
  workspaceMemberSet,
  worktreeName,
} from './repoIdentity';
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

describe('path identity', () => {
  it('maps every spelling of a directory to one key', () => {
    expect(pathKey('D:\\GitSources\\strand')).toBe('D:/GitSources/strand');
    expect(pathKey('D:/GitSources/strand')).toBe('D:/GitSources/strand');
    expect(pathKey('D:/GitSources/strand/')).toBe('D:/GitSources/strand');
    // std::fs::canonicalize's verbatim forms on Windows.
    expect(pathKey('\\\\?\\D:\\GitSources\\strand')).toBe('D:/GitSources/strand');
    expect(pathKey('\\\\?\\UNC\\server\\share\\repo')).toBe('//server/share/repo');
  });
});

describe('workspace membership', () => {
  const tab = (path: string, commonDir: string, linked = false) => ({
    path,
    meta: { common_dir: commonDir, is_linked_worktree: linked },
  });

  it('derives the main workdir from a plain .git common dir only', () => {
    expect(mainPathFromCommonDir('/src/strand/.git')).toBe('/src/strand');
    expect(mainPathFromCommonDir('C:\\dev\\portal\\.git')).toBe('C:/dev/portal');
    expect(mainPathFromCommonDir('\\\\?\\D:\\GitSources\\strand\\.git')).toBe('D:/GitSources/strand');
    expect(mainPathFromCommonDir('/repos/bare.git')).toBeNull();
    expect(mainPathFromCommonDir('/src/app/.git/modules/lib')).toBeNull();
  });

  it('includes member mains and excludes non-members', () => {
    const tabs = [tab('/src/strand', '/src/strand/.git'), tab('/src/other', '/src/other/.git')];
    const out = workspaceMemberSet(tabs, new Set(['/src/strand']));
    expect(out.has('/src/strand')).toBe(true);
    expect(out.has('/src/other')).toBe(false);
  });

  it('lets a linked worktree inherit membership whether or not the main tab is open', () => {
    const wt = tab('/src/strand.worktrees/fix', '/src/strand/.git', true);
    const withMain = workspaceMemberSet([tab('/src/strand', '/src/strand/.git'), wt], new Set(['/src/strand']));
    expect(withMain.has(wt.path)).toBe(true);

    // Main tab closed: inheritance still resolves via the shared common dir.
    const withoutMain = workspaceMemberSet([wt], new Set(['/src/strand']));
    expect(withoutMain.has(wt.path)).toBe(true);
  });

  it('honors a worktree listed by its own path', () => {
    const wt = tab('/src/strand.worktrees/fix', '/src/strand/.git', true);
    const out = workspaceMemberSet([wt], new Set(['/src/strand.worktrees/fix']));
    expect(out.has(wt.path)).toBe(true);
  });

  it('tolerates separator drift between member paths and tab paths', () => {
    const tabs = [
      tab('C:\\dev\\portal', 'C:\\dev\\portal\\.git'),
      tab('C:\\dev\\portal.wt\\fix', 'C:\\dev\\portal\\.git', true),
    ];
    const out = workspaceMemberSet(tabs, new Set(['C:/dev/portal']));
    expect(out.has('C:\\dev\\portal')).toBe(true);
    expect(out.has('C:\\dev\\portal.wt\\fix')).toBe(true);
  });

  it('matches members against Windows verbatim common dirs', () => {
    // On Windows the backend canonicalizes common_dir into the \\?\ form
    // while tab and member paths stay in drive-letter spelling.
    const wt = tab('D:\\src\\repo.wt\\fix', '\\\\?\\D:\\src\\repo\\.git', true);
    const out = workspaceMemberSet([wt], new Set(['D:\\src\\repo']));
    expect(out.has(wt.path)).toBe(true);
  });
});
