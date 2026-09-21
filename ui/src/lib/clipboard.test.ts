import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: mocks.writeText,
  readText: mocks.readText,
}));

import { copyToClipboard, readClipboardText, writeClipboardText } from './clipboard';

const webWrite = vi.fn();
const webRead = vi.fn();

function host(): typeof globalThis & { __TAURI_INTERNALS__?: unknown; window?: { __TAURI_INTERNALS__?: unknown } } {
  return globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown; window?: { __TAURI_INTERNALS__?: unknown } };
}

function stubShell(desktop: boolean, clipboard: { writeText: typeof webWrite; readText: typeof webRead } | undefined = {
  writeText: webWrite,
  readText: webRead,
}) {
  const g = host();
  if (desktop) {
    g.__TAURI_INTERNALS__ = {};
    if (g.window) g.window.__TAURI_INTERNALS__ = {};
  } else {
    delete g.__TAURI_INTERNALS__;
    if (g.window) delete g.window.__TAURI_INTERNALS__;
  }
  vi.stubGlobal('window', desktop ? { __TAURI_INTERNALS__: {} } : {});
  vi.stubGlobal('navigator', clipboard ? { clipboard } : {});
}

describe('clipboard helpers', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    mocks.writeText.mockReset();
    mocks.readText.mockReset();
    webWrite.mockReset();
    webRead.mockReset();
    warn.mockClear();
    stubShell(false);
  });

  afterEach(() => {
    delete window.__strandCaptureClipboardWrite;
    stubShell(false);
    vi.unstubAllGlobals();
  });

  it('copyToClipboard writes through the native plugin in the desktop shell', async () => {
    stubShell(true);
    mocks.writeText.mockResolvedValue(undefined);

    copyToClipboard('sha');
    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('sha'));
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('short-circuits writes through the native-review capture seam', async () => {
    stubShell(true);
    const capture = vi.fn().mockResolvedValue(undefined);
    window.__strandCaptureClipboardWrite = capture;

    await writeClipboardText('feedback markdown');
    copyToClipboard('copied notes');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith('copied notes'));

    expect(capture).toHaveBeenCalledWith('feedback markdown');
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('writes through the native plugin in the desktop shell', async () => {
    stubShell(true);
    mocks.writeText.mockResolvedValue(undefined);

    await writeClipboardText('sha');

    expect(mocks.writeText).toHaveBeenCalledWith('sha');
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('reads through the native plugin in the desktop shell', async () => {
    stubShell(true);
    mocks.readText.mockResolvedValue('pasted');

    await expect(readClipboardText()).resolves.toBe('pasted');
    expect(mocks.readText).toHaveBeenCalled();
    expect(webRead).not.toHaveBeenCalled();
  });

  it('falls back to navigator.clipboard outside Tauri', async () => {
    webWrite.mockResolvedValue(undefined);
    webRead.mockResolvedValue('demo');

    await writeClipboardText('branch');
    await expect(readClipboardText()).resolves.toBe('demo');

    expect(webWrite).toHaveBeenCalledWith('branch');
    expect(webRead).toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.readText).not.toHaveBeenCalled();
  });

  it('copyToClipboard swallows write denials', async () => {
    webWrite.mockRejectedValue(new Error('denied'));

    copyToClipboard('secret');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });

  it('readClipboardText returns empty on denial instead of throwing', async () => {
    webRead.mockRejectedValue(new Error('denied'));

    await expect(readClipboardText()).resolves.toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('readClipboardText swallows desktop read denials', async () => {
    stubShell(true);
    mocks.readText.mockRejectedValue(new Error('denied'));

    await expect(readClipboardText()).resolves.toBe('');
    expect(warn).toHaveBeenCalled();
    expect(webRead).not.toHaveBeenCalled();
  });

  it('readClipboardText returns empty when the web clipboard API is missing', async () => {
    stubShell(false, undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: {} });

    await expect(readClipboardText()).resolves.toBe('');
    expect(warn).not.toHaveBeenCalled();
    expect(mocks.readText).not.toHaveBeenCalled();
  });

  it('propagates desktop write denials from writeClipboardText', async () => {
    stubShell(true);
    mocks.writeText.mockRejectedValue(new Error('denied'));

    await expect(writeClipboardText('x')).rejects.toThrow('denied');
  });
});
