import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Vertical activity-timeline rail for the All Commits graph. Time runs
 * top→bottom (newest at the top, matching the list), and the y-axis is
 * **time**, not row index: each horizontal bar is an equal-width time bucket
 * whose length encodes how many commits landed in that span — so bursts of
 * activity read as long bars and quiet stretches as gaps. Doubles as a
 * scrubber: a translucent band marks the currently-visible window, and
 * click/drag seeks the list to that point in time.
 *
 * Purely a pointer affordance (like a scrollbar/minimap) — `aria-hidden`
 * because every position it reaches is also reachable by arrow-key list
 * navigation and search, so it adds nothing for a keyboard/AT user.
 */

/** Target pixel height of one bucket bar — bucket count ≈ railHeight / this. */
const BAR_H = 4;
const MIN_BUCKETS = 8;
const MAX_BUCKETS = 200;
/** Approx tooltip height — used to clamp it within the rail (it can't be
 * measured before paint, and it's a fixed two-line chip). */
const TIP_H = 34;

interface TimelineRow {
  time_unix: number;
}

interface CommitTimelineProps {
  /** Graph rows (commits + stash nodes), newest-first — the same list the
   * table renders, so row indices line up with the scroll math. */
  rows: TimelineRow[];
  /** Per-row pixel height (density-dependent). */
  rowH: number;
  /** Sticky header height above the rows (excluded from the scroll body). */
  headerPx: number;
  /** Current scroll offset of the list — drives the viewport band. */
  scrollTop: number;
  /** Visible height of the list viewport. */
  viewH: number;
  /** Scroll the list so the given row index sits near the top of the view. */
  onSeekToRow: (index: number) => void;
}

