import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

type ClipboardCapture = (text: string) => void | Promise<void>;

declare global {
  interface Window {
    /** Native-review / test harness only: short-circuit clipboard writes. */
    __strandCaptureClipboardWrite?: ClipboardCapture;
  }
}

/** True inside the Tauri webview. Duplicates `isTauri` so this helper does not
 * load the IPC command map on every tree/diff import. */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean(
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

/** Write `text` to the system clipboard. Rejects when the OS or webview
 * denies access — callers that must not surface a rejection should use
 * {@link copyToClipboard}. */
export async function writeClipboardText(text: string): Promise<void> {
  const capture = typeof window !== 'undefined'
    ? window.__strandCaptureClipboardWrite
    : undefined;
  if (capture) {
    await capture(text);
    return;
  }
  if (isDesktopShell()) {
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

/** Write `text` to the clipboard, swallowing the rejection clipboard APIs throw
 * when access is denied (so a copy never surfaces an unhandled rejection). */
export function copyToClipboard(text: string): void {
  void writeClipboardText(text).catch((e) => console.warn('clipboard write failed', e));
}

export async function readClipboardText(): Promise<string> {
  try {
    if (isDesktopShell()) return await readText();
    if (!navigator.clipboard?.readText) return '';
    return await navigator.clipboard.readText();
  } catch (error) {
    console.warn('clipboard read failed', error);
    return '';
  }
}
