import { describe, expect, it } from 'vitest';

import {
  buildReviewFeedback,
  buildWorkspaceReviewFeedback,
  collectFeedbackFiles,
} from './reviewExport';
import type { ReviewNote } from './types';

let seq = 0;
const note = (text: string, line: number | null = null, side?: 'new' | 'old'): ReviewNote => ({
  id: `n${++seq}`,
  text,
  line,
  ...(side ? { side } : {}),
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

  it('locates old-side anchors with the old-line counter (deletion-only blocks)', () => {
    // "old 42" is OLD line 40 (hunk 2 starts at -38; ctx 38, ctx 39 → del 40).
    // A new-side lookup of 40 would land on " ctx 40" instead — the side
    // field is what keeps the excerpt on the deleted line.
    const out = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('dead code', 40, 'old')] }],
    });
    expect(out).toContain('-old 42\n+new 42\n+new 43\n ctx 44\n ctx 45\n```');
  });

  it('treats notes without a side as new-side (pre-side persistence)', () => {
    const withSide = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('x', 2, 'new')] }],
    });
    const without = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('x', 2)] }],
    });
    expect(without).toBe(withSide);
  });
});

describe('buildWorkspaceReviewFeedback', () => {
  it('groups by repo with per-repo context and demoted file headings', () => {
    const out = buildWorkspaceReviewFeedback({
      workspaceName: 'acme',
      repos: [
        {
          repoName: 'api',
          branch: 'main',
          baselineShort: 'abc1234',
          files: [{ path: 'src/a.ts', patch: PATCH, notes: [note('rename this', 2)] }],
        },
        {
          repoName: 'web',
          branch: null,
          baselineShort: null,
          files: [{ path: 'app.tsx', patch: '', notes: [note('whole file')] }],
        },
      ],
    });
    expect(out).toBe(
      [
        '# Review feedback — acme workspace',
        '',
        '## api (branch main)',
        '',
        'Changes reviewed since abc1234.',
        '',
        '### src/a.ts',
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
        '## web',
        '',
        '### app.tsx',
        '',
        '- whole file',
        '',
        'Please address each note above. Notes are grouped by repository; file paths are relative to their repository.',
        '',
      ].join('\n'),
    );
  });

  it('skips repos without noted files (empty files and note-less files)', () => {
    const out = buildWorkspaceReviewFeedback({
      workspaceName: 'w',
      repos: [
        { repoName: 'clean', branch: 'main', baselineShort: null, files: [] },
        {
          repoName: 'noteless',
          branch: null,
          baselineShort: 'fff0000',
          files: [{ path: 'x.ts', patch: PATCH, notes: [] }],
        },
        {
          repoName: 'noted',
          branch: null,
          baselineShort: null,
          files: [{ path: 'y.ts', patch: '', notes: [note('keep')] }],
        },
      ],
    });
    expect(out).not.toContain('## clean');
    expect(out).not.toContain('## noteless');
    expect(out).not.toContain('fff0000');
    expect(out).toContain('## noted\n\n### y.ts\n\n- keep');
  });

  it('matches the single-repo body rendering (same file, one level down)', () => {
    const files = [{ path: 'src/a.ts', patch: PATCH, notes: [note('leaks', 40)] }];
    const single = buildReviewFeedback({
      repoName: 'r',
      branch: null,
      baselineShort: null,
      files,
    });
    const workspace = buildWorkspaceReviewFeedback({
      workspaceName: 'w',
      repos: [{ repoName: 'r', branch: null, baselineShort: null, files }],
    });
    // The excerpt + note body must be byte-identical; only the heading depth
    // and the surrounding header/closing lines differ.
    const body = (s: string) => s.slice(s.indexOf('```diff'), s.indexOf('\n\nPlease address'));
    expect(body(workspace)).toBe(body(single));
    expect(single).toContain('## src/a.ts');
    expect(workspace).toContain('### src/a.ts');
  });
});

describe('collectFeedbackFiles', () => {
  const notes: Record<string, ReviewNote[]> = {
    'b.ts': [note('on b')],
    'gone.ts': [note('left the pool')],
    'a.ts': [note('on a')],
    'clean.ts': [],
  };
  const pool = [
    { path: 'a.ts', patch: 'A' },
    { path: 'clean.ts', patch: 'C' },
    { path: 'b.ts', patch: 'B' },
  ];

  it('unions pool files with notes and orphaned noted paths (pool order first)', () => {
    const files = collectFeedbackFiles(pool, notes);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'gone.ts']);
    expect(files[0].patch).toBe('A');
    // Orphans export without a patch → buildReviewFeedback emits no excerpt.
    expect(files[2].patch).toBe('');
    expect(files[2].notes[0].text).toBe('left the pool');
  });

  it('works with an empty pool (Review view never populated this session)', () => {
    const files = collectFeedbackFiles([], notes);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'gone.ts']);
    expect(files.every((f) => f.patch === '')).toBe(true);
  });

  it('returns nothing when no notes exist', () => {
    expect(collectFeedbackFiles(pool, {})).toEqual([]);
    expect(collectFeedbackFiles(pool, { 'a.ts': [] })).toEqual([]);
  });
});
