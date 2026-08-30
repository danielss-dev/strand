export type HeroiComposerSuggestion =
  | { kind: 'file'; value: string; detail: string }
  | { kind: 'skill'; value: string; detail: string };

export interface HeroiComposerTrigger {
  start: number;
  end: number;
  marker: '@' | '/';
  query: string;
}

export function composerTrigger(text: string, cursor: number): HeroiComposerTrigger | null {
  const before = text.slice(0, cursor);
  const match = /(^|\s)([@/])(\S*)$/.exec(before);
  if (!match) return null;
  const marker = match[2] as '@' | '/';
  if (marker === '/' && match[3].includes('/')) return null;
  return {
    start: cursor - marker.length - match[3].length,
    end: cursor,
    marker,
    query: match[3].toLowerCase(),
  };
}

export function replaceComposerTrigger(
  text: string,
  trigger: HeroiComposerTrigger,
  suggestion: HeroiComposerSuggestion,
): { text: string; cursor: number } {
  const replacement = suggestion.kind === 'file'
    ? `@${quoteMentionPath(suggestion.value)} `
    : `$${suggestion.value} `;
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, cursor: trigger.start + replacement.length };
}

export function appendFileMentions(text: string, paths: readonly string[]): string {
  const mentions = paths.map((path) => `@${quoteMentionPath(path.replace(/\\/g, '/'))}`);
  if (mentions.length === 0) return text;
  return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${mentions.join(' ')} `;
}

function quoteMentionPath(path: string): string {
  return /\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

export function filterSuggestions(
  suggestions: readonly HeroiComposerSuggestion[],
  query: string,
  limit = 12,
): HeroiComposerSuggestion[] {
  const normalized = query.toLowerCase();
  return suggestions
    .filter((entry) => !normalized || entry.value.toLowerCase().includes(normalized))
    .sort((a, b) => {
      const av = a.value.toLowerCase();
      const bv = b.value.toLowerCase();
      const ap = av.startsWith(normalized) ? 0 : 1;
      const bp = bv.startsWith(normalized) ? 0 : 1;
      return ap - bp || av.length - bv.length || av.localeCompare(bv);
    })
    .slice(0, limit);
}
