import { useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { match } from '../lib/fuzzy';
import { groupColor, groupTabs } from '../lib/repoIdentity';
import { useRepo } from '../stores/repo';
import { useRepoIcons } from '../stores/repoIcons';

interface Props {
  /** Open a recent (not-currently-open) repository by path. */
  onOpenRecent: (path: string) => void;
  onClose: () => void;
}

/** A switchable row: an already-open repo (switch the active tab) or a recent
 *  one not currently open (open it). */
interface Entry {
  kind: 'open' | 'recent';
  path: string;
  /** Display name (a worktree shows its branch). */
  label: string;
  /** Right-aligned secondary text — branch for open repos, path for recents. */
  meta: string;
  /** Folded into fuzzy matching but not shown. */
  keywords: string;
  /** Dot color (open repos only). */
  color?: string;
  worktree?: boolean;
  active?: boolean;
}

const LIST_ID = 'repo-switcher-listbox';
const optId = (i: number) => `repo-switcher-opt-${i}`;
/** Recents shown with no query — querying lifts the cap. */
const RECENT_CAP = 8;

/** Wrap matched ranges in `<span class="hl">` (mirrors the palette). */
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

/**
 * Repo quick-switcher (⌘/Ctrl+E) — a focused, repo-only sibling of the command
 * palette. Fuzzy-search every open repository (switch the active tab) plus any
 * recent one not currently open (opens it). ⌘K stays the full palette; this
 * overlay reuses the palette's chrome and keyboard model but lists nothing but
 * repositories.
 */
export function RepoSwitcher({ onOpenRecent, onClose }: Props) {
  const tabs = useRepo((s) => s.tabs);
  const activeTabPath = useRepo((s) => s.activeTabPath);
  const setActiveTab = useRepo((s) => s.setActiveTab);
  const recents = useRepo((s) => s.recents);
  const icons = useRepoIcons((s) => s.icons);
  const ensure = useRepoIcons((s) => s.ensure);

  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pull saved icons so open-repo dots match the tab strip / rail.
  useEffect(() => {
    for (const t of tabs) ensure(t.path);
  }, [tabs, ensure]);

  // Restore focus to the opener on close (matches the palette/dialog convention).
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null) openerRef.current = document.activeElement as HTMLElement | null;
  useEffect(() => () => openerRef.current?.focus?.(), []);

  // Every open repo + every recent not already open, as switchable entries.
  const entries = useMemo<Entry[]>(() => {
    const ordered = groupTabs(tabs);

    // Dot color per group: the group's main tab's custom color, else a stable
    // hashed hue (same rule as the tab strip).
    const colorByDir = new Map<string, string>();
    for (const t of ordered) {
      if (colorByDir.has(t.meta.common_dir)) continue;
      const main = ordered.find(
        (x) => x.meta.common_dir === t.meta.common_dir && !x.meta.is_linked_worktree,
      );
      const custom = main ? icons[main.path]?.color : undefined;
      colorByDir.set(t.meta.common_dir, custom || groupColor(t.meta.common_dir));
    }

    const open: Entry[] = ordered.map((t) => {
      const linked = t.meta.is_linked_worktree;
      return {
        kind: 'open',
        path: t.path,
        label: linked ? (t.meta.branch || t.meta.name) : t.meta.name,
        meta: linked ? `worktree · ${t.meta.branch}` : t.meta.branch,
        keywords: `${t.meta.name} ${t.meta.branch} ${t.path}`,
        color: colorByDir.get(t.meta.common_dir),
        worktree: linked,
        active: t.path === activeTabPath,
      };
    });

    const openPaths = new Set(tabs.map((t) => t.path));
    const recent: Entry[] = recents
      .filter((r) => !openPaths.has(r.path))
      .map((r) => ({
        kind: 'recent',
        path: r.path,
        label: r.name,
        meta: r.path,
        keywords: r.path,
      }));

    return [...open, ...recent];
  }, [tabs, activeTabPath, recents, icons]);

  // Fuzzy-filter + sort, keeping open repos ahead of recents on ties. With no
  // query, recents are capped (open repos always all show).
  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const scored: { e: Entry; ranges: [number, number][]; score: number }[] = [];
    let recentShown = 0;
    for (const e of entries) {
      const m = match(query, e.label, e.keywords);
      if (!m) continue;
      if (!query && e.kind === 'recent') {
        if (recentShown >= RECENT_CAP) continue;
        recentShown++;
      }
      scored.push({ e, ranges: m.ranges, score: m.score });
    }
    if (query) {
      // Stable sort by score, open repos winning ties (kind rank 0 vs 1).
      scored.sort((a, b) => b.score - a.score
        || (a.e.kind === b.e.kind ? 0 : a.e.kind === 'open' ? -1 : 1));
    }
    return scored;
  }, [entries, q]);

  // Group the flat list into Open / Recent sections, preserving each item's
  // flat index so selection + aria-activedescendant stay aligned.
  const sections = useMemo(() => {
    const secs: { kind: 'open' | 'recent'; rows: { e: Entry; ranges: [number, number][]; idx: number }[] }[] = [];
    items.forEach(({ e, ranges }, idx) => {
      const last = secs[secs.length - 1];
      if (last && last.kind === e.kind) last.rows.push({ e, ranges, idx });
      else secs.push({ kind: e.kind, rows: [{ e, ranges, idx }] });
    });
    return secs;
  }, [items]);

  // Reset selection when the visible set changes.
  useEffect(() => { setSel(0); }, [q, items.length]);

  // Keep the selected row in view during keyboard nav.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (e: Entry) => {
    if (e.kind === 'open') void setActiveTab(e.path);
    else onOpenRecent(e.path);
    onClose();
  };

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="palette repo-switcher" role="dialog" aria-modal="true" aria-label="Switch repository">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Switch to a repository…"
            aria-label="Switch repository"
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
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const item = items[sel];
                if (item) run(item.e);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>

        <div className="palette-list" ref={listRef} role="listbox" id={LIST_ID} aria-label="Repositories">
          {items.length === 0 && (
            <div className="palette-sect">
              {entries.length === 0 ? 'No repositories yet' : 'No matches'}
            </div>
          )}
          {sections.map((sec) => (
            <div role="group" aria-label={sec.kind === 'open' ? 'Open' : 'Recent'} key={sec.kind}>
              <div className="palette-sect" aria-hidden="true">{sec.kind === 'open' ? 'Open' : 'Recent'}</div>
              {sec.rows.map(({ e, ranges, idx }) => (
                <div
                  role="option"
                  id={optId(idx)}
                  data-idx={idx}
                  key={e.path}
                  aria-selected={idx === sel}
                  aria-label={e.meta ? `${e.label}, ${e.active ? 'active, ' : ''}${e.meta}` : e.label}
                  className={'palette-item' + (idx === sel ? ' active' : '')}
                  onMouseMove={() => { if (idx !== sel) setSel(idx); }}
                  onClick={() => run(e)}
                >
                  <span className="ico" aria-hidden="true">
                    {e.kind === 'recent' ? (
                      <Icon name="history" size={14} />
                    ) : e.worktree ? (
                      <Icon name="worktree" size={13} />
                    ) : (
                      <span className="repo-menu-dot" style={{ background: e.color }} />
                    )}
                  </span>
                  <span className="label" aria-hidden="true">
                    <Highlighted label={e.label} ranges={ranges} />
                  </span>
                  {e.active && <span className="meta active" aria-hidden="true"><Icon name="check" size={12} stroke={2.2} /></span>}
                  {!e.active && e.meta && <span className="meta" aria-hidden="true">{e.meta}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {items.length === 0 ? 'No matches' : `${items.length} repositor${items.length === 1 ? 'y' : 'ies'}`}
        </div>

        <div className="palette-foot">
          <div className="grp"><span className="kbd">↑↓</span> navigate</div>
          <div className="grp"><span className="kbd">↵</span> switch</div>
          <div className="grp right"><span className="kbd">esc</span> close</div>
        </div>
      </div>
    </div>
  );
}
