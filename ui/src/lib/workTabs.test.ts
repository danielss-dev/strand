import { describe, expect, it } from 'vitest';

import {
  adjacentWorkTabId,
  activateWorkPane,
  closeEmptyWorkPane,
  closeWorkTab,
  EMPTY_REPO_WORK,
  openWorkFile,
  moveWorkTab,
  splitWorkPane,
  splitWorkTab,
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
      activePaneId: 'root',
      layout: { kind: 'pane', id: 'root', tabIds: ['a', 'b', 'c'], activeTabId: 'b' },
      tabs: [
        { kind: 'terminal', id: 'a', repoPath: 'r', label: 'A', shell: null, runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null },
        { kind: 'terminal', id: 'b', repoPath: 'r', label: 'B', shell: null, runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null },
        { kind: 'terminal', id: 'c', repoPath: 'r', label: 'C', shell: null, runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null },
      ],
    };
    expect(closeWorkTab(state, 'b').activeTabId).toBe('c');
  });

  it('splits the active view into a nested editor group', () => {
    const source = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'file-a');
    const duplicate = { ...source.tabs[0], id: 'file-b' };
    const split = splitWorkPane(
      source,
      source.activePaneId,
      'horizontal',
      'pane-b',
      duplicate,
    );
    expect(split.layout).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      children: [
        { kind: 'pane', tabIds: ['file-a'] },
        { kind: 'pane', id: 'pane-b', tabIds: ['file-b'] },
      ],
    });
    expect(split.activePaneId).toBe('pane-b');
    expect(split.activeTabId).toBe('file-b');
  });

  it('deduplicates pinned files within a pane but allows the same file in another pane', () => {
    let state = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'left');
    state = splitWorkPane(state, state.activePaneId, 'horizontal', 'right-pane', null);
    state = openWorkFile(state, file('a.ts'), 'pinned', () => 'right');
    state = openWorkFile(state, file('a.ts'), 'pinned', () => 'unused');
    expect(state.tabs.map((tab) => tab.id)).toEqual(['left', 'right']);
  });

  it('keeps one replaceable preview per pane and collapses an empty split', () => {
    let state = openWorkFile(EMPTY_REPO_WORK, file('left.ts'), 'preview', () => 'left');
    state = splitWorkPane(state, state.activePaneId, 'horizontal', 'right-pane', null);
    state = openWorkFile(state, file('right-a.ts'), 'preview', () => 'right');
    state = openWorkFile(state, file('right-b.ts'), 'preview', () => 'unused');
    expect(state.tabs.map((tab) => tab.kind === 'file' && tab.path)).toEqual(['left.ts', 'right-b.ts']);
    state = closeWorkTab(state, 'right');
    expect(state.layout).toMatchObject({ kind: 'pane', tabIds: ['left'] });
    expect(state.activePaneId).toBe('work-pane-root');
    expect(activateWorkPane(state, 'missing')).toBe(state);
  });

  it('reorders a tab within its pane using an insertion target', () => {
    let state = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'a');
    state = openWorkFile(state, file('b.ts'), 'pinned', () => 'b');
    state = openWorkFile(state, file('c.ts'), 'pinned', () => 'c');
    const moved = moveWorkTab(state, 'c', state.activePaneId, 'a');
    expect(moved.layout).toMatchObject({ kind: 'pane', tabIds: ['c', 'a', 'b'], activeTabId: 'c' });
  });

  it('moves a tab into another pane and collapses its empty source', () => {
    let state = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'a');
    state = splitWorkPane(state, state.activePaneId, 'horizontal', 'right', null);
    state = openWorkFile(state, file('b.ts'), 'pinned', () => 'b');
    const moved = moveWorkTab(state, 'a', 'right', 'b');
    expect(moved.layout).toMatchObject({
      kind: 'pane',
      id: 'right',
      tabIds: ['a', 'b'],
      activeTabId: 'a',
    });
    expect(moved.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
  });

  it('moves a live terminal without replacing its renderer descriptor', () => {
    const restored = restoreTerminalDescriptors([{ id: 'term', label: 'Terminal 1' }]);
    const terminal = {
      ...restored.tabs[0],
      repoPath: 'repo-a',
      runtimeId: 'runtime-1',
      lifecycle: 'running' as const,
    };
    let state: RepoWorkTabs = { ...restored, tabs: [terminal] };
    state = splitWorkPane(state, state.activePaneId, 'horizontal', 'right', null);
    const moved = moveWorkTab(state, 'term', 'right');
    expect(moved.tabs[0]).toBe(terminal);
    expect(moved.tabs[0]).toMatchObject({ runtimeId: 'runtime-1', lifecycle: 'running' });
  });

  it('creates a directional split by moving the dragged tab', () => {
    let state = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'a');
    state = openWorkFile(state, file('b.ts'), 'pinned', () => 'b');
    const split = splitWorkTab(state, 'b', state.activePaneId, 'left', 'new-pane');
    expect(split.layout).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      children: [
        { kind: 'pane', id: 'new-pane', tabIds: ['b'] },
        { kind: 'pane', id: 'work-pane-root', tabIds: ['a'] },
      ],
    });
    expect(split.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
  });

  it('keeps an empty source group when its only tab is split, then closes it explicitly', () => {
    const state = openWorkFile(EMPTY_REPO_WORK, file('a.ts'), 'pinned', () => 'a');
    const split = splitWorkTab(state, 'a', state.activePaneId, 'bottom', 'new-pane');
    expect(split.layout).toMatchObject({
      kind: 'split',
      direction: 'vertical',
      children: [
        { kind: 'pane', id: 'work-pane-root', tabIds: [] },
        { kind: 'pane', id: 'new-pane', tabIds: ['a'] },
      ],
    });
    expect(closeEmptyWorkPane(split, 'work-pane-root').layout).toMatchObject({
      kind: 'pane',
      id: 'new-pane',
      tabIds: ['a'],
    });
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
