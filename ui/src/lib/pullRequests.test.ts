import { describe, expect, it } from 'vitest';

import { checkTone, diffStats, markdownUrl, parsePullRequestPatch } from './pullRequests';

describe('checkTone', () => {
  it('normalizes provider success, running, and failure states', () => {
    expect(checkTone('SUCCESS')).toBe('success');
    expect(checkTone('in progress')).toBe('running');
    expect(checkTone('queued')).toBe('running');
    expect(checkTone('timed-out')).toBe('failed');
    expect(checkTone('neutral')).toBe('neutral');
  });
});

describe('parsePullRequestPatch', () => {
  it('returns provider patch files and line totals', () => {
    const [file] = parsePullRequestPatch(`diff --git a/a.txt b/a.txt
index 5626abf..f719efd 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1,2 @@
 one
+two
`);
    expect(file.name).toBe('a.txt');
    expect(diffStats(file)).toEqual({ additions: 1, deletions: 0 });
  });
});

describe('markdownUrl', () => {
  it('resolves safe relative links and rejects executable protocols', () => {
    expect(markdownUrl('/acme/repo/issues/1', 'https://github.com/acme/repo/pull/2'))
      .toBe('https://github.com/acme/repo/issues/1');
    expect(markdownUrl('javascript:alert(1)', 'https://github.com/acme/repo/pull/2')).toBeNull();
  });
});
