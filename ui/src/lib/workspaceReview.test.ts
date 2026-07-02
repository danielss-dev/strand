import { describe, expect, it } from 'vitest';

import { activeWorkspaceMembers, workspaceQueueOrder } from './workspaceReview';
import type { RepoMeta, Workspace } from './types';

const DEFAULT_ID = '__default__';

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

function ws(overrides: Partial<Workspace>): Workspace {
  return { id: 'w1', name: 'Product', repoPaths: [], createdAt: 0, ...overrides };
}

describe('activeWorkspaceMembers', () => {
  const tabs = [
    { path: 'D:\\src\\api', meta: meta({ path: 'D:\\src\\api', common_dir: 'D:\\src\\api\\.git' }) },
    {
      path: 'D:\\src\\web.worktrees\\feat',
      meta: meta({
        path: 'D:\\src\\web.worktrees\\feat',
        common_dir: 'D:\\src\\web\\.git',
        is_linked_worktree: true,
      }),
    },
  ];

  it('resolves members in membership order against open tabs by path key', () => {
    const workspaces = [
      ws({ id: DEFAULT_ID, name: 'Default' }),
      // Stored with forward slashes — the open tab spells it with backslashes.
      ws({ id: 'w1', repoPaths: ['D:/src/api', 'D:/src/web'] }),
    ];
    const members = activeWorkspaceMembers(workspaces, 'w1', tabs, DEFAULT_ID);
    expect(members).toHaveLength(2);
    // Resolved to the open tab's own spelling, so reviewSession keys match
    // the single-repo Review's.
    expect(members[0]).toEqual({ path: 'D:\\src\\api', meta: tabs[0].meta });
    // Not open (only its worktree is, and worktree tabs are not members):
    // keeps the stored path, no meta.
    expect(members[1]).toEqual({ path: 'D:/src/web', meta: null });
  });

  it('resolves null active id to the Default workspace', () => {
    const workspaces = [
      ws({ id: DEFAULT_ID, name: 'Default', repoPaths: ['D:/src/api'] }),
      ws({ id: 'w1', repoPaths: ['D:/src/web'] }),
    ];
    const members = activeWorkspaceMembers(workspaces, null, tabs, DEFAULT_ID);
    expect(members.map((m) => m.path)).toEqual(['D:\\src\\api']);
  });

  it('returns empty for an unknown workspace id', () => {
    expect(activeWorkspaceMembers([ws({})], 'nope', tabs, DEFAULT_ID)).toEqual([]);
  });

  it('never resolves a member onto a linked-worktree tab', () => {
    const workspaces = [ws({ id: 'w1', repoPaths: ['D:/src/web.worktrees/feat'] })];
    const members = activeWorkspaceMembers(workspaces, 'w1', tabs, DEFAULT_ID);
    // The stored path happens to equal a worktree tab's path — it still
    // resolves pathless (meta null) rather than adopting the worktree tab.
    expect(members[0].meta).toBeNull();
  });
});

describe('workspaceQueueOrder', () => {
  it('walks members in workspace order, files in tree display order', () => {
    const members = [
      {
        path: '/a',
        diffs: [{ path: 'zz.ts' }, { path: 'src/deep/x.ts' }, { path: 'src/a.ts' }],
      },
      { path: '/b', diffs: [{ path: 'readme.md' }] },
    ];
    expect(workspaceQueueOrder(members)).toEqual([
      // /a first (workspace order); within it, directories before files.
      { repo: '/a', file: 'src/deep/x.ts' },
      { repo: '/a', file: 'src/a.ts' },
      { repo: '/a', file: 'zz.ts' },
      { repo: '/b', file: 'readme.md' },
    ]);
  });

  it('skips empty members and preserves input arrays', () => {
    const diffs = [{ path: 'b.ts' }, { path: 'a.ts' }];
    const members = [
      { path: '/clean', diffs: [] },
      { path: '/dirty', diffs },
    ];
    expect(workspaceQueueOrder(members)).toEqual([
      { repo: '/dirty', file: 'a.ts' },
      { repo: '/dirty', file: 'b.ts' },
    ]);
    // The sort must not mutate the member's diff list.
    expect(diffs.map((d) => d.path)).toEqual(['b.ts', 'a.ts']);
  });
});
