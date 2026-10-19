import { describe, expect, it, vi } from 'vitest';

import {
  applyHunkAction,
  hasConflictMarkers,
  saveResolution,
  suggestionMatchesHunks,
  writableResolution,
} from './conflictAi';
import { buildViews, conflictHunks, parseConflicts, type Resolution } from './conflictParse';

/**
 * Both sides edit the same function (diff3), and one side renames a helper
 * (2-way). N is the hunk count `parseConflicts` reports for this text.
 */
const FIXTURE = [
  'fn greet(name: &str) -> String {',
  '<<<<<<< HEAD',
  '    format!("hello {name}")',
  '||||||| base',
  '    format!("hi {name}")',
  '=======',
  '    format!("hey {name}")',
  '>>>>>>> feature',
  '}',
  '',
  '<<<<<<< HEAD',
  'fn helper() {}',
  '=======',
  'fn renamed_helper() {}',
  '>>>>>>> feature',
].join('\n');

const TWO_WAY = [
  '<<<<<<< HEAD',
  'fn greet(name: &str) -> String {',
  '    format!("hello {name}")',
  '}',
  '=======',
  'fn welcome(user: &str) -> String {',
  '    format!("hi {user}")',
  '}',
  '>>>>>>> feature',
].join('\n');

describe('conflict fixtures', () => {
  it('parses the mixed fixture into exactly two hunks and keeps base only on the first', () => {
    const parsed = parseConflicts(FIXTURE);
    expect(parsed.total).toBe(2);
    const hunks = conflictHunks(parsed);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].base).toBe('    format!("hi {name}")');
    expect(hunks[0].ours).toContain('hello');
    expect(hunks[0].theirs).toContain('hey');
    expect(hunks[1].base).toBeNull();
    expect(hunks[1].ours).toBe('fn helper() {}');
    expect(hunks[1].theirs).toBe('fn renamed_helper() {}');
  });

  it('parses a 2-way rename with no base', () => {
    const hunks = conflictHunks(parseConflicts(TWO_WAY));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].base).toBeNull();
    expect(hunks[0].theirs).toContain('fn welcome');
  });
});

