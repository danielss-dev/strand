import type { EmbeddedShellChoice, FilesTreeMutationChange } from './types';

export type WorkFileMode = 'content' | 'preview' | 'history' | 'compare' | 'blame';

export type WorkFileTab = {
  kind: 'file';
  id: string;
  repoPath: string;
  path: string;
  revision: string | null;
  isDirectory: boolean;
  mode: WorkFileMode;
  preview: boolean;
  missing: boolean;
};

export type TerminalLifecycle = 'dormant' | 'starting' | 'running' | 'exited' | 'error';

export type WorkTerminalTab = {
  kind: 'terminal';
  id: string;
  repoPath: string;
  label: string;
  /** Null follows the repository/global default; a concrete choice is pinned
   * to this tab so relaunch and descriptor restore use the same shell. */
  shell: EmbeddedShellChoice | null;
  runtimeId: string | null;
  lifecycle: TerminalLifecycle;
  exitCode: number | null;
  error: string | null;
};

export type WorkTab = WorkFileTab | WorkTerminalTab;

export type WorkPane = {
  kind: 'pane';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
};

export type WorkPaneSplit = {
  kind: 'split';
  direction: 'horizontal' | 'vertical';
  children: [WorkPaneLayout, WorkPaneLayout];
};

export type WorkPaneLayout = WorkPane | WorkPaneSplit;
export type WorkPaneEdge = 'left' | 'right' | 'top' | 'bottom';

export interface RepoWorkTabs {
  tabs: WorkTab[];
  activeTabId: string | null;
  activePaneId: string;
  layout: WorkPaneLayout;
  restored: boolean;
}

export interface TerminalDescriptor {
  id: string;
  label: string;
  /** Optional for descriptors written before per-terminal shell selection. */
  shell?: EmbeddedShellChoice | null;
}

export const EMPTY_WORK_PANE_ID = 'work-pane-root';
export const EMPTY_REPO_WORK: RepoWorkTabs = {
  tabs: [],
  activeTabId: null,
  activePaneId: EMPTY_WORK_PANE_ID,
  layout: { kind: 'pane', id: EMPTY_WORK_PANE_ID, tabIds: [], activeTabId: null },
  restored: false,
};

export function fileIdentity(tab: Pick<WorkFileTab, 'path' | 'revision' | 'isDirectory'>): string {
  return `${tab.revision ?? 'WORKTREE'}\0${tab.isDirectory ? 'directory' : 'file'}\0${tab.path}`;
}

export function openWorkFile(
  state: RepoWorkTabs,
  file: Omit<WorkFileTab, 'kind' | 'id' | 'preview' | 'missing'>,
  disposition: 'preview' | 'pinned',
  makeId: () => string,
): RepoWorkTabs {
  const identity = fileIdentity(file);
  const pane = activeWorkPane(state);
  const pinned = pane.tabIds
    .flatMap((id) => state.tabs.find((tab) => tab.id === id) ?? [])
    .find(
      (tab): tab is WorkFileTab => tab.kind === 'file' && !tab.preview && fileIdentity(tab) === identity,
    );
  if (pinned) return activateWorkTab(state, pinned.id);

  const previewId = pane.tabIds.find((id) => {
    const tab = state.tabs.find((candidate) => candidate.id === id);
    return tab?.kind === 'file' && tab.preview;
  });
  const previewIndex = previewId ? state.tabs.findIndex((tab) => tab.id === previewId) : -1;
  const matchingPreview = previewIndex >= 0
    && fileIdentity(state.tabs[previewIndex] as WorkFileTab) === identity;
  if (matchingPreview && disposition === 'pinned') {
    const tabs = state.tabs.slice();
    tabs[previewIndex] = { ...(tabs[previewIndex] as WorkFileTab), preview: false };
    return activateWorkTab({ ...state, tabs }, tabs[previewIndex].id);
  }
  if (matchingPreview) return activateWorkTab(state, state.tabs[previewIndex].id);

  const tab: WorkFileTab = {
    kind: 'file',
    id: makeId(),
    preview: disposition === 'preview',
    missing: false,
    ...file,
  };
  if (disposition === 'preview' && previewIndex >= 0) {
    const tabs = state.tabs.slice();
    // Replacement keeps the preview's peer position stable.
    tabs[previewIndex] = { ...tab, id: state.tabs[previewIndex].id };
    return activateWorkTab({ ...state, tabs }, tabs[previewIndex].id);
  }
  return appendWorkTab(state, tab);
}

