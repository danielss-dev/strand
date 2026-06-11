import { describe, expect, it } from 'vitest';

import { ignorePatterns } from './ignore';

describe('ignorePatterns', () => {
  it('root-anchors the exact pattern and derives the extension glob', () => {
    expect(ignorePatterns('src/notes.txt')).toEqual({
      exact: '/src/notes.txt',
      extension: '*.txt',
    });
  });

  it('uses the last dot of a multi-dot name', () => {
    expect(ignorePatterns('dist/archive.tar.gz').extension).toBe('*.gz');
  });

  it('offers no extension glob for dotfiles, trailing dots, or bare names', () => {
    expect(ignorePatterns('.env').extension).toBeNull();
    expect(ignorePatterns('config/.env').extension).toBeNull();
    expect(ignorePatterns('weird.').extension).toBeNull();
    expect(ignorePatterns('Makefile').extension).toBeNull();
  });

  it('only looks at the last path segment for the dot', () => {
    const r = ignorePatterns('a.b/file');
    expect(r.exact).toBe('/a.b/file');
    expect(r.extension).toBeNull();
  });

  it('escapes bracket metacharacters so Next.js-style paths match literally', () => {
    expect(ignorePatterns('app/[id]/route.ts')).toEqual({
      exact: '/app/\\[id\\]/route.ts',
      extension: '*.ts',
    });
  });

  it('escapes asterisks and question marks in names', () => {
    expect(ignorePatterns('notes/*scratch*.md').exact).toBe('/notes/\\*scratch\\*.md');
    expect(ignorePatterns('what?.txt').exact).toBe('/what\\?.txt');
  });

  it('escapes backslashes without double-escaping the inserted ones', () => {
    expect(ignorePatterns('a\\b/[x].txt').exact).toBe('/a\\\\b/\\[x\\].txt');
  });

  it('escapes metacharacters in the extension glob too', () => {
    expect(ignorePatterns('file.t[x]t').extension).toBe('*.t\\[x\\]t');
  });

  it('leaves metachar-free extensions unchanged', () => {
    expect(ignorePatterns('app/[id]/page.tsx').extension).toBe('*.tsx');
  });
});
