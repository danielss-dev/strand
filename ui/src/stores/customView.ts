import { create } from 'zustand';

import {
  closeCustomPane,
  createCustomTemplate,
  defaultWorkbenchView,
  parseStoredCustomView,
  setCustomPaneSurface,
  splitCustomPane,
  storeCustomView,
  type CustomSurfaceId,
  type CustomLayout,
  type CustomSplitDirection,
  type CustomTemplateId,
  type CustomViewModel,
} from '../lib/customView';
import { settings } from '../lib/db';
import { DEFAULT_WORKSPACE_ID } from '../lib/workspaceIdentity';

const LEGACY_STORAGE_KEY = 'custom-view.layout';
export const customViewStorageKey = (workspaceId: string) =>
  `custom-view.layout:${workspaceId}`;
const makeId = () => crypto.randomUUID();
const MAX_UNDO_HISTORY = 50;

interface CustomViewState extends CustomViewModel {
  workspaceId: string | null;
  restored: boolean;
  /** False means the Workbench uses its implicit full-size Work default. */
  configured: boolean;
  canUndo: boolean;
  restore(workspaceId: string): Promise<void>;
  activatePane(paneId: string): void;
  setSurface(paneId: string, surfaceId: CustomSurfaceId | null): void;
  splitPane(paneId: string, direction: CustomSplitDirection): void;
  closePane(paneId: string): void;
  applyTemplate(template: CustomTemplateId): void;
  resetWorkbench(): void;
  undo(): void;
}

interface WorkspaceViewModel extends CustomViewModel {
  configured: boolean;
}

const models = new Map<string, WorkspaceViewModel>();
const past = new Map<string, WorkspaceViewModel[]>();
const restorePromises = new Map<string, Promise<WorkspaceViewModel>>();
const persistenceTails = new Map<string, Promise<void>>();

function pushPast(workspaceId: string, model: WorkspaceViewModel): void {
  const history = past.get(workspaceId) ?? [];
  history.push({
    layout: model.layout,
    activePaneId: model.activePaneId,
    configured: model.configured,
  });
  if (history.length > MAX_UNDO_HISTORY) history.shift();
  past.set(workspaceId, history);
}

function persist(workspaceId: string, model: WorkspaceViewModel): void {
  // Structural edits can arrive back-to-back (split, then immediately assign
  // a feature). Serialize writes so an older SQLite call cannot finish last
  // and replace the newest layout on the next launch. Each workspace owns an
  // independent queue, so a slow write in one workspace never stalls another.
  const tail = persistenceTails.get(workspaceId) ?? Promise.resolve();
  const next = tail
    .then(() => model.configured
      ? settings.set(customViewStorageKey(workspaceId), storeCustomView(model))
      : settings.remove(customViewStorageKey(workspaceId)))
    .catch((error) => { console.warn('Workbench layout persist failed', error); });
  persistenceTails.set(workspaceId, next);
}

async function load(workspaceId: string): Promise<WorkspaceViewModel> {
  let model: CustomViewModel | null = null;
  try {
    const stored = await settings.get<unknown>(customViewStorageKey(workspaceId));
    model = parseStoredCustomView(stored);

    // Preserve the original app-wide layout for existing users, but attach it
    // only to Default. Named workspaces deliberately begin independently.
    if (!model && stored == null && workspaceId === DEFAULT_WORKSPACE_ID) {
      model = parseStoredCustomView(await settings.get<unknown>(LEGACY_STORAGE_KEY));
      if (model) {
        await settings.set(customViewStorageKey(workspaceId), storeCustomView(model));
        // Complete the one-way migration. Leaving the global value behind
        // would resurrect it after the user resets Default to zero-config.
        await settings.remove(LEGACY_STORAGE_KEY);
      }
    }
  } catch (error) {
    console.warn('Workbench layout restore failed', error);
  }
  return model
    ? { ...model, configured: true }
    : { ...defaultWorkbenchView(), configured: false };
}

