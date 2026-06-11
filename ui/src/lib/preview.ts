import { isMarkdownPath } from './markdown';

/**
 * Which text files the file view's Preview tab can render. Shared by the
 * view (tab visibility) and the repo store (initial-tab choice on
 * `selectFile`, steered by the `fileOpenTab` setting).
 */

export const isSvgPath = (path: string): boolean => path.toLowerCase().endsWith('.svg');

export const isPreviewablePath = (path: string): boolean =>
  isSvgPath(path) || isMarkdownPath(path);
