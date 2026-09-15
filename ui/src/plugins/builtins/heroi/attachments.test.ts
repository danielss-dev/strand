import { describe, expect, it } from 'vitest';

import {
  composerImageReject,
  dataUrlPayload,
  droppedImageFiles,
  normalizeImageMime,
  toImagePayload,
} from './attachments';

describe('Heroi composer images', () => {
  it('accepts common vision image types and rejects everything else', () => {
    expect(normalizeImageMime({ name: 'shot.png', type: 'image/png' })).toBe('image/png');
    expect(normalizeImageMime({ name: 'shot.JPG', type: '' })).toBe('image/jpeg');
    expect(normalizeImageMime({ name: 'notes.txt', type: 'text/plain' })).toBeNull();
    expect(composerImageReject({ name: 'shot.png', type: 'image/png', size: 12 }, 0)).toBeNull();
    expect(composerImageReject({ name: 'shot.png', type: 'image/png', size: 12 }, 4)).toBe('limit');
    expect(composerImageReject({ name: 'notes.txt', type: 'text/plain', size: 12 }, 0)).toBe('type');
    expect(composerImageReject({ name: 'shot.png', type: 'image/png', size: 5 * 1024 * 1024 }, 0)).toBe('size');
  });

  it('turns a data URL into the IPC payload without executing HTML', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    expect(dataUrlPayload(dataUrl)).toEqual({
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    });
    expect(dataUrlPayload('javascript:alert(1)')).toBeNull();
    expect(toImagePayload({
      id: 'img-1',
      name: 'shot.png',
      mimeType: 'image/png',
      dataUrl,
    })).toEqual({
      name: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    });
  });

  it('keeps OS image drops separate from repository file mentions', () => {
    const png = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const txt = new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' });
    const transfer = {
      files: {
        0: png,
        1: txt,
        length: 2,
        item: (index: number) => (index === 0 ? png : txt),
        [Symbol.iterator]: function* () { yield png; yield txt; },
      },
    } as unknown as DataTransfer;
    expect(droppedImageFiles(transfer).map((file) => file.name)).toEqual(['shot.png']);
  });
});
