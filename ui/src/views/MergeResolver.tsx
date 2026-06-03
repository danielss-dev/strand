import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { File as PierreFile } from '@pierre/diffs/react';

import { Icon } from '../components/Icon';
import { tauri } from '../lib/tauri';
import { useRepo } from '../stores/repo';
import { useSettings } from '../stores/settings';
import {
  buildViews,
  conflictAtLine,
  parseConflicts,
  toLineRange,
  type Resolution,
} from '../lib/conflictParse';

/**
 * Full-screen three-way merge resolver (Sublime/Fork style): incoming
 * ("theirs") and current ("ours") on top, the assembled result below. The user
 * walks conflicts with the ‹ › nav (or clicks a side's highlighted block) and
 * accepts theirs / ours / both per conflict; the result is built from those
 * picks (pick-sides only — no free editing). Resolve writes the merged file and
 * stages it via `useRepo.resolveConflict`.
 */
export function MergeResolver({ path, onClose }: { path: string; onClose: () => void }) {
  const activePath = useRepo((s) => s.activePath);
  const oursBranch = useRepo((s) => s.meta?.branch ?? 'HEAD');
  const resolveConflict = useRepo((s) => s.resolveConflict);
  const pierreTheme = useSettings((s) => s.resolvedTheme) === 'light' ? 'pierre-light' : 'pierre-dark';

  const [raw, setRaw] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Map<number, Resolution>>(() => new Map());
  const [focused, setFocused] = useState(0);
  const [busy, setBusy] = useState(false);

  // Load the raw conflicted file once per file/repo.
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    setRaw(null);
    setLoadError(null);
    setResolutions(new Map());
    setFocused(0);
    tauri
      .repoReadConflictFile(activePath, path)
      .then((c) => { if (!cancelled) setRaw(c); })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [activePath, path]);

  const parsed = useMemo(() => (raw != null ? parseConflicts(raw) : null), [raw]);
  const views = useMemo(
    () => (parsed ? buildViews(parsed, resolutions) : null),
    [parsed, resolutions],
  );

  const total = views?.total ?? 0;
  const resolvedCount = views ? views.ranges.filter((r) => r.resolved).length : 0;
  const allResolved = total > 0 && resolvedCount === total;
  const focusedRange = views?.ranges[focused];

  // Accept a side for a conflict, then jump to the next still-unresolved one.
  // Advancement happens here (not in an effect) so manually navigating onto an
  // already-resolved conflict doesn't spring focus away — you can review picks.
  const pick = useCallback(
    (index: number, res: Resolution) => {
      setResolutions((prev) => new Map(prev).set(index, res));
      if (total > 0) {
        const stillOpen = (j: number) => j !== index && !resolutions.has(j);
        let nextFocus = index;
        for (let k = 1; k <= total; k++) {
          const j = (index + k) % total;
          if (stillOpen(j)) { nextFocus = j; break; }
        }
        setFocused(nextFocus);
      }
    },
    [resolutions, total],
  );

  const step = useCallback(
    (delta: number) => {
      if (total === 0) return;
      setFocused((f) => (f + delta + total) % total);
    },
    [total],
  );

  // Per-side "take all" state, derived from the resolutions: a side is "all
  // taken" when every conflict's resolution includes it (`both` includes both).
  const ranges = views?.ranges ?? [];
  const theirsAll = total > 0 && ranges.every((r) => {
    const x = resolutions.get(r.index);
    return x === 'theirs' || x === 'both';
  });
  const oursAll = total > 0 && ranges.every((r) => {
    const x = resolutions.get(r.index);
    return x === 'ours' || x === 'both';
  });

  // Toggle "take every conflict from this side": recompute from the resulting
  // (theirs, ours) flags — both → 'both', one → that side, neither → clear.
  const toggleSide = useCallback(
    (side: 'theirs' | 'ours') => {
      const t = side === 'theirs' ? !theirsAll : theirsAll;
      const o = side === 'ours' ? !oursAll : oursAll;
      const res: Resolution | null = t && o ? 'both' : t ? 'theirs' : o ? 'ours' : null;
      setResolutions(() => {
        const m = new Map<number, Resolution>();
        if (res) for (const r of ranges) m.set(r.index, res);
        return m;
      });
    },
    [theirsAll, oursAll, ranges],
  );

  // Scroll-sync the two source panes so theirs/ours stay aligned.
  const theirsScroll = useRef<HTMLDivElement>(null);
  const oursScroll = useRef<HTMLDivElement>(null);
  const resultScroll = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const syncScroll = (from: typeof theirsScroll, to: typeof oursScroll) => () => {
    if (syncing.current || !from.current || !to.current) return;
    syncing.current = true;
    to.current.scrollTop = from.current.scrollTop;
    to.current.scrollLeft = from.current.scrollLeft;
    requestAnimationFrame(() => { syncing.current = false; });
  };

  // Esc cancels; ‹ › / [ ] step conflicts when no text field is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { onClose(); return; }
      if (e.key === '[' || e.key === 'ArrowLeft') step(-1);
      else if (e.key === ']' || e.key === 'ArrowRight') step(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose, step]);

  async function save() {
    if (!views || !allResolved || busy) return;
    setBusy(true);
    try {
      await resolveConflict(path, views.resultText);
      onClose();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fileOpts = (
    side: 'theirs' | 'ours' | 'result',
    onPick?: (index: number) => void,
  ) => ({
    theme: pierreTheme,
    disableBackground: true,
    disableFileHeader: true,
    onLineClick: (p: { lineNumber: number }) => {
      if (!views) return;
      const idx = conflictAtLine(views.ranges, side, p.lineNumber);
      if (idx < 0) return;
      setFocused(idx);
      onPick?.(idx);
    },
  });

  return (
    <div className="merge-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="merge-modal" role="dialog" aria-modal="true" aria-label={`Resolve conflicts in ${path}`}>
        <div className="mm-header">
          <span className="mm-title"><Icon name="branch" size={14} /> Merge</span>
          <span className="mm-file"><Icon name="file" size={13} /> {path}</span>
          <div className="mm-cards">
            <SideHeaderCard
              label={parsed?.theirsLabel ?? 'incoming'}
              role="incoming"
              checked={theirsAll}
              onToggle={() => toggleSide('theirs')}
            />
            <SideHeaderCard
              label={oursBranch}
              role="current"
              checked={oursAll}
              onToggle={() => toggleSide('ours')}
            />
          </div>
          <div className="mm-counter">
            <span className={'mm-count' + (allResolved ? ' done' : resolvedCount === 0 ? ' none' : '')}>
              {resolvedCount}/{total || 0}
            </span>
            <button type="button" className="icon-btn" onClick={() => step(-1)} disabled={total === 0} aria-label="Previous conflict" title="Previous conflict (‹ / [)">
              <Icon name="chev-up" size={13} />
            </button>
            <button type="button" className="icon-btn" onClick={() => step(1)} disabled={total === 0} aria-label="Next conflict" title="Next conflict (› / ])">
              <Icon name="chev-down" size={13} />
            </button>
          </div>
        </div>

        {loadError ? (
          <div className="mm-error">{loadError}</div>
        ) : !views ? (
          <div className="mm-loading">Loading conflicted file…</div>
        ) : total === 0 ? (
          <div className="mm-loading">No conflict markers found — nothing to resolve.</div>
        ) : (
          <>
            <div className="mm-sides">
              <section className="mm-pane">
                <div className="mm-pane-scroll" ref={theirsScroll} onScroll={syncScroll(theirsScroll, oursScroll)}>
                  <PierreFile
                    file={{ name: path, contents: views.theirsText }}
                    selectedLines={focusedRange ? toLineRange(focusedRange.theirs) : null}
                    options={fileOpts('theirs', (i) => pick(i, 'theirs'))}
                  />
                  <HighlightLayer scrollRef={theirsScroll} ranges={views.ranges} side="theirs" focusedIndex={focused} />
                </div>
              </section>
              <section className="mm-pane">
                <div className="mm-pane-scroll" ref={oursScroll} onScroll={syncScroll(oursScroll, theirsScroll)}>
                  <PierreFile
                    file={{ name: path, contents: views.oursText }}
                    selectedLines={focusedRange ? toLineRange(focusedRange.ours) : null}
                    options={fileOpts('ours', (i) => pick(i, 'ours'))}
                  />
                  <HighlightLayer scrollRef={oursScroll} ranges={views.ranges} side="ours" focusedIndex={focused} />
                </div>
              </section>
            </div>

            <div className="mm-actions">
              <span className="mm-actions-label">
                Conflict {focused + 1} of {total}
                {focusedRange?.resolved ? ' · resolved' : ''}
              </span>
              <div className="mm-actions-btns">
                <button type="button" className="btn" onClick={() => pick(focused, 'theirs')}>Take theirs</button>
                <button type="button" className="btn" onClick={() => pick(focused, 'both')}>Take both</button>
                <button type="button" className="btn" onClick={() => pick(focused, 'ours')}>Take ours</button>
              </div>
            </div>

            <section className="mm-result">
              <header className="mm-pane-head result">
                <Icon name="changes" size={12} /> Result
                <span className="mm-side-tag">{path}</span>
              </header>
              <div className="mm-pane-scroll" ref={resultScroll}>
                <PierreFile
                  file={{ name: path, contents: views.resultText }}
                  selectedLines={focusedRange ? toLineRange(focusedRange.result) : null}
                  options={fileOpts('result')}
                />
                <HighlightLayer scrollRef={resultScroll} ranges={views.ranges} side="result" focusedIndex={focused} />
              </div>
            </section>
          </>
        )}

        <div className="mm-footer">
          <span className="mm-status">
            {total > 0 ? `${resolvedCount} of ${total} resolved` : ''}
          </span>
          <div className="mm-footer-btns">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="btn primary"
              disabled={!allResolved || busy}
              onClick={() => void save()}
              title={allResolved ? 'Write the merged file and stage it' : 'Resolve every conflict first'}
            >
              {busy ? 'Resolving…' : 'Resolve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Branch card in the modal header with a "take every conflict from this side"
 *  checkbox. */
function SideHeaderCard({
  label,
  role,
  checked,
  onToggle,
}: {
  label: string;
  role: 'incoming' | 'current';
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={'mm-card' + (checked ? ' on' : '')}>
      <button
        type="button"
        className={'mm-card-check' + (checked ? ' on' : '')}
        onClick={onToggle}
        aria-pressed={checked}
        title={`Take all conflicts from ${label}`}
      >
        {checked ? <Icon name="check" size={11} stroke={2.4} /> : null}
      </button>
      <span className="mm-card-text">
        <span className="mm-card-branch"><Icon name="branch" size={12} /> {label}</span>
        <span className="mm-card-role">{role}</span>
      </span>
    </div>
  );
}

interface Band {
  index: number;
  top: number;
  height: number;
  resolved: boolean;
}

/**
 * Overlay that highlights *every* conflict region in a pane (the focused one is
 * already drawn by Pierre's `selectedLines`, so we skip it here). Pierre's
 * `<File>` has no multi-line highlight prop, so we measure the rendered gutter
 * rows — each carries a 0-based `data-line-index` — and paint a translucent
 * band over each non-focused conflict's line span. Re-measures on content
 * resize (async highlight), scroll (virtualization), and window resize; best
 * effort — if the rows can't be read it simply draws nothing.
 */
function HighlightLayer({
  scrollRef,
  ranges,
  side,
  focusedIndex,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  ranges: { index: number; theirs: [number, number]; ours: [number, number]; result: [number, number]; resolved: boolean }[];
  side: 'theirs' | 'ours' | 'result';
  focusedIndex: number;
}) {
  const [bands, setBands] = useState<Band[]>([]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      // Pierre renders into an open shadow root on its `diffs-container`
      // element, so the gutter rows aren't in the light DOM — reach into the
      // shadow root (falling back to light DOM just in case).
      const host = el.querySelector('diffs-container');
      const root: ParentNode = host?.shadowRoot ?? el;
      const rows = root.querySelectorAll<HTMLElement>('[data-line-index]');
      if (rows.length === 0) { setBands([]); return; }
      const boxTop = el.getBoundingClientRect().top;
      const scrollTop = el.scrollTop;
      const byIndex = new Map<number, { top: number; bottom: number }>();
      rows.forEach((node) => {
        const li = Number(node.getAttribute('data-line-index'));
        if (Number.isNaN(li)) return;
        const r = node.getBoundingClientRect();
        byIndex.set(li, { top: r.top - boxTop + scrollTop, bottom: r.bottom - boxTop + scrollTop });
      });
      const next: Band[] = [];
      for (const range of ranges) {
        if (range.index === focusedIndex) continue; // focused = Pierre selectedLines
        const [s, e] = range[side];
        let top = Infinity;
        let bottom = -Infinity;
        for (let li = s; li < e; li++) {
          const m = byIndex.get(li);
          if (m) { top = Math.min(top, m.top); bottom = Math.max(bottom, m.bottom); }
        }
        if (bottom > top) next.push({ index: range.index, top, height: bottom - top, resolved: range.resolved });
      }
      setBands(next);
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [scrollRef, ranges, side, focusedIndex]);

  return (
    <div className="mm-bands" aria-hidden>
      {bands.map((b) => (
        <div
          key={b.index}
          className={`mm-band ${side}` + (b.resolved ? ' resolved' : '')}
          style={{ top: b.top, height: b.height }}
        />
      ))}
    </div>
  );
}
