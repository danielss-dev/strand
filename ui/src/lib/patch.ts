/**
 * Cheap, stable content hash (FNV-1a, hex) for diff text. Keys the
 * reviewed-file map: a file is "reviewed" only while its current diff hashes
 * to the value recorded when the reviewer marked it — any later edit by the
 * agent flips it back to unreviewed. Not cryptographic; collisions just mean
 * a stale checkmark, never data loss.
 */
export function hashPatch(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * {@link hashPatch} over a diff's whole-file patch, cached per FileDiff
 * object (one per fetch) — pennies for source files, tens of milliseconds
 * for a multi-megabyte lockfile, so each pool refresh hashes once, not once
 * per verdicts recompute. Shared by the Review and Workspace Review views.
 */
const patchHashCache = new WeakMap<{ patch: string }, string>();
export function hashFileDiff(d: { patch: string }): string {
  let h = patchHashCache.get(d);
  if (h === undefined) {
    h = hashPatch(d.patch);
    patchHashCache.set(d, h);
  }
  return h;
}

/**
 * Direction in which the resulting patch will be applied:
 * - `forward` for Stage (apply to index, source = pre-change side).
 * - `reverse` for Discard/Unstage (Rust will reverse before apply, so the
 *   source = post-change side).
 *
 * Picks which lines of the *other* change blocks in the same hunk get
 * promoted to context vs. omitted. See `sliceChangeBlock`.
 */
export type SliceDirection = 'forward' | 'reverse';

export interface ChangeLineSelection {
  /** Old-file line numbers selected from the deletion side. */
  deletions: readonly number[];
  /** New-file line numbers selected from the addition side. */
  additions: readonly number[];
}

/**
 * Carve a synthetic single-hunk patch that targets exactly one change block
 * inside `hunkIndex`, leaving the rest of the hunks (and the other change
 * blocks in the same hunk) untouched. The output is a normal unified-diff
 * patch — same file header as the input, one `@@` hunk, no others — and
 * can be fed straight to `Repo::apply_patch` on the Rust side.
 *
 * `contentIndex` matches Pierre's `DiffAcceptRejectHunkConfig.changeIndex`:
 * a position in the hunk's `hunkContent[]` array (mixed context/change),
 * **not** an ordinal among change blocks. We render annotations only for
 * `ChangeContent` items, so callers should always pass a change-block index.
 *
 * Rewrite rule for *other* change blocks in the same hunk:
 * - `forward` (Stage to index, source = pre-change): their `-` lines exist
 *   on both sides → promoted to context; their `+` lines exist on neither
 *   → omitted.
 * - `reverse` (Discard/Unstage, source = post-change after Rust flips the
 *   patch): mirror — their `+` lines become context, their `-` lines are
 *   omitted.
 *
 * `\ No newline at end of file` markers travel with the line they qualify:
 * kept if the line was kept (as-is or promoted to context), dropped if the
 * line was dropped.
 */
export function sliceChangeBlock(
  patch: string,
  hunkIndex: number,
  contentIndex: number,
  direction: SliceDirection,
): string {
  return slicePatch(patch, hunkIndex, contentIndex, direction, null);
}

/** Carve a patch for only selected changed lines inside one change block. */
export function sliceSelectedLines(
  patch: string,
  hunkIndex: number,
  contentIndex: number,
  direction: SliceDirection,
  selection: ChangeLineSelection,
): string {
  if (selection.deletions.length === 0 && selection.additions.length === 0) {
    throw new Error('sliceSelectedLines: empty selection');
  }
  return slicePatch(patch, hunkIndex, contentIndex, direction, {
    deletions: new Set(selection.deletions),
    additions: new Set(selection.additions),
  });
}

function slicePatch(
  patch: string,
  hunkIndex: number,
  contentIndex: number,
  direction: SliceDirection,
  selection: { deletions: Set<number>; additions: Set<number> } | null,
): string {
  if (!patch) throw new Error('sliceChangeBlock: empty patch');
  // Normalize the trailing newline up front so split('\n') doesn't produce a
  // bogus empty body line on the last hunk. With this, every hunk's body is
  // simply `lines[start+1 .. nextStart]` — no special case for the tail.
  const lines = (patch.endsWith('\n') ? patch.slice(0, -1) : patch).split('\n');

  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) throw new Error('sliceChangeBlock: no hunks in patch');
  const header = lines.slice(0, firstHunk);

  const hunkStarts: number[] = [];
  for (let i = firstHunk; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) hunkStarts.push(i);
  }
  hunkStarts.push(lines.length);

  if (hunkIndex < 0 || hunkIndex >= hunkStarts.length - 1) {
    throw new Error(`sliceChangeBlock: hunkIndex ${hunkIndex} out of range`);
  }

  const hunkHeaderLine = lines[hunkStarts[hunkIndex]];
  const bodyLines = lines.slice(hunkStarts[hunkIndex] + 1, hunkStarts[hunkIndex + 1]);

  const parsed = parseHunkHeader(hunkHeaderLine);

  // Segment body lines into Pierre-shaped content groups.
  // Group rules (mirroring ContextContent/ChangeContent):
  // - contiguous ` ` lines form a 'context' group
  // - contiguous `+`/`-` lines form a 'change' group
  // - `\` (no-EOF marker) lines belong to whichever group the preceding
  //   line was in. A `\` at the very start (only possible if the patch is
  //   malformed) is dropped.
  interface Group {
    type: 'context' | 'change';
    start: number;
    end: number; // inclusive
  }
  const groups: Group[] = [];
  for (let i = 0; i < bodyLines.length; ) {
    const c = bodyLines[i][0];
    if (c === ' ') {
      const start = i;
      while (i < bodyLines.length && (bodyLines[i][0] === ' ' || bodyLines[i][0] === '\\')) {
        i++;
      }
      groups.push({ type: 'context', start, end: i - 1 });
    } else if (c === '+' || c === '-') {
      const start = i;
      while (
        i < bodyLines.length &&
        (bodyLines[i][0] === '+' || bodyLines[i][0] === '-' || bodyLines[i][0] === '\\')
      ) {
        i++;
      }
      groups.push({ type: 'change', start, end: i - 1 });
    } else if (c === '\\') {
      // Marker with no preceding line — skip.
      i++;
    } else {
      // Unknown prefix — skip defensively.
      i++;
    }
  }

  if (contentIndex < 0 || contentIndex >= groups.length) {
    throw new Error(
      `sliceChangeBlock: contentIndex ${contentIndex} out of range (have ${groups.length} groups)`,
    );
  }
  if (groups[contentIndex].type !== 'change') {
    throw new Error(
      `sliceChangeBlock: contentIndex ${contentIndex} points to a context group, not a change block`,
    );
  }

  // Pierre reports selections in old/new file line numbers, not offsets into
  // the patch body. Map both coordinates once while walking the hunk.
  const deletionLineByIndex = new Map<number, number>();
  const additionLineByIndex = new Map<number, number>();
  let deletionLine = parsed.aStart;
  let additionLine = parsed.cStart;
  for (let i = 0; i < bodyLines.length; i++) {
    const c = bodyLines[i][0];
    if (c === ' ') {
      deletionLineByIndex.set(i, deletionLine++);
      additionLineByIndex.set(i, additionLine++);
    } else if (c === '-') {
      deletionLineByIndex.set(i, deletionLine++);
    } else if (c === '+') {
      additionLineByIndex.set(i, additionLine++);
    }
  }

  const newBody: string[] = [];
  let selectedChangedLines = 0;
  let targetChangedLines = 0;
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    if (g === contentIndex) {
      for (let j = grp.start; j <= grp.end; j++) {
        if (bodyLines[j][0] === '+' || bodyLines[j][0] === '-') targetChangedLines++;
      }
    }
    if (grp.type === 'context' || (g === contentIndex && selection == null)) {
      for (let j = grp.start; j <= grp.end; j++) newBody.push(bodyLines[j]);
      continue;
    }
    // Other change groups, plus unselected lines in the target group, are
    // rewritten to the source side. Selected target lines stay changes.
    let lastKeptRealLine = false;
    for (let j = grp.start; j <= grp.end; j++) {
      const l = bodyLines[j];
      const c = l[0];
      if (c === '\\') {
        if (lastKeptRealLine) newBody.push(l);
        continue;
      }
      const isSelected =
        g === contentIndex &&
        selection != null &&
        (c === '-'
          ? selection.deletions.has(deletionLineByIndex.get(j)!)
          : c === '+'
            ? selection.additions.has(additionLineByIndex.get(j)!)
            : false);
      if (isSelected) {
        newBody.push(l);
        selectedChangedLines++;
        lastKeptRealLine = true;
        continue;
      }
      if (direction === 'forward') {
        if (c === '-') {
          newBody.push(' ' + l.slice(1));
          lastKeptRealLine = true;
        } else {
          // '+' omitted
          lastKeptRealLine = false;
        }
      } else {
        if (c === '+') {
          newBody.push(' ' + l.slice(1));
          lastKeptRealLine = true;
        } else {
          // '-' omitted
          lastKeptRealLine = false;
        }
      }
    }
  }

  if (selection && selectedChangedLines === 0) {
    throw new Error('sliceSelectedLines: selection does not contain changed lines in this block');
  }

  // Recount sides. Context lines (' ') count toward both; '-' counts toward
  // source, '+' counts toward target. '\' markers don't count.
  let bCount = 0;
  let dCount = 0;
  for (const l of newBody) {
    const c = l[0];
    if (c === ' ') {
      bCount++;
      dCount++;
    } else if (c === '-') {
      bCount++;
    } else if (c === '+') {
      dCount++;
    }
  }

  let outputHeader = header;
  let leftStart = parsed.aStart;
  let rightStart = parsed.cStart;
  const partialSelection = selection != null && selectedChangedLines < targetChangedLines;
  if (partialSelection && direction === 'reverse' && header.includes('--- /dev/null')) {
    // A partial reverse of a creation removes selected lines but leaves the
    // file present, so it is a modification rather than a file deletion.
    outputHeader = creationOrDeletionAsModification(header, 'creation');
    leftStart = parsed.cStart;
    rightStart = parsed.cStart;
  } else if (partialSelection && direction === 'forward' && header.includes('+++ /dev/null')) {
    // A partial forward apply of a deletion keeps unselected lines, so it is
    // likewise a modification rather than a whole-file deletion.
    outputHeader = creationOrDeletionAsModification(header, 'deletion');
    leftStart = parsed.aStart;
    rightStart = parsed.aStart;
  }

  const newHeader = formatHunkHeader(leftStart, bCount, rightStart, dCount, parsed.trailing);

  const parts = [...outputHeader, newHeader, ...newBody];
  let out = parts.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function creationOrDeletionAsModification(
  header: string[],
  kind: 'creation' | 'deletion',
): string[] {
  const oldPath = header.find((line) => line.startsWith('--- '))?.slice(4);
  const newPath = header.find((line) => line.startsWith('+++ '))?.slice(4);
  return header
    .filter(
      (line) =>
        !line.startsWith('new file mode ') &&
        !line.startsWith('deleted file mode ') &&
        !line.startsWith('index '),
    )
    .map((line) => {
      if (kind === 'creation' && line === '--- /dev/null' && newPath) {
        return `--- ${swapPatchPathPrefix(newPath, 'b/', 'a/')}`;
      }
      if (kind === 'deletion' && line === '+++ /dev/null' && oldPath) {
        return `+++ ${swapPatchPathPrefix(oldPath, 'a/', 'b/')}`;
      }
      return line;
    });
}

