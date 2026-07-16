import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
  osType: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mocks.isPermissionGranted,
}));
vi.mock('./integrations', () => ({ osType: mocks.osType }));

import { isDesktopNotificationPermissionGranted } from './notifications';

describe('isDesktopNotificationPermissionGranted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses the broken Web Notification permission shim on Windows', async () => {
    mocks.osType.mockReturnValue('windows');
    mocks.invoke.mockResolvedValue(true);

    await expect(isDesktopNotificationPermissionGranted()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('plugin:notification|is_permission_granted');
    expect(mocks.isPermissionGranted).not.toHaveBeenCalled();
  });

  it('uses the plugin permission flow on other platforms', async () => {
    mocks.osType.mockReturnValue('macos');
    mocks.isPermissionGranted.mockResolvedValue(false);

    await expect(isDesktopNotificationPermissionGranted()).resolves.toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
