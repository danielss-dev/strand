import { create } from 'zustand';

import {
  closeCustomPane,
  createCustomTemplate,
  emptyCustomView,
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
  canUndo: boolean;
  restore(workspaceId: string): Promise<void>;
  activatePane(paneId: string): void;
  setSurface(paneId: string, surfaceId: CustomSurfaceId | null): void;
  splitPane(paneId: string, direction: CustomSplitDirection): void;
  closePane(paneId: string): void;
  applyTemplate(template: CustomTemplateId): void;
  undo(): void;
}

const models = new Map<string, CustomViewModel>();
const past = new Map<string, CustomViewModel[]>();
const restorePromises = new Map<string, Promise<CustomViewModel>>();
const persistenceTails = new Map<string, Promise<void>>();

function pushPast(workspaceId: string, model: CustomViewModel): void {
  const history = past.get(workspaceId) ?? [];
  history.push({ layout: model.layout, activePaneId: model.activePaneId });
  if (history.length > MAX_UNDO_HISTORY) history.shift();
  past.set(workspaceId, history);
}

function persist(workspaceId: string, model: CustomViewModel): void {
  const stored = storeCustomView(model);
  // Structural edits can arrive back-to-back (split, then immediately assign
  // a feature). Serialize writes so an older SQLite call cannot finish last
  // and replace the newest layout on the next launch. Each workspace owns an
  // independent queue, so a slow write in one workspace never stalls another.
  const tail = persistenceTails.get(workspaceId) ?? Promise.resolve();
  const next = tail
    .then(() => settings.set(customViewStorageKey(workspaceId), stored))
    .catch((error) => { console.warn('Custom view layout persist failed', error); });
  persistenceTails.set(workspaceId, next);
}

async function load(workspaceId: string): Promise<CustomViewModel> {
  let model: CustomViewModel | null = null;
  try {
    const stored = await settings.get<unknown>(customViewStorageKey(workspaceId));
    model = parseStoredCustomView(stored);

    // Preserve the original app-wide layout for existing users, but attach it
    // only to Default. Named workspaces deliberately begin independently.
    if (!model && stored == null && workspaceId === DEFAULT_WORKSPACE_ID) {
      model = parseStoredCustomView(await settings.get<unknown>(LEGACY_STORAGE_KEY));
      if (model) await settings.set(customViewStorageKey(workspaceId), storeCustomView(model));
    }
  } catch (error) {
    console.warn('Custom view layout restore failed', error);
  }
  return model ?? emptyCustomView();
}

export const useCustomView = create<CustomViewState>((set, get) => ({
  ...emptyCustomView(),
  workspaceId: null,
  restored: false,
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
    set({ ...emptyCustomView(), workspaceId, restored: false, canUndo: false });
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
      models.set(state.workspaceId, { layout: state.layout, activePaneId });
    }
  },

  setSurface(paneId, surfaceId) {
    set((state) => {
      if (!state.restored || !state.workspaceId) return state;
      const next = setCustomPaneSurface(state, paneId, surfaceId, makeId);
      if (next.layout === state.layout) return state;
      pushPast(state.workspaceId, state);
      models.set(state.workspaceId, next);
      persist(state.workspaceId, next);
      return { ...next, canUndo: true };
    });
  },

  splitPane(paneId, direction) {
    set((state) => {
      if (!state.restored || !state.workspaceId) return state;
      const next = splitCustomPane(state, paneId, direction, makeId);
      if (next.layout === state.layout) return state;
      pushPast(state.workspaceId, state);
      models.set(state.workspaceId, next);
      persist(state.workspaceId, next);
      return { ...next, canUndo: true };
    });
  },

  closePane(paneId) {
    set((state) => {
      if (!state.restored || !state.workspaceId) return state;
      const next = closeCustomPane(state, paneId);
      if (next.layout === state.layout) return state;
      pushPast(state.workspaceId, state);
      models.set(state.workspaceId, next);
      persist(state.workspaceId, next);
      return { ...next, canUndo: true };
    });
  },

  applyTemplate(template) {
    const workspaceId = get().workspaceId;
    if (!get().restored || !workspaceId) return;
    const current = get();
    const next = createCustomTemplate(template, makeId);
    pushPast(workspaceId, current);
    set({ ...next, canUndo: true });
    models.set(workspaceId, next);
    persist(workspaceId, next);
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
