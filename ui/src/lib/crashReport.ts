/**
 * Crash-report issue builder. Reporting is deliberately user-mediated: we
 * never upload anything — the toast/Settings action opens a *prefilled
 * GitHub issue* in the browser, so the user reviews exactly what leaves the
 * machine (crash logs can carry repository paths) and submitting is their
 * explicit act. Pure string work here so it's unit-testable.
 */

const ISSUES_URL = 'https://github.com/danielss-dev/strand/issues/new';

/** GitHub rejects very long URLs (~8k); keep the whole thing under this. */
const URL_BUDGET = 7000;

const TRUNCATION_NOTE = '\n… (truncated — the full entry is in crash.log)';

/**
 * Prefilled report for inappropriate pull-request, user-generated, or AI
 * content. The reporter chooses what to disclose and submits the issue in
 * their browser; Strand sends nothing automatically.
 */
export function buildContentReportUrl(version: string, platform: string): string {
  const body = [
    '<!-- Do not include credentials, secrets, or private repository content.',
    'Share provider links only when they are safe for the public issue. -->',
    '',
    `**Strand version:** ${version}`,
    `**Platform:** ${platform}`,
    '',
    '### Content type',
    '',
    '<!-- User-generated content, pull-request interaction, or AI-generated draft? -->',
    '',
    '### Where it appeared',
    '',
    '<!-- Name the Strand surface and, if safe, include the provider URL. -->',
    '',
    '### Why it is inappropriate',
    '',
    '<!-- Describe the concern and the action you are requesting. -->',
    '',
  ].join('\n');
  return `${ISSUES_URL}?title=${encodeURIComponent('Report inappropriate content')}`
    + `&body=${encodeURIComponent(body)}`;
}

/**
 * Derive an issue title from a panic entry. The hook writes the std panic
 * Display — `panicked at <file>:<line>:<col>:\n<message>` — so the message
 * is the line after the location. Falls back to a generic title.
 */
export function crashIssueTitle(entry: string): string {
  const lines = entry.split('\n');
  const at = lines.findIndex((l) => l.startsWith('panicked at '));
  const message = at >= 0 ? (lines[at + 1] ?? '').trim() : '';
  const title = message ? `Crash: ${message}` : 'Crash report';
  return title.length > 90 ? `${title.slice(0, 89)}…` : title;
}

/**
 * Prefilled new-issue URL for a crash entry. The body leads with a review
 * reminder (paths may name private repos), then version/OS and the log
 * excerpt in a fence. The excerpt is shrunk until the encoded URL fits
 * `URL_BUDGET`, keeping the head (panic message + top frames).
 */
export function buildCrashIssueUrl(entry: string, version: string, platform: string): string {
  const title = crashIssueTitle(entry);
  const build = (excerpt: string) => {
    const body = [
      '<!-- Please review the excerpt below before submitting and remove anything',
      "you'd rather not share — crash logs can include repository paths. -->",
      '',
      `**Strand version:** ${version}`,
      `**Platform:** ${platform}`,
      '',
      '### Crash log excerpt',
      '',
      '```text',
      excerpt,
      '```',
      '',
    ].join('\n');
    return `${ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  };

  let excerpt = entry.trim();
  let url = build(excerpt);
  while (url.length > URL_BUDGET && excerpt.length > TRUNCATION_NOTE.length) {
    // Worst-case encoding is 3 bytes per char, so step the raw excerpt down
    // by a third of the overshoot (min 200 so pathological input converges).
    const cut = Math.max(200, Math.ceil((url.length - URL_BUDGET) / 3));
    excerpt = excerpt.slice(0, Math.max(0, excerpt.length - TRUNCATION_NOTE.length - cut)) + TRUNCATION_NOTE;
    url = build(excerpt);
  }
  return url;
}
