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

/** App releases are `vMAJOR.MINOR.PATCH` (e.g. `v1.7.7`). Helper tags are not. */
export function isStrandAppReleaseTag(tag: string): boolean {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

export function parseGithubReleases(data: unknown): StrandRelease[] {
  if (!Array.isArray(data)) throw new Error('Unexpected releases response');
  const out: StrandRelease[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.draft === true) continue;
    if (typeof rec.tag_name !== 'string' || rec.tag_name.length === 0) continue;
    if (!isStrandAppReleaseTag(rec.tag_name)) continue;
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

const GITHUB_JSON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

export async function fetchStrandReleases(
  fetchImpl: typeof fetch = fetch,
): Promise<StrandRelease[]> {
  let response: Response;
  try {
    response = await fetchImpl(STRAND_RELEASES_URL, { headers: GITHUB_JSON_HEADERS });
  } catch {
    throw new Error('network');
  }
  if (!response.ok) throw new Error(`http ${response.status}`);
  return parseGithubReleases(await response.json());
}

export interface ReleasePr {
  number: number;
  url: string;
  title: string;
}

export interface ParsedReleaseNotes {
  intro: string;
  prs: ReleasePr[];
}

const CHANGED_HEADING = /^##\s+What['’]s Changed\s*$/i;
const PR_URL = /https:\/\/github\.com\/danielss-dev\/strand\/pull\/(\d+)/i;
const BY_AUTHOR_IN = /\s+by @[\w-]+\s+in\s+$/i;

/** Split a GitHub release body into the intro blurb and What's Changed PRs. */
export function parseReleaseNotes(notes: string): ParsedReleaseNotes {
  const lines = notes.replace(/\r\n?/g, '\n').split('\n');
  const heading = lines.findIndex((line) => CHANGED_HEADING.test(line.trim()));
  if (heading === -1) return { intro: notes.trim(), prs: [] };

  const intro = lines.slice(0, heading).join('\n').trim();
  const prs: ReleasePr[] = [];
  const seen = new Set<number>();
  for (const line of lines.slice(heading + 1)) {
    if (!/^\s*[*+-]\s+/.test(line)) continue;
    const urlMatch = PR_URL.exec(line);
    if (!urlMatch) continue;
    const number = Number(urlMatch[1]);
    if (seen.has(number)) continue;
    seen.add(number);
    let title = line.replace(/^\s*[*+-]\s+/, '').replace(urlMatch[0], '');
    title = title.replace(BY_AUTHOR_IN, '').trim();
    if (!title) title = `#${number}`;
    prs.push({ number, url: urlMatch[0], title });
  }
  return { intro, prs };
}

const BODY_BEGIN = '<!-- CURSOR_AGENT_PR_BODY_BEGIN -->';
const BODY_END = '<!-- CURSOR_AGENT_PR_BODY_END -->';

/** Drop agent chrome so What's New shows the human-written PR description. */
export function cleanPullRequestBody(raw: string | null | undefined): string {
  let text = raw ?? '';
  const begin = text.indexOf(BODY_BEGIN);
  const end = text.indexOf(BODY_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    text = text.slice(begin + BODY_BEGIN.length, end);
  }
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<div\b[^>]*>[\s\S]*?(?:open-in-web|open-in-cursor|Open in Web|Open in Cursor)[\s\S]*?<\/div>/gi, '');
  text = text.replace(/<sub\b[^>]*>[\s\S]*?<\/sub>/gi, '');
  return text.trim();
}

export function strandPullUrl(number: number): string {
  return `https://api.github.com/repos/danielss-dev/strand/pulls/${number}`;
}

const prBodyCache = new Map<number, string>();

export function clearPullRequestBodyCache(): void {
  prBodyCache.clear();
}

/** Lazy unauthenticated PR body fetch. Hits the 60/hour cap if prefetched. */
export async function fetchPullRequestBody(
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cached = prBodyCache.get(number);
  if (cached !== undefined) return cached;
  let response: Response;
  try {
    response = await fetchImpl(strandPullUrl(number), { headers: GITHUB_JSON_HEADERS });
  } catch {
    throw new Error('network');
  }
  if (!response.ok) throw new Error(`http ${response.status}`);
  const data: unknown = await response.json();
  const body = data && typeof data === 'object' && 'body' in data
    ? (data as { body: unknown }).body
    : null;
  const cleaned = cleanPullRequestBody(typeof body === 'string' ? body : '');
  prBodyCache.set(number, cleaned);
  return cleaned;
}
