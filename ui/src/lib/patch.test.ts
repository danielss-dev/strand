import { describe, expect, it } from 'vitest';

import { hashPatch, sliceChangeBlock } from './patch';

/**
 * `sliceChangeBlock` writes patches that `git apply` consumes against the
 * user's working tree — a bug here corrupts real files, so the slicing rules
 * (promote vs omit, marker travel, header recount) are pinned down hard.
 */

// One hunk, two change blocks separated by context. Group indices:
// 0 = context(ctx1), 1 = change(-old1+new1), 2 = context(ctx2),
// 3 = change(-old2+new2).
const TWO_BLOCKS = [
  'diff --git a/f.txt b/f.txt',
  'index 0000000..1111111 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,4 @@',
  ' ctx1',
  '-old1',
  '+new1',
  ' ctx2',
  '-old2',
  '+new2',
  '',
].join('\n');

describe('sliceChangeBlock', () => {
  it('forward slice keeps the target block and demotes the other block to its pre-change side', () => {
    const out = sliceChangeBlock(TWO_BLOCKS, 0, 1, 'forward');
    const lines = out.trimEnd().split('\n');
    // Target block survives as a change.
    expect(lines).toContain('-old1');
    expect(lines).toContain('+new1');
    // Other block: its '-' line exists on both sides → context; '+' omitted.
    expect(lines).toContain(' old2');
    expect(lines).not.toContain('+new2');
    expect(lines).not.toContain('-old2');
    // Header recounted for the rewritten body (4 source / 4 target lines).
    expect(lines).toContain('@@ -1,4 +1,4 @@');
    // Original file header is preserved.
    expect(lines[0]).toBe('diff --git a/f.txt b/f.txt');
  });

  it('reverse slice mirrors the rule: the other block keeps its post-change side', () => {
    const out = sliceChangeBlock(TWO_BLOCKS, 0, 3, 'reverse');
    const lines = out.trimEnd().split('\n');
    expect(lines).toContain('-old2');
    expect(lines).toContain('+new2');
    // Other block: '+' promoted to context, '-' omitted.
    expect(lines).toContain(' new1');
    expect(lines).not.toContain('-old1');
    expect(lines).not.toContain('+new1');
    expect(lines).toContain('@@ -1,4 +1,4 @@');
  });

  it('slicing the only change block reproduces the hunk unchanged', () => {
    const single = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+B',
      '',
    ].join('\n');
    const out = sliceChangeBlock(single, 0, 1, 'forward');
    expect(out).toBe(single);
  });

  it('keeps a no-newline marker with its kept line and drops it with a dropped line', () => {
    const patch = [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      '-keep1',
      '+KEEP1',
      ' mid',
      // Trailing change block whose '+' line has no final newline.
      '@@ -9,2 +9,2 @@',
      ' tail-ctx',
      '-tail',
      '+TAIL',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    // Target the first hunk's block: the second hunk is dropped wholesale
    // (only the selected hunk is emitted), marker and all.
    const out = sliceChangeBlock(patch, 0, 0, 'forward');
    expect(out).not.toContain('No newline');
    expect(out).toContain('+KEEP1');

    // Target the second hunk's change block: the marker (qualifying +TAIL,
    // which is kept) must survive.
    const out2 = sliceChangeBlock(patch, 1, 1, 'forward');
    expect(out2).toContain('+TAIL');
    expect(out2).toContain('\\ No newline at end of file');
  });

  it('rejects out-of-range and non-change indices', () => {
    expect(() => sliceChangeBlock(TWO_BLOCKS, 5, 0, 'forward')).toThrow(/hunkIndex/);
    expect(() => sliceChangeBlock(TWO_BLOCKS, 0, 0, 'forward')).toThrow(/context group/);
    expect(() => sliceChangeBlock('', 0, 0, 'forward')).toThrow(/empty patch/);
  });
});

describe('hashPatch', () => {
  it('is stable for equal input and differs across edits', () => {
    const a = hashPatch('+line one\n-line two\n');
    expect(hashPatch('+line one\n-line two\n')).toBe(a);
    expect(hashPatch('+line one\n-line TWO\n')).not.toBe(a);
    expect(hashPatch('')).toMatch(/^[0-9a-f]+$/);
  });
});
