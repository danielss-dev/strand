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

export interface RepoWorkTabs {
  tabs: WorkTab[];
  activeTabId: string | null;
  restored: boolean;
}

export interface TerminalDescriptor {
  id: string;
  label: string;
  /** Optional for descriptors written before per-terminal shell selection. */
  shell?: EmbeddedShellChoice | null;
}

export const EMPTY_REPO_WORK: RepoWorkTabs = { tabs: [], activeTabId: null, restored: false };

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
  const pinned = state.tabs.find(
    (tab): tab is WorkFileTab => tab.kind === 'file' && !tab.preview && fileIdentity(tab) === identity,
  );
  if (pinned) return { ...state, activeTabId: pinned.id };

  const previewIndex = state.tabs.findIndex((tab) => tab.kind === 'file' && tab.preview);
  const matchingPreview = previewIndex >= 0
    && fileIdentity(state.tabs[previewIndex] as WorkFileTab) === identity;
  if (matchingPreview && disposition === 'pinned') {
    const tabs = state.tabs.slice();
    tabs[previewIndex] = { ...(tabs[previewIndex] as WorkFileTab), preview: false };
    return { ...state, tabs, activeTabId: tabs[previewIndex].id };
  }
  if (matchingPreview) return { ...state, activeTabId: state.tabs[previewIndex].id };

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
    return { ...state, tabs, activeTabId: tabs[previewIndex].id };
  }
  return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id };
}

export function closeWorkTab(state: RepoWorkTabs, id: string): RepoWorkTabs {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeTabId = state.activeTabId === id
    ? (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null
    : state.activeTabId;
  return { ...state, tabs, activeTabId };
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
  return {
    restored: true,
    activeTabId: null,
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
