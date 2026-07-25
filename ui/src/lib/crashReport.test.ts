import { describe, expect, it } from 'vitest';

import { buildContentReportUrl, buildCrashIssueUrl, crashIssueTitle } from './crashReport';

const ENTRY = [
  '=== panic at unix:1730000000 (strand 0.8.0)',
  'panicked at crates/strand-core/src/diff.rs:42:13:',
  'called `Option::unwrap()` on a `None` value',
  'stack backtrace:',
  '   0: std::panicking::begin_panic',
].join('\n');

describe('crashIssueTitle', () => {
  it('uses the panic message line after the location', () => {
    expect(crashIssueTitle(ENTRY)).toBe('Crash: called `Option::unwrap()` on a `None` value');
  });

  it('falls back when the entry has no panic marker', () => {
    expect(crashIssueTitle('garbled tail')).toBe('Crash report');
  });

  it('caps very long messages', () => {
    const entry = `panicked at src/main.rs:1:1:\n${'x'.repeat(300)}`;
    const title = crashIssueTitle(entry);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('buildCrashIssueUrl', () => {
  it('prefills a GitHub new-issue URL with version, platform, and the entry', () => {
    const url = buildCrashIssueUrl(ENTRY, '0.8.0', 'windows');
    expect(url.startsWith('https://github.com/danielss-dev/strand/issues/new?title=')).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('Strand version:** 0.8.0');
    expect(decoded).toContain('Platform:** windows');
    expect(decoded).toContain('called `Option::unwrap()`');
    expect(decoded).toContain('```text');
  });

  it('shrinks a huge entry until the URL fits the budget, keeping the head', () => {
    const entry = `panicked at src/main.rs:1:1:\nboom\n${'frame line with some detail\n'.repeat(2000)}`;
    const url = buildCrashIssueUrl(entry, '0.8.0', 'macos');
    expect(url.length).toBeLessThanOrEqual(7000);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('boom');
    expect(decoded).toContain('truncated — the full entry is in crash.log');
  });
});

describe('buildContentReportUrl', () => {
  it('opens a user-reviewed inappropriate-content report without private data', () => {
    const url = buildContentReportUrl('1.1.1', 'windows');
    expect(url.startsWith('https://github.com/danielss-dev/strand/issues/new?title=')).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('Report inappropriate content');
    expect(decoded).toContain('Strand version:** 1.1.1');
    expect(decoded).toContain('Platform:** windows');
    expect(decoded).toContain('Do not include credentials, secrets, or private repository content');
    expect(decoded).toContain('User-generated content, pull-request interaction, or AI-generated draft');
  });
});
