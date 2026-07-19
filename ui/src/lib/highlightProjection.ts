import type { HlToken } from './highlight';

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
