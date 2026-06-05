import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icon';

export interface ProgressPopupProps {
  /** Verb line, e.g. "Cloning" / "Opening". */
  title: string;
  /** Repo / folder name shown next to the title. */
  subject: string;
  /** Phase text under the bar, e.g. "Receiving objects 58%". */
  detail: string;
  /** 0–100 for a determinate bar; null for an indeterminate sweep. */
  percent: number | null;
  /** Pre-formatted estimate, e.g. "~1m 12s remaining". Falls back to elapsed. */
  eta: string | null;
  /** `Date.now()` when the operation began — drives the elapsed clock. */
  startedAt: number;
  /** When set, the op failed: show this reason and a Dismiss button instead of a bar. */
  error?: string | null;
  /** Dismiss the (error) popup. */
  onDismiss?: () => void;
}

/**
 * Persistent bottom-center popup for a long-running operation (clone, opening a
 * large repo). Unlike the transient sync toast it stays mounted for the whole
 * operation — and, critically, **stays on failure** with the reason and a
 * Dismiss button, so a clone/open that dies is never silently swallowed.
 *
 * Determinate bar + ETA when the caller has a percentage (clone); indeterminate
 * sweep + elapsed time when it doesn't (opening a repo has no streamed progress).
 */
export function ProgressPopup({ title, subject, detail, percent, eta, startedAt, error, onDismiss }: ProgressPopupProps) {
  const failed = error != null;
  const dismissRef = useRef<HTMLButtonElement>(null);

  // Tick once a second so the elapsed clock advances — but only while we're
  // actually showing elapsed (no ETA, not failed); a determinate clone
  // re-renders via its own progress stream, so the timer would be pointless.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (failed || eta != null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [failed, eta]);

  // On failure, focus the Dismiss button and let Escape dismiss — the popup is
  // the only surface for the error, so it must be keyboard-operable.
  useEffect(() => {
    if (!failed) return;
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [failed, onDismiss]);

  if (failed) {
    const failTitle = title === 'Cloning' ? 'Clone failed' : title === 'Opening' ? 'Open failed' : `${title} failed`;
    return (
      <div className="op-progress op-error" role="alert">
        <div className="op-progress-head">
          <span className="op-progress-fail" aria-hidden="true"><Icon name="x" size={13} stroke={2} /></span>
          <span className="op-progress-title">{failTitle}</span>
          <span className="op-progress-subject">{subject}</span>
          <button ref={dismissRef} type="button" className="op-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
        <div className="op-progress-sub">
          <span className="detail" title={error ?? undefined}>{error}</span>
        </div>
      </div>
    );
  }

  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const indeterminate = percent == null;
  // ETA when we have one (clone), otherwise the running elapsed time (open).
  const right = eta ?? formatDuration(elapsed);

  // The visible card is presentational; a single coarse sr-only live region
  // announces the operation (not the per-tick percent/elapsed, which would
  // flood a screen reader — aria-hidden on descendants doesn't stop that).
  return (
    <div className="op-progress">
      <div className="op-progress-head" aria-hidden="true">
        <span className="op-progress-spin"><Icon name="refresh" size={13} /></span>
        <span className="op-progress-title">{title}</span>
        <span className="op-progress-subject">{subject}</span>
      </div>
      <div className="op-progress-bar" aria-hidden="true">
        <div
          className="fill"
          style={{ width: indeterminate ? '40%' : `${Math.max(2, Math.min(100, percent))}%` }}
          data-indeterminate={indeterminate ? '' : undefined}
        />
      </div>
      <div className="op-progress-sub" aria-hidden="true">
        <span className="detail">{detail}</span>
        <span className="right">{right}</span>
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {title} {subject}
      </div>
    </div>
  );
}

/** Compact duration: "5s", "1m 12s", "1h 3m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
