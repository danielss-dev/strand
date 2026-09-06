import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import type { PullRequest } from './types';

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
if (typeof navigator === 'undefined') Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'vitest', platform: '', maxTouchPoints: 0 } });
afterAll(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, 'navigator');
});
const { PullRequestMergeControl } = await import('../views/PullRequestMergeControl');
const { providerName } = await import('./pullRequests');
const pr = { id: 7, state: 'open', is_draft: false, can_mark_ready: false, source_commit: 'a'.repeat(40) } as PullRequest;
const caps = { can_comment: true, can_review: true, can_request_changes: false, can_close: true, can_reopen: false, merge_strategies: [] };

describe('hosted provider capabilities', () => {
  it('keeps Bitbucket merge on the provider when atomic head protection is unavailable', () => {
    const html = renderToStaticMarkup(createElement(PullRequestMergeControl, { path: '/fixture', provider: 'bitbucket', pr: { ...pr, capabilities: caps }, disabledReason: '', onMerged: () => {}, onToast: () => {} }));
    expect(html).toContain('Merge on Bitbucket Cloud');
    expect(html).not.toContain('<button');
  });
  it('describes GitLab project merge semantics accurately', () => {
    const html = renderToStaticMarkup(createElement(PullRequestMergeControl, { path: '/fixture', provider: 'git_lab', pr: { ...pr, capabilities: { ...caps, merge_strategies: ['merge_commit'] } }, disabledReason: '', onMerged: () => {}, onToast: () => {} }));
    expect(html).toContain('Merge with project settings');
    expect(html).not.toContain('Create a merge commit');
  });
  it('retains existing provider behavior when optional capabilities are absent', () => {
    for (const provider of ['git_hub', 'azure_dev_ops'] as const) {
      const html = renderToStaticMarkup(createElement(PullRequestMergeControl, { path: '/fixture', provider, pr, disabledReason: '', onMerged: () => {}, onToast: () => {} }));
      expect(html).toContain('Merge pull request');
      expect(html).toContain('Choose merge strategy');
    }
    expect(providerName('git_lab')).toBe('GitLab');
    expect(providerName('bitbucket')).toBe('Bitbucket Cloud');
  });
});
