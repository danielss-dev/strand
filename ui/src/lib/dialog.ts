import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

import { useSettings } from '../stores/settings';
import { isTauri } from './tauri';

/**
 * Show the native directory picker for "open repository", allowing several
 * folders to be selected at once (each opens as its own tab). Returns the
 * chosen absolute paths, or `[]` if the user cancelled or we're not in Tauri.
 * Starts in the configured default folder (Settings → Git), if any.
 */
export async function pickRepoDirectories(): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await openDialog({
    directory: true,
    multiple: true,
    title: 'Open repositories',
    defaultPath: useSettings.getState().defaultCloneDir ?? undefined,
  });
  if (Array.isArray(selected)) return selected;
  return typeof selected === 'string' ? [selected] : [];
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

/**
 * Show the native file picker filtered to VS Code `.code-workspace` files
 * (the workspace importer). Returns the chosen path, or `null` if the user
 * cancelled or we're not in Tauri.
 */
export async function pickCodeWorkspaceFile(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await openDialog({
    multiple: false,
    title: 'Import .code-workspace',
    filters: [{ name: 'VS Code workspace', extensions: ['code-workspace'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

/** Choose a PEM certificate for an Azure DevOps Server PAT profile. */
export async function pickPemCertificate(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await openDialog({
    multiple: false,
    title: 'Import CA certificate',
    filters: [{ name: 'PEM certificate', extensions: ['pem', 'crt', 'cer'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

/** Choose a destination for an mbox-compatible commit patch export. */
export async function pickCommitPatchDestination(
  repoPath: string,
  fileName: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const separator = repoPath.includes('\\') ? '\\' : '/';
  const selected = await saveDialog({
    title: 'Export commit patch',
    defaultPath: `${repoPath.replace(/[\\/]+$/, '')}${separator}${fileName}`,
    filters: [{ name: 'Git patch', extensions: ['patch', 'mbox'] }],
  });
  return typeof selected === 'string' ? selected : null;
}
