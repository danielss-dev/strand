import { create } from 'zustand';

import {
  closeCustomPane,
  createCustomTemplate,
  emptyCustomView,
  parseStoredCustomView,
  setCustomPaneFeature,
  splitCustomPane,
  storeCustomView,
  type CustomFeatureId,
  type CustomLayout,
  type CustomSplitDirection,
  type CustomTemplateId,
  type CustomViewModel,
} from '../lib/customView';
import { settings } from '../lib/db';

const STORAGE_KEY = 'custom-view.layout';
const makeId = () => crypto.randomUUID();

interface CustomViewState extends CustomViewModel {
  restored: boolean;
  restore(): Promise<void>;
  activatePane(paneId: string): void;
  setFeature(paneId: string, feature: CustomFeatureId | null): void;
  splitPane(paneId: string, direction: CustomSplitDirection): void;
  closePane(paneId: string): void;
  applyTemplate(template: CustomTemplateId): void;
}

let restorePromise: Promise<void> | null = null;
let persistenceTail: Promise<void> = Promise.resolve();

function persist(model: CustomViewModel): void {
  const stored = storeCustomView(model);
  // Structural edits can arrive back-to-back (split, then immediately assign
  // a feature). Serialize writes so an older SQLite call cannot finish last
  // and replace the newest layout on the next launch.
  persistenceTail = persistenceTail
    .then(() => settings.set(STORAGE_KEY, stored))
    .catch((error) => { console.warn('Custom view layout persist failed', error); });
}

export const useCustomView = create<CustomViewState>((set, get) => ({
  ...emptyCustomView(),
  restored: false,

  async restore() {
    if (get().restored) return;
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      let model: CustomViewModel | null = null;
      try {
        model = parseStoredCustomView(await settings.get<unknown>(STORAGE_KEY));
      } catch (error) {
        console.warn('Custom view layout restore failed', error);
      }
      set({ ...(model ?? emptyCustomView()), restored: true });
    })().finally(() => { restorePromise = null; });
    return restorePromise;
  },

  activatePane(activePaneId) {
    if (get().activePaneId === activePaneId) return;
    set({ activePaneId });
  },

  setFeature(paneId, feature) {
    set((state) => {
      const next = setCustomPaneFeature(state, paneId, feature);
      if (next.layout === state.layout) return state;
      persist(next);
      return next;
    });
  },

  splitPane(paneId, direction) {
    set((state) => {
      const next = splitCustomPane(state, paneId, direction, makeId);
      if (next.layout === state.layout) return state;
      persist(next);
      return next;
    });
  },

  closePane(paneId) {
    set((state) => {
      const next = closeCustomPane(state, paneId);
      if (next.layout === state.layout) return state;
      persist(next);
      return next;
    });
  },

  applyTemplate(template) {
    const next = createCustomTemplate(template, makeId);
    set(next);
    persist(next);
  },
}));

export type { CustomFeatureId, CustomLayout, CustomSplitDirection, CustomTemplateId };
