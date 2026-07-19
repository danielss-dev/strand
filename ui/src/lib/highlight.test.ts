import { describe, expect, it } from 'vitest';

import { projectTokenColors, type HlToken } from './highlight';

const tokens: HlToken[][] = [
  [
    { content: 'const', color: '#keyword' },
    { content: ' value', color: '#name' },
  ],
  [
    { content: 'return', color: '#keyword' },
    { content: ' value', color: '#name' },
  ],
];

function text(segments: HlToken[]): string {
  return segments.map((segment) => segment.content).join('');
}

function colorOf(segments: HlToken[], needle: string): string | undefined {
  return segments.find((segment) => segment.content.includes(needle))?.color;
}

describe('projectTokenColors', () => {
  it('keeps syntax colors across an inserted line while using the current text', () => {
    const projected = projectTokenColors(
      'const value\nreturn value',
      'const value\n\nreturn value',
      tokens,
    );

    expect(text(projected)).toBe('const value\n\nreturn value');
    expect(colorOf(projected, 'const')).toBe('#keyword');
    expect(colorOf(projected, 'return')).toBe('#keyword');
  });

  it('borrows the replaced token color until retokenization finishes', () => {
    const projected = projectTokenColors(
      'const value\nreturn value',
      'let value\nreturn value',
      tokens,
    );

    expect(text(projected)).toBe('let value\nreturn value');
    expect(colorOf(projected, 'let')).toBe('#keyword');
    expect(colorOf(projected, 'return')).toBe('#keyword');
  });

  it('reconstructs CRLF buffers without discarding their token colors', () => {
    const projected = projectTokenColors(
      'const value\r\nreturn value',
      'const value\r\n\r\nreturn value',
      tokens,
    );

    expect(text(projected)).toBe('const value\r\n\r\nreturn value');
    expect(colorOf(projected, 'const')).toBe('#keyword');
    expect(colorOf(projected, 'return')).toBe('#keyword');
  });
});
