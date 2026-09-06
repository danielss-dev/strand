import { expect, it } from 'vitest';
import { bisectRatingBlock, type BisectState } from './bisect';
const state: BisectState = { active: true, token: 'a', original: 'main', original_tip: 'tip', current: 'candidate', subject: 'Change', expected: 'candidate', good_term: 'good', bad_term: 'bad', remaining: 8, remaining_truncated: false, range_error: '', culprit: null, ambiguous: false, no_checkout: false, clean: true, log: '' };
it('allows the selected clean revision but blocks an external checkout', () => {
  expect(bisectRatingBlock(state)).toBeNull();
  expect(bisectRatingBlock({ ...state, current: 'different' })).toContain('differs');
});
it('preserves test edits and blocks rating a completed or ambiguous result', () => {
  expect(bisectRatingBlock({ ...state, clean: false })).toContain('stash');
  expect(bisectRatingBlock({ ...state, culprit: 'found' })).toContain('reset');
  expect(bisectRatingBlock({ ...state, ambiguous: true })).toContain('reset');
});
