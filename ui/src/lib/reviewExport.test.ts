import { describe, expect, it } from 'vitest';

import { buildReviewFeedback } from './reviewExport';
import type { ReviewNote } from './types';

let seq = 0;
const note = (text: string, line: number | null = null): ReviewNote => ({
  id: `n${++seq}`,
  text,
  line,
  createdAt: 0,
});

/** Two hunks: new-side lines 1-4 (hunk 1) and 40-47 (hunk 2). */
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' line one',
  '+line two added',
  ' line three',
  ' line four',
  '@@ -38,6 +40,8 @@',
  ' ctx 40',
  ' ctx 41',
  '-old 42',
  '+new 42',
  '+new 43',
  ' ctx 44',
  ' ctx 45',
  ' ctx 46',
  ' ctx 47',
  '',
].join('\n');

describe('buildReviewFeedback', () => {
  it('renders header, baseline line, excerpt, note, and closing line', () => {
    const out = buildReviewFeedback({
      repoName: 'strand',
      branch: 'main',
      baselineShort: 'abc1234',
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('rename this', 2)] }],
    });
    expect(out).toBe(
      [
        '# Review feedback — strand (branch main)',
        '',
        'Changes reviewed since abc1234.',
        '',
        '## src/a.ts',
        '',
        '```diff',
        ' line one',
        '+line two added',
        ' line three',
        ' line four',
        '```',
        '',
        '**Note:** rename this',
        '',
        'Please address each note above.',
        '',
      ].join('\n'),
    );
  });

  it('omits the branch suffix and baseline line when unknown', () => {
    const out = buildReviewFeedback({
      repoName: 'strand',
      branch: null,
      baselineShort: null,
      files: [{ path: 'a.ts', patch: PATCH, notes: [note('whole file')] }],
    });
    expect(out.startsWith('# Review feedback — strand\n\n## a.ts\n')).toBe(true);
    expect(out).not.toContain('Changes reviewed since');
    expect(out).not.toContain('(branch');
  });

  it('locates a line in the second hunk and clips the window to that hunk', () => {
    const out = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('leaks', 40)] }],
    });
    // Line 40 is the first body line of hunk 2: the window must not include
    // the @@ header or hunk 1's lines, and extends 4 lines forward.
    expect(out).toContain(
      '```diff\n ctx 40\n ctx 41\n-old 42\n+new 42\n+new 43\n```\n\n**Note:** leaks',
    );
    expect(out).not.toContain('@@ -38');
  });

  it('clips the window at the end of a hunk', () => {
    const out = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('tail', 47)] }],
    });
    expect(out).toContain('```diff\n+new 43\n ctx 44\n ctx 45\n ctx 46\n ctx 47\n```');
  });

  it('falls back to no excerpt when the line is not in any hunk', () => {
    const out = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('ghost', 999)] }],
    });
    expect(out).toContain('## src/a.ts\n\n**Note:** ghost\n');
    expect(out).not.toContain('```');
  });

  it('renders file-level notes as one bullet list and skips note-less files', () => {
    const out = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [
        { path: 'a.ts', patch: PATCH, notes: [note('first'), note('second')] },
        { path: 'b.ts', patch: PATCH, notes: [] },
      ],
    });
    expect(out).toContain('## a.ts\n\n- first\n- second\n');
    expect(out).not.toContain('## b.ts');
  });

  it('lengthens the excerpt fence past backtick runs in the patch', () => {
    const patch = ['@@ -1,2 +1,3 @@', ' intro', '+```js', ' outro', ''].join('\n');
    const out = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'doc.md', patch, notes: [note('fence', 2)] }],
    });
    expect(out).toContain('````diff\n intro\n+```js\n outro\n````');
  });
});
