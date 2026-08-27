import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));

vi.mock('../lib/db', () => ({ settings: db }));

import { createCustomTemplate, storeCustomView } from '../lib/customView';
import { useCustomView } from './customView';

describe('Custom view persistence', () => {
  beforeEach(() => {
    db.get.mockReset();
    db.set.mockReset();
    db.set.mockResolvedValue(undefined);
  });

  it('restores a versioned tree and serializes layout mutations in order', async () => {
    let id = 0;
    const stored = createCustomTemplate('review', () => `saved-${++id}`);
    db.get.mockResolvedValue(storeCustomView(stored));

    await useCustomView.getState().restore();
    expect(useCustomView.getState().layout).toEqual(stored.layout);

    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writes: unknown[] = [];
    db.set.mockImplementation((_key, value) => {
      writes.push(value);
      return writes.length === 1 ? firstWrite : Promise.resolve();
    });

    const pane = useCustomView.getState().activePaneId;
    useCustomView.getState().setFeature(pane, 'work');
    useCustomView.getState().splitPane(pane, 'horizontal');

    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(1));
    expect(db.set).toHaveBeenNthCalledWith(
      1,
      'custom-view.layout',
      expect.objectContaining({ version: 1, layout: expect.any(Object) }),
    );

    releaseFirst();
    await vi.waitFor(() => expect(db.set).toHaveBeenCalledTimes(2));
    expect(writes[1]).toMatchObject({
      version: 1,
      layout: { kind: 'split', direction: 'horizontal' },
    });
  });
});
