import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { computeChangeMap } from '../lib/changeMap';

/**
 * Overview ruler for a single-file diff — a thin vertical strip beside the
 * scrollbar marking where the change blocks sit in the file (green added,
 * red deleted, split for mixed), plus a translucent thumb tracking the
 * visible region. Click or drag to jump.
 *
 * Positions are proportional: diff rows have uniform height, so
 * `row / totalRows` equals the scroll fraction even while the Virtualizer
 * is still measuring. The scroller is found via `hostSelector` (the same
 * document-level pattern stepChangeBlock uses) because Pierre's Virtualizer
 * owns the element and we can't ref into it.
 */
export function DiffMinimap({
  patch,
  layout,
  hostSelector,
}: {
  patch: string;
  layout: 'unified' | 'split';
  hostSelector: string;
}) {
  const model = useMemo(() => computeChangeMap(patch, layout), [patch, layout]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Visible-region thumb as fractions of the content height; null while the
  // whole diff fits on screen (a thumb would just be the full strip).
  const [view, setView] = useState<{ top: number; height: number } | null>(null);

  useEffect(() => {
    if (!model) return;
    const host = document.querySelector<HTMLElement>(hostSelector);
    if (!host) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const sh = host.scrollHeight;
      if (sh <= host.clientHeight + 1) {
        setView(null);
        return;
      }
      setView({ top: host.scrollTop / sh, height: host.clientHeight / sh });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    host.addEventListener('scroll', schedule, { passive: true });
    // The Virtualizer grows scrollHeight as it measures rows — watching its
    // content child catches that; watching the host catches pane resizes.
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    if (host.firstElementChild) ro.observe(host.firstElementChild);
    return () => {
      host.removeEventListener('scroll', schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostSelector, model]);

  const seek = useCallback(
    (clientY: number) => {
      const host = document.querySelector<HTMLElement>(hostSelector);
      const track = trackRef.current;
      if (!host || !track) return;
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      host.scrollTo({ top: frac * host.scrollHeight - host.clientHeight / 2 });
    },
    [hostSelector],
  );

  if (!model) return null;
  const { blocks, total } = model;

  return (
    <div
      ref={trackRef}
      className="diff-map"
      title="Change map — click to jump"
      aria-hidden="true"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seek(e.clientY);
      }}
    >
      {view && (
        <div
          className="dm-view"
          style={{
            top: `${view.top * 100}%`,
            height: `max(12px, ${view.height * 100}%)`,
          }}
        />
      )}
      {blocks.map((b, i) => (
        <div
          key={i}
          className={`dm-mark ${b.kind}`}
          style={{
            top: `${(b.row / total) * 100}%`,
            height: `max(2px, ${(b.rows / total) * 100}%)`,
          }}
        />
      ))}
    </div>
  );
}
