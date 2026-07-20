import { describe, expect, it } from 'vitest';

import {
  adjacentWorkTabId,
  closeWorkTab,
  EMPTY_REPO_WORK,
  openWorkFile,
  reconcileWorkMutation,
  restoreTerminalDescriptors,
  type RepoWorkTabs,
} from './workTabs';

const file = (path: string) => ({
  repoPath: 'repo-a', path, revision: null, isDirectory: false, mode: 'content' as const,
});

describe('Work tabs', () => {
  it('replaces one preview in place and promotes it when pinned', () => {
    let n = 0;
    const id = () => `id-${++n}`;
    let state = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'preview', id);
    state = openWorkFile(state, file('b.ts'), 'preview', id);
    expect(state.tabs).toMatchObject([{ id: 'id-1', path: 'b.ts', preview: true }]);
    state = openWorkFile(state, file('b.ts'), 'pinned', id);
    expect(state.tabs).toMatchObject([{ id: 'id-1', path: 'b.ts', preview: false }]);
  });

  it('deduplicates pinned files while preserving terminal peer order', () => {
    const restored = restoreTerminalDescriptors([{ id: 'term', label: 'Terminal 1' }]);
    let state = { ...restored, tabs: restored.tabs.map((tab) => ({ ...tab, repoPath: 'repo-a' })) };
    state = openWorkFile(state, file('a.ts'), 'pinned', () => 'file');
    state = openWorkFile(state, file('a.ts'), 'pinned', () => 'duplicate');
    expect(state.tabs.map((tab) => tab.id)).toEqual(['term', 'file']);
  });

  it('chooses a neighboring tab on close', () => {
    const state: RepoWorkTabs = {
      restored: true,
      activeTabId: 'b',
      tabs: [
        { kind: 'terminal', id: 'a', repoPath: 'r', label: 'A', shell: null, runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null },
        { kind: 'terminal', id: 'b', repoPath: 'r', label: 'B', shell: null, runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null },
        { kind: 'terminal', id: 'c', repoPath: 'r', label: 'C', shell: null, runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null },
      ],
    };
    expect(closeWorkTab(state, 'b').activeTabId).toBe('c');
  });

  it('cycles peer tabs in either direction with wraparound', () => {
    const tabs = ['a', 'b', 'c'].map((id) => ({
      kind: 'terminal' as const,
      id,
      repoPath: 'r',
      label: id,
      shell: null,
      runtimeId: null,
      lifecycle: 'dormant' as const,
      exitCode: null,
      error: null,
    }));
    expect(adjacentWorkTabId(tabs, 'c', 1)).toBe('a');
    expect(adjacentWorkTabId(tabs, 'a', -1)).toBe('c');
    expect(adjacentWorkTabId(tabs, null, 1)).toBe('a');
    expect(adjacentWorkTabId(tabs, null, -1)).toBe('c');
  });

  it('rewrites moved paths, closes removed previews, and marks pinned files missing', () => {
    let state = openWorkFile(EMPTY_REPO_WORK, file('src/a.ts'), 'pinned', () => 'pinned');
    state = openWorkFile(state, file('src/b.ts'), 'preview', () => 'preview');
    state = reconcileWorkMutation(state, { kind: 'move', moves: [{ from: 'src', to: 'app' }] });
    expect(state.tabs.map((tab) => tab.kind === 'file' && tab.path)).toEqual(['app/a.ts', 'app/b.ts']);
    state = reconcileWorkMutation(state, { kind: 'delete', paths: ['app'] });
    expect(state.tabs).toMatchObject([{ id: 'pinned', missing: true }]);
  });

  it('restores terminal descriptors without selecting or starting them', () => {
    const restored = restoreTerminalDescriptors([{ id: 'term', label: 'PowerShell' }]);
    expect(restored.activeTabId).toBeNull();
    expect(restored.tabs[0]).toMatchObject({ lifecycle: 'dormant', runtimeId: null });
  });

  it('keeps an explicitly selected shell in the persisted descriptor', () => {
    const restored = restoreTerminalDescriptors([{
      id: 'wsl',
      label: 'WSL · Ubuntu',
      shell: { kind: 'wsl', distribution: 'Ubuntu' },
    }]);
    expect(restored.tabs[0]).toMatchObject({
      shell: { kind: 'wsl', distribution: 'Ubuntu' },
    });
  });

  it('keeps repository tab sessions isolated', () => {
    const repoA = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'a');
    const repoB = openWorkFile(
      EMPTY_REPO_WORK,
      { ...file('b.ts'), repoPath: 'repo-b' },
      'pinned',
      () => 'b',
    );
    expect(repoA.tabs.map((tab) => tab.id)).toEqual(['a']);
    expect(repoB.tabs.map((tab) => tab.id)).toEqual(['b']);
  });
});
