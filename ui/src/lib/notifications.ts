import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted } from '@tauri-apps/plugin-notification';

import { osType } from './integrations';

/**
 * Tauri notification 2.3.3's injected Windows shim initializes its Web
 * Notification permission to `denied` without consulting the desktop plugin.
 * Ask the native backend directly on Windows; other platforms retain the
 * plugin's normal permission flow.
 */
export async function isDesktopNotificationPermissionGranted(): Promise<boolean> {
  if (osType() === 'windows') {
    return (await invoke<boolean | null>('plugin:notification|is_permission_granted')) === true;
  }
  return isPermissionGranted();
}
