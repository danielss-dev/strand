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
