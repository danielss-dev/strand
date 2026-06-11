import type { FileDiff } from './types';

/** One matching content line inside a diff pool (⌘F in-diff search). */
export interface DiffMatch {
  path: string;
  /** Line text without the leading `+`/`-`/space prefix. */
  lineText: string;
  /** Line number on the new side; `null` for deleted lines. */
  newLine: number | null;
  /** Line number on the old side; `null` for added lines. */
  oldLine: number | null;
  kind: 'add' | 'del' | 'ctx';
  /**
   * The input entry's `tag`, copied through verbatim. Lets a caller searching
   * a mixed pool (Local Changes feeds unstaged + staged copies of the same
   * path) know which entry a match came from — a path alone is ambiguous.
   */
  tag?: unknown;
}

export interface DiffSearchResult {
  matches: DiffMatch[];
  /** True when at least one match past `limit` was dropped. */
  truncated: boolean;
}

/**
 * Case-insensitive substring search over a pool of unified-diff patches.
 * Only content lines are searched — patch metadata (`diff --git`, `index`,
 * `---`/`+++` file headers) and `@@` hunk headers never match, but the hunk
 * headers are parsed to keep the old/new line counters honest. Matching is
 * done on the line text *without* its `+`/`-`/space prefix.
 */
export function searchDiffs(
  diffs: (Pick<FileDiff, 'path' | 'patch' | 'binary'> & { tag?: unknown })[],
  query: string,
  limit = 400,
): DiffSearchResult {
  const q = query.trim().toLowerCase();
  const matches: DiffMatch[] = [];
  if (!q) return { matches, truncated: false };

  for (const d of diffs) {
    if (d.binary || d.patch.length === 0) continue;
    let oldLine = 0;
    let newLine = 0;
    // Everything before the first @@ is file-header metadata (`---`/`+++`
    // lines would otherwise read as del/add content).
    let inHunk = false;
    for (const line of d.patch.split('\n')) {
      if (line.startsWith('@@')) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
          oldLine = parseInt(m[1], 10);
          newLine = parseInt(m[2], 10);
          inHunk = true;
        }
        continue;
      }
      if (!inHunk || line.length === 0) continue;
      const c = line[0];
      let kind: DiffMatch['kind'];
      let ol: number | null;
      let nl: number | null;
      if (c === '+') {
        kind = 'add';
        ol = null;
        nl = newLine++;
      } else if (c === '-') {
        kind = 'del';
        ol = oldLine++;
        nl = null;
      } else if (c === ' ') {
        kind = 'ctx';
        ol = oldLine++;
        nl = newLine++;
      } else {
        // `\ No newline at end of file` and anything else non-content.
        continue;
      }
      const text = line.slice(1);
      if (text.toLowerCase().includes(q)) {
        if (matches.length >= limit) return { matches, truncated: true };
        matches.push({ path: d.path, lineText: text, newLine: nl, oldLine: ol, kind, tag: d.tag });
      }
    }
  }
  return { matches, truncated: false };
}