export const useCustomView = create<CustomViewState>((set, get) => ({
  ...defaultWorkbenchView(),
  workspaceId: null,
  restored: false,
  configured: false,
  canUndo: false,

  async restore(workspaceId) {
    const current = get();
    if (current.workspaceId === workspaceId && current.restored) return;

    const cached = models.get(workspaceId);
    if (cached) {
      set({
        ...cached,
        workspaceId,
        restored: true,
        canUndo: (past.get(workspaceId)?.length ?? 0) > 0,
      });
      return;
    }

    // Hide the previous workspace's tree immediately. Its layout must never
    // flash or accept edits while this workspace's SQLite read is pending.
    set({
      ...defaultWorkbenchView(),
      workspaceId,
      restored: false,
      configured: false,
      canUndo: false,
    });
    let promise = restorePromises.get(workspaceId);
    if (!promise) {
      promise = load(workspaceId).finally(() => { restorePromises.delete(workspaceId); });
      restorePromises.set(workspaceId, promise);
    }
    const model = await promise;
    models.set(workspaceId, model);
    if (get().workspaceId === workspaceId) {
      set({ ...model, restored: true, canUndo: (past.get(workspaceId)?.length ?? 0) > 0 });
    }
  },

  activatePane(activePaneId) {
    const state = get();
    if (state.activePaneId === activePaneId) return;
    set({ activePaneId });
    if (state.restored && state.workspaceId) {
      models.set(state.workspaceId, {
        layout: state.layout,
        activePaneId,
        configured: state.configured,
      });
    }
  },

  setSurface(paneId, surfaceId) {
    set((state) => {
      if (!state.restored || !state.workspaceId) return state;
      const next = setCustomPaneSurface(state, paneId, surfaceId, makeId);
      if (next.layout === state.layout) return state;
      pushPast(state.workspaceId, state);
      const configured = { ...next, configured: true };
      models.set(state.workspaceId, configured);
      persist(state.workspaceId, configured);
      return { ...configured, canUndo: true };
    });
  },

  splitPane(paneId, direction) {
    set((state) => {
      if (!state.restored || !state.workspaceId) return state;
      const next = splitCustomPane(state, paneId, direction, makeId);
      if (next.layout === state.layout) return state;
      pushPast(state.workspaceId, state);
      const configured = { ...next, configured: true };
      models.set(state.workspaceId, configured);
      persist(state.workspaceId, configured);
      return { ...configured, canUndo: true };
    });
  },

  closePane(paneId) {
    set((state) => {
      if (!state.restored || !state.workspaceId) return state;
      const next = closeCustomPane(state, paneId);
      if (next.layout === state.layout) return state;
      pushPast(state.workspaceId, state);
      const configured = { ...next, configured: true };
      models.set(state.workspaceId, configured);
      persist(state.workspaceId, configured);
      return { ...configured, canUndo: true };
    });
  },

  applyTemplate(template) {
    const workspaceId = get().workspaceId;
    if (!get().restored || !workspaceId) return;
    const current = get();
    const next = createCustomTemplate(template, makeId);
    pushPast(workspaceId, current);
    const configured = { ...next, configured: true };
    set({ ...configured, canUndo: true });
    models.set(workspaceId, configured);
    persist(workspaceId, configured);
  },

  resetWorkbench() {
    const state = get();
    if (!state.restored || !state.workspaceId || !state.configured) return;
    pushPast(state.workspaceId, state);
    const next = { ...defaultWorkbenchView(), configured: false };
    models.set(state.workspaceId, next);
    persist(state.workspaceId, next);
    set({ ...next, canUndo: true });
  },

  undo() {
    const state = get();
    if (!state.restored || !state.workspaceId) return;
    const history = past.get(state.workspaceId);
    if (!history?.length) return;
    const previous = history.pop()!;
    models.set(state.workspaceId, previous);
    persist(state.workspaceId, previous);
    set({ ...previous, canUndo: history.length > 0 });
  },
}));

export type { CustomLayout, CustomSplitDirection, CustomSurfaceId, CustomTemplateId };
