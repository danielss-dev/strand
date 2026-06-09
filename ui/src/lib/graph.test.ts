import { describe, expect, it } from 'vitest';

import { computeGraph, laneColorVar } from './graph';
import type { Commit } from './types';

/**
 * The lane algorithm assumes a complete, topologically-ordered commit list
 * (parents always after children) — the same invariant `repo_log` guarantees
 * and the reason commit search highlights instead of filtering.
 */

function commit(hash: string, parents: string[]): Commit {
  return {
    hash,
    short_hash: hash.slice(0, 7),
    subject: `commit ${hash}`,
    body: '',
    author_name: 'Test',
    author_email: 'test@example.com',
    time_unix: 0,
    parents,
  };
}

describe('computeGraph', () => {
  it('lays a linear history out in a single lane', () => {
    const layout = computeGraph([
      commit('c3', ['c2']),
      commit('c2', ['c1']),
      commit('c1', []),
    ]);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(layout.rows.every((r) => !r.isMerge)).toBe(true);
    // Root commit has no outgoing segments; the others connect downward.
    expect(layout.rows[2].segments.filter((s) => s.kind === 'out')).toHaveLength(0);
    expect(layout.rows[0].segments.some((s) => s.kind === 'out' && s.to === 0)).toBe(true);
  });

  it('gives a merge two outgoing edges and fuses the branch back', () => {
    // main: m2 ← merge ← m1 ← root; feature: f1 branches from root.
    const layout = computeGraph([
      commit('merge', ['m1', 'f1']),
      commit('f1', ['root']),
      commit('m1', ['root']),
      commit('root', []),
    ]);
    expect(layout.rows[0].isMerge).toBe(true);
    const outs = layout.rows[0].segments.filter((s) => s.kind === 'out');
    expect(outs).toHaveLength(2);
    // The two parents occupy two distinct lanes.
    expect(new Set(outs.map((s) => s.to)).size).toBe(2);
    expect(layout.laneCount).toBe(2);
    // Both branches converge on root: its row receives two incoming edges.
    const rootRow = layout.rows[3];
    expect(rootRow.segments.filter((s) => s.kind === 'in')).toHaveLength(2);
  });

  it('keeps every segment within the reported lane count', () => {
    const layout = computeGraph([
      commit('e', ['c', 'd']),
      commit('d', ['b']),
      commit('c', ['a']),
      commit('b', ['a']),
      commit('a', []),
    ]);
    for (const row of layout.rows) {
      expect(row.lane).toBeLessThan(layout.laneCount);
      for (const seg of row.segments) {
        expect(seg.from).toBeLessThan(layout.laneCount);
        expect(seg.to).toBeLessThan(layout.laneCount);
      }
    }
  });

  it('handles an empty log', () => {
    expect(computeGraph([])).toEqual({ rows: [], laneCount: 0 });
  });
});

describe('laneColorVar', () => {
  it('cycles through the 7-color palette', () => {
    expect(laneColorVar(0)).toBe('var(--b-1)');
    expect(laneColorVar(6)).toBe('var(--b-7)');
    expect(laneColorVar(7)).toBe('var(--b-1)');
  });
});
