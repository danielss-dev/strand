import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock('../lib/db', () => ({ settings: db }));

import { createCustomTemplate, customPanes, emptyCustomView, storeCustomView } from '../lib/customView';
import { DEFAULT_WORKSPACE_ID } from '../lib/workspaceIdentity';
import { surfaceIdForLegacyFeature } from '../workbench/builtInSurfaces';
import { customViewStorageKey, useCustomView } from './customView';

const surface = surfaceIdForLegacyFeature;

describe('Custom view persistence', () => {
  beforeEach(() => {
    db.get.mockReset();
    db.set.mockReset();
    db.set.mockResolvedValue(undefined);
  });

  it('restores independent workspace trees and serializes each workspace in order', async () => {
    let id = 0;
    const workspaceA = 'workspace-a';
    const workspaceB = 'workspace-b';
    const storedA = createCustomTemplate('review', () => `saved-a-${++id}`);
    const storedB = createCustomTemplate('focus', () => `saved-b-${++id}`);
    db.get.mockImplementation((key) => Promise.resolve(
      key === customViewStorageKey(workspaceA)
        ? storeCustomView(storedA)
        : key === customViewStorageKey(workspaceB)
          ? storeCustomView(storedB)
          : null,
    ));

    await useCustomView.getState().restore(workspaceA);
    expect(useCustomView.getState()).toMatchObject({
      workspaceId: workspaceA,
      layout: storedA.layout,
    });

    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writes: unknown[] = [];
    db.set.mockImplementation((key, value) => {
      writes.push(value);
      return key === customViewStorageKey(workspaceA) && writes.length === 1
        ? firstWrite
        : Promise.resolve();
    });

    const pane = useCustomView.getState().activePaneId;
    useCustomView.getState().setSurface(pane, surface('work'));
    useCustomView.getState().splitPane(pane, 'horizontal');

    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(1));
    expect(db.set).toHaveBeenNthCalledWith(
      1,
      customViewStorageKey(workspaceA),
      expect.objectContaining({ version: 2, layout: expect.any(Object) }),
    );

    // Workspace B restores and writes without waiting for A's blocked queue.
    await useCustomView.getState().restore(workspaceB);
    expect(useCustomView.getState().layout).toEqual(storedB.layout);
    useCustomView.getState().applyTemplate('review');
    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(2));
    expect(db.set.mock.calls[1][0]).toBe(customViewStorageKey(workspaceB));

    releaseFirst();
    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(3));
    expect(db.set.mock.calls[2][0]).toBe(customViewStorageKey(workspaceA));
    expect(writes[2]).toMatchObject({
      version: 2,
      layout: { kind: 'split', direction: 'horizontal' },
    });

    await useCustomView.getState().restore(workspaceA);
    expect(useCustomView.getState().layout).toMatchObject({
      kind: 'split',
      direction: 'horizontal',
    });
  });

  it('migrates the legacy app-wide layout only into Default', async () => {
    let id = 0;
    const legacy = createCustomTemplate('review', () => `legacy-${++id}`);
    db.get.mockImplementation((key) => Promise.resolve(
      key === 'custom-view.layout' ? storeCustomView(legacy) : null,
    ));

    await useCustomView.getState().restore(DEFAULT_WORKSPACE_ID);

    expect(useCustomView.getState().layout).toEqual(legacy.layout);
    expect(db.set).toHaveBeenCalledWith(
      customViewStorageKey(DEFAULT_WORKSPACE_ID),
      storeCustomView(legacy),
    );
  });

  it('does not reveal a stale layout when an earlier workspace restore finishes last', async () => {
    let id = 0;
    const workspaceA = 'restore-race-a';
    const workspaceB = 'restore-race-b';
    const storedA = createCustomTemplate('focus', () => `race-a-${++id}`);
    const storedB = createCustomTemplate('review', () => `race-b-${++id}`);
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    db.get.mockImplementation((key) => new Promise((resolve) => {
      if (key === customViewStorageKey(workspaceA)) resolveA = resolve;
      else if (key === customViewStorageKey(workspaceB)) resolveB = resolve;
      else resolve(null);
    }));

    const restoreA = useCustomView.getState().restore(workspaceA);
    const restoreB = useCustomView.getState().restore(workspaceB);
    resolveB(storeCustomView(storedB));
    await restoreB;
    expect(useCustomView.getState()).toMatchObject({
      workspaceId: workspaceB,
      layout: storedB.layout,
      restored: true,
    });

    resolveA(storeCustomView(storedA));
    await restoreA;
    expect(useCustomView.getState()).toMatchObject({
      workspaceId: workspaceB,
      layout: storedB.layout,
      restored: true,
    });
  });

  it('pushes every layout mutation and restores layout and active pane on undo', async () => {
    let id = 0;
    const workspace = 'undo-mutations';
    const stored = createCustomTemplate('review', () => `undo-${++id}`);
    db.get.mockResolvedValue(storeCustomView(stored));
    await useCustomView.getState().restore(workspace);

    const [first, second] = customPanes(stored.layout);
    useCustomView.getState().activatePane(second.id);
    useCustomView.getState().setSurface(first.id, surface('work'));
    expect(useCustomView.getState().canUndo).toBe(true);
    useCustomView.getState().undo();
    expect(useCustomView.getState()).toMatchObject({
      layout: stored.layout,
      activePaneId: second.id,
      canUndo: false,
    });

    useCustomView.getState().splitPane(first.id, 'vertical');
    expect(useCustomView.getState().canUndo).toBe(true);
    useCustomView.getState().undo();
    expect(useCustomView.getState()).toMatchObject({
      layout: stored.layout,
      activePaneId: second.id,
      canUndo: false,
    });

    useCustomView.getState().activatePane(first.id);
    useCustomView.getState().closePane(first.id);
    expect(useCustomView.getState().canUndo).toBe(true);
    useCustomView.getState().undo();
    expect(useCustomView.getState()).toMatchObject({
      layout: stored.layout,
      activePaneId: first.id,
      canUndo: false,
    });

    useCustomView.getState().applyTemplate('focus');
    expect(useCustomView.getState().canUndo).toBe(true);
    useCustomView.getState().undo();
    expect(useCustomView.getState()).toMatchObject({
      layout: stored.layout,
      activePaneId: first.id,
      canUndo: false,
    });

    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(8));
  });

  it('caps undo history at 50 entries', async () => {
    const workspace = 'undo-cap';
    db.get.mockResolvedValue(storeCustomView(emptyCustomView()));
    await useCustomView.getState().restore(workspace);

    for (let index = 0; index < 51; index += 1) {
      useCustomView.getState().setSurface(
        'custom-pane-root',
        surface(index % 2 === 0 ? 'work' : 'local'),
      );
    }
    for (let index = 0; index < 50; index += 1) useCustomView.getState().undo();

    expect(useCustomView.getState()).toMatchObject({
      layout: {
        kind: 'pane',
        id: 'custom-pane-root',
        surface: { surfaceId: surface('work') },
      },
      activePaneId: 'custom-pane-root',
      canUndo: false,
    });
    const afterCap = useCustomView.getState();
    useCustomView.getState().undo();
    expect(useCustomView.getState()).toBe(afterCap);
    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(101));
  });

  it('does nothing when there is no layout to undo', async () => {
    const workspace = 'undo-empty';
    db.get.mockResolvedValue(storeCustomView(emptyCustomView()));
    await useCustomView.getState().restore(workspace);
    const before = useCustomView.getState();

    useCustomView.getState().undo();

    expect(useCustomView.getState()).toBe(before);
    expect(useCustomView.getState().canUndo).toBe(false);
    expect(db.set).not.toHaveBeenCalled();
  });
});
