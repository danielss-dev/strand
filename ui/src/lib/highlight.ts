import BlameWorker from './highlight.worker?worker';
import { getFiletypeFromFileName, resolveLanguage, resolveTheme } from '@pierre/diffs';

export interface HlToken { content: string; color?: string }
export type HlTheme = 'pierre-dark' | 'pierre-light';
export interface HighlightRequest {
  id: number;
  code: string;
  theme: Awaited<ReturnType<typeof resolveTheme>>;
  language: Awaited<ReturnType<typeof resolveLanguage>> | null;
}
export interface HighlightResponse { id: number; tokens: HlToken[][] | null }

/** Bound UTF-8 bytes, lines and individual lines before transferring to a worker. */
export function canHighlight(code: string): boolean {
  if (code.length > 1_000_000) return false;
  let bytes = 0;
  let lines = 1;
  let lineLength = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (c >= 0xd800 && c <= 0xdbff && code.charCodeAt(i + 1) >= 0xdc00 && code.charCodeAt(i + 1) <= 0xdfff) {
      bytes++;
      i++;
    }
    if (c === 10) { lines++; lineLength = 0; }
    else lineLength++;
    if (bytes > 1_000_000 || lines > 12_000 || lineLength > 10_000) return false;
  }
  return true;
}

/** Owned by the mounted Blame list; grammar state stays in its lazy worker. */
export class FileHighlighter {
  private worker: Worker | null = null;
  private sequence = 0;
  private resolve: ((tokens: HlToken[][] | null) => void) | null = null;

  async tokenize(code: string, filename: string, theme: HlTheme): Promise<HlToken[][] | null> {
    this.resolve?.(null);
    this.resolve = null;
    const id = ++this.sequence;
    if (!canHighlight(code)) { this.dispose(); return Promise.resolve(null); }
    try {
      // Pierre resolves its grammar/theme registry in the window context.
      // Only tokenization belongs in the worker, as in Pierre's own pool.
      const lang = getFiletypeFromFileName(filename);
      const [resolvedTheme, language] = await Promise.all([
        resolveTheme(theme),
        lang && lang !== 'text' && lang !== 'ansi' ? resolveLanguage(lang).catch(() => null) : null,
      ]);
      if (id !== this.sequence) return null;
      if (!this.worker) {
        this.worker = new BlameWorker();
        this.worker.onmessage = ({ data }: MessageEvent<HighlightResponse>) => {
          if (data.id !== this.sequence) return;
          this.resolve?.(data.tokens);
          this.resolve = null;
        };
        this.worker.onerror = () => this.dispose();
        this.worker.onmessageerror = () => this.dispose();
      }
      return new Promise((resolve) => {
        this.resolve = resolve;
        try {
          this.worker!.postMessage({ id, code, theme: resolvedTheme, language } satisfies HighlightRequest);
        } catch { this.dispose(); }
      });
    } catch {
      if (id === this.sequence) this.dispose();
      return Promise.resolve(null);
    }
  }

  dispose(): void {
    this.sequence++;
    this.resolve?.(null);
    this.resolve = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
