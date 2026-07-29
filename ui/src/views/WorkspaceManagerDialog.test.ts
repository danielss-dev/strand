import { describe, expect, it, vi } from 'vitest';

import type { RecentRepo, RepoMeta } from '../lib/types';
import type { RepoTab } from '../stores/repo';

vi.stubGlobal('window', {});

const { mergeKnownRepositories, validateRecentRepositories } = await import(
  './WorkspaceManagerDialog'
);

function meta(path: string, name = 'repo'): RepoMeta {
  return {
    name,
    path,
    branch: 'main',
    head_oid: null,
    ahead: 0,
    behind: 0,
    detached: false,
    operation: null,
    common_dir: `${path}/.git`,
    is_linked_worktree: false,
  };
}

function recent(path: string, name = 'repo'): RecentRepo {
  return { path, name, last_opened: 1 };
}

describe('Workspace Manager repository candidates', () => {
  it('omits recents that no longer open and keeps canonical valid paths', async () => {
    const repoOpen = vi.fn(async (path: string) => {
      if (path === '/deleted/worktree') throw new Error('not found');
      return meta('/canonical/repo', 'repo');
    });

    const candidates = await validateRecentRepositories(
      [recent('/deleted/worktree', 'worktree'), recent('/old/repo')],
      repoOpen,
    );

    expect(candidates).toEqual([{ path: '/canonical/repo', name: 'repo' }]);
  });

  it('validates equivalent path spellings only once', async () => {
    const repoOpen = vi.fn(async () => meta('D:\\src\\repo'));

    await validateRecentRepositories(
      [recent('D:/src/repo'), recent('D:\\src\\repo')],
      repoOpen,
    );

    expect(repoOpen).toHaveBeenCalledOnce();
  });

  it('keeps open main repositories and deduplicates them from validated recents', () => {
    const main = { path: 'D:\\src\\repo', meta: meta('D:\\src\\repo') } as RepoTab;
    const linked = {
      path: 'D:\\src\\repo-worktree',
      meta: { ...meta('D:\\src\\repo-worktree'), is_linked_worktree: true },
    } as RepoTab;

    expect(
      mergeKnownRepositories(
        [{ path: 'D:/src/repo', name: 'repo' }],
        [main, linked],
      ),
    ).toEqual([{ path: 'D:/src/repo', name: 'repo' }]);
  });
});
