/** Shared budget for advisory checkout/workspace reads, separate from foreground IPC. */
export function createReadLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(read: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await read();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

export const backgroundRead = createReadLimiter(2);
