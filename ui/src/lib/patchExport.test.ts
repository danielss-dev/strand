import { describe, expect, it } from 'vitest';

import { concatPatches, patchesToMarkdown } from './patchExport';

const d = (path: string, patch: string, binary = false) => ({ path, patch, binary });

describe('concatPatches', () => {
  it('joins patches, normalizing each to exactly one trailing newline', () => {
    const out = concatPatches([
      d('a.ts', 'diff --git a/a.ts b/a.ts\n+one'), // no trailing newline
      d('b.ts', 'diff --git a/b.ts b/b.ts\n+two\n\n\n'), // several
    ]);
    expect(out).toBe('diff --git a/a.ts b/a.ts\n+one\ndiff --git a/b.ts b/b.ts\n+two\n');
  });

  it('keeps a binary stub patch but skips empty patches', () => {
    const out = concatPatches([
      d('img.png', 'Binary files a/img.png and b/img.png differ\n', true),
      d('blob.bin', '', true),
      d('empty.ts', ''),
    ]);
    expect(out).toBe('Binary files a/img.png and b/img.png differ\n');
  });

  it('returns the empty string for nothing to copy', () => {
    expect(concatPatches([])).toBe('');
    expect(concatPatches([d('a.bin', '', true)])).toBe('');
  });
});

describe('patchesToMarkdown', () => {
  it('renders a heading and a diff fence per file', () => {
    const out = patchesToMarkdown([d('src/a.ts', '@@ -1 +1 @@\n-x\n+y\n')]);
    expect(out).toBe('### src/a.ts\n\n```diff\n@@ -1 +1 @@\n-x\n+y\n```\n');
  });

  it('prepends an optional title header', () => {
    const out = patchesToMarkdown([d('a.ts', '+x\n')], { title: 'Review' });
    expect(out.startsWith('# Review\n\n### a.ts\n')).toBe(true);
  });

  it('lengthens the fence past backtick runs inside the patch', () => {
    const out = patchesToMarkdown([d('doc.md', '+```js\n+code\n+```\n')]);
    expect(out).toContain('````diff\n+```js\n+code\n+```\n````\n');
  });

  it('emits a binary note instead of a fence for binary or patch-less files', () => {
    expect(patchesToMarkdown([d('img.png', '', true)])).toBe(
      '### img.png\n\n_binary file changed_\n',
    );
    expect(patchesToMarkdown([d('mode-only', '')])).toContain('_binary file changed_');
  });

  it('returns the empty string for an empty input', () => {
    expect(patchesToMarkdown([])).toBe('');
  });
});
