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
}

export type HunkAction =
  | { type: 'accept'; text: string }
  | { type: 'edit'; text: string }
  | { type: 'reject' };

export type ApplyHunkResult =
  | { ok: true; resolutions: Map<number, Resolution> }
  | { ok: false; reason: 'markers' };

const MARKER = /^(<{7}|\|{7}|={7}|>{7})/;

/** True when a line would still be a conflict marker after a write. */
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

/** The text Resolve may write, or null when the file must stay untouched. */
export function writableResolution(
  parsed: ParsedConflict,
  resolutions: ReadonlyMap<number, Resolution>,
): string | null {
  const views = buildViews(parsed, new Map(resolutions));
  if (views.total === 0 || views.ranges.some((range) => !range.resolved)) return null;
  if (hasConflictMarkers(views.resultText)) return null;
  return views.resultText;
}

export function suggestionMatchesHunks(
  hunkCount: number,
  suggestions: readonly AiHunkSuggestion[],
): boolean {
  return hunkCount > 0 && suggestions.length === hunkCount;
}
