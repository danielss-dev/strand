import { describe, expect, it } from 'vitest';

import { formatBytes, imageMime, isImagePath } from './image';

describe('isImagePath', () => {
  it('recognizes image extensions case-insensitively, anywhere in the tree', () => {
    expect(isImagePath('icon.png')).toBe(true);
    expect(isImagePath('assets/Screenshot.PNG')).toBe(true);
    expect(isImagePath('a/b/photo.jpeg')).toBe(true);
    expect(isImagePath('logo.SVG')).toBe(true);
    expect(isImagePath('fav.ico')).toBe(true);
    expect(isImagePath('pic.avif')).toBe(true);
  });

  it('rejects non-images and extension-less paths', () => {
    expect(isImagePath('main.rs')).toBe(false);
    expect(isImagePath('archive.png.gz')).toBe(false);
    expect(isImagePath('Makefile')).toBe(false);
    expect(isImagePath('dir.png/file')).toBe(false);
  });
});

describe('imageMime', () => {
  it('maps the special cases and the common ones', () => {
    expect(imageMime('a.svg')).toBe('image/svg+xml');
    expect(imageMime('a.ico')).toBe('image/x-icon');
    expect(imageMime('a.jpg')).toBe('image/jpeg');
    expect(imageMime('a.PNG')).toBe('image/png');
    expect(imageMime('a.txt')).toBe('application/octet-stream');
  });
});

describe('formatBytes', () => {
  it('formats across unit boundaries', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(6553)).toBe('6.4 KB');
    expect(formatBytes(150 * 1024)).toBe('150 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