export function closeWorkTab(state: RepoWorkTabs, id: string): RepoWorkTabs {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const owner = workPanes(state.layout).find((pane) => pane.tabIds.includes(id));
  if (!owner) return { ...state, tabs };
  const tabIndex = owner.tabIds.indexOf(id);
  const nextIds = owner.tabIds.filter((tabId) => tabId !== id);
  const nextActiveId = owner.activeTabId === id
    ? nextIds[tabIndex] ?? nextIds[tabIndex - 1] ?? null
    : owner.activeTabId;
  let layout = updateWorkPane(state.layout, owner.id, (pane) => ({
    ...pane,
    tabIds: nextIds,
    activeTabId: nextActiveId,
  }));
  let activePaneId = state.activePaneId;
  if (nextIds.length === 0 && workPanes(layout).length > 1) {
    const collapsed = collapseEmptyWorkPane(layout, owner.id);
    layout = collapsed.layout;
    if (activePaneId === owner.id) activePaneId = collapsed.focusPaneId;
  }
  const activePane = findWorkPane(layout, activePaneId) ?? workPanes(layout)[0];
  const activeTabId = state.activeTabId === id || activePaneId !== state.activePaneId
    ? activePane.activeTabId
    : state.activeTabId;
  return { ...state, tabs, layout, activePaneId, activeTabId };
}

export function appendWorkTab(
  state: RepoWorkTabs,
  tab: WorkTab,
  paneId = state.activePaneId,
): RepoWorkTabs {
  const target = findWorkPane(state.layout, paneId) ?? activeWorkPane(state);
  const layout = updateWorkPane(state.layout, target.id, (pane) => ({
    ...pane,
    tabIds: [...pane.tabIds, tab.id],
    activeTabId: tab.id,
  }));
  return {
    ...state,
    tabs: [...state.tabs, tab],
    layout,
    activePaneId: target.id,
    activeTabId: tab.id,
  };
}

export function activateWorkPane(state: RepoWorkTabs, paneId: string): RepoWorkTabs {
  const pane = findWorkPane(state.layout, paneId);
  if (!pane) return state;
  if (state.activePaneId === pane.id && state.activeTabId === pane.activeTabId) return state;
  return { ...state, activePaneId: pane.id, activeTabId: pane.activeTabId };
}

export function activateWorkTab(state: RepoWorkTabs, id: string): RepoWorkTabs {
  const pane = workPanes(state.layout).find((candidate) => candidate.tabIds.includes(id));
  if (!pane || !state.tabs.some((tab) => tab.id === id)) return state;
  if (state.activePaneId === pane.id && state.activeTabId === id && pane.activeTabId === id) return state;
  return {
    ...state,
    activePaneId: pane.id,
    activeTabId: id,
    layout: updateWorkPane(state.layout, pane.id, (candidate) => ({
      ...candidate,
      activeTabId: id,
    })),
  };
}

export function splitWorkPane(
  state: RepoWorkTabs,
  paneId: string,
  direction: WorkPaneSplit['direction'],
  newPaneId: string,
  duplicate: WorkTab | null,
): RepoWorkTabs {
  const pane = findWorkPane(state.layout, paneId);
  if (!pane) return state;
  const nextPane: WorkPane = {
    kind: 'pane',
    id: newPaneId,
    tabIds: duplicate ? [duplicate.id] : [],
    activeTabId: duplicate?.id ?? null,
  };
  const split: WorkPaneSplit = {
    kind: 'split',
    direction,
    children: [pane, nextPane],
  };
  return {
    ...state,
    tabs: duplicate ? [...state.tabs, duplicate] : state.tabs,
    layout: replaceWorkPane(state.layout, pane.id, split),
    activePaneId: nextPane.id,
    activeTabId: nextPane.activeTabId,
  };
}

