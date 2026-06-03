/**
 * Parse a git conflicted file (with `<<<<<<< / ======= / >>>>>>>` markers,
 * optionally a `|||||||` diff3 base) into segments, and assemble the three
 * views the merge resolver shows: the incoming ("theirs") side, the current
 * ("ours") side, and the merged result built from the user's per-conflict
 * picks. Pure + UI-agnostic so it's easy to reason about and test.
 *
 * In git's markers the first block (`<<<<<<< HEAD`) is *ours* (current/HEAD)
 * and the block after `=======` is *theirs* (incoming).
 */

export type Resolution = 'ours' | 'theirs' | 'both';

type Seg =
  | { kind: 'common'; lines: string[] }
  | { kind: 'conflict'; ours: string[]; theirs: string[] };

export interface ParsedConflict {
  segs: Seg[];
  /** Label after `<<<<<<<` (usually `HEAD`). */
  oursLabel: string;
  /** Label after `>>>>>>>` (the merged-in branch). */
  theirsLabel: string;
  /** Number of conflict regions. */
  total: number;
}

/** 0-based half-open `[start, end)` line span within a built view. */
export type Span = [number, number];

export interface ConflictRange {
  index: number;
  theirs: Span;
  ours: Span;
  result: Span;
  resolved: boolean;
}

export interface MergeViews {
  theirsText: string;
  oursText: string;
  resultText: string;
  ranges: ConflictRange[];
  total: number;
}

const isStart = (l: string) => l.startsWith('<<<<<<<');
const isBase = (l: string) => l.startsWith('|||||||');
const isSep = (l: string) => l.startsWith('=======');
const isEnd = (l: string) => l.startsWith('>>>>>>>');

export function parseConflicts(text: string): ParsedConflict {
  const lines = text.split('\n');
  const segs: Seg[] = [];
  let common: string[] = [];
  let oursLabel = 'HEAD';
  let theirsLabel = 'incoming';
  let total = 0;

  const flushCommon = () => {
    if (common.length) {
      segs.push({ kind: 'common', lines: common });
      common = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!isStart(l)) {
      common.push(l);
      i++;
      continue;
    }
    flushCommon();
    oursLabel = l.slice(7).trim() || oursLabel;
    i++;

    const ours: string[] = [];
    while (i < lines.length && !isBase(lines[i]) && !isSep(lines[i]) && !isEnd(lines[i])) {
      ours.push(lines[i]);
      i++;
    }
    // Skip an optional diff3 base section (`||||||| … =======`).
    if (i < lines.length && isBase(lines[i])) {
      i++;
      while (i < lines.length && !isSep(lines[i]) && !isEnd(lines[i])) i++;
    }
    if (i < lines.length && isSep(lines[i])) i++;

    const theirs: string[] = [];
    while (i < lines.length && !isEnd(lines[i])) {
      theirs.push(lines[i]);
      i++;
    }
    if (i < lines.length && isEnd(lines[i])) {
      theirsLabel = lines[i].slice(7).trim() || theirsLabel;
      i++;
    }
    segs.push({ kind: 'conflict', ours, theirs });
    total++;
  }
  flushCommon();

  return { segs, oursLabel, theirsLabel, total };
}

/**
 * Build the three rendered views for the current set of resolutions. An
 * unresolved conflict contributes a single placeholder line to the result so
 * the user sees where work remains; the result text only loses every marker
 * once all conflicts are resolved.
 */
export function buildViews(
  parsed: ParsedConflict,
  resolutions: Map<number, Resolution>,
): MergeViews {
  const theirs: string[] = [];
  const ours: string[] = [];
  const result: string[] = [];
  const ranges: ConflictRange[] = [];
  let ci = 0;

  for (const seg of parsed.segs) {
    if (seg.kind === 'common') {
      theirs.push(...seg.lines);
      ours.push(...seg.lines);
      result.push(...seg.lines);
      continue;
    }
    const tStart = theirs.length;
    const oStart = ours.length;
    const rStart = result.length;
    theirs.push(...seg.theirs);
    ours.push(...seg.ours);

    const res = resolutions.get(ci);
    if (res === 'ours') result.push(...seg.ours);
    else if (res === 'theirs') result.push(...seg.theirs);
    else if (res === 'both') result.push(...seg.ours, ...seg.theirs);
    else result.push('··· unresolved merge conflict — choose theirs, ours, or both ···');

    ranges.push({
      index: ci,
      theirs: [tStart, theirs.length],
      ours: [oStart, ours.length],
      result: [rStart, result.length],
      resolved: res != null,
    });
    ci++;
  }

  return {
    theirsText: theirs.join('\n'),
    oursText: ours.join('\n'),
    resultText: result.join('\n'),
    ranges,
    total: ci,
  };
}

/** Convert a 0-based half-open span to Pierre's 1-based inclusive line range
 *  (`{start, end}`), clamping empty spans to a single line so a zero-line side
 *  still highlights its boundary. */
export function toLineRange(span: Span): { start: number; end: number } {
  const start = span[0] + 1;
  return { start, end: Math.max(start, span[1]) };
}

/** Index of the conflict whose `side` span contains the 1-based `lineNumber`,
 *  or -1. Used to map a click in a pane back to a conflict. */
export function conflictAtLine(
  ranges: ConflictRange[],
  side: 'theirs' | 'ours' | 'result',
  lineNumber: number,
): number {
  const idx = lineNumber - 1;
  const hit = ranges.find((r) => idx >= r[side][0] && idx < r[side][1]);
  return hit ? hit.index : -1;
}
