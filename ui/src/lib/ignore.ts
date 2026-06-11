/**
 * Ignore patterns offered for an untracked file by the "Add to .gitignore"
 * quick action (Local Changes + Files tab context menus).
 *
 * - `exact`: the file itself, root-anchored (`/src/notes.txt`) so it can't
 *   accidentally match a same-named file elsewhere in the tree. Gitignore
 *   metacharacters in the path are escaped so a literal name like
 *   `app/[id]/route.ts` matches itself, not a character class.
 * - `extension`: `*.<ext>` when the file name has an extension. A leading dot
 *   (`.env`) or trailing dot (`foo.`) is not an extension.
 */
export function ignorePatterns(path: string): { exact: string; extension: string | null } {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const extension =
    dot > 0 && dot < base.length - 1 ? `*.${escapeSegment(base.slice(dot + 1))}` : null;
  return { exact: '/' + path.split('/').map(escapeSegment).join('/'), extension };
}

/**
 * Backslash-escape the characters gitignore treats as pattern syntax within
 * one path segment: `\` (escaped first — the single-pass replace guarantees
 * inserted backslashes are never re-escaped), then `[`, `]`, `*`, `?`.
 */
function escapeSegment(segment: string): string {
  return segment.replace(/[\\[\]*?]/g, (c) => '\\' + c);
}
