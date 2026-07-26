import { create } from 'zustand';

import { settings } from '../lib/db';
import { t } from '../lib/i18n';
import {
  activateWorkPane,
  activateWorkTab,
  activeWorkPane,
  appendWorkTab,
  closeEmptyWorkPane,
  closeWorkTab,
  EMPTY_REPO_WORK,
  findWorkPane,
  openWorkFile,
  moveWorkTab,
  reconcileWorkMutation,
  restoreTerminalDescriptors,
  splitWorkPane,
  splitWorkTab,
  terminalDescriptors,
  workPanes,
  type RepoWorkTabs,
  type TerminalLifecycle,
  type WorkFileTab,
  type WorkFileMode,
  type WorkPaneEdge,
  type WorkTab,
  type WorkTerminalTab,
} from '../lib/workTabs';
import type { FilesTreeMutationChange } from '../lib/types';
import type { EmbeddedShellChoice } from '../lib/types';
import { isPreviewablePath } from '../lib/preview';
import { useSettings } from './settings';

const key = (repoPath: string) => `work-terminals:${repoPath}`;
const fresh = (): RepoWorkTabs => ({ ...EMPTY_REPO_WORK, tabs: [] });
const makeId = () => crypto.randomUUID();

interface WorkState {
  repos: Record<string, RepoWorkTabs>;
  restore(repoPath: string): Promise<void>;
  openFile(
    repoPath: string,
    path: string,
    revision: string | null,
    isDirectory: boolean,
    disposition?: 'preview' | 'pinned',
    mode?: WorkFileMode,
    paneId?: string,
  ): void;
  setFileMode(repoPath: string, id: string, mode: WorkFileMode): void;
  addTerminal(repoPath: string, shell?: EmbeddedShellChoice | null, label?: string, paneId?: string): string;
  activate(repoPath: string, id: string): void;
  activatePane(repoPath: string, paneId: string): void;
  splitPane(repoPath: string, paneId: string, direction: 'horizontal' | 'vertical'): void;
  moveTab(repoPath: string, tabId: string, paneId: string, beforeTabId?: string | null): void;
  splitTab(repoPath: string, tabId: string, paneId: string, edge: WorkPaneEdge): void;
  closePane(repoPath: string, paneId: string): void;
  moveActiveTabToAdjacentPane(repoPath: string, delta: -1 | 1): void;
  splitActiveTab(repoPath: string, edge: WorkPaneEdge): void;
  close(repoPath: string, id: string): Promise<void>;
  setTerminalRuntime(repoPath: string, id: string, runtimeId: string, label?: string): void;
  setTerminalState(
    repoPath: string,
    id: string,
    lifecycle: TerminalLifecycle,
    detail?: { exitCode?: number | null; error?: string | null },
  ): void;
  clearTerminalRuntime(repoPath: string, id: string): void;
  reconcile(repoPath: string, change: FilesTreeMutationChange): void;
  clearRepo(repoPath: string): Promise<void>;
}

function persistTerminals(repoPath: string, state: RepoWorkTabs): void {
  void settings.set(key(repoPath), terminalDescriptors(state)).catch((error) =>
    console.warn('Work terminal descriptors persist failed', error));
}