export function moveWorkTab(
  state: RepoWorkTabs,
  tabId: string,
  targetPaneId: string,
  beforeTabId: string | null = null,
): RepoWorkTabs {
  const source = workPanes(state.layout).find((pane) => pane.tabIds.includes(tabId));
  const target = findWorkPane(state.layout, targetPaneId);
  if (!source || !target || !state.tabs.some((tab) => tab.id === tabId)) return state;
  if (source.id === target.id && beforeTabId === tabId) return activateWorkTab(state, tabId);

  const sourceIndex = source.tabIds.indexOf(tabId);
  const sourceIds = source.tabIds.filter((id) => id !== tabId);
  const sourceActiveId = source.activeTabId === tabId
    ? sourceIds[sourceIndex] ?? sourceIds[sourceIndex - 1] ?? null
    : source.activeTabId;
  const targetIds = source.id === target.id ? sourceIds : target.tabIds;
  const beforeIndex = beforeTabId ? targetIds.indexOf(beforeTabId) : -1;
  const insertIndex = beforeIndex >= 0 ? beforeIndex : targetIds.length;
  const nextTargetIds = targetIds.slice();
  nextTargetIds.splice(insertIndex, 0, tabId);

  let layout = updateWorkPane(state.layout, source.id, (pane) => ({
    ...pane,
    tabIds: sourceIds,
    activeTabId: sourceActiveId,
  }));
  layout = updateWorkPane(layout, target.id, (pane) => ({
    ...pane,
    tabIds: nextTargetIds,
    activeTabId: tabId,
  }));
  if (source.id !== target.id && sourceIds.length === 0 && workPanes(layout).length > 1) {
    layout = collapseEmptyWorkPane(layout, source.id).layout;
  }
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId && tab.kind === 'file' && tab.preview ? { ...tab, preview: false } : tab),
    layout,
    activePaneId: target.id,
    activeTabId: tabId,
  };
}

export function splitWorkTab(
  state: RepoWorkTabs,
  tabId: string,
  targetPaneId: string,
  edge: WorkPaneEdge,
  newPaneId: string,
): RepoWorkTabs {
  const source = workPanes(state.layout).find((pane) => pane.tabIds.includes(tabId));
  const target = findWorkPane(state.layout, targetPaneId);
  if (!source || !target || !state.tabs.some((tab) => tab.id === tabId)) return state;

  const sourceIndex = source.tabIds.indexOf(tabId);
  const sourceIds = source.tabIds.filter((id) => id !== tabId);
  const sourceActiveId = source.activeTabId === tabId
    ? sourceIds[sourceIndex] ?? sourceIds[sourceIndex - 1] ?? null
    : source.activeTabId;
  let layout = updateWorkPane(state.layout, source.id, (pane) => ({
    ...pane,
    tabIds: sourceIds,
    activeTabId: sourceActiveId,
  }));
  if (source.id !== target.id && sourceIds.length === 0 && workPanes(layout).length > 1) {
    layout = collapseEmptyWorkPane(layout, source.id).layout;
  }

  const nextTarget = findWorkPane(layout, target.id);
  if (!nextTarget) return state;
  const nextPane: WorkPane = {
    kind: 'pane',
    id: newPaneId,
    tabIds: [tabId],
    activeTabId: tabId,
  };
  const nextFirst = edge === 'left' || edge === 'top';
  const split: WorkPaneSplit = {
    kind: 'split',
    direction: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
    children: nextFirst ? [nextPane, nextTarget] : [nextTarget, nextPane],
  };
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId && tab.kind === 'file' && tab.preview ? { ...tab, preview: false } : tab),
    layout: replaceWorkPane(layout, nextTarget.id, split),
    activePaneId: nextPane.id,
    activeTabId: tabId,
  };
}

export function closeEmptyWorkPane(state: RepoWorkTabs, paneId: string): RepoWorkTabs {
  const pane = findWorkPane(state.layout, paneId);
  if (!pane || pane.tabIds.length > 0 || workPanes(state.layout).length === 1) return state;
  const collapsed = collapseEmptyWorkPane(state.layout, paneId);
  const activePane = findWorkPane(collapsed.layout, collapsed.focusPaneId) ?? workPanes(collapsed.layout)[0];
  return {
    ...state,
    layout: collapsed.layout,
    activePaneId: activePane.id,
    activeTabId: activePane.activeTabId,
  };
}

export function activeWorkPane(state: RepoWorkTabs): WorkPane {
  return findWorkPane(state.layout, state.activePaneId) ?? workPanes(state.layout)[0];
}

export function findWorkPane(layout: WorkPaneLayout, paneId: string): WorkPane | null {
  if (layout.kind === 'pane') return layout.id === paneId ? layout : null;
  return findWorkPane(layout.children[0], paneId) ?? findWorkPane(layout.children[1], paneId);
}

export function workPanes(layout: WorkPaneLayout): WorkPane[] {
  if (layout.kind === 'pane') return [layout];
  return [...workPanes(layout.children[0]), ...workPanes(layout.children[1])];
}

