import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', {});

const { startCloneDialogFocusLifecycle } = await import('./CloneDialog');

describe('CloneDialog focus lifecycle', () => {
  it('reclaims focus after a closing palette restores a control behind the modal', () => {
    const paletteInput = { focus: vi.fn() };
    const underlyingNote = { focus: vi.fn() };
    const urlInput = { focus: vi.fn() };
    let active = urlInput;
    let deferred = () => {};
    const cancelFrame = vi.fn();

    const cleanup = startCloneDialogFocusLifecycle(
      paletteInput,
      () => active,
      () => urlInput,
      (callback) => {
        deferred = callback;
        return 7;
      },
      cancelFrame,
    );

    // Palette unmount restores its opener after React's autoFocus ran.
    active = underlyingNote;
    deferred();

    expect(urlInput.focus).toHaveBeenCalledOnce();

    cleanup();
    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(underlyingNote.focus).toHaveBeenCalledOnce();
    expect(paletteInput.focus).not.toHaveBeenCalled();
  });

  it('preserves the direct opener when autofocus already owns focus', () => {
    const directOpener = { focus: vi.fn() };
    const urlInput = { focus: vi.fn() };
    let deferred = () => {};

    const cleanup = startCloneDialogFocusLifecycle(
      directOpener,
      () => urlInput,
      () => urlInput,
      (callback) => {
        deferred = callback;
        return 1;
      },
      vi.fn(),
    );

    deferred();
    cleanup();

    expect(directOpener.focus).toHaveBeenCalledOnce();
  });
});
