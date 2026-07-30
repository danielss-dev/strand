import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkDirect: vi.fn(),
  openMicrosoftStore: vi.fn(),
  relaunch: vi.fn(),
  storeUpdateAvailable: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mocks.checkDirect,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: mocks.relaunch,
}));

vi.mock('../lib/tauri', () => ({
  errMessage: (error: unknown) => (
    error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error)
  ),
  tauri: {
    microsoftStoreOpenProduct: mocks.openMicrosoftStore,
    microsoftStoreUpdateAvailable: mocks.storeUpdateAvailable,
  },
}));

describe('Microsoft Store updates', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_DISTRIBUTION', 'msix');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('surfaces an available update and opens its Store product page', async () => {
    mocks.storeUpdateAvailable.mockResolvedValue(true);
    mocks.openMicrosoftStore.mockResolvedValue(undefined);

    const { useUpdates } = await import('./updates');
    await useUpdates.getState().check();

    expect(useUpdates.getState().status).toBe('available');
    await useUpdates.getState().openMicrosoftStore();
    expect(mocks.openMicrosoftStore).toHaveBeenCalledOnce();
    expect(mocks.checkDirect).not.toHaveBeenCalled();
  });

  it('reports when Microsoft Store has no update', async () => {
    mocks.storeUpdateAvailable.mockResolvedValue(false);

    const { useUpdates } = await import('./updates');
    await useUpdates.getState().check();

    expect(useUpdates.getState().status).toBe('upToDate');
  });

  it('keeps native Store diagnostics readable', async () => {
    mocks.storeUpdateAvailable.mockRejectedValue({
      message: 'Microsoft Store is unavailable',
    });

    const { useUpdates } = await import('./updates');
    await useUpdates.getState().check();

    expect(useUpdates.getState()).toMatchObject({
      status: 'error',
      error: 'Microsoft Store is unavailable',
    });
  });
});