export function CommitTimeline({
  rows,
  rowH,
  headerPx,
  scrollTop,
  viewH,
  onSeekToRow,
}: CommitTimelineProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [railH, setRailH] = useState(0);
  const [railW, setRailW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setRailH(el.clientHeight);
      setRailW(el.clientWidth);
    });
    setRailH(el.clientHeight);
    setRailW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Time bounds + per-bucket counts. Recomputed only when the row set or the
  // bucket count (rail height) changes — one pass over `rows`.
  const { times, counts, maxCount, tMax, span } = useMemo(() => {
    if (rows.length === 0) {
      return { times: [] as number[], counts: [] as number[], maxCount: 0, tMax: 0, span: 1 };
    }
    let hi = -Infinity;
    let lo = Infinity;
    const ts = new Array<number>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i].time_unix;
      ts[i] = t;
      if (t > hi) hi = t;
      if (t < lo) lo = t;
    }
    const s = Math.max(1, hi - lo);
    const n = Math.max(MIN_BUCKETS, Math.min(MAX_BUCKETS, Math.round(railH / BAR_H) || MIN_BUCKETS));
    const c = new Array<number>(n).fill(0);
    for (let i = 0; i < ts.length; i++) {
      let b = Math.floor(((hi - ts[i]) / s) * n);
      if (b >= n) b = n - 1;
      else if (b < 0) b = 0;
      c[b]++;
    }
    let mc = 0;
    for (const v of c) if (v > mc) mc = v;
    return { times: ts, counts: c, maxCount: mc, tMax: hi, span: s };
  }, [rows, railH]);

  // Newest row at/below a time — the row to scroll to when seeking. Times run
  // descending (topological ≈ time desc), so a descending binary search lands
  // the first row at or older than `t`.
  const rowAtTime = useCallback(
    (t: number): number => {
      let loIdx = 0;
      let hiIdx = times.length - 1;
      let ans = times.length - 1;
      while (loIdx <= hiIdx) {
        const mid = (loIdx + hiIdx) >> 1;
        if (times[mid] <= t) {
          ans = mid;
          hiIdx = mid - 1;
        } else {
          loIdx = mid + 1;
        }
      }
      return ans;
    },
    [times],
  );

  const seek = useCallback(
    (clientY: number) => {
      const el = railRef.current;
      if (!el || times.length === 0) return;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      onSeekToRow(rowAtTime(tMax - frac * span));
    },
    [times, tMax, span, rowAtTime, onSeekToRow],
  );

  const bucketAt = useCallback(
    (clientY: number): number | null => {
      const el = railRef.current;
      if (!el || counts.length === 0) return null;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(0.999, (clientY - rect.top) / rect.height));
      return Math.min(counts.length - 1, Math.floor(frac * counts.length));
    },
    [counts.length],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      seek(e.clientY);
    },
    [seek],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      setHover(bucketAt(e.clientY));
      if (dragging) seek(e.clientY);
    },
    [dragging, seek, bucketAt],
  );
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  }, []);

  const n = counts.length;
  const slotH = n > 0 ? railH / n : 0;
  const barInset = 6; // px gap from the right edge so bars don't touch the border
  const usableW = Math.max(0, railW - barInset);

  // Bars are stable while scrolling (only the band/tip move), so memoize the
  // element array — same reference lets React skip reconciling 200 rects on
  // every scroll tick, keeping the graph's hot scroll path cheap.
  const bars = useMemo(() => {
    if (slotH <= 0) return null;
    return counts.map((c, i) => {
      if (c === 0) return null;
      const w = maxCount > 0 ? Math.max(2, (c / maxCount) * usableW) : 0;
      return (
        <rect
          key={i}
          className={i === hover ? 'tl-bar hot' : 'tl-bar'}
          x={railW - barInset - w}
          y={i * slotH}
          width={w}
          height={Math.max(1, slotH - 0.5)}
        />
      );
    });
  }, [counts, maxCount, slotH, railW, usableW, hover]);

  // Viewport band: visible row range → their times → y. Non-linear vs. scroll
  // (time axis), which is the point — it shows how much *time* the window spans.
  const band = useMemo(() => {
    if (times.length === 0 || railH === 0) return null;
    const last = times.length - 1;
    const topIdx = Math.max(0, Math.min(last, Math.floor((scrollTop - headerPx) / rowH)));
    const botIdx = Math.max(0, Math.min(last, Math.ceil((scrollTop - headerPx + viewH) / rowH) - 1));
    const yTop = ((tMax - times[topIdx]) / span) * railH;
    const yBot = ((tMax - times[botIdx]) / span) * railH;
    const top = Math.max(0, Math.min(yTop, yBot));
    const h = Math.max(3, Math.abs(yBot - yTop));
    return { top, h };
  }, [times, railH, scrollTop, headerPx, rowH, viewH, tMax, span]);

  // Date axis: evenly-spaced gridlines with date labels, so the rail reads as
  // a time axis (newest at top, older as you go down). Even pixel spacing = even
  // time spacing because the y-axis is linear time. Adjacent duplicate labels
  // (a span tighter than a day) are drawn once.
  const ticks = useMemo(() => {
    if (railH === 0 || times.length === 0 || span <= 1) return [];
    const count = Math.max(2, Math.min(10, Math.round(railH / 72)));
    const out: { y: number; label: string; show: boolean; bottom: boolean }[] = [];
    let prev = '';
    for (let i = 0; i <= count; i++) {
      const frac = i / count;
      const label = fmtDate(tMax - frac * span);
      out.push({ y: frac * railH, label, show: label !== prev, bottom: i === count });
      prev = label;
    }
    return out;
  }, [railH, times.length, span, tMax]);

  // Tooltip for the hovered bucket: its date span + commit count.
  const tip = useMemo(() => {
    if (hover === null || n === 0) return null;
    const tHi = tMax - (hover / n) * span;
    const tLo = tMax - ((hover + 1) / n) * span;
    const a = fmtDate(tLo);
    const b = fmtDate(tHi);
    const c = counts[hover];
    // Clamp vertically so the centered tooltip never spills past the rail's
    // ends — the Panel clips overflow, so an unclamped tip gets cut off under
    // the toolbar / status bar near the top and bottom.
    const half = TIP_H / 2;
    const y = Math.max(half, Math.min(railH - half, (hover + 0.5) * slotH));
    return {
      y,
      date: a === b ? b : `${a} – ${b}`,
      count: `${c} commit${c === 1 ? '' : 's'}`,
    };
  }, [hover, n, tMax, span, counts, slotH, railH]);

  return (
    <div
      ref={railRef}
      className={`graph-timeline${dragging ? ' dragging' : ''}`}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => !dragging && setHover(null)}
    >
      <svg width={railW} height={railH} preserveAspectRatio="none">
        {band && (
          <rect className="tl-band" x={0} y={band.top} width={railW} height={band.h} />
        )}
        {bars}
      </svg>
      <div className="tl-axis">
        {ticks.map((t, i) => (
          <div key={i} className={t.bottom ? 'tl-tick bottom' : 'tl-tick'} style={{ top: t.y }}>
            {t.show && <span className="tl-tick-label">{t.label}</span>}
          </div>
        ))}
      </div>
      {tip && (
        <div className="tl-tip" style={{ top: tip.y }}>
          <span className="tl-tip-date">{tip.date}</span>
          <span className="tl-tip-count">{tip.count}</span>
        </div>
      )}
    </div>
  );
}

/** Short absolute date; appends the year only when it isn't the current one. */
function fmtDate(unix: number): string {
  const d = new Date(unix * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