describe('accept, edit, and reject', () => {
  it('accepting every hunk produces marker-free text and rejecting writes nothing', () => {
    const parsed = parseConflicts(FIXTURE);
    const suggestions = [
      { text: '    format!("hello {name}")', explanation: 'Keep the current greeting.', confidence: 'high' as const },
      { text: 'fn renamed_helper() {}', explanation: 'Take the incoming name.', confidence: 'medium' as const },
    ];
    expect(suggestionMatchesHunks(parsed.total, suggestions)).toBe(true);
    expect(suggestionMatchesHunks(parsed.total, suggestions.slice(0, 1))).toBe(false);

    let resolutions = new Map<number, Resolution>();
    for (let index = 0; index < parsed.total; index++) {
      const rejected = applyHunkAction(resolutions, index, { type: 'reject' });
      expect(rejected.ok).toBe(true);
      if (rejected.ok) resolutions = rejected.resolutions;
    }
    expect(resolutions.size).toBe(0);
    expect(writableResolution(parsed, resolutions)).toBeNull();
    // Rejecting left every hunk unresolved, so Resolve has nothing to write.
    expect(buildViews(parsed, resolutions).ranges.map((range) => range.resolved)).toEqual([false, false]);

    for (let index = 0; index < suggestions.length; index++) {
      const accepted = applyHunkAction(resolutions, index, { type: 'accept', text: suggestions[index].text });
      expect(accepted.ok).toBe(true);
      if (accepted.ok) resolutions = accepted.resolutions;
    }
    const written = writableResolution(parsed, resolutions);
    expect(written).not.toBeNull();
    expect(hasConflictMarkers(written ?? '')).toBe(false);
    expect(written).toContain('format!("hello {name}")');
    expect(written).toContain('fn renamed_helper() {}');
    expect(written).not.toContain('fn helper() {}');
  });

  it('mixes an edited AI hunk with ours and theirs picks', () => {
    const parsed = parseConflicts(FIXTURE);
    let resolutions = new Map<number, Resolution>([[1, 'ours']]);
    const edited = applyHunkAction(resolutions, 0, { type: 'edit', text: '    format!("hello, {name}")' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    resolutions = edited.resolutions;
    const text = writableResolution(parsed, resolutions);
    expect(text?.split('\n')).toEqual([
      'fn greet(name: &str) -> String {',
      '    format!("hello, {name}")',
      '}',
      '',
      'fn helper() {}',
    ]);
    expect(hasConflictMarkers(text ?? '')).toBe(false);
  });

  it('reject clears a custom hunk and leaves a side pick in place', () => {
    const accepted = applyHunkAction(new Map([[0, 'theirs']]), 1, { type: 'accept', text: 'merged' });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const rejectedCustom = applyHunkAction(accepted.resolutions, 1, { type: 'reject' });
    expect(rejectedCustom.ok).toBe(true);
    if (!rejectedCustom.ok) return;
    expect(rejectedCustom.resolutions.has(1)).toBe(false);
    expect(rejectedCustom.resolutions.get(0)).toBe('theirs');
    const rejectedSide = applyHunkAction(rejectedCustom.resolutions, 0, { type: 'reject' });
    expect(rejectedSide.ok).toBe(true);
    if (rejectedSide.ok) expect(rejectedSide.resolutions.get(0)).toBe('theirs');
  });

  it('treats only opening and closing marker lines as conflict markers', () => {
    expect(hasConflictMarkers('<<<<<<< HEAD\nours')).toBe(true);
    expect(hasConflictMarkers('a\n>>>>>>> feature')).toBe(true);
    expect(hasConflictMarkers('a\n<<<<<<<\r\nb')).toBe(true);
    expect(hasConflictMarkers('Title\n=======\n\nBody')).toBe(false);
    expect(hasConflictMarkers('Title\n==========')).toBe(false);
    expect(hasConflictMarkers('<<<<<<<<<< not a marker\n|||||||')).toBe(false);
  });

  it('saves side picks in a file with a setext heading exactly as before', () => {
    const raw = [
      'Title',
      '=======',
      '',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> feature',
    ].join('\n');
    const parsed = parseConflicts(raw);
    const resolutions = new Map<number, Resolution>([[0, 'theirs']]);
    expect(writableResolution(parsed, resolutions)).toBe(buildViews(parsed, resolutions).resultText);
    expect(writableResolution(parsed, resolutions)).toBe('Title\n=======\n\ntheirs');
    const custom = new Map<number, Resolution>([[0, { kind: 'custom', text: 'Sub\n=======' }]]);
    expect(writableResolution(parsed, custom)).toBe('Title\n=======\n\nSub\n=======');
  });

  it('writes only on Resolve, once, and reports a blocked save', async () => {
    const parsed = parseConflicts(FIXTURE);
    const write = vi.fn(async () => {});
    let resolutions = new Map<number, Resolution>();
    const accepted = applyHunkAction(resolutions, 0, { type: 'accept', text: 'merged' });
    if (accepted.ok) resolutions = accepted.resolutions;
    const rejected = applyHunkAction(resolutions, 1, { type: 'reject' });
    if (rejected.ok) resolutions = rejected.resolutions;
    expect(write).not.toHaveBeenCalled();

    await expect(saveResolution(parsed, resolutions, write)).resolves.toBe('blocked');
    expect(write).not.toHaveBeenCalled();

    resolutions.set(1, 'ours');
    await expect(saveResolution(parsed, resolutions, write)).resolves.toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('fn greet(name: &str) -> String {\nmerged\n}\n\nfn helper() {}');

    const marked = new Map<number, Resolution>([[0, { kind: 'custom', text: '<<<<<<< HEAD' }], [1, 'ours']]);
    await expect(saveResolution(parsed, marked, write)).resolves.toBe('blocked');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses replacement text that still contains conflict markers', () => {
    const result = applyHunkAction(new Map(), 0, { type: 'accept', text: '<<<<<<< HEAD\nnope' });
    expect(result).toEqual({ ok: false, reason: 'markers' });
  });
});
