import { expect, it } from 'vitest';
import { completionAction, completionLabel } from './pullRequestCompletion';
import type { PullRequestCompletion } from './types';

it('distinguishes a queued request from waiting policies and a completed merge', () => {
  const state = { kind: 'github_queue', status: 'queued', position: 7 } as PullRequestCompletion;
  expect(completionLabel(state)).toBe('In GitHub merge queue · position 7');
  expect(completionAction(state, false)).toBe('Leave merge queue');
  expect(completionLabel({ ...state, status: 'merged' })).toBe('Merged');
  expect(completionLabel({ ...state, kind: 'azure_auto_complete', status: 'waiting_for_policies', position: null })).toBe('Azure auto-complete enabled · waiting for policies');
  expect(completionAction({ ...state, kind: 'azure_auto_complete' }, false)).toBe('Cancel auto-complete');
});
