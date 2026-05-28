import { useMemo } from 'react';
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

  const graph = useMemo(() => computeGraph(commits), [commits]);
  const refsByOid = useMemo(() => indexRefs(refs), [refs]);
  const colWidth = graphColWidth(graph.laneCount);

  const onRowClick = (hash: string) => {
    void selectCommit(selectedCommit === hash ? null : hash);
  };

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <div className="graph-search">
          <input placeholder="Search commits…" aria-label="Search commits" />
        </div>
      </div>
      <div className="graph-split">
        <PanelGroup direction="horizontal" autoSaveId="strand:commits-split">
          <Panel defaultSize={selectedCommit ? 62 : 100} minSize={40}>
            <div className="graph-main">
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
                    return (
                      <tr
                        key={c.hash}
                        className={active ? 'active' : undefined}
                        onClick={() => onRowClick(c.hash)}
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

function relativeDate(unix: number): string {
  const delta = Date.now() / 1000 - unix;
  if (delta < 60) return `${Math.round(delta)}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  return `${Math.round(delta / 86400)}d`;
}
