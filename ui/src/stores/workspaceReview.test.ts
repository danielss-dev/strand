import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileDiff, RepoMeta } from '../lib/types';

const tauri = vi.hoisted(() => ({
  repoMeta: vi.fn(),
  repoStatus: vi.fn(),
  repoDiffSummary: vi.fn(),
  repoDiffFiles: vi.fn(),
  repoDiffUnstaged: vi.fn(),
  repoDiffUnstagedPaths: vi.fn(),
  repoDiffUnstagedFull: vi.fn(),
  repoStageMany: vi.fn(),
  repoDiscardMany: vi.fn(),
  repoApplyPatch: vi.fn(),
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

import { useWorkspaceReview, workspaceHunkActionsAllowed } from './workspaceReview';

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

function diff(path: string, old_path: string | null = null): FileDiff & { revision: string } {
  return { path, old_path, patch: `patch for ${path}`, status: old_path ? 'renamed' : 'modified', adds: 1, dels: 1, binary: false, revision: `content:${path}` };
}

describe('workspaceReview store: members deleted from disk', () => {
  beforeEach(() => {
    for (const fn of Object.values(tauri)) fn.mockReset();
    reviewSession.getBaseline.mockReset().mockResolvedValue(null);
    reviewSession.getReviewed.mockReset().mockResolvedValue(null);
    reviewSession.getNotes.mockReset().mockResolvedValue(null);
    repoState.current = { ...repoState.current, tabs: [], activePath: null, meta: null };
    tauri.repoDiffUnstagedFull.mockResolvedValue([]);
    tauri.repoDiffSummary.mockResolvedValue([]);
    tauri.repoDiffFiles.mockImplementation(async (path, source, files: string[]) => {
      const summaries = await tauri.repoDiffSummary(path, source);
      return summaries.filter((row: FileDiff) => files.includes(row.path));
    });
    tauri.repoDiffUnstagedPaths.mockResolvedValue([]);
    tauri.repoStatus.mockResolvedValue([]);
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

  it('uses current index rename targets independently of a pinned review baseline', async () => {
    useWorkspace(['/rename']);
    tauri.repoMeta.mockResolvedValue(meta('/rename'));
    reviewSession.getBaseline.mockResolvedValue({ oid: 'baseline', short: 'base', setAt: 1 });
    tauri.repoDiffSummary.mockResolvedValue([
      { path: 'current.txt', old_path: 'baseline-name.txt', patch: 'review', status: 'renamed' },
    ]);
    tauri.repoDiffUnstagedPaths.mockResolvedValue([
      { path: 'current.txt', old_path: 'index-name.txt' },
    ]);
    await useWorkspaceReview.getState().refreshAll();
    expect(useWorkspaceReview.getState().members[0].unstaged).toEqual([
      { path: 'current.txt', old_path: 'index-name.txt' },
    ]);
    expect(tauri.repoDiffUnstaged).not.toHaveBeenCalled();
  });

  it('bounds a 20-member refresh and drops queued reads when the pane closes', async () => {
    useWorkspace(Array.from({ length: 20 }, (_, i) => `/bounded/${i}`));
    tauri.repoMeta.mockImplementation((path: string) => Promise.resolve(meta(path)));
    const release: (() => void)[] = [];
    tauri.repoDiffSummary.mockImplementation(() => new Promise((resolve) => {
      release.push(() => resolve([]));
    }));
    const pending = useWorkspaceReview.getState().refreshAll();
    await vi.waitFor(() => expect(release).toHaveLength(2));
    useWorkspaceReview.getState().setActive(false);
    release.forEach((resolve) => resolve());
    await pending;
    expect(tauri.repoDiffSummary).toHaveBeenCalledTimes(2);
  });

  it('keeps staged and partially staged files in the combined inbox and gates their hunks', async () => {
    useWorkspace(['/combined']);
    tauri.repoMeta.mockResolvedValue(meta('/combined'));
    const pool = [diff('staged.txt'), diff('partial.txt'), diff('loose.txt')];
    tauri.repoDiffSummary.mockResolvedValue(pool);
    tauri.repoDiffUnstagedPaths.mockResolvedValue([
      { path: 'partial.txt', old_path: null }, { path: 'loose.txt', old_path: null },
    ]);
    tauri.repoStatus.mockResolvedValue([
      { path: 'staged.txt', staged: true }, { path: 'partial.txt', staged: true },
      { path: 'partial.txt', staged: false }, { path: 'loose.txt', staged: false },
    ]);
    await useWorkspaceReview.getState().refreshAll();
    await useWorkspaceReview.getState().loadFiles('/combined', pool.map((file) => file.path));
    const member = useWorkspaceReview.getState().members[0];
    expect(tauri.repoDiffSummary).toHaveBeenCalledWith('/combined', { kind: 'review', baseline: 'HEAD' });
    expect(tauri.repoDiffUnstagedFull).not.toHaveBeenCalled();
    expect(member.diffs.map((file) => file.patch)).toEqual(pool.map((file) => file.patch));
    expect(workspaceHunkActionsAllowed(member, 'staged.txt')).toBe(false);
    expect(workspaceHunkActionsAllowed(member, 'partial.txt')).toBe(false);
    expect(workspaceHunkActionsAllowed(member, 'loose.txt')).toBe(true);
    await expect(useWorkspaceReview.getState().applyBlock('/combined', 'partial.txt', 'patch', 'index', 'unused')).rejects.toThrow('not an unstaged patch');
    expect(tauri.repoApplyPatch).not.toHaveBeenCalled();

    // Staging the remaining files changes mutation availability, not the pool.
    tauri.repoDiffUnstagedPaths.mockResolvedValue([]);
    tauri.repoStatus.mockResolvedValue(pool.map((file) => ({ path: file.path, staged: true })));
    await useWorkspaceReview.getState().refreshMember('/combined');
    expect(useWorkspaceReview.getState().members[0].diffs).toBe(member.diffs);
    await useWorkspaceReview.getState().stageFiles('/combined', ['staged.txt']);
    expect(tauri.repoStageMany).not.toHaveBeenCalled();
  });

  it('stages current rename paths and gates hunks when the intermediate name is staged', async () => {
    useWorkspace(['/rename-chain']);
    tauri.repoMeta.mockResolvedValue(meta('/rename-chain'));
    tauri.repoDiffSummary.mockResolvedValue([diff('current.txt', 'head.txt')]);
    tauri.repoDiffUnstagedPaths.mockResolvedValue([{ path: 'current.txt', old_path: 'index.txt' }]);
    tauri.repoStatus.mockResolvedValue([{ path: 'index.txt', staged: true }]);
    await useWorkspaceReview.getState().refreshAll();
    await useWorkspaceReview.getState().loadFiles('/rename-chain', ['current.txt']);
    const member = useWorkspaceReview.getState().members[0];
    expect(workspaceHunkActionsAllowed(member, 'current.txt')).toBe(false);
    await useWorkspaceReview.getState().stageFiles('/rename-chain', ['current.txt', 'head.txt']);
    expect(tauri.repoStageMany).toHaveBeenCalledWith('/rename-chain', ['current.txt', 'index.txt']);
  });

  it('retains the comparison and notes scope after a failed refresh, then clears the error on retry', async () => {
    useWorkspace(['/retry']);
    tauri.repoMeta.mockResolvedValue(meta('/retry'));
    const baseline = { oid: 'pinned', short: 'pinned', setAt: 1 };
    reviewSession.getBaseline.mockResolvedValue(baseline);
    tauri.repoDiffSummary.mockResolvedValue([diff('a.txt')]);
    tauri.repoDiffUnstagedPaths.mockResolvedValue([{ path: 'a.txt', old_path: null }]);
    reviewSession.getNotes.mockResolvedValue({ 'a.txt': [{ id: 'note', text: 'retain', line: null }] });
    await useWorkspaceReview.getState().refreshAll();
    const before = useWorkspaceReview.getState().members[0];
    tauri.repoDiffSummary.mockRejectedValue(new Error('object unavailable'));
    await useWorkspaceReview.getState().refreshMember('/retry');
    const failed = useWorkspaceReview.getState().members[0];
    expect(failed.baseline).toBe(before.baseline);
    expect(failed.diffs).toBe(before.diffs);
    expect(failed.notes).toBe(before.notes);
    expect(failed.noteScope).toBe(before.noteScope);
    expect(failed.error).toContain('object unavailable');
    expect(failed.loading).toBe(false);
    await expect(useWorkspaceReview.getState().discardFiles('/retry', ['a.txt'])).rejects.toThrow('Refresh');
    expect(tauri.repoDiscardMany).not.toHaveBeenCalled();
    tauri.repoDiffSummary.mockResolvedValue([diff('a.txt')]);
    await useWorkspaceReview.getState().refreshMember('/retry');
    expect(useWorkspaceReview.getState().members[0].error).toBeNull();
    expect(tauri.repoDiffSummary).toHaveBeenLastCalledWith('/retry', { kind: 'review', baseline: baseline.oid });
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
