import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferedWrites } from './bufferedWrites';

afterEach(() => vi.useRealTimers());

describe('buffered persistence', () => {
  it('serializes only the newest streaming value per time window', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const queue = new BufferedWrites(write);
    for (let i = 0; i < 100; i++) queue.schedule('thread', { text: String(i) });
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('thread', { text: '99' });
  });

  it('orders final state after a slow write and allows other scopes through', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saved: string[] = [];
    const queue = new BufferedWrites(async (_key, value) => {
      if (value === 'first') await gate;
      saved.push(String(value));
    });
    queue.schedule('a', 'first');
    const first = queue.flush('a');
    queue.schedule('a', 'intermediate');
    queue.schedule('a', 'final');
    const final = queue.flush('a');
    queue.schedule('b', 'independent');
    await queue.flush('b');
    expect(saved).toEqual(['independent']);
    release();
    await Promise.all([first, final]);
    expect(saved).toEqual(['independent', 'first', 'final']);
  });

  it('retains the latest state after a write failure for an explicit retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
    const queue = new BufferedWrites(write);
    queue.schedule('a', 'final');
    await expect(queue.flush('a')).rejects.toThrow('disk');
    await queue.flush('a');
    expect(write).toHaveBeenLastCalledWith('a', 'final');
  });
});
