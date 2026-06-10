import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { useSettings } from '../stores/settings';
import { isTauri } from './tauri';

/**
 * Show the native directory picker for "open repository". Returns the
 * chosen absolute path, or `null` if the user cancelled or we're not in
 * Tauri. Starts in the configured default folder (Settings → Git), if any.
 */
export async function pickRepoDirectory(): Promise<string | null> {
  return pickDirectory('Open repository', useSettings.getState().defaultCloneDir ?? undefined);
}

/**
 * Show the native directory picker with a custom title, optionally starting
 * at `defaultPath`. Returns the chosen absolute path, or `null` if the user
 * cancelled or we're not in Tauri. Used for "open repository" and for
 * choosing a clone destination folder.
 */
export async function pickDirectory(
  title = 'Choose folder',
  defaultPath?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await openDialog({ directory: true, multiple: false, title, defaultPath });
  return typeof selected === 'string' ? selected : null;
}
