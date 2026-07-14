import { describe, expect, it } from 'vitest';

import { aiCoverageLabel, aiRequestMatches, otherAiProvider } from './aiGeneration';

describe('AI request lifecycle', () => {
  const request = { opId: 'one', path: '/repo/a', provider: 'openai' as const, target: 'main' };

  it('rejects a response after repository, provider, or PR target changes', () => {
    expect(aiRequestMatches(request, { path: '/repo/a', provider: 'openai', target: 'main' })).toBe(true);
    expect(aiRequestMatches(request, { path: '/repo/b', provider: 'openai', target: 'main' })).toBe(false);
    expect(aiRequestMatches(request, { path: '/repo/a', provider: 'anthropic', target: 'main' })).toBe(false);
    expect(aiRequestMatches(request, { path: '/repo/a', provider: 'openai', target: 'release' })).toBe(false);
  });

  it('labels partial context and the provider that produced it', () => {
    expect(aiCoverageLabel({
      scope: 'committed',
      totalFiles: 23,
      manifestFiles: 23,
      patchFiles: 8,
      omittedPatchFiles: 15,
      truncatedPatchFiles: 2,
      sensitiveExcludedFiles: 1,
    }, 'anthropic')).toBe(
      'Generated with Claude Code · 8 of 23 patches included; 2 truncated; 1 sensitive excluded.',
    );
  });

  it('selects a retry provider without mutating the original preference', () => {
    const preference = 'openai' as const;
    expect(otherAiProvider(preference)).toBe('anthropic');
    expect(preference).toBe('openai');
  });
});
