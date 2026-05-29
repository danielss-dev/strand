import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { computeGraph } from '../lib/graph';
import type { Refs } from '../lib/types';
import { useRepo } from '../stores/repo';
import { CommitDetail } from './CommitDetail';
import { CommitGraphCell, graphColWidth } from './CommitGraphCell';

/** All Commits view: graph + selectable rows + right-side detail panel. */
export function Commits() {
  const commits = useRepo((s) => s.commits);
  const refs = useRepo((s) => s.refs);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const selectCommit = useRepo((s) => s.selectCommit);
  const graphMainRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);
  const didInitialFocus = useRef(false);
  const [focusedCommit, setFocusedCommit] = useState<string | null>(null);

  // Multi-selection (for future bulk ops: cherry-pick, compare, …). Distinct
  // from `selectedCommit`, which drives the single-commit detail panel.
  // `anchor` is the fixed end of a shift-range; it moves on plain
  // click/arrow and stays put while extending.
  const [multi, setMulti] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  const graph = useMemo(() => computeGraph(commits), [commits]);
  // Inclusive range of hashes between two commits, by their row order.
  const rangeBetween = useCallback(
    (a: string, b: string): string[] => {
      const ia = commits.findIndex((c) => c.hash === a);
      const ib = commits.findIndex((c) => c.hash === b);
      if (ia === -1 || ib === -1) return b ? [b] : [];
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
      return commits.slice(lo, hi + 1).map((c) => c.hash);
    },
    [commits],
  );
  const refsByOid = useMemo(() => indexRefs(refs), [refs]);
  const currentCommit = useMemo(() => currentCommitHash(refs, commits), [commits, refs]);
  const colWidth = graphColWidth(graph.laneCount);

  const onRowClick = (hash: string, e: React.MouseEvent) => {
    graphMainRef.current?.focus();
    setFocusedCommit(hash);
    if (e.metaKey || e.ctrlKey) {
      // Toggle membership; leave the detail panel untouched.
      setMulti((prev) => {
        const next = new Set(prev);
        if (next.has(hash)) next.delete(hash);
        else next.add(hash);
        return next;
      });
      anchorRef.current = hash;
      return;
    }
    if (e.shiftKey) {
      const anchor = anchorRef.current ?? focusedCommit ?? hash;
      setMulti(new Set(rangeBetween(anchor, hash)));
      return;
    }
    // Plain click: single-select + toggle the detail panel.
    setMulti(new Set([hash]));
    anchorRef.current = hash;
    void selectCommit(selectedCommit === hash ? null : hash);
  };

  const moveFocus = useCallback(
    (direction: 1 | -1, extend: boolean) => {
      if (commits.length === 0) return;

      const currentIndex = commits.findIndex((c) => c.hash === focusedCommit);
      const nextIndex =
        currentIndex === -1
          ? direction === 1
            ? 0
            : commits.length - 1
          : Math.max(0, Math.min(commits.length - 1, currentIndex + direction));
      const nextHash = commits[nextIndex]?.hash;
      if (!nextHash || nextHash === focusedCommit) return;

      setFocusedCommit(nextHash);
      if (extend) {
        const anchor = anchorRef.current ?? focusedCommit ?? nextHash;
        setMulti(new Set(rangeBetween(anchor, nextHash)));
      } else {
        setMulti(new Set([nextHash]));
        anchorRef.current = nextHash;
        if (selectedCommit) void selectCommit(nextHash);
      }
    },
    [commits, focusedCommit, selectedCommit, selectCommit, rangeBetween],
  );

  const clearMulti = useCallback(() => {
    const keep = focusedCommit;
    setMulti(keep ? new Set([keep]) : new Set());
    anchorRef.current = keep;
  }, [focusedCommit]);

  const onGraphKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setMulti(new Set(commits.map((c) => c.hash)));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (focusedCommit) void selectCommit(focusedCommit);
        return;
      }
      if (e.key === 'Escape') {
        if (selectedCommit) {
          e.preventDefault();
          void selectCommit(null);
        } else if (multi.size > 1) {
          e.preventDefault();
          clearMulti();
        }
      }
    },
    [commits, focusedCommit, moveFocus, selectedCommit, selectCommit, multi, clearMulti],
  );

  useEffect(() => {
    if (didInitialFocus.current || !currentCommit) return;
    didInitialFocus.current = true;
    setFocusedCommit(currentCommit);
    setMulti(new Set([currentCommit]));
    anchorRef.current = currentCommit;
    graphMainRef.current?.focus();
    if (selectedCommit) void selectCommit(null);
  }, [currentCommit, selectedCommit, selectCommit]);

  // Prune the selection to commits that still exist after a log refresh
  // (e.g. a checkout swapped the visible history), and re-anchor focus if the
  // focused row vanished — otherwise the highlight, scroll, and the next
  // arrow press all lose their place.
  useEffect(() => {
    setMulti((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(commits.map((c) => c.hash));
      let changed = false;
      const next = new Set<string>();
      for (const h of prev) {
        if (present.has(h)) next.add(h);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (focusedCommit && !commits.some((c) => c.hash === focusedCommit)) {
      const fallback = currentCommit ?? commits[0]?.hash ?? null;
      setFocusedCommit(fallback);
      anchorRef.current = fallback;
    }
  }, [commits, focusedCommit, currentCommit]);

  useEffect(() => {
    focusedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focusedCommit]);

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <div className="graph-search">
          <input placeholder="Search commits…" aria-label="Search commits" />
        </div>
        {multi.size > 1 && (
          <div className="graph-sel-count" role="status">
            <span>{multi.size} selected</span>
            <button type="button" className="clear" onClick={clearMulti} title="Clear selection">
              Clear
            </button>
          </div>
        )}
      </div>
      <div className="graph-split">
        <PanelGroup direction="horizontal" autoSaveId="strand:commits-split">
          <Panel defaultSize={selectedCommit ? 62 : 100} minSize={40}>
            <div
              ref={graphMainRef}
              className="graph-main"
              tabIndex={0}
              role="grid"
              aria-multiselectable
              aria-label="Commit graph"
              aria-activedescendant={focusedCommit ? `commit-row-${focusedCommit}` : undefined}
              onKeyDown={onGraphKeyDown}
            >
              <table className="graph-table">
                <thead>
                  <tr>
                    <th style={{ width: colWidth }}></th>
                    <th>Message</th>
                    <th style={{ width: 160 }}>Author</th>
                    <th style={{ width: 100 }}>Date</th>
                    <th style={{ width: 80 }}>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {commits.map((c, i) => {
                    const chips = refsByOid.get(c.hash);
                    const row = graph.rows[i];
                    const active = selectedCommit === c.hash;
                    const focused = focusedCommit === c.hash;
                    const selected = multi.has(c.hash);
                    return (
                      <tr
                        key={c.hash}
                        id={`commit-row-${c.hash}`}
                        role="row"
                        ref={focused ? focusedRowRef : undefined}
                        className={[
                          active ? 'active' : null,
                          focused ? 'focused' : null,
                          selected ? 'selected' : null,
                        ]
                          .filter(Boolean)
                          .join(' ') || undefined}
                        aria-selected={selected}
                        onClick={(e) => onRowClick(c.hash, e)}
                      >
                        <td className="graph-col" style={{ width: colWidth }}>
                          {row ? <CommitGraphCell row={row} laneCount={graph.laneCount} /> : null}
                        </td>
                        <td className="msg">
                          {chips && chips.length > 0 ? (
                            <span className="ref-chips">
                              {chips.map((chip) => (
                                <span key={chip.key} className={`ref-chip ${chip.kind}`}>
                                  {chip.label}
                                </span>
                              ))}
                            </span>
                          ) : null}
                          {row?.isMerge ? <span className="merge">⊕</span> : null}
                          <span className="msg-text">{c.subject}</span>
                        </td>
                        <td className="author">{c.author_name}</td>
                        <td className="date">{relativeDate(c.time_unix)}</td>
                        <td className="hash">{c.short_hash}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
          {selectedCommit ? (
            <>
              <PanelResizeHandle className="rs-handle vert" />
              <Panel defaultSize={38} minSize={25} maxSize={55}>
                <CommitDetail />
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>
    </div>
  );
}

interface RefChip {
  key: string;
  label: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
}

function indexRefs(refs: Refs): Map<string, RefChip[]> {
  const m = new Map<string, RefChip[]>();
  const push = (oid: string, chip: RefChip) => {
    const arr = m.get(oid);
    if (arr) arr.push(chip);
    else m.set(oid, [chip]);
  };
  for (const b of refs.branches) {
    push(b.target, {
      key: `b:${b.full_name}`,
      label: b.name,
      kind: b.is_head ? 'head' : 'local',
    });
  }
  for (const rb of refs.remote_branches) {
    push(rb.target, {
      key: `rb:${rb.full_name}`,
      label: `${rb.remote}/${rb.branch}`,
      kind: 'remote',
    });
  }
  for (const t of refs.tags) {
    push(t.target, { key: `t:${t.full_name}`, label: t.name, kind: 'tag' });
  }
  return m;
}

function currentCommitHash(refs: Refs, commits: { hash: string }[]): string | null {
  const head = refs.branches.find((b) => b.is_head)?.target;
  if (head && commits.some((c) => c.hash === head)) return head;
  return commits[0]?.hash ?? null;
}

function relativeDate(unix: number): string {
  const delta = Date.now() / 1000 - unix;
  if (delta < 60) return `${Math.round(delta)}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  return `${Math.round(delta / 86400)}d`;
}
