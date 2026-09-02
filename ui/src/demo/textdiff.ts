/**
 * Line-level diffing for the in-browser demo backend. Produces git-style
 * unified patches (what `<Diff />` and Pierre parse) and applies them back,
 * so hunk/line staging and discards behave like the real engine.
 */

export type LineOp = { kind: 'eq' | 'del' | 'add'; text: string };

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Classic LCS table diff — fixtures are small, so O(n·m) is fine. */
export function diffLines(oldText: string, newText: string): LineOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}

export function countChanges(ops: LineOp[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const op of ops) {
    if (op.kind === 'add') adds += 1;
    else if (op.kind === 'del') dels += 1;
  }
  return { adds, dels };
}

export interface PatchOptions {
  oldPath: string | null;
  newPath: string | null;
  /** Lines of context around each change; `Infinity` yields a whole-file patch. */
  context?: number;
}

function fakeBlobId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

/** Render a git-style unified patch for one file. */
export function unifiedPatch(oldText: string, newText: string, options: PatchOptions): string {
  const { oldPath, newPath } = options;
  const context = options.context ?? 3;
  const label = newPath ?? oldPath ?? 'file';
  const ops = diffLines(oldText, newText);
  const header: string[] = [`diff --git a/${oldPath ?? label} b/${newPath ?? label}`];
  if (oldPath == null) header.push('new file mode 100644', `index 0000000..${fakeBlobId(newText)}`);
  else if (newPath == null) header.push('deleted file mode 100644', `index ${fakeBlobId(oldText)}..0000000`);
  else {
    if (oldPath !== newPath) header.push(`similarity index 90%`, `rename from ${oldPath}`, `rename to ${newPath}`);
    header.push(`index ${fakeBlobId(oldText)}..${fakeBlobId(newText)} 100644`);
  }
  header.push(oldPath == null ? '--- /dev/null' : `--- a/${oldPath}`);
  header.push(newPath == null ? '+++ /dev/null' : `+++ b/${newPath}`);

  const hunks = buildHunks(ops, context);
  if (hunks.length === 0) return '';
  return `${header.join('\n')}\n${hunks.join('\n')}\n`;
}

function buildHunks(ops: LineOp[], context: number): string[] {
  const changeIdx: number[] = [];
  ops.forEach((op, idx) => { if (op.kind !== 'eq') changeIdx.push(idx); });
  if (changeIdx.length === 0) return [];

  // Group changes whose context windows touch into one hunk.
  const groups: Array<[number, number]> = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length, changeIdx[0] + 1 + context);
  for (let k = 1; k < changeIdx.length; k += 1) {
    const from = Math.max(0, changeIdx[k] - context);
    const to = Math.min(ops.length, changeIdx[k] + 1 + context);
    if (from <= end) end = Math.max(end, to);
    else {
      groups.push([start, end]);
      start = from;
      end = to;
    }
  }
  groups.push([start, end]);

  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const [from, to] of groups) {
    for (; cursor < from; cursor += 1) {
      const op = ops[cursor];
      if (op.kind !== 'add') oldLine += 1;
      if (op.kind !== 'del') newLine += 1;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = from; k < to; k += 1) {
      const op = ops[k];
      if (op.kind === 'eq') { body.push(` ${op.text}`); oldCount += 1; newCount += 1; }
      else if (op.kind === 'del') { body.push(`-${op.text}`); oldCount += 1; }
      else { body.push(`+${op.text}`); newCount += 1; }
    }
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
    oldLine += oldCount;
    newLine += newCount;
    cursor = to;
  }
  return out;
}

interface Hunk { oldStart: number; newStart: number; lines: string[] }

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of patch.split('\n')) {
    const head = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (head) {
      current = { oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line === '' || line.startsWith('\\')) continue;
    if (line[0] === ' ' || line[0] === '+' || line[0] === '-') current.lines.push(line);
  }
  return hunks;
}

/**
 * Apply a unified patch to `text`. `reverse` undoes it (turns `+` into `-`).
 * Hunks come from {@link unifiedPatch} on the same content, so offsets match;
 * a context mismatch throws, which the demo surfaces as a normal git error.
 */
export function applyPatch(text: string, patch: string, reverse = false): string {
  const src = splitLines(text);
  const out: string[] = [];
  let pos = 0;
  for (const hunk of parseHunks(patch)) {
    const lines = hunk.lines.map((l) => {
      if (!reverse) return l;
      if (l[0] === '+') return `-${l.slice(1)}`;
      if (l[0] === '-') return `+${l.slice(1)}`;
      return l;
    });
    const consumesOld = lines.some((l) => l[0] !== '+');
    // A pure-insertion hunk reports the line *before* the insertion.
    let start = (reverse ? hunk.newStart : hunk.oldStart) - 1;
    if (!consumesOld) start += 1;
    if (start < pos) throw new Error('patch does not apply: overlapping hunks');
    while (pos < start) out.push(src[pos++]);
    for (const l of lines) {
      const body = l.slice(1);
      if (l[0] === ' ' || l[0] === '-') {
        if (src[pos] !== body) throw new Error('patch does not apply: context mismatch');
        pos += 1;
        if (l[0] === ' ') out.push(body);
      } else {
        out.push(body);
      }
    }
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
