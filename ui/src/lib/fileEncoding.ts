import { t, type MessageKey } from './i18n';
import type { FileContent } from './types';

/** Bytes examined for BOM, NULs, and line endings. The content command already
 * caps reads at 2 MB; this keeps the status-bar scan bounded on that prefix. */
export const FILE_ENCODING_SAMPLE_BYTES = 64 * 1024;

export type LineEndingKind = 'LF' | 'CRLF' | 'CR' | 'Mixed';
export type FileEncodingKind = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'unknown';

export interface FileEncodingInfo {
  encoding: FileEncodingKind;
  /** Absent when the sample contains no newline. Never implied as LF. */
  lineEndings: LineEndingKind | null;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, i) => bytes[i] === byte);
}

function lineEndingsFromCounts(lf: number, crlf: number, cr: number): LineEndingKind | null {
  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0);
  if (kinds === 0) return null;
  if (kinds > 1) return 'Mixed';
  if (crlf > 0) return 'CRLF';
  if (cr > 0) return 'CR';
  return 'LF';
}

function scanUtf8LineEndings(bytes: Uint8Array, start: number): LineEndingKind | null {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = start; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x0d && bytes[i + 1] === 0x0a) {
      crlf += 1;
      i += 1;
    } else if (byte === 0x0d) {
      cr += 1;
    } else if (byte === 0x0a) {
      lf += 1;
    }
  }
  return lineEndingsFromCounts(lf, crlf, cr);
}

function scanUtf16LineEndings(bytes: Uint8Array, littleEndian: boolean): LineEndingKind | null {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = 2; i + 1 < bytes.length; i += 2) {
    const unit = littleEndian
      ? bytes[i] | (bytes[i + 1] << 8)
      : (bytes[i] << 8) | bytes[i + 1];
    if (unit === 0x000d) {
      const next = i + 3 < bytes.length
        ? (littleEndian
          ? bytes[i + 2] | (bytes[i + 3] << 8)
          : (bytes[i + 2] << 8) | bytes[i + 3])
        : -1;
      if (next === 0x000a) {
        crlf += 1;
        i += 2;
      } else {
        cr += 1;
      }
    } else if (unit === 0x000a) {
      lf += 1;
    }
  }
  return lineEndingsFromCounts(lf, crlf, cr);
}

function hasNul(bytes: Uint8Array, start: number): boolean {
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function isValidUtf8(bytes: Uint8Array, start: number): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
    return true;
  } catch {
    return false;
  }
}

/** Drop a trailing incomplete UTF-8 sequence created by the sample cap. */
function dropIncompleteUtf8Tail(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return bytes;
  let i = bytes.length - 1;
  let continuations = 0;
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80) {
    continuations += 1;
    i -= 1;
  }
  if (i < 0) return bytes;
  const lead = bytes[i];
  const needed = (lead & 0x80) === 0 ? 0
    : (lead & 0xe0) === 0xc0 ? 1
    : (lead & 0xf0) === 0xe0 ? 2
    : (lead & 0xf8) === 0xf0 ? 3
    : -1;
  if (needed >= 0 && continuations < needed) return bytes.subarray(0, i);
  return bytes;
}

function sampleBytes(source: Uint8Array): Uint8Array {
  if (source.length <= FILE_ENCODING_SAMPLE_BYTES) return source;
  return dropIncompleteUtf8Tail(source.subarray(0, FILE_ENCODING_SAMPLE_BYTES));
}

function detectFromDecodedText(text: string): FileEncodingInfo | null {
  const sample = text.length > FILE_ENCODING_SAMPLE_BYTES
    ? text.slice(0, FILE_ENCODING_SAMPLE_BYTES)
    : text;
  if (sample.includes('\0')) return null;
  const bom = sample.charCodeAt(0) === 0xfeff;
  const start = bom ? 1 : 0;
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let i = start; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 13 && sample.charCodeAt(i + 1) === 10) {
      crlf += 1;
      i += 1;
    } else if (code === 13) {
      cr += 1;
    } else if (code === 10) {
      lf += 1;
    }
  }
  return {
    encoding: bom ? 'utf-8-bom' : 'utf-8',
    lineEndings: lineEndingsFromCounts(lf, crlf, cr),
  };
}

function detectFromBytes(bytes: Uint8Array): FileEncodingInfo | null {
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { encoding: 'utf-16le', lineEndings: scanUtf16LineEndings(bytes, true) };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { encoding: 'utf-16be', lineEndings: scanUtf16LineEndings(bytes, false) };
  }
  const utf8Bom = startsWith(bytes, UTF8_BOM);
  const bodyStart = utf8Bom ? 3 : 0;
  if (hasNul(bytes, bodyStart)) return null;
  const encoding: FileEncodingKind = utf8Bom
    ? 'utf-8-bom'
    : isValidUtf8(bytes, bodyStart)
      ? 'utf-8'
      : 'unknown';
  return { encoding, lineEndings: scanUtf8LineEndings(bytes, bodyStart) };
}

/** Detect encoding (BOM) and line endings from a bounded prefix of raw bytes
 * or already-decoded text. Returns null for binary (NUL) samples. */
export function detectFileEncoding(source: Uint8Array | string): FileEncodingInfo | null {
  if (typeof source === 'string') return detectFromDecodedText(source);
  return detectFromBytes(sampleBytes(source));
}

/** Map a `repo_file_content` payload onto a status-bar label. The engine
 * preserves CRLF in `text` and blanks `text` when `binary` is set. */
export function detectFromFileContent(
  content: Pick<FileContent, 'text' | 'binary' | 'editable' | 'truncated'>,
): FileEncodingInfo | null {
  if (content.binary) return null;
  const detected = detectFileEncoding(content.text);
  if (!detected) return null;
  if (!content.editable && !content.truncated && detected.encoding === 'utf-8') {
    return { encoding: 'unknown', lineEndings: detected.lineEndings };
  }
  return detected;
}

function encodingKey(kind: FileEncodingKind): MessageKey {
  switch (kind) {
    case 'utf-8': return 'status.encoding.utf8';
    case 'utf-8-bom': return 'status.encoding.utf8Bom';
    case 'utf-16le': return 'status.encoding.utf16le';
    case 'utf-16be': return 'status.encoding.utf16be';
    case 'unknown': return 'status.encoding.unknown';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function lineEndingKey(kind: LineEndingKind): MessageKey {
  switch (kind) {
    case 'LF': return 'status.lineEnding.lf';
    case 'CRLF': return 'status.lineEnding.crlf';
    case 'CR': return 'status.lineEnding.cr';
    case 'Mixed': return 'status.lineEnding.mixed';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Status-bar chip text, or null when there is nothing honest to show. */
export function formatFileEncodingLabel(info: FileEncodingInfo | null): string | null {
  if (!info) return null;
  const encoding = t(encodingKey(info.encoding));
  if (!info.lineEndings) return encoding;
  return t('status.fileEncoding', {
    encoding,
    lineEnding: t(lineEndingKey(info.lineEndings)),
  });
}
