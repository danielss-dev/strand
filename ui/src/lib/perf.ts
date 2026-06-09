/**
 * Lightweight webview-side performance instrumentation for the PRD §8
 * targets that can't be measured from the Rust engine (cold start, refresh
 * latency as the user perceives it).
 *
 * Off in production unless the user opts in by setting
 * `localStorage['strand:perf'] = '1'` — measurements land in the console and
 * the Performance timeline (`performance.measure`), nothing leaves the app.
 */

const enabled: boolean =
  import.meta.env.DEV ||
  (typeof localStorage !== 'undefined' && localStorage.getItem('strand:perf') === '1');

export function perfEnabled(): boolean {
  return enabled;
}

/** Time an async operation; logs + records a `performance.measure`. */
export async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!enabled) return run();
  const start = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - start;
    try {
      performance.measure(`strand:${label}`, { start, duration: ms });
    } catch {
      // measure() with options is unsupported in some webviews — logging suffices.
    }
    console.debug(`[perf] ${label}: ${ms.toFixed(1)}ms`);
  }
}

let coldStartLogged = false;

/**
 * Call when the first repo snapshot lands — `performance.now()` is ms since
 * webview start, which approximates the PRD's "splash → interactive".
 */
export function logColdStart(): void {
  if (!enabled || coldStartLogged) return;
  coldStartLogged = true;
  console.info(`[perf] cold start → first snapshot: ${performance.now().toFixed(0)}ms`);
}
