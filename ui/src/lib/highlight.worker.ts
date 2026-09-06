import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HighlightRequest, HighlightResponse, HlToken } from './highlight';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(message: HighlightResponse): void;
};
let pending: HighlightRequest | null = null;
let running = false;
const highlighter = createHighlighterCore({
  themes: [], langs: [], engine: createJavaScriptRegexEngine(),
});

scope.onmessage = ({ data }) => { pending = data; void drain(); };

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const request = pending;
      pending = null;
      let tokens: HlToken[][] | null = null;
      try {
        const hl = await highlighter;
        if (pending) continue;
        if (!hl.getLoadedThemes().includes(request.theme.name)) hl.loadThemeSync(request.theme);
        let lang = 'text';
        if (request.language) {
          if (!hl.getLoadedLanguages().includes(request.language.name)) hl.loadLanguageSync(request.language.data);
          lang = request.language.name;
        }
        tokens = hl.codeToTokens(request.code, { lang, theme: request.theme.name }).tokens
          .map((line) => line.map(({ content, color }) => ({ content, color })));
      } catch { /* Parsing failures stay plain text. */ }
      scope.postMessage({ id: request.id, tokens });
    }
  } finally {
    running = false;
  }
}
