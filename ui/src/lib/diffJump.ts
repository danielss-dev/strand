import { lineToRow } from './changeMap';
import type { DiffMatch } from './diffSearch';

/** A concrete line to land on inside a rendered diff. */
export interface DiffLineTarget {
  line: number;
  /** Which side `line` counts on — `'old'` for deletion-only anchors. */
  side: 'new' | 'old';
}

/** The line a ⌘F match should land on: deletions anchor on the old side,
 * additions and context on the new side. */
export function matchTarget(m: DiffMatch): DiffLineTarget | null {
  if (m.kind === 'del') return m.oldLine != null ? { line: m.oldLine, side: 'old' } : null;
  if (m.newLine != null) return { line: m.newLine, side: 'new' };
  return m.oldLine != null ? { line: m.oldLine, side: 'old' } : null;
}

/**
 * Find the rendered row for `target` in any Pierre diff under `host`.
 * Pierre's rows live in `<diffs-container>`'s shadow DOM and carry
 * `data-line` (the row's own side: new for additions/context, old for
 * deletions), `data-alt-line` (the old side, context rows only) and
 * `data-line-type`. Gutter number rows have no `data-line`, so they can't
 * false-match; in split layout both columns match and either centers fine.
 */
function findRow(host: HTMLElement, target: DiffLineTarget): HTMLElement | null {
  const sel =
    target.side === 'new'
      ? `[data-line-type="change-addition"][data-line="${target.line}"], ` +
        `[data-line-type="context"][data-line="${target.line}"]`
      : `[data-line-type="change-deletion"][data-line="${target.line}"], ` +
        `[data-line-type="context"][data-alt-line="${target.line}"]`;
  for (const dc of host.querySelectorAll('diffs-container')) {
    const row = dc.shadowRoot?.querySelector<HTMLElement>(sel);
    if (row) return row;
  }
  return null;
}

/** Tint the landed row briefly so the eye finds it. Inline style, because
 * the row sits behind a shadow boundary outer CSS can't reach — inherited
 * custom properties (`--accent`) still resolve through it. */
function flash(row: HTMLElement): void {
  row.style.transition = 'background-color 0.5s ease';
  row.style.backgroundColor = 'color-mix(in oklab, var(--accent) 28%, transparent)';
  window.setTimeout(() => {
    row.style.backgroundColor = '';
    window.setTimeout(() => {
      row.style.transition = '';
    }, 600);
  }, 900);
}

/**
 * Scroll a diff pane to a specific content line and flash it. Two phases:
 * look for the exact row in the DOM and center it; while it isn't mounted
 * (Pierre's Virtualizer windows big diffs; Local Changes bodies mount
 * viewport-lazily), scroll to the line's proportional position first —
 * {@link lineToRow} maps it into rendered-row space, so `row / total` is the
 * scroll fraction even mid-measure — and retry until the row exists to
 * center + flash it exactly. The proportional seek re-applies on every miss
 * because the Virtualizer's scrollHeight keeps growing while it measures a
 * freshly mounted file. Callers without a single-file scroller (stacked
 * multi-file panes) omit `patch`/`layout` and rely on retries alone.
 */
export function scrollToDiffLine(
  hostSelector: string,
  target: DiffLineTarget,
  opts: { patch?: string; layout?: 'unified' | 'split' } = {},
): void {
  let attempts = 0;
  const attempt = () => {
    const host = document.querySelector<HTMLElement>(hostSelector);
    if (!host) return;
    const row = findRow(host, target);
    if (row) {
      const rr = row.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      host.scrollTo({
        top: host.scrollTop + rr.top - hr.top - (host.clientHeight - rr.height) / 2,
      });
      flash(row);
      return;
    }
    if (opts.patch && opts.layout) {
      const pos = lineToRow(opts.patch, opts.layout, target.line, target.side);
      if (pos) {
        host.scrollTo({
          top: ((pos.row + 0.5) / pos.total) * host.scrollHeight - host.clientHeight / 2,
        });
      }
    }
    if (++attempts < 12) window.setTimeout(attempt, 120);
  };
  // First attempt only after the next frame: a jump that swaps the selected
  // file must not probe the OLD file's still-mounted rows (same line number,
  // wrong file). By the frame after the event handler, React has committed.
  requestAnimationFrame(attempt);
}
