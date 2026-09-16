import type { OsType } from './integrations';

export type TerminalClipboardAction = 'copy' | 'paste' | 'forward';

export interface TerminalClipboardKeyEvent {
  type: string;
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
}

export interface TerminalClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  paste(data: string): void;
}

export interface TerminalClipboard {
  copy(text: string): void;
  read(): Promise<string>;
}

/** VS Code / Windows Terminal: Ctrl+C copies a selection, otherwise SIGINT;
 * Ctrl+V pastes. Shift variants and macOS stay on xterm / ⌘ paths. */
export function terminalClipboardAction(
  event: Pick<TerminalClipboardKeyEvent, 'type' | 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  hasSelection: boolean,
  platform: OsType,
): TerminalClipboardAction {
  if (event.type !== 'keydown') return 'forward';
  if (platform === 'macos') return 'forward';
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return 'forward';
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const isC = key === 'c' || event.code === 'KeyC';
  const isV = key === 'v' || event.code === 'KeyV';
  if (isC) return hasSelection ? 'copy' : 'forward';
  if (isV) return 'paste';
  return 'forward';
}

/** Returns whether xterm should keep handling the key (`true` = forward to PTY). */
export function consumeTerminalClipboardKey(
  event: TerminalClipboardKeyEvent,
  terminal: TerminalClipboardTerminal,
  platform: OsType,
  clipboard: TerminalClipboard,
): boolean {
  const action = terminalClipboardAction(event, terminal.hasSelection(), platform);
  switch (action) {
    case 'copy':
      event.preventDefault();
      clipboard.copy(terminal.getSelection());
      return false;
    case 'paste':
      event.preventDefault();
      void clipboard.read().then((text) => {
        if (text) terminal.paste(text);
      });
      return false;
    case 'forward':
      return true;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export function readClipboardText(): Promise<string> {
  if (!navigator.clipboard?.readText) return Promise.resolve('');
  return navigator.clipboard.readText().catch((error) => {
    console.warn('clipboard read failed', error);
    return '';
  });
}
