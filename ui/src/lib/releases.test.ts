import { describe, expect, it, vi } from 'vitest';

import {
  cleanPullRequestBody,
  clearPullRequestBodyCache,
  fetchPullRequestBody,
  fetchStrandReleases,
  normalizeVersion,
  parseGithubReleases,
  parseReleaseNotes,
  selectDefaultRelease,
  strandPullUrl,
  STRAND_RELEASES_URL,
  type StrandRelease,
} from './releases';

const sample: StrandRelease[] = [
  { tag: 'v1.7.7', version: '1.7.7', notes: '' },
  { tag: 'v1.7.6', version: '1.7.6', notes: 'Opened files in Workbench.' },
  { tag: 'v1.7.5', version: '1.7.5', notes: 'Healed blank taskbar pins.' },
];

describe('normalizeVersion', () => {
  it('strips a leading v so tags match getVersion()', () => {
    expect(normalizeVersion('v1.7.7')).toBe('1.7.7');
    expect(normalizeVersion('1.7.7')).toBe('1.7.7');
    expect(normalizeVersion('V1.0.0')).toBe('1.0.0');
  });
});

describe('parseGithubReleases', () => {
  it('keeps GitHub newest-first order, skips drafts, and trims bodies', () => {
    const parsed = parseGithubReleases([
      { tag_name: 'v1.7.7', body: '  ', draft: false },
      { tag_name: 'v1.7.6', body: 'Workbench open\n', draft: false },
      { tag_name: 'v9.9.9', body: 'secret', draft: true },
      { tag_name: 'v1.7.5', body: null, draft: false },
    ]);
    expect(parsed).toEqual([
      { tag: 'v1.7.7', version: '1.7.7', notes: '' },
      { tag: 'v1.7.6', version: '1.7.6', notes: 'Workbench open' },
      { tag: 'v1.7.5', version: '1.7.5', notes: '' },
    ]);
  });

  it('rejects a non-array payload', () => {
    expect(() => parseGithubReleases({ message: 'nope' })).toThrow('Unexpected releases response');
  });
});

describe('selectDefaultRelease', () => {
  it('selects the current app version when it is in the list', () => {
    expect(selectDefaultRelease(sample, '1.7.6')?.version).toBe('1.7.6');
    expect(selectDefaultRelease(sample, 'v1.7.5')?.version).toBe('1.7.5');
  });

  it('falls back to the newest release', () => {
    expect(selectDefaultRelease(sample, '9.9.9')?.version).toBe('1.7.7');
    expect(selectDefaultRelease(sample, null)?.version).toBe('1.7.7');
  });
});

describe('fetchStrandReleases', () => {
  it('requests the public unauthenticated releases URL', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(STRAND_RELEASES_URL);
      return {
        ok: true,
        json: async () => [{ tag_name: 'v1.7.6', body: 'notes', draft: false }],
      } as Response;
    }) as typeof fetch;
    await expect(fetchStrandReleases(fetchImpl)).resolves.toEqual([
      { tag: 'v1.7.6', version: '1.7.6', notes: 'notes' },
    ]);
  });

  it('fails on HTTP errors so the dialog can retry', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => [] }) as Response) as typeof fetch;
    await expect(fetchStrandReleases(fetchImpl)).rejects.toThrow('http 502');
  });

  it('fails on network errors so the dialog can retry', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(fetchStrandReleases(fetchImpl)).rejects.toThrow('network');
  });

  it('keeps every published release, including older Strand tags', () => {
    const payload = [
      { tag_name: 'v1.7.7', body: '', draft: false },
      { tag_name: 'v1.7.4', body: 'notes', draft: false },
      { tag_name: 'strand-azdo-v1.3.0', body: 'helper', draft: false },
      { tag_name: 'v0.5.0', body: 'alpha', draft: false },
    ];
    expect(parseGithubReleases(payload).map((r) => r.version)).toEqual([
      '1.7.7',
      '1.7.4',
      'strand-azdo-v1.3.0',
      '0.5.0',
    ]);
  });
});

const changedBody = [
  'Right-click a file in **Local Changes**.',
  '',
  "## What's Changed",
  '* feat(ui): open files in Workbench (DAN-84) by @danielss-dev in https://github.com/danielss-dev/strand/pull/145',
  '* fix(terminal): hide WSL console (DAN-83) by @danielss-dev in https://github.com/danielss-dev/strand/pull/144',
  '',
  '**Full Changelog**: https://github.com/danielss-dev/strand/compare/v1.7.5...v1.7.6',
].join('\n');

describe('parseReleaseNotes', () => {
  it('keeps the intro and one item per What\'s Changed PR', () => {
    expect(parseReleaseNotes(changedBody)).toEqual({
      intro: 'Right-click a file in **Local Changes**.',
      prs: [
        {
          number: 145,
          url: 'https://github.com/danielss-dev/strand/pull/145',
          title: 'feat(ui): open files in Workbench (DAN-84)',
        },
        {
          number: 144,
          url: 'https://github.com/danielss-dev/strand/pull/144',
          title: 'fix(terminal): hide WSL console (DAN-83)',
        },
      ],
    });
  });

  it('returns no PRs when the body has no What\'s Changed list', () => {
    expect(parseReleaseNotes('Healed blank taskbar pins.')).toEqual({
      intro: 'Healed blank taskbar pins.',
      prs: [],
    });
  });
});

describe('cleanPullRequestBody', () => {
  it('keeps only the marked description and drops agent chrome', () => {
    const raw = [
      '<!-- CURSOR_AGENT_PR_BODY_BEGIN -->',
      '## Behaviour',
      '',
      'Open the whole file in Work.',
      '<!-- CURSOR_AGENT_PR_BODY_END -->',
      '',
      '<sub>To show artifacts inline, <a href="https://cursor.com/dashboard/cloud-agents#my-pull-requests">enable</a> in settings.</sub>',
      '',
      '<div><a href="https://cursor.com/agents/bc-x?cursor_cta=open_in_web"><img alt="Open in Web" src="https://cursor.com/assets/images/open-in-web-dark.png"></a>&nbsp;<a href="https://cursor.com/background-agent?cursor_cta=open_in_cursor"><img alt="Open in Cursor" src="https://cursor.com/assets/images/open-in-cursor-dark.png"></a></div>',
    ].join('\n');
    expect(cleanPullRequestBody(raw)).toBe('## Behaviour\n\nOpen the whole file in Work.');
    expect(cleanPullRequestBody(raw)).not.toContain('Open in Web');
    expect(cleanPullRequestBody(raw)).not.toContain('enable');
    expect(cleanPullRequestBody('<!-- note -->\nHello')).toBe('Hello');
  });
});

describe('fetchPullRequestBody', () => {
  it('fetches lazily, cleans the body, and caches for the session', async () => {
    clearPullRequestBodyCache();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(strandPullUrl(145));
      return {
        ok: true,
        json: async () => ({
          body: '<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\nClean notes.\n<!-- CURSOR_AGENT_PR_BODY_END --><div>Open in Web</div>',
        }),
      } as Response;
    }) as typeof fetch;
    await expect(fetchPullRequestBody(145, fetchImpl)).resolves.toBe('Clean notes.');
    await expect(fetchPullRequestBody(145, fetchImpl)).resolves.toBe('Clean notes.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures so retry can refetch', async () => {
    clearPullRequestBodyCache();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as Response) as typeof fetch;
    await expect(fetchPullRequestBody(99, fetchImpl)).rejects.toThrow('http 502');
    await expect(fetchPullRequestBody(99, fetchImpl)).rejects.toThrow('http 502');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
