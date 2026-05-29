import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { isTauri } from './tauri';

/**
 * Show the native directory picker for "open repository". Returns the
 * chosen absolute path, or `null` if the user cancelled or we're not in
 * Tauri.
 */
export async function pickRepoDirectory(): Promise<string | null> {
  return pickDirectory('Open repository');
}

/**
 * Show the native directory picker with a custom title. Returns the chosen
 * absolute path, or `null` if the user cancelled or we're not in Tauri. Used
 * for "open repository" and for choosing a clone destination folder.
 */
export async function pickDirectory(title = 'Choose folder'): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await openDialog({ directory: true, multiple: false, title });
  return typeof selected === 'string' ? selected : null;
}
