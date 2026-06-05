import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from '../components/Icon';
import { useSettings } from '../stores/settings';

/** Result groups, in the order they render in the list and the scope row. */
export type PaletteGroup = 'Actions' | 'Branches' | 'Tags' | 'Files' | 'Commits' | 'Recent';

export interface PaletteAction {
  id: string;
  label: string;
  /** Which section the item lives under (and which scope pill selects it). */
  group: PaletteGroup;
  /** Extra search terms folded into matching but never displayed. */
  keywords?: string;
  /** Right-aligned secondary text (short SHA, status, ahead/behind). */
  meta?: string;
  /** Spoken form of `meta` for screen readers (e.g. "modified" for "M"). Falls back to `meta`. */
  metaLabel?: string;
  /** Keyboard-shortcut chip shown on the right. */
  shortcut?: string;
  /** Per-item icon override; defaults to the group icon. */
  icon?: IconName;
  run(): void;
}

const GROUP_ORDER: PaletteGroup[] = ['Actions', 'Branches', 'Tags', 'Files', 'Commits', 'Recent'];
const GROUP_ICON: Record<PaletteGroup, IconName> = {
  Actions: 'command',
  Branches: 'branch',
  Tags: 'tag',
  Files: 'file',
  Commits: 'graph',
  Recent: 'history',
};

// Caps keep the list fast on large repos — a 100k-commit / 10k-file repo must
// not render (or, for an empty query, allocate) thousands of rows.
const CAP_PER_GROUP = 6; // per group when scope = All
const CAP_SCOPED = 50; // single selected scope
// Defensive upper bound across all groups. The per-group caps already keep the
// total well under this (6 groups × 6 = 36 under "All", 50 under one scope);
// it's belt-and-suspenders against a future group being added.
const CAP_TOTAL = 80;

const LIST_ID = 'palette-listbox';
const optId = (i: number) => `palette-opt-${i}`;

interface Match {
  score: number;
  /** [start, end) ranges within `label` to highlight. Empty = matched via keywords. */
  ranges: [number, number][];
}

/** Contiguous-run subsequence match over `text`, with highlight ranges. */
function subsequence(q: string, text: string): { ranges: [number, number][]; gaps: number } | null {
  let qi = 0;
  const ranges: [number, number][] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length && qi < q.length; i++) {
    if (text[i] === q[qi]) {
      if (start === -1) {
        start = i;
        end = i + 1;
      } else if (i === end) {
        end = i + 1;
      } else {
        ranges.push([start, end]);
        start = i;
        end = i + 1;
      }
      qi++;
    }
  }
  if (qi < q.length) return null;
  if (start !== -1) ranges.push([start, end]);
  return { ranges, gaps: ranges.length - 1 };
}

/**
 * Score `label` (and fall back to `keywords`) against a lowercased query.
 * Higher is better. A contiguous substring beats a scattered subsequence,
 * an earlier match beats a later one, and a word-boundary hit gets a bonus.
 * Returns null when nothing matches.
 */
function match(q: string, label: string, keywords?: string): Match | null {
  if (!q) return { score: 0, ranges: [] };
  const lab = label.toLowerCase();

  const idx = lab.indexOf(q);
  if (idx >= 0) {
    const boundary = idx === 0 || /[^a-z0-9]/.test(lab[idx - 1]);
    return { score: 1000 - idx + (boundary ? 200 : 0), ranges: [[idx, idx + q.length]] };
  }

  const sub = subsequence(q, lab);
  if (sub) {
    return { score: 400 - (sub.ranges[0]?.[0] ?? 0) - sub.gaps * 20, ranges: sub.ranges };
  }

  // Keyword match never highlights the label (the hit is off-screen).
  if (keywords) {
    const kw = keywords.toLowerCase();
    if (kw.includes(q) || subsequence(q, kw)) return { score: 80, ranges: [] };
  }
  return null;
}

/** Render a label with its matched ranges wrapped in <span class="hl">. */
function Highlighted({ label, ranges }: { label: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{label}</>;
  const out: React.ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([s, e], k) => {
    if (s > pos) out.push(<span key={`t${k}`}>{label.slice(pos, s)}</span>);
    out.push(<span key={`h${k}`} className="hl">{label.slice(s, e)}</span>);
    pos = e;
  });
  if (pos < label.length) out.push(<span key="tail">{label.slice(pos)}</span>);
  return <>{out}</>;
}

/** Accessible name for an option: label plus the spoken form of its meta. */
function spoken(a: PaletteAction): string {
  const m = a.metaLabel ?? a.meta;
  return m ? `${a.label}, ${m}` : a.label;
}

interface Props {
  actions: PaletteAction[];
  onClose: () => void;
}

interface Scored {
  a: PaletteAction;
  m: Match;
}

