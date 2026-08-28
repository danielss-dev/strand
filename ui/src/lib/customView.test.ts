import { describe, expect, it } from 'vitest';

import {
  MAX_CUSTOM_PANES,
  closeCustomPane,
  createCustomTemplate,
  customPanes,
  emptyCustomView,
  parseStoredCustomView,
  setCustomPaneSurface,
  splitCustomPane,
  storeCustomView,
} from './customView';
import {
  legacyFeatureIdForSurface,
  surfaceIdForLegacyFeature,
  type LegacyCustomFeatureId,
} from '../workbench/builtInSurfaces';

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

function legacySurfaces(state: ReturnType<typeof emptyCustomView>) {
  return customPanes(state.layout).map((pane) => (
    pane.surface ? legacyFeatureIdForSurface(pane.surface.surfaceId) ?? pane.surface.surfaceId : null
  ));
}

const surface = (legacy: LegacyCustomFeatureId) => surfaceIdForLegacyFeature(legacy);

describe('Custom view layout', () => {
  it('splits a pane and collapses it into its neighbor', () => {
    const makeId = ids();
    let state = setCustomPaneSurface(emptyCustomView(), 'custom-pane-root', surface('work'), makeId);
    state = splitCustomPane(state, state.activePaneId, 'horizontal', makeId);
    expect(legacySurfaces(state)).toEqual(['work', null]);
    state = setCustomPaneSurface(state, state.activePaneId, surface('commits'), makeId);
    state = closeCustomPane(state, 'custom-pane-root');
    expect(legacySurfaces(state)).toEqual(['commits']);
  });

  it('collapses nested template panes without disturbing surviving surfaces', () => {
    let state = createCustomTemplate('vscode', ids());
    const local = customPanes(state.layout).find((pane) => pane.surface?.surfaceId === surface('local'));
    expect(local).toBeDefined();
    state = closeCustomPane(state, local!.id);
    expect(legacySurfaces(state)).toEqual(['files', 'work', 'commits']);
    expect(state.activePaneId).toBe(customPanes(state.layout)[2].id);

    state = closeCustomPane(state, state.activePaneId);
    const files = customPanes(state.layout).find((pane) => pane.surface?.surfaceId === surface('files'));
    expect(files).toBeDefined();
    state = closeCustomPane(state, files!.id);
    expect(legacySurfaces(state)).toEqual(['work']);
  });

  it('moves singleton surface instances and swaps the target contents', () => {
    const makeId = ids();
    let state = createCustomTemplate('review', makeId);
    const [review, commits] = customPanes(state.layout);
    const commitsInstance = commits.surface?.instanceId;
    state = setCustomPaneSurface(state, review.id, surface('commits'), makeId);
    expect(legacySurfaces(state)).toEqual(['commits', 'review']);
    expect(customPanes(state.layout)[0].surface?.instanceId).toBe(commitsInstance);
  });

  it('assigns unused surfaces and moves a singleton into an empty pane', () => {
    const makeId = ids();
    let state = setCustomPaneSurface(emptyCustomView(), 'custom-pane-root', surface('review'), makeId);
    state = splitCustomPane(state, 'custom-pane-root', 'vertical', makeId);
    state = setCustomPaneSurface(state, state.activePaneId, surface('review'), makeId);
    expect(legacySurfaces(state)).toEqual([null, 'review']);
    state = setCustomPaneSurface(state, 'custom-pane-root', surface('work'), makeId);
    expect(legacySurfaces(state)).toEqual(['work', 'review']);
  });

  it('creates the VS Code template with namespaced surfaces and stable splits', () => {
    const state = createCustomTemplate('vscode', ids());
    expect(legacySurfaces(state)).toEqual(['files', 'work', 'local', 'commits']);
    expect(state.layout).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
      ratio: 18,
      children: [
        { kind: 'pane', surface: { surfaceId: surface('files') } },
        {
          kind: 'split',
          direction: 'horizontal',
          ratio: 72,
          children: [
            { kind: 'pane', surface: { surfaceId: surface('work') } },
            { kind: 'split', direction: 'vertical', ratio: 56 },
          ],
        },
      ],
    });
  });

  it('uses a defensive pane cap independent of installed contributions', () => {
    let state = emptyCustomView();
    const makeId = ids();
    for (let index = 1; index < MAX_CUSTOM_PANES; index += 1) {
      state = splitCustomPane(state, state.activePaneId, index % 2 ? 'horizontal' : 'vertical', makeId);
    }
    expect(customPanes(state.layout)).toHaveLength(MAX_CUSTOM_PANES);
    expect(splitCustomPane(state, state.activePaneId, 'horizontal', makeId)).toBe(state);
  });

  it('round-trips v2 and preserves unknown plugin surfaces', () => {
    const state = createCustomTemplate('review', ids());
    expect(parseStoredCustomView(storeCustomView(state))?.layout).toEqual(state.layout);

    const pluginLayout = {
      version: 2,
      layout: {
        kind: 'pane',
        id: 'plugin-pane',
        surface: {
          surfaceId: 'example.plugin.dashboard',
          instanceId: 'plugin-instance',
          binding: { kind: 'follow-active' },
        },
      },
    };
    expect(parseStoredCustomView(pluginLayout)?.layout).toMatchObject(pluginLayout.layout);
  });

  it('migrates v1 layouts and rejects corrupt v2 identity or singleton data', () => {
    const migrated = parseStoredCustomView({
      version: 1,
      layout: { kind: 'pane', id: 'legacy', feature: 'work' },
    });
    expect(legacySurfaces(migrated!)).toEqual(['work']);

    const maxLegacyId = 'p'.repeat(160);
    const maxIdMigration = parseStoredCustomView({
      version: 1,
      layout: { kind: 'pane', id: maxLegacyId, feature: 'files' },
    });
    expect(maxIdMigration).not.toBeNull();
    expect(parseStoredCustomView(storeCustomView(maxIdMigration!))).not.toBeNull();

    const duplicate = {
      version: 2,
      layout: {
        kind: 'split', id: 'split', direction: 'horizontal', ratio: 50,
        children: [
          {
            kind: 'pane', id: 'one',
            surface: { surfaceId: surface('work'), instanceId: 'one-instance', binding: { kind: 'follow-active' } },
          },
          {
            kind: 'pane', id: 'two',
            surface: { surfaceId: surface('work'), instanceId: 'two-instance', binding: { kind: 'follow-active' } },
          },
        ],
      },
    };
    expect(parseStoredCustomView(duplicate)).toBeNull();
    expect(parseStoredCustomView({
      ...duplicate,
      layout: {
        ...duplicate.layout,
        children: [
          duplicate.layout.children[0],
          { ...duplicate.layout.children[1], id: 'one' },
        ],
      },
    })).toBeNull();
  });
});
