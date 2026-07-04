/**
 * Change map for the diff overview ruler (`DiffMinimap`): where each change
 * block sits in a rendered single-file diff, in *rendered row* space — not
 * file line numbers. `row / total` maps straight to a scroll fraction
 * because diff rows have uniform height; file line numbers wouldn't
 * (deleted lines render rows that don't exist in the new file).
 */
export interface ChangeMapBlock {
  /** First rendered diff row the block occupies (0-based). */
  row: number;
  /** How many rendered rows it spans. */
  rows: number;
  kind: 'add' | 'del' | 'mixed';
}

export interface ChangeMap {
  blocks: ChangeMapBlock[];
  /** Total rendered diff rows (context + change), across all hunks. */
  total: number;
}

/**
 * Scan a unified-diff patch into a {@link ChangeMap}. Grouping mirrors
 * Pierre's ChangeContent (and `sliceChangeBlock`): contiguous `+`/`-` lines
 * form one block. Layout matters for row counts: unified stacks deletions
 * above additions; split aligns them side-by-side, so a mixed block only
 * occupies the taller column. `\ No newline` markers and everything before
 * the first `@@` render no rows. Returns null when there's nothing to map
 * (empty/malformed patch or no change blocks).
 */
export function computeChangeMap(
  patch: string,
  layout: 'unified' | 'split',
): ChangeMap | null {
  const lines = (patch.endsWith('\n') ? patch.slice(0, -1) : patch).split('\n');
  const blocks: ChangeMapBlock[] = [];
  let row = 0;
  let dels = 0;
  let adds = 0;
  const flush = () => {
    if (dels === 0 && adds === 0) return;
    const rows = layout === 'split' ? Math.max(dels, adds) : dels + adds;
    blocks.push({
      row,
      rows,
      kind: dels > 0 && adds > 0 ? 'mixed' : adds > 0 ? 'add' : 'del',
    });
    row += rows;
    dels = adds = 0;
  };
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = line[0];
    if (c === '-') dels++;
    else if (c === '+') adds++;
    else if (c === '\\') continue;
    else {
      flush();
      row++;
    }
  }
  flush();
  return row > 0 && blocks.length > 0 ? { blocks, total: row } : null;
}

/**
 * Locate one content line's rendered diff row (the ⌘F jump target), in the
 * same rendered-row space as {@link computeChangeMap} — so `row / total` is
 * directly a scroll fraction that agrees with the minimap. `side` picks
 * which line counter `line` refers to: `'old'` for deletions, `'new'` for
 * additions; context lines carry both. Within a change block Pierre renders
 * all deletions above all additions regardless of their order in the patch
 * text (and split lays them side-by-side), so a change line's row can only
 * be resolved once its whole block has been scanned. Returns null when the
 * line isn't in the patch.
 */
export function lineToRow(
  patch: string,
  layout: 'unified' | 'split',
  line: number,
  side: 'new' | 'old',
): { row: number; total: number } | null {
  const lines = (patch.endsWith('\n') ? patch.slice(0, -1) : patch).split('\n');
  let row = 0;
  let dels = 0;
  let adds = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  // The target's offset within the current (unflushed) block, or -1.
  let hitDel = -1;
  let hitAdd = -1;
  let found = -1;
  const flush = () => {
    if (dels === 0 && adds === 0) return;
    if (hitDel >= 0) found = row + hitDel;
    else if (hitAdd >= 0) found = row + (layout === 'split' ? hitAdd : dels + hitAdd);
    row += layout === 'split' ? Math.max(dels, adds) : dels + adds;
    dels = adds = 0;
    hitDel = hitAdd = -1;
  };
  for (const l of lines) {
    if (l.startsWith('@@')) {
      flush();
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = l[0];
    if (c === '-') {
      if (side === 'old' && oldLine === line) hitDel = dels;
      dels++;
      oldLine++;
    } else if (c === '+') {
      if (side === 'new' && newLine === line) hitAdd = adds;
      adds++;
      newLine++;
    } else if (c === '\\') {
      continue;
    } else {
      flush();
      if (side === 'new' ? newLine === line : oldLine === line) found = row;
      row++;
      oldLine++;
      newLine++;
    }
  }
  flush();
  return found >= 0 && row > 0 ? { row: found, total: row } : null;
}
