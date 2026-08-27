import { describe, expect, it } from 'vitest';

import {
  closeCustomPane,
  createCustomTemplate,
  customPanes,
  emptyCustomView,
  parseStoredCustomView,
  setCustomPaneFeature,
  splitCustomPane,
  storeCustomView,
} from './customView';

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

describe('Custom view layout', () => {
  it('splits a pane and collapses it into its neighbor', () => {
    let state = setCustomPaneFeature(emptyCustomView(), 'custom-pane-root', 'work');
    state = splitCustomPane(state, state.activePaneId, 'horizontal', ids());
    expect(state.layout).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      children: [
        { kind: 'pane', feature: 'work' },
        { kind: 'pane', id: 'id-1', feature: null },
      ],
    });
    state = setCustomPaneFeature(state, state.activePaneId, 'commits');
    state = closeCustomPane(state, 'custom-pane-root');
    expect(state.layout).toMatchObject({ kind: 'pane', id: 'id-1', feature: 'commits' });
  });

  it('collapses nested template panes without disturbing surviving features', () => {
    let state = createCustomTemplate('vscode', ids());
    const local = customPanes(state.layout).find((pane) => pane.feature === 'local');
    expect(local).toBeDefined();
    state = closeCustomPane(state, local!.id);
    expect(customPanes(state.layout).map((pane) => pane.feature)).toEqual(['work', 'commits']);
    expect(state.activePaneId).toBe(customPanes(state.layout)[1].id);

    state = closeCustomPane(state, state.activePaneId);
    expect(state.layout).toMatchObject({ kind: 'pane', feature: 'work' });
  });

  it('moves a feature instead of mounting the same surface twice', () => {
    let state = setCustomPaneFeature(emptyCustomView(), 'custom-pane-root', 'review');
    state = splitCustomPane(state, 'custom-pane-root', 'vertical', ids());
    state = setCustomPaneFeature(state, state.activePaneId, 'review');
    expect(customPanes(state.layout).map((pane) => pane.feature)).toEqual([null, 'review']);
  });

  it('creates a VS Code-style workbench template with stable split identities', () => {
    const state = createCustomTemplate('vscode', ids());
    expect(customPanes(state.layout).map((pane) => pane.feature)).toEqual(['work', 'local', 'commits']);
    expect(state.layout).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      ratio: 68,
      children: [
        { kind: 'pane', feature: 'work' },
        { kind: 'split', direction: 'vertical', ratio: 56 },
      ],
    });
  });

  it('bounds a layout to the number of unique feature surfaces', () => {
    let state = emptyCustomView();
    const makeId = ids();
    for (let i = 1; i < 8; i += 1) {
      state = splitCustomPane(state, state.activePaneId, i % 2 ? 'horizontal' : 'vertical', makeId);
    }
    expect(customPanes(state.layout)).toHaveLength(8);
    expect(splitCustomPane(state, state.activePaneId, 'horizontal', makeId)).toBe(state);
  });

  it('round-trips a stored layout and rejects duplicate features or ids', () => {
    const state = createCustomTemplate('review', ids());
    expect(parseStoredCustomView(storeCustomView(state))?.layout).toEqual(state.layout);

    const duplicateFeature = {
      version: 1,
      layout: {
        kind: 'split', id: 'split', direction: 'horizontal', ratio: 50,
        children: [
          { kind: 'pane', id: 'one', feature: 'work' },
          { kind: 'pane', id: 'two', feature: 'work' },
        ],
      },
    };
    expect(parseStoredCustomView(duplicateFeature)).toBeNull();
    expect(parseStoredCustomView({
      ...duplicateFeature,
      layout: {
        ...duplicateFeature.layout,
        children: [
          { kind: 'pane', id: 'same', feature: 'work' },
          { kind: 'pane', id: 'same', feature: 'local' },
        ],
      },
    })).toBeNull();
    expect(parseStoredCustomView({
      version: 1,
      layout: {
        ...duplicateFeature.layout,
        ratio: 83,
        children: [
          { kind: 'pane', id: 'one', feature: 'work' },
          { kind: 'pane', id: 'two', feature: 'local' },
        ],
      },
    })).toBeNull();
  });
});
