import { expect, it } from 'vitest';
import { createReadLimiter } from './backgroundReads';

it('bounds concurrent native reads and releases capacity after failure', async () => {
  const read = createReadLimiter(2);
  let running = 0;
  let max = 0;
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => read(async () => {
    max = Math.max(max, ++running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running--;
    if (index === 0) throw new Error('missing checkout');
    return index;
  })));
  expect(max).toBe(2);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(19);
});
