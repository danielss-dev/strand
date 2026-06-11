/**
 * Image-path helpers for the binary image diff preview: which paths render
 * as images, and the MIME type a data: URL needs for each.
 */

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const extOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
};

/** True when the path's extension is a previewable image format. */
export const isImagePath = (path: string): boolean => extOf(path) in MIME_BY_EXT;

/** MIME type for a data: URL of this image path. */
export const imageMime = (path: string): string =>
  MIME_BY_EXT[extOf(path)] ?? 'application/octet-stream';

/** Compact human byte size for the preview meta line ("6.4 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
