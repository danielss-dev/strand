import { describe, expect, it, vi } from 'vitest';

import {
  consumeTerminalClipboardKey,
  terminalClipboardAction,
  type TerminalClipboardKeyEvent,
  type TerminalClipboardTerminal,
} from './terminalClipboard';

function event(
  partial: Partial<TerminalClipboardKeyEvent> & Pick<TerminalClipboardKeyEvent, 'key'>,
): TerminalClipboardKeyEvent {
  return {
    type: 'keydown',
    code: partial.key.length === 1 ? `Key${partial.key.toUpperCase()}` : undefined,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...partial,
  };
}

function terminal(partial: Partial<TerminalClipboardTerminal> = {}): TerminalClipboardTerminal {
  return {
    hasSelection: () => false,
    getSelection: () => '',
    paste: vi.fn(),
    ...partial,
  };
}

describe('terminalClipboardAction', () => {
  it('copies Ctrl+C on Windows when xterm has a selection', () => {
    expect(terminalClipboardAction(event({ key: 'c' }), true, 'windows')).toBe('copy');
  });

  it('forwards Ctrl+C on Windows when there is no selection', () => {
    expect(terminalClipboardAction(event({ key: 'c' }), false, 'windows')).toBe('forward');
  });

  it('pastes Ctrl+V on Windows and Linux', () => {
    expect(terminalClipboardAction(event({ key: 'v' }), false, 'windows')).toBe('paste');
    expect(terminalClipboardAction(event({ key: 'v' }), true, 'linux')).toBe('paste');
  });

  it('leaves Ctrl+Shift+C/V to xterm', () => {
    expect(terminalClipboardAction(event({ key: 'c', shiftKey: true }), true, 'windows')).toBe('forward');
    expect(terminalClipboardAction(event({ key: 'v', shiftKey: true }), false, 'windows')).toBe('forward');
  });

  it('does not claim macOS Ctrl or Command chords', () => {
    expect(terminalClipboardAction(event({ key: 'c' }), true, 'macos')).toBe('forward');
    expect(terminalClipboardAction(event({ key: 'v' }), false, 'macos')).toBe('forward');
    expect(terminalClipboardAction(event({ key: 'c', ctrlKey: false, metaKey: true }), true, 'macos')).toBe('forward');
    expect(terminalClipboardAction(event({ key: 'v', ctrlKey: false, metaKey: true }), false, 'macos')).toBe('forward');
  });

  it('ignores keyup and Alt chords', () => {
    expect(terminalClipboardAction(event({ type: 'keyup', key: 'c' }), true, 'windows')).toBe('forward');
    expect(terminalClipboardAction(event({ key: 'c', altKey: true }), true, 'linux')).toBe('forward');
  });

  it('matches physical KeyC/KeyV when the layout reports a non-Latin key', () => {
    expect(terminalClipboardAction(event({ key: 'с', code: 'KeyC' }), true, 'windows')).toBe('copy');
    expect(terminalClipboardAction(event({ key: 'м', code: 'KeyV' }), false, 'windows')).toBe('paste');
  });
});

describe('consumeTerminalClipboardKey', () => {
  it('copies the selection and stops xterm from sending SIGINT', () => {
    const copy = vi.fn();
    const host = terminal({ hasSelection: () => true, getSelection: () => 'ls -la' });
    const key = event({ key: 'c' });
    expect(consumeTerminalClipboardKey(key, host, 'windows', { copy, read: async () => '' })).toBe(false);
    expect(key.preventDefault).toHaveBeenCalled();
    expect(copy).toHaveBeenCalledWith('ls -la');
  });

  it('forwards a bare Ctrl+C so the PTY still receives interrupt', () => {
    const copy = vi.fn();
    const key = event({ key: 'c' });
    expect(consumeTerminalClipboardKey(key, terminal(), 'windows', { copy, read: async () => '' })).toBe(true);
    expect(key.preventDefault).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it('pastes clipboard text through xterm and does not forward Ctrl+V', async () => {
    const host = terminal();
    const key = event({ key: 'v' });
    expect(consumeTerminalClipboardKey(key, host, 'linux', { copy: vi.fn(), read: async () => 'echo hi' })).toBe(false);
    expect(key.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(host.paste).toHaveBeenCalledWith('echo hi'));
  });

  it('does not paste an empty clipboard', async () => {
    const host = terminal();
    consumeTerminalClipboardKey(event({ key: 'v' }), host, 'windows', { copy: vi.fn(), read: async () => '' });
    await Promise.resolve();
    expect(host.paste).not.toHaveBeenCalled();
  });
});
