import { describe, expect, it, vi } from 'vitest';

import { runExclusive } from './runExclusive';

describe('runExclusive', () => {
  it('drops a call made while one is in flight and accepts the next one after', async () => {
    const flag = { current: false };
    let finish = () => {};
    const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));

    const first = runExclusive(flag, work);
    await runExclusive(flag, work);
    expect(work).toHaveBeenCalledOnce();

    finish();
    await first;
    expect(flag.current).toBe(false);
    const third = runExclusive(flag, work);
    finish();
    await third;
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('releases the flag when the work throws', async () => {
    const flag = { current: false };
    await expect(runExclusive(flag, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(flag.current).toBe(false);
  });
});