export function CommandPalette({ actions, onClose }: Props) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<PaletteGroup | 'All'>('All');
  const [sel, setSel] = useState(0);
  const platform = useSettings((s) => s.platform);
  const cmdKey = platform === 'mac' ? '⌘' : 'Ctrl ';
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restore focus to whoever opened the palette when it closes — captured on
  // first render, before the input's autoFocus moves focus (matches the
  // focus-return convention the other dialogs follow).
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null) openerRef.current = document.activeElement as HTMLElement | null;
  useEffect(() => () => openerRef.current?.focus?.(), []);

  // Scope pills: "All" plus every group actually present in the candidate set,
  // in canonical order. Repo-scoped groups vanish when no repo is open.
  const scopes = useMemo<(PaletteGroup | 'All')[]>(() => {
    const present = new Set(actions.map((a) => a.group));
    return ['All', ...GROUP_ORDER.filter((g) => present.has(g))];
  }, [actions]);

  // Drop a stale scope (e.g. the Files group emptied) back to All.
  useEffect(() => {
    if (!scopes.includes(scope)) setScope('All');
  }, [scopes, scope]);

  const items = useMemo<Scored[]>(() => {
    const query = q.trim().toLowerCase();
    const empty = query === '';
    const cap = scope === 'All' ? CAP_PER_GROUP : CAP_SCOPED;

    const byGroup = new Map<PaletteGroup, Scored[]>();
    for (const a of actions) {
      if (scope !== 'All' && a.group !== scope) continue;
      // With no query under "All", only the cheap, always-relevant groups show;
      // dumping every file/commit would be noise (and slow). Type or pick a
      // scope to surface them.
      if (empty && scope === 'All' && a.group !== 'Actions' && a.group !== 'Recent') continue;
      const m = match(query, a.label, a.keywords);
      if (!m) continue;
      const arr = byGroup.get(a.group) ?? [];
      // With an empty query every entry "matches" (score 0); cap during
      // collection so a 10k-file scope doesn't allocate + sort 10k to show 50.
      // (Order is the caller's stable order, so the first `cap` are correct.)
      if (empty && arr.length >= cap) continue;
      arr.push({ a, m });
      byGroup.set(a.group, arr);
    }

    const out: Scored[] = [];
    for (const g of GROUP_ORDER) {
      const arr = byGroup.get(g);
      if (!arr) continue;
      if (!empty) arr.sort((x, y) => y.m.score - x.m.score);
      for (const e of arr.slice(0, cap)) {
        out.push(e);
        if (out.length >= CAP_TOTAL) return out;
      }
    }
    return out;
  }, [actions, q, scope]);

  // Group the flat (already capped + ordered) item list into sections, keeping
  // each item's flat index so selection + aria-activedescendant stay aligned.
  const sections = useMemo(() => {
    const secs: { group: PaletteGroup; rows: { e: Scored; idx: number }[] }[] = [];
    items.forEach((e, idx) => {
      const last = secs[secs.length - 1];
      if (last && last.group === e.a.group) last.rows.push({ e, idx });
      else secs.push({ group: e.a.group, rows: [{ e, idx }] });
    });
    return secs;
  }, [items]);

  // Reset selection whenever the visible set changes so we never point at a
  // stale index.
  useEffect(() => {
    setSel(0);
  }, [q, scope, items.length]);

  // Keep the selected row in view as the user navigates with the keyboard.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const cycleScope = (dir: 1 | -1) => {
    if (scopes.length < 2) return;
    const cur = scopes.indexOf(scope);
    const next = (cur + dir + scopes.length) % scopes.length;
    setScope(scopes[next]);
  };

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command, branch, file, or commit…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={LIST_ID}
            aria-activedescendant={items[sel] ? optId(sel) : undefined}
            aria-autocomplete="list"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(Math.max(items.length - 1, 0), s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Tab') {
                e.preventDefault();
                cycleScope(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Enter') {
                const item = items[sel];
                if (item) {
                  item.a.run();
                  onClose();
                }
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
        </div>

        {scopes.length > 1 && (
          <div className="palette-scope" role="group" aria-label="Result scope">
            {scopes.map((s) => (
              <button
                type="button"
                key={s}
                aria-pressed={scope === s}
                className={'pill' + (scope === s ? ' on' : '')}
                onClick={() => {
                  setScope(s);
                  inputRef.current?.focus();
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="palette-list" ref={listRef} role="listbox" id={LIST_ID} aria-label="Results">
          {items.length === 0 && <div className="palette-sect">No matches</div>}
          {sections.map((sec) => (
            <div role="group" aria-label={sec.group} key={sec.group}>
              <div className="palette-sect" aria-hidden="true">{sec.group}</div>
              {sec.rows.map(({ e, idx }) => (
                <div
                  role="option"
                  id={optId(idx)}
                  data-idx={idx}
                  key={e.a.id}
                  aria-selected={idx === sel}
                  aria-label={spoken(e.a)}
                  className={'palette-item' + (idx === sel ? ' active' : '')}
                  onMouseMove={() => {
                    if (idx !== sel) setSel(idx);
                  }}
                  onClick={() => {
                    e.a.run();
                    onClose();
                  }}
                >
                  <span className="ico" aria-hidden="true">
                    <Icon name={e.a.icon ?? GROUP_ICON[e.a.group]} size={14} />
                  </span>
                  <span className="label" aria-hidden="true">
                    <Highlighted label={e.a.label} ranges={e.m.ranges} />
                  </span>
                  {e.a.meta && <span className="meta" aria-hidden="true">{e.a.meta}</span>}
                  {e.a.shortcut && <span className="kbd" aria-hidden="true">{e.a.shortcut}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Announce the result count as the query changes (the rows live in a
            mouse/active-descendant list that screen readers don't auto-report). */}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {items.length === 0 ? 'No matches' : `${items.length} result${items.length === 1 ? '' : 's'}`}
        </div>

        <div className="palette-foot">
          <div className="grp"><span className="kbd">↑↓</span> navigate</div>
          <div className="grp"><span className="kbd">↵</span> run</div>
          <div className="grp"><span className="kbd">⇥</span> scope</div>
          <div className="grp"><span className="kbd">{cmdKey}K</span> toggle</div>
          <div className="grp right"><span className="kbd">esc</span> close</div>
        </div>
      </div>
    </div>
  );
}
