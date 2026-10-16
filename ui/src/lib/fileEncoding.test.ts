import { describe, expect, it } from 'vitest';

import {
  FILE_ENCODING_SAMPLE_BYTES,
  detectFileEncoding,
  detectFromFileContent,
  formatFileEncodingLabel,
} from './fileEncoding';
import { t } from './i18n';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('detectFileEncoding', () => {
  it('detects LF', () => {
    expect(detectFileEncoding('one\ntwo\n')).toEqual({ encoding: 'utf-8', lineEndings: 'LF' });
  });

  it('detects CRLF', () => {
    expect(detectFileEncoding('one\r\ntwo\r\n')).toEqual({ encoding: 'utf-8', lineEndings: 'CRLF' });
  });

  it('detects CR-only', () => {
    expect(detectFileEncoding('one\rtwo\r')).toEqual({ encoding: 'utf-8', lineEndings: 'CR' });
  });

  it('detects mixed endings', () => {
    expect(detectFileEncoding('one\r\ntwo\nthree\r')).toEqual({ encoding: 'utf-8', lineEndings: 'Mixed' });
  });

  it('does not invent LF when there is no newline', () => {
    expect(detectFileEncoding('hello')).toEqual({ encoding: 'utf-8', lineEndings: null });
  });

  it('treats empty input as UTF-8 with no line ending', () => {
    expect(detectFileEncoding('')).toEqual({ encoding: 'utf-8', lineEndings: null });
    expect(detectFileEncoding(bytes())).toEqual({ encoding: 'utf-8', lineEndings: null });
  });

  it('detects a UTF-8 BOM', () => {
    expect(detectFileEncoding('\uFEFFhello\n')).toEqual({ encoding: 'utf-8-bom', lineEndings: 'LF' });
    expect(detectFileEncoding(bytes(0xef, 0xbb, 0xbf, 0x68, 0x0a))).toEqual({
      encoding: 'utf-8-bom',
      lineEndings: 'LF',
    });
  });

  it('detects UTF-16 LE by BOM, including CRLF units', () => {
    expect(detectFileEncoding(bytes(
      0xff, 0xfe,
      0x61, 0x00,
      0x0d, 0x00, 0x0a, 0x00,
      0x62, 0x00,
    ))).toEqual({ encoding: 'utf-16le', lineEndings: 'CRLF' });
  });

  it('detects UTF-16 BE by BOM', () => {
    expect(detectFileEncoding(bytes(
      0xfe, 0xff,
      0x00, 0x61,
      0x00, 0x0a,
      0x00, 0x62,
    ))).toEqual({ encoding: 'utf-16be', lineEndings: 'LF' });
  });

  it('hides binary samples with NUL bytes', () => {
    expect(detectFileEncoding(bytes(0x00, 0x01, 0x02))).toBeNull();
    expect(detectFileEncoding('hello\0world')).toBeNull();
  });

  it('does not treat UTF-16 BOM files as binary despite NULs', () => {
    expect(detectFileEncoding(bytes(0xff, 0xfe, 0x61, 0x00, 0x62, 0x00)))
      .toEqual({ encoding: 'utf-16le', lineEndings: null });
  });

  it('falls back for invalid UTF-8 without claiming UTF-8', () => {
    expect(detectFileEncoding(bytes(0xff, 0x61, 0x0a))).toEqual({
      encoding: 'unknown',
      lineEndings: 'LF',
    });
  });

  it('does not treat a sample-boundary UTF-8 split as unknown', () => {
    const emoji = Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]);
    const prefix = new Uint8Array(FILE_ENCODING_SAMPLE_BYTES - 1).fill(0x61);
    const sliced = new Uint8Array(prefix.length + emoji.length);
    sliced.set(prefix);
    sliced.set(emoji, prefix.length);
    expect(detectFileEncoding(sliced)).toEqual({ encoding: 'utf-8', lineEndings: null });
  });
});

describe('detectFromFileContent', () => {
  it('hides binary payloads', () => {
    expect(detectFromFileContent({ text: '', binary: true, editable: false, truncated: false }))
      .toBeNull();
  });

  it('keeps CRLF from engine text', () => {
    expect(detectFromFileContent({
      text: 'one\r\ntwo\r\n',
      binary: false,
      editable: true,
      truncated: false,
    })).toEqual({ encoding: 'utf-8', lineEndings: 'CRLF' });
  });

  it('does not claim UTF-8 for non-editable, non-truncated, non-binary text', () => {
    expect(detectFromFileContent({
      text: 'one\n',
      binary: false,
      editable: false,
      truncated: false,
    })).toEqual({ encoding: 'unknown', lineEndings: 'LF' });
  });

  it('still reports UTF-8 for a truncated valid prefix', () => {
    expect(detectFromFileContent({
      text: 'one\n',
      binary: false,
      editable: false,
      truncated: true,
    })).toEqual({ encoding: 'utf-8', lineEndings: 'LF' });
  });
});

describe('formatFileEncodingLabel', () => {
  it('omits a line-ending claim when none were found', () => {
    expect(formatFileEncodingLabel({ encoding: 'utf-8', lineEndings: null }))
      .toBe(t('status.encoding.utf8'));
  });

  it('joins encoding and CRLF', () => {
    expect(formatFileEncodingLabel({ encoding: 'utf-8', lineEndings: 'CRLF' }))
      .toBe(t('status.fileEncoding', {
        encoding: t('status.encoding.utf8'),
        lineEnding: t('status.lineEnding.crlf'),
      }));
  });

  it('returns null when detection failed', () => {
    expect(formatFileEncodingLabel(null)).toBeNull();
  });
});
