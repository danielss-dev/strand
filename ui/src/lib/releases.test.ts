import { describe, expect, it, vi } from 'vitest';

import {
  fetchStrandReleases,
  normalizeVersion,
  parseGithubReleases,
  selectDefaultRelease,
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
});
