import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Must match the popOut* keyframe duration in styles/features.css. */
export const EXIT_MS = 180;

interface PresenceProps<T> {
  /** The live value. Non-null shows the content; null begins the exit. */
  value: T | null | undefined;
  /** Render the (last non-null) value. `exiting` is true while leaving — pass
   *  it through to add the `exiting` class that runs the reverse animation. */
  children: (value: T, exiting: boolean) => ReactNode;
  /** Exit animation length in ms. Defaults to {@link EXIT_MS}. */
  duration?: number;
}

/**
 * Keeps content mounted through an exit animation. React unmounts a
 * conditionally-rendered node instantly, so a CSS leave animation never gets a
 * chance to play. This holds the last non-null `value` mounted for `duration`
 * ms after it goes null, flagging `exiting` so the child can animate out, then
 * unmounts. Re-showing before the timer fires cancels the exit cleanly.
 *
 * Timer-based (not animationend) so it works regardless of the child's DOM
 * shape and behaves the same in WebView2 and WKWebView/WebKitGTK.
 */
export function Presence<T>({ value, children, duration = EXIT_MS }: PresenceProps<T>) {
  const [rendered, setRendered] = useState<T | null>(value ?? null);
  const [exiting, setExiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value != null) {
      // Entering or updating: cancel any pending exit and show the value.
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setRendered(value);
      setExiting(false);
    } else if (rendered != null && !exiting) {
      // Leaving: keep the last value mounted while the exit animation plays.
      setExiting(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        setExiting(false);
        setRendered(null);
      }, duration);
    }
  }, [value, rendered, exiting, duration]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (rendered == null) return null;
  return <>{children(rendered, exiting)}</>;
}