function updateWorkPane(
  layout: WorkPaneLayout,
  paneId: string,
  update: (pane: WorkPane) => WorkPane,
): WorkPaneLayout {
  if (layout.kind === 'pane') return layout.id === paneId ? update(layout) : layout;
  return {
    ...layout,
    children: [
      updateWorkPane(layout.children[0], paneId, update),
      updateWorkPane(layout.children[1], paneId, update),
    ],
  };
}

function replaceWorkPane(
  layout: WorkPaneLayout,
  paneId: string,
  replacement: WorkPaneLayout,
): WorkPaneLayout {
  if (layout.kind === 'pane') return layout.id === paneId ? replacement : layout;
  return {
    ...layout,
    children: [
      replaceWorkPane(layout.children[0], paneId, replacement),
      replaceWorkPane(layout.children[1], paneId, replacement),
    ],
  };
}

function collapseEmptyWorkPane(
  layout: WorkPaneLayout,
  paneId: string,
): { layout: WorkPaneLayout; focusPaneId: string } {
  if (layout.kind === 'pane') return { layout, focusPaneId: layout.id };
  const [first, second] = layout.children;
  if (first.kind === 'pane' && first.id === paneId) {
    return { layout: second, focusPaneId: workPanes(second)[0].id };
  }
  if (second.kind === 'pane' && second.id === paneId) {
    const panes = workPanes(first);
    return { layout: first, focusPaneId: panes[panes.length - 1].id };
  }
  const inFirst = findWorkPane(first, paneId);
  if (inFirst) {
    const collapsed = collapseEmptyWorkPane(first, paneId);
    return { layout: { ...layout, children: [collapsed.layout, second] }, focusPaneId: collapsed.focusPaneId };
  }
  const collapsed = collapseEmptyWorkPane(second, paneId);
  return { layout: { ...layout, children: [first, collapsed.layout] }, focusPaneId: collapsed.focusPaneId };
}

/** Resolve the next peer tab with wraparound for fast keyboard navigation. */
export function adjacentWorkTabId(
  tabs: readonly WorkTab[],
  activeId: string | null,
  delta: -1 | 1,
): string | null {
  if (tabs.length === 0) return null;
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  if (activeIndex < 0) return delta > 0 ? tabs[0].id : tabs[tabs.length - 1].id;
  return tabs[(activeIndex + delta + tabs.length) % tabs.length].id;
}

export function reconcileWorkMutation(
  state: RepoWorkTabs,
  change: FilesTreeMutationChange,
): RepoWorkTabs {
  let next = state;
  if (change.kind === 'move') {
    const tabs = state.tabs.map((tab) => {
      if (tab.kind !== 'file' || tab.revision) return tab;
      const move = change.moves.find(({ from }) => tab.path === from || tab.path.startsWith(`${from}/`));
      if (!move) return tab;
      return { ...tab, path: `${move.to}${tab.path.slice(move.from.length)}`, missing: false };
    });
    return { ...state, tabs };
  }
  if (change.kind !== 'delete') return state;
  for (const tab of state.tabs) {
    if (tab.kind !== 'file' || tab.revision) continue;
    const removed = change.paths.some((path) => tab.path === path || tab.path.startsWith(`${path}/`));
    if (!removed) continue;
    if (tab.preview) next = closeWorkTab(next, tab.id);
    else next = { ...next, tabs: next.tabs.map((item) => item.id === tab.id ? { ...tab, missing: true } : item) };
  }
  return next;
}

export function restoreTerminalDescriptors(descriptors: TerminalDescriptor[]): RepoWorkTabs {
  const pane: WorkPane = {
    kind: 'pane',
    id: EMPTY_WORK_PANE_ID,
    tabIds: descriptors.map(({ id }) => id),
    activeTabId: null,
  };
  return {
    restored: true,
    activeTabId: null,
    activePaneId: pane.id,
    layout: pane,
    tabs: descriptors.map((descriptor) => ({
      kind: 'terminal' as const,
      repoPath: '',
      ...descriptor,
      shell: descriptor.shell ?? null,
      runtimeId: null,
      lifecycle: 'dormant' as const,
      exitCode: null,
      error: null,
    })),
  };
}

export function terminalDescriptors(state: RepoWorkTabs): TerminalDescriptor[] {
  return state.tabs
    .filter((tab): tab is WorkTerminalTab => tab.kind === 'terminal')
    .map(({ id, label, shell }) => ({ id, label, shell }));
}
