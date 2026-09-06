import { describe, expect, it, vi } from 'vitest';
import { RefreshQueue } from './refreshQueue';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('refresh coordination', () => {
  it('coalesces simultaneous requests before starting work', async () => {
    const queue = new RefreshQueue();
    const first = vi.fn(async () => {});
    const last = vi.fn(async () => {});
    await Promise.all([queue.run('repo/status', first), queue.run('repo/status', last)]);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledOnce();
  });

  it('rejects a superseded result and drains one trailing read after a write burst', async () => {
    const queue = new RefreshQueue();
    const gate = deferred();
    const published: number[] = [];
    const first = queue.run('repo/diff', async (current) => {
      await gate.promise;
      if (current()) published.push(1);
    });
    await Promise.resolve();
    const skipped = vi.fn(async () => {});
    const second = queue.run('repo/diff', skipped);
    const last = queue.run('repo/diff', async (current) => {
      if (current()) published.push(3);
    });
    gate.resolve();
    await Promise.all([first, second, last]);
    expect(skipped).not.toHaveBeenCalled();
    expect(published).toEqual([3]);
  });

  it('does not block other resources and recovers after failure', async () => {
    const queue = new RefreshQueue();
    const gate = deferred();
    const slow = queue.run('a', () => gate.promise);
    await expect(queue.run('b', async () => { throw new Error('disk'); })).rejects.toThrow('disk');
    await queue.run('b', async () => {});
    gate.resolve();
    await slow;
  });
});