function swapPatchPathPrefix(path: string, from: string, to: string): string {
  if (path.startsWith(from)) return to + path.slice(from.length);
  if (path.startsWith(`"${from}`)) return `"${to}${path.slice(from.length + 1)}`;
  return path;
}

interface ParsedHunkHeader {
  aStart: number;
  aCount: number;
  cStart: number;
  cCount: number;
  /** Everything after the closing `@@`, including the leading space (or empty). */
  trailing: string;
}

function parseHunkHeader(line: string): ParsedHunkHeader {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) throw new Error(`sliceChangeBlock: malformed hunk header: ${line}`);
  return {
    aStart: parseInt(m[1], 10),
    aCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    cStart: parseInt(m[3], 10),
    cCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    trailing: m[5],
  };
}

function formatHunkHeader(
  aStart: number,
  bCount: number,
  cStart: number,
  dCount: number,
  trailing: string,
): string {
  // Unified-diff convention: omit the count when it's exactly 1. When 0,
  // git uses `-A,0` with A being the line *before* the insertion point;
  // we keep the original start because `sliceChangeBlock` never drops
  // source-side lines (it either keeps them or promotes them to
  // context, both of which count toward bCount). So bCount/dCount can
  // only be 0 when the *original* hunk header already had a 0 count,
  // and that start value was emitted by git itself in canonical form.
  const left = bCount === 1 ? `-${aStart}` : `-${aStart},${bCount}`;
  const right = dCount === 1 ? `+${cStart}` : `+${cStart},${dCount}`;
  return `@@ ${left} ${right} @@${trailing}`;
}
