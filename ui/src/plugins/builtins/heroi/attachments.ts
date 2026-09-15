export const HEROI_MAX_IMAGES = 4;
export const HEROI_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface HeroiImageDraft {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface HeroiImagePayload {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export type ComposerImageReject = 'type' | 'size' | 'limit';

const IMAGE_MIMES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

const EXTENSION_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function normalizeImageMime(file: { name: string; type: string }): string | null {
  const fromType = IMAGE_MIMES[file.type.trim().toLowerCase()];
  if (fromType) return fromType;
  const extension = file.name.split('.').pop()?.trim().toLowerCase() ?? '';
  return EXTENSION_MIMES[extension] ?? null;
}

export function composerImageReject(
  file: { name: string; type: string; size: number },
  currentCount: number,
): ComposerImageReject | null {
  if (currentCount >= HEROI_MAX_IMAGES) return 'limit';
  if (!normalizeImageMime(file)) return 'type';
  if (file.size <= 0 || file.size > HEROI_MAX_IMAGE_BYTES) return 'size';
  return null;
}

export function dataUrlPayload(dataUrl: string): { mimeType: string; dataBase64: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl.trim());
  if (!match) return null;
  const mimeType = IMAGE_MIMES[match[1].toLowerCase()];
  if (!mimeType) return null;
  return { mimeType, dataBase64: match[2] };
}

export function toImagePayload(image: HeroiImageDraft): HeroiImagePayload | null {
  const payload = dataUrlPayload(image.dataUrl);
  if (!payload) return null;
  return {
    name: image.name,
    mimeType: payload.mimeType,
    dataBase64: payload.dataBase64,
  };
}

export function clipboardImageFiles(clipboard: DataTransfer | null): File[] {
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length > 0) return files;
  return Array.from(clipboard.files).filter((file) => file.type.startsWith('image/'));
}

export function droppedImageFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return Array.from(transfer.files).filter((file) => normalizeImageMime(file));
}
