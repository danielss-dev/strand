import { expect, it, vi } from 'vitest';
import type { HighlightRequest, HighlightResponse } from './highlight';

it('tokenizes resolved Pierre grammars and themes in a worker context', async () => {
  const postMessage = vi.fn<(message: HighlightResponse) => void>();
  const scope = { postMessage, onmessage: null as ((event: { data: HighlightRequest }) => void) | null };
  vi.stubGlobal('self', scope);
  // Pierre reads navigator at import time; Node 20 does not provide it.
  vi.stubGlobal('navigator', { userAgent: 'Strand test' });
  try {
    const { resolveLanguage, resolveTheme } = await import('@pierre/diffs');
    const language = await resolveLanguage('typescript');
    const theme = await resolveTheme('pierre-dark');
    await import('./highlight.worker');
    scope.onmessage!({ data: { id: 1, code: '/* multi\nline */\nexport const a = 1;', theme, language } });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const tokens = postMessage.mock.calls[0][0].tokens!;
    expect(tokens).toHaveLength(3);
    expect(tokens[1].map((token) => token.content).join('')).toBe('line */');
    expect(tokens[0][0].color).toBe(tokens[1][0].color);
    expect(new Set(tokens[2].map((token) => token.color)).size).toBeGreaterThan(1);
  } finally { vi.unstubAllGlobals(); }
});
