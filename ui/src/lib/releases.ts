/**
 * Public GitHub Releases for danielss-dev/strand.
 *
 * What's New reads this catalog at runtime (unauthenticated). Drafts are
 * omitted; GitHub returns newest first. `docs/changelog/` is early history
 * only and is not a source here.
 */

export const STRAND_RELEASES_URL =
  'https://api.github.com/repos/danielss-dev/strand/releases?per_page=100';

export interface StrandRelease {
  /** GitHub tag, e.g. `v1.7.6`. */
  tag: string;
  /** Tag without a leading `v`, matching `getVersion()`. */
  version: string;
  /** Trimmed release body; empty when GitHub published no notes. */
  notes: string;
}

export function normalizeVersion(value: string): string {
  return value.replace(/^v/i, '').trim();
}

export function parseGithubReleases(data: unknown): StrandRelease[] {
  if (!Array.isArray(data)) throw new Error('Unexpected releases response');
  const out: StrandRelease[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.draft === true) continue;
    if (typeof rec.tag_name !== 'string' || rec.tag_name.length === 0) continue;
    out.push({
      tag: rec.tag_name,
      version: normalizeVersion(rec.tag_name),
      notes: typeof rec.body === 'string' ? rec.body.trim() : '',
    });
  }
  return out;
}

/** Current app version when it is in the list; otherwise the newest release. */
export function selectDefaultRelease(
  releases: StrandRelease[],
  currentVersion: string | null | undefined,
): StrandRelease | null {
  if (releases.length === 0) return null;
  if (currentVersion) {
    const current = normalizeVersion(currentVersion);
    const match = releases.find((r) => r.version === current);
    if (match) return match;
  }
  return releases[0];
}

export async function fetchStrandReleases(
  fetchImpl: typeof fetch = fetch,
): Promise<StrandRelease[]> {
  let response: Response;
  try {
    response = await fetchImpl(STRAND_RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    throw new Error('network');
  }
  if (!response.ok) throw new Error(`http ${response.status}`);
  return parseGithubReleases(await response.json());
}
