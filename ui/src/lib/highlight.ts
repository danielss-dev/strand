/**
 * Tokenizer for the Blame view's code column — reuses **Pierre's own
 * highlighter and themes** so blame is colored identically to the Content tab
 * (which renders through Pierre's `<File>`). `getSharedHighlighter` returns the
 * same Shiki instance Pierre uses, and `getFiletypeFromFileName` is the same
 * language detection, so the tokens match what Content shows. Anything that
 * fails degrades to plain text (`null`).
 */
import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs';

/** One highlighted token — the subset of Shiki's `ThemedToken` we render. */
export interface HlToken {
  content: string;
  color?: string;
}

function mergeSegments(segments: HlToken[]): HlToken[] {
  const merged: HlToken[] = [];
  for (const segment of segments) {
    if (!segment.content) continue;
    const previous = merged.at(-1);
    if (previous && previous.color === segment.color) previous.content += segment.content;
    else merged.push({ ...segment });
  }
  return merged;
}

function flattenTokens(tokens: HlToken[][], source: string): HlToken[] {
  const segments: HlToken[] = [];
  const lineBreaks = source.match(/\r\n|\r|\n/g) ?? [];
  tokens.forEach((line, lineIndex) => {
    segments.push(...line);
    if (lineIndex < tokens.length - 1) {
      segments.push({ content: lineBreaks[lineIndex] ?? '\n' });
    }
  });
  return mergeSegments(segments);
}

function sliceSegments(segments: HlToken[], start: number, end: number): HlToken[] {
  if (start >= end) return [];
  const sliced: HlToken[] = [];
  let offset = 0;
  for (const segment of segments) {
    const segmentEnd = offset + segment.content.length;
    if (segmentEnd > start && offset < end) {
      sliced.push({
        content: segment.content.slice(Math.max(0, start - offset), Math.min(segment.content.length, end - offset)),
        color: segment.color,
      });
    }
    offset = segmentEnd;
    if (offset >= end) break;
  }
  return sliced;
}

function colorAt(segments: HlToken[], offset: number): string | undefined {
  let cursor = 0;
  for (const segment of segments) {
    cursor += segment.content.length;
    if (offset < cursor) return segment.color;
  }
  return segments.at(-1)?.color;
}

/**
 * Keep the last Shiki colors attached to unchanged text while a newly edited
 * buffer is being tokenized. The changed slice borrows its nearest token color
 * until the authoritative token pass arrives. This guarantees that typing
 * never swaps the whole editor to a plain-text frame.
 */
export function projectTokenColors(
  source: string,
  target: string,
  tokens: HlToken[][],
): HlToken[] {
  const segments = flattenTokens(tokens, source);
  if (segments.map((segment) => segment.content).join('') !== source) {
    return [{ content: target }];
  }
  if (source === target) return segments;

  let prefix = 0;
  const sharedLength = Math.min(source.length, target.length);
  while (prefix < sharedLength && source.charCodeAt(prefix) === target.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  while (
    suffix < source.length - prefix
    && suffix < target.length - prefix
    && source.charCodeAt(source.length - suffix - 1) === target.charCodeAt(target.length - suffix - 1)
  ) suffix++;

  const changed = target.slice(prefix, target.length - suffix);
  const changedColor = colorAt(
    segments,
    Math.min(prefix, Math.max(0, source.length - 1)),
  );
  return mergeSegments([
    ...sliceSegments(segments, 0, prefix),
    { content: changed, color: changedColor },
    ...sliceSegments(segments, source.length - suffix, source.length),
  ]);
}

/** Pierre theme names, matched to the app's resolved light/dark theme — the
 *  same values the Content tab / diffs pass to Pierre. */
export type HlTheme = 'pierre-dark' | 'pierre-light';

/** Don't tokenize files larger than this many lines — Shiki tokenizes the whole
 *  buffer at once, which gets expensive, and blame is capped at 50k anyway. */
const MAX_HL_LINES = 12_000;

/**
 * Tokenize `code` for `filename` under `theme`, returning one token array per
 * line (aligned 1:1 with the lines of `code`), or `null` to fall back to plain
 * text (too large, or any error).
 */
export async function tokenizeFile(
  code: string,
  filename: string,
  theme: HlTheme,
): Promise<HlToken[][] | null> {
  // Cheap line count without allocating a split array.
  let lineCount = 1;
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineCount++;
  if (lineCount > MAX_HL_LINES) return null;

  try {
    const lang = getFiletypeFromFileName(filename);
    const langs = lang && lang !== 'text' ? [lang] : [];
    // The shared highlighter Pierre uses — already has the file's language +
    // pierre theme loaded once the Content tab (or any diff) has rendered.
    const hl = await getSharedHighlighter({ themes: [theme], langs });
    if (!hl.getLoadedThemes().includes(theme)) await hl.loadTheme(theme);
    let useLang = 'text';
    if (lang && lang !== 'text') {
      if (!hl.getLoadedLanguages().includes(lang)) {
        try { await hl.loadLanguage(lang); } catch { /* unknown grammar */ }
      }
      if (hl.getLoadedLanguages().includes(lang)) useLang = lang;
    }
    return hl.codeToTokens(code, { lang: useLang, theme }).tokens;
  } catch {
    return null;
  }
}
