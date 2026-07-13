/** One matching line in a read-only file (Mod+F in the Content tab). */
export interface FileSearchMatch {
  line: number;
  lineText: string;
}

export interface FileSearchResult {
  matches: FileSearchMatch[];
  /** True when at least one match past `limit` was dropped. */
  truncated: boolean;
}

/** Case-insensitive substring search over file contents, capped for UI speed. */
export function searchFileText(
  text: string,
  query: string,
  limit = 400,
): FileSearchResult {
  const q = query.trim().toLowerCase();
  const matches: FileSearchMatch[] = [];
  if (!q) return { matches, truncated: false };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(q)) continue;
    if (matches.length >= limit) return { matches, truncated: true };
    matches.push({ line: i + 1, lineText: lines[i] });
  }
  return { matches, truncated: false };
}
