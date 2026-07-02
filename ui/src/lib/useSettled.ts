import { useEffect, useRef, useState } from 'react';

/**
 * Follow `value`, but while it changes in rapid succession (held-down j/k)
 * wait for a pause before swapping. The first change after an idle stretch
 * applies immediately, so a single step still feels instant; only scrubbing
 * defers, and the intermediate values are never rendered at all.
 *
 * Shared by the Review and Workspace Review diff panes — both render
 * whole-file patches, which are too heavy to mount per keystroke.
 */
export function useSettled<T>(value: T, delay = 120, idleGap = 250): T {
  const [settled, setSettled] = useState(value);
  const lastSwap = useRef(0);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const now = performance.now();
    if (now - lastSwap.current > idleGap) {
      lastSwap.current = now;
      setSettled(value);
      return;
    }
    const t = window.setTimeout(() => {
      lastSwap.current = performance.now();
      setSettled(value);
    }, delay);
    return () => window.clearTimeout(t);
  }, [value, settled, delay, idleGap]);
  return settled;
}
