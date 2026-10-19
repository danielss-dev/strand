import {
  buildViews,
  type ParsedConflict,
  type Resolution,
} from './conflictParse';

export type ConflictConfidence = 'low' | 'medium' | 'high';

export interface AiHunkSuggestion {
  text: string;
  explanation: string;
  confidence: ConflictConfidence;
  /** A side or base was cut to fit the prompt; the model never saw all of it. */
  truncated?: boolean;
}

export type HunkAction =
  | { type: 'accept'; text: string }
  | { type: 'edit'; text: string }
  | { type: 'reject' };

export type ApplyHunkResult =
  | { ok: true; resolutions: Map<number, Resolution> }
  | { ok: false; reason: 'markers' };

// Exactly seven `<` or `>`, then end of line or whitespace and a label: the
// lines git writes to open and close a conflict. A lone `=======` (a Markdown
// or RST setext underline) or a longer run is ordinary text; `=======` and
// `|||||||` only mean something between those lines, which this already flags.
const MARKER = /^(<{7}|>{7})(\s|$)/;

/** True when the text still holds a conflict's opening or closing marker line. */
export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some((line) => MARKER.test(line.replace(/\r$/, '')));
}

/**
 * Apply one reviewed hunk decision. Accept and edit store replacement text.
 * Reject drops a custom resolution and leaves ours/theirs/both picks in place.
 * Neither path writes a file.
 */
export function applyHunkAction(
  resolutions: ReadonlyMap<number, Resolution>,
  index: number,
  action: HunkAction,
): ApplyHunkResult {
  switch (action.type) {
    case 'accept':
    case 'edit': {
      if (hasConflictMarkers(action.text)) return { ok: false, reason: 'markers' };
      const next = new Map(resolutions);
      next.set(index, { kind: 'custom', text: action.text });
      return { ok: true, resolutions: next };
    }
    case 'reject': {
      const next = new Map(resolutions);
      const current = next.get(index);
      if (current && typeof current !== 'string') next.delete(index);
      return { ok: true, resolutions: next };
    }
    default: {
      const _never: never = action;
      return _never;
    }
  }
}

/**
 * The text Resolve may write, or null when the file must stay untouched.
 * Ours/theirs/both picks write exactly what they did before AI suggestions;
 * only custom (AI or edited) hunk text is checked for markers.
 */
export function writableResolution(
  parsed: ParsedConflict,
  resolutions: ReadonlyMap<number, Resolution>,
): string | null {
  const views = buildViews(parsed, new Map(resolutions));
  if (views.total === 0 || views.ranges.some((range) => !range.resolved)) return null;
  for (const resolution of resolutions.values()) {
    if (typeof resolution !== 'string' && hasConflictMarkers(resolution.text)) return null;
  }
  return views.resultText;
}

/**
 * Resolve: write the merged text once through `write`, or report why not.
 * Suggest, Accept, Edit, and Reject never reach this.
 */
export async function saveResolution(
  parsed: ParsedConflict,
  resolutions: ReadonlyMap<number, Resolution>,
  write: (text: string) => Promise<void>,
): Promise<'written' | 'blocked'> {
  const text = writableResolution(parsed, resolutions);
  if (text == null) return 'blocked';
  await write(text);
  return 'written';
}

export function suggestionMatchesHunks(
  hunkCount: number,
  suggestions: readonly AiHunkSuggestion[],
): boolean {
  return hunkCount > 0 && suggestions.length === hunkCount;
}
