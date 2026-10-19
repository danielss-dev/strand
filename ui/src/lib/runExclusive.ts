/**
 * Run `work` unless an earlier call sharing `flag` is still in flight; a call
 * made meanwhile is dropped, not queued. `flag` is typically a React ref.
 */
export async function runExclusive(flag: { current: boolean }, work: () => Promise<void>): Promise<void> {
  if (flag.current) return;
  flag.current = true;
  try {
    await work();
  } finally {
    flag.current = false;
  }
}
