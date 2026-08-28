import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RepoMeta } from '../lib/types';

const tauri = vi.hoisted(() => ({
  repoMeta: vi.fn(),
  repoDiffSinceFull: vi.fn(),
  repoDiffUnstaged: vi.fn(),
  repoDiffUnstagedFull: vi.fn(),
}));

const reviewSession = vi.hoisted(() => ({
  getBaseline: vi.fn(),
  getReviewed: vi.fn(),
  getNotes: vi.fn(),
  setReviewed: vi.fn(),
  setNotes: vi.fn(),
}));

const repoState = vi.hoisted(() => ({
  current: {
    tabs: [] as { path: string; meta: RepoMeta }[],
    activePath: null as string | null,
    meta: null as RepoMeta | null,
    baseline: null,
    reviewed: {} as Record<string, string>,
    reviewNotes: {} as Record<string, unknown[]>,
  },
}));

const wsState = vi.hoisted(() => ({
  current: {
    workspaces: [] as { id: string; name: string; repoPaths: string[]; createdAt: number }[],
    activeWorkspaceId: null as string | null,
  },
}));

vi.mock('../lib/tauri', () => ({ tauri, errMessage: (e: unknown) => String(e) }));
vi.mock('../lib/db', () => ({ reviewSession }));
vi.mock('./repo', () => ({
  useRepo: {
    getState: () => repoState.current,
    setState: (patch: Partial<typeof repoState.current>) => {
      repoState.current = { ...repoState.current, ...patch };
    },
  },
  makeReviewNote: () => null,
}));
vi.mock('./workspaces', () => ({
  DEFAULT_WORKSPACE_ID: '__default__',
  useWorkspaces: { getState: () => wsState.current },
}));

import { useWorkspaceReview } from './workspaceReview';

function meta(path: string): RepoMeta {
  return {
    name: path.split('/').pop() ?? path,
    path,
    branch: 'main',
    head_oid: 'abc',
    ahead: 0,
    behind: 0,
    detached: false,
    operation: null,
    common_dir: `${path}/.git`,
    is_linked_worktree: false,
  };
}

function memberPaths(): string[] {
  return useWorkspaceReview.getState().members.map((m) => m.path);
}

function useWorkspace(repoPaths: string[]): void {
  wsState.current = {
    workspaces: [{ id: 'w1', name: 'W', repoPaths, createdAt: 0 }],
    activeWorkspaceId: 'w1',
  };
}

describe('workspaceReview store: members deleted from disk', () => {
  beforeEach(() => {
    for (const fn of Object.values(tauri)) fn.mockReset();
    reviewSession.getBaseline.mockReset().mockResolvedValue(null);
    reviewSession.getReviewed.mockReset().mockResolvedValue(null);
    reviewSession.getNotes.mockReset().mockResolvedValue(null);
    repoState.current = { ...repoState.current, tabs: [], activePath: null, meta: null };
    tauri.repoDiffUnstagedFull.mockResolvedValue([]);
  });

  it('drops a member whose directory is gone instead of rendering a dead error section', async () => {
    useWorkspace(['/r/live', '/r/dead']);
    tauri.repoMeta.mockImplementation((path: string) =>
      path === '/r/dead'
        ? Promise.reject(new Error(`Could not find a git repository in ${path}`))
        : Promise.resolve(meta(path)),
    );

    await useWorkspaceReview.getState().refreshAll();

    expect(memberPaths()).toEqual(['/r/live']);
    expect(useWorkspaceReview.getState().members[0].error).toBeNull();
  });

  it('keeps a vanished member out of later refreshes, and it rejoins when the path returns', async () => {
    useWorkspace(['/s/live', '/s/dead']);
    tauri.repoMeta.mockImplementation((path: string) =>
      path === '/s/dead' ? Promise.reject(new Error('gone')) : Promise.resolve(meta(path)),
    );
    await useWorkspaceReview.getState().refreshAll();
    expect(memberPaths()).toEqual(['/s/live']);

    // Still gone: the revalidation misses and the seed skips the path.
    await useWorkspaceReview.getState().refreshAll();
    expect(memberPaths()).toEqual(['/s/live']);

    // The path comes back (re-clone): the next refresh re-members it.
    tauri.repoMeta.mockImplementation((path: string) => Promise.resolve(meta(path)));
    await useWorkspaceReview.getState().refreshAll();
    expect(memberPaths()).toEqual(['/s/live', '/s/dead']);
  });

  it('drops a member whose repository is deleted mid-session when its slice refreshes', async () => {
    useWorkspace(['/t/live', '/t/dead']);
    tauri.repoMeta.mockImplementation((path: string) => Promise.resolve(meta(path)));
    await useWorkspaceReview.getState().refreshAll();
    expect(memberPaths()).toEqual(['/t/live', '/t/dead']);

    tauri.repoMeta.mockImplementation((path: string) =>
      path === '/t/dead' ? Promise.reject(new Error('gone')) : Promise.resolve(meta(path)),
    );
    await useWorkspaceReview.getState().refreshMember('/t/dead');

    expect(memberPaths()).toEqual(['/t/live']);
  });
});