export const useWork = create<WorkState>((set, get) => ({
  repos: {},

  async restore(repoPath) {
    if (get().repos[repoPath]?.restored) return;
    const descriptors = (await settings.get<Array<{
      id: string;
      label: string;
      shell?: EmbeddedShellChoice | null;
    }>>(key(repoPath))) ?? [];
    set((state) => {
      if (state.repos[repoPath]?.restored) return state;
      const restored = restoreTerminalDescriptors(descriptors);
      return {
        repos: {
          ...state.repos,
          [repoPath]: {
            ...restored,
            tabs: restored.tabs.map((tab) => ({ ...tab, repoPath })),
          },
        },
      };
    });
  },

  openFile(repoPath, path, revision, isDirectory, disposition = 'preview', mode, paneId) {
    const initialMode = mode ?? (
      !isDirectory && useSettings.getState().fileOpenTab === 'preview' && isPreviewablePath(path)
        ? 'preview'
        : 'content'
    );
    set((state) => ({
      repos: {
        ...state.repos,
        [repoPath]: openWorkFile(
          paneId
            ? activateWorkPane(state.repos[repoPath] ?? fresh(), paneId)
            : state.repos[repoPath] ?? fresh(),
          { repoPath, path, revision, isDirectory, mode: initialMode },
          disposition,
          makeId,
        ),
      },
    }));
  },

  setFileMode(repoPath, id, mode) {
    set((state) => {
      const repo = state.repos[repoPath] ?? fresh();
      return {
        repos: {
          ...state.repos,
          [repoPath]: {
            ...repo,
            tabs: repo.tabs.map((tab) => tab.id === id && tab.kind === 'file' ? { ...tab, mode } : tab),
          },
        },
      };
    });
  },

  addTerminal(repoPath, shell = null, label, paneId) {
    const repo = get().repos[repoPath] ?? fresh();
    const terminalNumber = repo.tabs.filter((tab) => tab.kind === 'terminal').length + 1;
    const id = makeId();
    const tab: WorkTerminalTab = {
      kind: 'terminal', id, repoPath,
      label: label ?? t('work.terminalLabel', { count: terminalNumber }),
      shell,
      runtimeId: null, lifecycle: 'dormant', exitCode: null, error: null,
    };
    const next = { ...appendWorkTab(repo, tab, paneId), restored: true };
    set((state) => ({ repos: { ...state.repos, [repoPath]: next } }));
    persistTerminals(repoPath, next);
    return id;
  },

  activate(repoPath, id) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo?.tabs.some((tab) => tab.id === id)) return state;
      const next = activateWorkTab(repo, id);
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  activatePane(repoPath, paneId) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo || !findWorkPane(repo.layout, paneId)) return state;
      const next = activateWorkPane(repo, paneId);
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  splitPane(repoPath, paneId, direction) {
    const repo = get().repos[repoPath] ?? fresh();
    const pane = findWorkPane(repo.layout, paneId) ?? activeWorkPane(repo);
    const active = repo.tabs.find((tab) => tab.id === pane.activeTabId);
    if (!active) return;
    let duplicate: WorkTab | null = null;
    if (active?.kind === 'file') {
      duplicate = { ...active, id: makeId(), preview: false };
    } else if (active?.kind === 'terminal') {
      const terminalNumber = repo.tabs.filter((tab) => tab.kind === 'terminal').length + 1;
      duplicate = {
        ...active,
        id: makeId(),
        label: t('work.terminalLabel', { count: terminalNumber }),
        runtimeId: null,
        lifecycle: 'dormant',
        exitCode: null,
        error: null,
      };
    }
    const next = splitWorkPane(repo, pane.id, direction, makeId(), duplicate);
    set((state) => ({ repos: { ...state.repos, [repoPath]: next } }));
    if (duplicate?.kind === 'terminal') persistTerminals(repoPath, next);
  },

  moveTab(repoPath, tabId, paneId, beforeTabId = null) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo) return state;
      const next = moveWorkTab(repo, tabId, paneId, beforeTabId);
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  splitTab(repoPath, tabId, paneId, edge) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo) return state;
      const next = splitWorkTab(repo, tabId, paneId, edge, makeId());
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  closePane(repoPath, paneId) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo) return state;
      const next = closeEmptyWorkPane(repo, paneId);
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  moveActiveTabToAdjacentPane(repoPath, delta) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo || !repo.activeTabId) return state;
      const panes = workPanes(repo.layout);
      if (panes.length < 2) return state;
      const activeIndex = panes.findIndex((pane) => pane.id === repo.activePaneId);
      const target = panes[(activeIndex + delta + panes.length) % panes.length];
      const next = moveWorkTab(repo, repo.activeTabId, target.id);
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  splitActiveTab(repoPath, edge) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo || !repo.activeTabId) return state;
      const next = splitWorkTab(repo, repo.activeTabId, repo.activePaneId, edge, makeId());
      return next === repo ? state : { repos: { ...state.repos, [repoPath]: next } };
    });
  },

  async close(repoPath, id) {
    const repo = get().repos[repoPath];
    const tab = repo?.tabs.find((item) => item.id === id);
    if (!repo || !tab) return;
    if (tab.kind === 'terminal' && tab.runtimeId) {
      const { tauri } = await import('../lib/tauri');
      await tauri.terminalClose(tab.runtimeId).catch(() => undefined);
    }
    const next = closeWorkTab(get().repos[repoPath] ?? repo, id);
    set((state) => ({ repos: { ...state.repos, [repoPath]: next } }));
    if (tab.kind === 'terminal') persistTerminals(repoPath, next);
  },

  setTerminalRuntime(repoPath, id, runtimeId, label) {
    set((state) => ({
      repos: {
        ...state.repos,
        [repoPath]: mapTab(state.repos[repoPath], id, (tab) => tab.kind === 'terminal'
          ? { ...tab, runtimeId, lifecycle: 'running', label: label ?? tab.label, exitCode: null, error: null }
          : tab),
      },
    }));
    const next = get().repos[repoPath];
    if (next) persistTerminals(repoPath, next);
  },

  setTerminalState(repoPath, id, lifecycle, detail = {}) {
    set((state) => ({
      repos: {
        ...state.repos,
        [repoPath]: mapTab(state.repos[repoPath], id, (tab) => tab.kind === 'terminal'
          ? { ...tab, lifecycle, exitCode: detail.exitCode ?? tab.exitCode, error: detail.error ?? null }
          : tab),
      },
    }));
  },

  clearTerminalRuntime(repoPath, id) {
    set((state) => ({
      repos: {
        ...state.repos,
        [repoPath]: mapTab(state.repos[repoPath], id, (tab) => tab.kind === 'terminal'
          ? { ...tab, runtimeId: null }
          : tab),
      },
    }));
  },

  reconcile(repoPath, change) {
    set((state) => {
      const repo = state.repos[repoPath];
      if (!repo) return state;
      return { repos: { ...state.repos, [repoPath]: reconcileWorkMutation(repo, change) } };
    });
  },

  async clearRepo(repoPath) {
    const repo = get().repos[repoPath];
    for (const tab of repo?.tabs ?? []) {
      if (tab.kind === 'terminal' && tab.runtimeId) {
        const { tauri } = await import('../lib/tauri');
        await tauri.terminalClose(tab.runtimeId).catch(() => undefined);
      }
    }
    set((state) => {
      const repos = { ...state.repos };
      delete repos[repoPath];
      return { repos };
    });
    await settings.set(key(repoPath), []);
  },
}));

function mapTab(
  repo: RepoWorkTabs | undefined,
  id: string,
  map: (tab: WorkTab) => WorkTab,
): RepoWorkTabs {
  const current = repo ?? fresh();
  return { ...current, tabs: current.tabs.map((tab) => tab.id === id ? map(tab) : tab) };
}

export function activeWorkTab(repoPath: string | null): WorkTab | null {
  if (!repoPath) return null;
  const repo = useWork.getState().repos[repoPath];
  return repo?.tabs.find((tab) => tab.id === repo.activeTabId) ?? null;
}

export type { WorkFileTab, WorkTab };
