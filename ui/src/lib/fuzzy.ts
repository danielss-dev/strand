/**
 * Pure fuzzy-match scoring for the command palette. Lives outside
 * Palette.tsx so it can be unit-tested without a DOM (the view module pulls
 * in window-touching stores at import time).
 */

export interface Match {
  score: number;
  /** [start, end) ranges within `label` to highlight. Empty = matched via keywords. */
  ranges: [number, number][];
}

/** Contiguous-run subsequence match over `text`, with highlight ranges. */
export function subsequence(
  q: string,
  text: string,
): { ranges: [number, number][]; gaps: number } | null {
  let qi = 0;
  const ranges: [number, number][] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length && qi < q.length; i++) {
    if (text[i] === q[qi]) {
      if (start === -1) {
        start = i;
        end = i + 1;
      } else if (i === end) {
        end = i + 1;
      } else {
        ranges.push([start, end]);
        start = i;
        end = i + 1;
      }
      qi++;
    }
  }
  if (qi < q.length) return null;
  if (start !== -1) ranges.push([start, end]);
  return { ranges, gaps: ranges.length - 1 };
}

/**
 * Score `label` (and fall back to `keywords`) against a lowercased query.
 * Higher is better. A contiguous substring beats a scattered subsequence,
 * an earlier match beats a later one, and a word-boundary hit gets a bonus.
 * Returns null when nothing matches.
 */
export function match(q: string, label: string, keywords?: string): Match | null {
  if (!q) return { score: 0, ranges: [] };
  const lab = label.toLowerCase();

  const idx = lab.indexOf(q);
  if (idx >= 0) {
    const boundary = idx === 0 || /[^a-z0-9]/.test(lab[idx - 1]);
    return { score: 1000 - idx + (boundary ? 200 : 0), ranges: [[idx, idx + q.length]] };
  }

  const sub = subsequence(q, lab);
  if (sub) {
    return { score: 400 - (sub.ranges[0]?.[0] ?? 0) - sub.gaps * 20, ranges: sub.ranges };
  }

  // Keyword match never highlights the label (the hit is off-screen).
  if (keywords) {
    const kw = keywords.toLowerCase();
    if (kw.includes(q) || subsequence(q, kw)) return { score: 80, ranges: [] };
  }
  return null;
}
