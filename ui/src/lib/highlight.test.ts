import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const workers: { onmessage?: (event: { data: unknown }) => void; terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }[] = [];
  return { workers };
});
vi.mock('./highlight.worker?worker', () => ({ default: class {
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { mocks.workers.push(this); }
} }));
vi.mock('@pierre/diffs', () => ({
  getFiletypeFromFileName: () => 'typescript',
  resolveTheme: async (name: string) => ({ name }),
  resolveLanguage: async (name: string) => ({ name, data: {} }),
}));
import { canHighlight, FileHighlighter } from './highlight';

describe('Blame highlighting', () => {
  it('bounds encoded bytes, lines and very long lines', () => {
    expect(canHighlight('const x = 1;\n'.repeat(5000))).toBe(true);
    expect(canHighlight('x'.repeat(10_001))).toBe(false);
    expect(canHighlight('\n'.repeat(12_000))).toBe(false);
    expect(canHighlight(('界'.repeat(1000) + '\n').repeat(334))).toBe(false);
  });
  it('ignores obsolete worker replies and disposes outstanding work', async () => {
    const highlighter = new FileHighlighter();
    const first = highlighter.tokenize('old', 'a.ts', 'pierre-dark');
    await vi.waitFor(() => expect(mocks.workers.at(-1)?.postMessage).toHaveBeenCalledOnce());
    const worker = mocks.workers.at(-1)!;
    const oldId = worker.postMessage.mock.calls[0][0].id;
    const second = highlighter.tokenize('new', 'a.ts', 'pierre-light');
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    const newId = worker.postMessage.mock.calls[1][0].id;
    await expect(first).resolves.toBeNull();
    worker.onmessage!({ data: { id: oldId, tokens: [[{ content: 'old' }]] } });
    worker.onmessage!({ data: { id: newId, tokens: [[{ content: 'new' }]] } });
    await expect(second).resolves.toEqual([[{ content: 'new' }]]);
    const pending = highlighter.tokenize('third', 'b.ts', 'pierre-dark');
    highlighter.dispose();
    await expect(pending).resolves.toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
