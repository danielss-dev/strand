import { describe, expect, it } from 'vitest';
import { buildReviewFeedback, captureReviewNoteAnchor, collectFeedbackFiles, reviewNoteOutdated } from './reviewExport';
import { hashPatch } from './patch';
import { readReviewNotesForScope, writeReviewNotesForScope } from './db';
import type { ReviewNote } from './types';

const original = '@@ -1,2 +1,3 @@\n before();\n+authorizeAndDelete();\n after();\n';
const moved = '@@ -1,2 +1,4 @@\n+unrelated();\n before();\n+authorizeAndDelete();\n after();\n';
const saved: ReviewNote = {
  id: 'note', text: 'Check authorization', line: 2, createdAt: 0,
  anchor: captureReviewNoteAnchor(original, 2),
};
const feedback = (patch: string, note = saved) => buildReviewFeedback({
  repoName: 'example', branch: 'task', baselineShort: 'abc1234',
  files: [{ path: 'src/delete.ts', patch, notes: [note] }],
});

describe('review note anchors', () => {
  it('retains the inspected excerpt when later edits shift the target', () => {
    const output = feedback(moved);
    expect(output).toContain('Outdated note — original line 2');
    expect(output).toContain('+authorizeAndDelete();');
    expect(output).not.toContain('unrelated();');
    expect(reviewNoteOutdated(saved, hashPatch(original))).toBe(false);
    expect(reviewNoteOutdated(saved, hashPatch(moved))).toBe(true);
  });

  it('exports removed or renamed paths with original context and an outdated label', () => {
    const files = collectFeedbackFiles([{ path: 'src/renamed.ts', patch: moved }], { 'src/delete.ts': [saved] });
    const output = buildReviewFeedback({ repoName: 'r', branch: null, baselineShort: null, files });
    expect(output).toContain('## src/delete.ts');
    expect(output).toContain('Outdated note');
    expect(output).toContain('+authorizeAndDelete();');
  });

  it('never assigns current excerpts to legacy notes without saved context', () => {
    const { anchor: _anchor, ...legacy } = saved;
    const output = feedback(moved, legacy);
    expect(output).toContain('original context was not saved');
    expect(output).not.toContain('```');
    expect(output).toContain('Check authorization');
  });

  it('preserves old-side deletion context and anchor data through persistence', () => {
    const patch = '@@ -1,2 +1 @@\n-removed();\n retained();\n';
    const note = { ...saved, side: 'old' as const, line: 1, anchor: captureReviewNoteAnchor(patch, 1, 'old') };
    const stored = JSON.parse(JSON.stringify(writeReviewNotesForScope(null, 'scope', { 'src/delete.ts': [note] })));
    const restored = readReviewNotesForScope(stored, 'scope').notes['src/delete.ts'][0];
    expect(restored).toEqual(note);
    expect(feedback(moved, restored)).toContain('original old-side line 1');
    expect(feedback(moved, restored)).toContain('-removed();');
  });

  it('bounds saved excerpts from extremely long source lines', () => {
    const anchor = captureReviewNoteAnchor(`@@ -0,0 +1 @@\n+${'x'.repeat(100000)}\n`, 1);
    expect(anchor.excerpt!.length).toBeLessThan(4200);
    expect(anchor.excerpt).toContain('[Original excerpt truncated]');
  });
});
