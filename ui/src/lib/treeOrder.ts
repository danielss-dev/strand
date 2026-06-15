/**
 * File ordering that matches how `@pierre/trees` lays a tree out top-to-bottom.
 *
 * The Pierre file tree sorts **directories before files** at each path level,
 * then by a **case-insensitive natural** comparison of the segment name (so
 * `a2` < `a10`). A flat full-path string sort (what `repo` diff lists use)
 * interleaves nested files with their siblings differently, which makes `j`/`k`
 * appear to "dive into folders" instead of moving straight down the list the
 * user sees. Sorting the file paths with this comparator reproduces the tree's
 * visible *file* order (folder rows aside) so keyboard nav matches the arrows.
 *
 * This is a faithful re-implementation of Pierre's internal
 * `comparePreparedPaths` (`@pierre/trees/dist/path-store/src/sort.js`); kept in
 * `lib/` and unit-tested so the two can be checked against each other. It
 * considers only the *file* order — folder flattening and collapsed-folder
 * visibility don't affect the relative order of files, so they're ignored.
 */

type NaturalToken = string | number;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Split a lowercased string into alternating text / number tokens, so numeric
 * runs compare by value (`a2` before `a10`). Mirrors Pierre's tokenizer. */
function splitIntoNaturalTokens(value: string): NaturalToken[] {
  const tokens: NaturalToken[] = [];
  let tokenStart = 0;
  let i = 0;
  while (i < value.length) {
    while (i < value.length && !isDigit(value.charCodeAt(i))) i += 1;
    if (i >= value.length) break;
    if (i > tokenStart) tokens.push(value.slice(tokenStart, i));
    let num = 0;
    while (i < value.length && isDigit(value.charCodeAt(i))) {
      num = num * 10 + (value.charCodeAt(i) - 48);
      i += 1;
    }
    tokens.push(num);
    tokenStart = i;
  }
  if (tokenStart < value.length || tokens.length === 0) tokens.push(value.slice(tokenStart));
  return tokens;
}

function compareNaturalTokens(left: NaturalToken[], right: NaturalToken[]): number {
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    if (typeof l === 'number' && typeof r === 'number') return l < r ? -1 : 1;
    const ls = String(l);
    const rs = String(r);
    if (ls !== rs) return ls < rs ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return 0;
}

/** Compare two path segments case-insensitively + naturally, with the raw
 * value as the final tiebreak (so case differences are stable). */
function compareSegments(left: string, right: string): number {
  const ll = left.toLowerCase();
  const rl = right.toLowerCase();
  const tokenCmp = compareNaturalTokens(splitIntoNaturalTokens(ll), splitIntoNaturalTokens(rl));
  if (tokenCmp !== 0) return tokenCmp;
  if (ll !== rl) return ll < rl ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const segs = (p: string): string[] => p.split('/').filter(Boolean);

/**
 * Compare two *file* paths in Pierre tree display order: directories before
 * files at each level, then natural segment order. A path that is a prefix of
 * the other sorts first.
 */
export function compareTreePaths(a: string, b: string): number {
  const la = segs(a);
  const lb = segs(b);
  const shared = Math.min(la.length, lb.length);
  for (let depth = 0; depth < shared; depth++) {
    if (la[depth] === lb[depth]) continue;
    // A segment is a directory unless it's the path's last segment (these are
    // all file paths, so only the final segment is a file).
    const aIsDir = depth !== la.length - 1;
    const bIsDir = depth !== lb.length - 1;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return compareSegments(la[depth], lb[depth]);
  }
  if (la.length !== lb.length) return la.length < lb.length ? -1 : 1;
  return 0;
}

/** Return `paths` in tree display order (does not mutate the input). */
export function treeFileOrder(paths: readonly string[]): string[] {
  return [...paths].sort(compareTreePaths);
}
