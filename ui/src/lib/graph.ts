/**
 * Lane layout for the All Commits graph. Computed top-down (newest first)
 * in a single pass over `repo_log`'s topologically-sorted output. Each
 * lane is a vertical column; a lane "waits for" an oid and the commit
 * with that oid renders its node in that lane.
 *
 * Output is a flat per-row description: which lane the node sits in,
 * which segments cross the row, and their colors. The SVG cell knows
 * nothing about commits — it just draws these segments.
 */

/**
 * Minimal commit shape the lane layout needs. Real commits (`Commit`) satisfy
 * it; synthetic stash nodes set `isStash` so the cell can mark them.
 */
export interface GraphInput {
  hash: string;
  parents: string[];
  isStash?: boolean;
}

export type SegmentKind = 'in' | 'out' | 'pass';

export interface GraphSegment {
  /** Source lane (top of the row). */
  from: number;
  /** Destination lane (bottom of the row, or node lane for 'in'). */
  to: number;
  /** Index into the --b-1..--b-7 palette. */
  color: number;
  kind: SegmentKind;
}

export interface GraphRow {
  /** Lane (column index) the commit's node sits in. */
  lane: number;
  /** Color index for the node circle. */
  color: number;
  /** True when the commit has 2+ parents. */
  isMerge: boolean;
  /** True for a synthetic stash node (distinct marker in the cell). */
  isStash: boolean;
  /** All connector lines that cross this row. */
  segments: GraphSegment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Max number of lanes used at any point — drives column width. */
  laneCount: number;
}

interface LaneSlot {
  oid: string;
  color: number;
}

const PALETTE_SIZE = 7;

function allocLane(slot: LaneSlot, arr: (LaneSlot | null)[]): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null) {
      arr[i] = slot;
      return i;
    }
  }
  arr.push(slot);
  return arr.length - 1;
}

export function computeGraph(commits: GraphInput[]): GraphLayout {
  const rows: GraphRow[] = [];
  let lanes: (LaneSlot | null)[] = [];
  let laneCount = 0;
  let nextColor = 0;
  const newColor = (): number => {
    const c = nextColor;
    nextColor = (nextColor + 1) % PALETTE_SIZE;
    return c;
  };

  for (const c of commits) {
    // All lanes above that were expecting this commit converge here.
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.oid === c.hash) incoming.push(i);
    }

    let myLane: number;
    let myColor: number;
    if (incoming.length > 0) {
      myLane = incoming[0];
      myColor = lanes[myLane]!.color;
    } else {
      // No lane was waiting — first commit, or a tip we walked into cold.
      myColor = newColor();
      myLane = allocLane({ oid: c.hash, color: myColor }, lanes);
      // No incoming lines (this row originates a new lane).
    }

    // Build the lane state heading into the next row.
    const next: (LaneSlot | null)[] = lanes.slice();
    for (const k of incoming) next[k] = null;
    if (incoming.length === 0) next[myLane] = null;

    const parentLanes: { lane: number; color: number }[] = [];
    if (c.parents.length > 0) {
      // First parent inherits myLane (and myColor) — the trunk of this branch.
      next[myLane] = { oid: c.parents[0], color: myColor };
      parentLanes.push({ lane: myLane, color: myColor });

      // Additional parents = merge edges. Reuse an existing lane already
      // waiting for that parent oid (so two histories visually fuse).
      for (let pi = 1; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        let lane = next.findIndex((s) => s?.oid === p);
        let color: number;
        if (lane === -1) {
          color = newColor();
          lane = allocLane({ oid: p, color }, next);
        } else {
          color = next[lane]!.color;
        }
        parentLanes.push({ lane, color });
      }
    }

    // Segments crossing this row.
    const segments: GraphSegment[] = [];
    const width = Math.max(lanes.length, next.length);
    for (let k = 0; k < width; k++) {
      const wasActive = lanes[k] != null && !incoming.includes(k);
      const isActive = next[k] != null;
      if (wasActive && isActive) {
        segments.push({ from: k, to: k, color: lanes[k]!.color, kind: 'pass' });
      }
    }
    // Incoming: each lane that was waiting → myLane (drawn in top half).
    for (const k of incoming) {
      segments.push({ from: k, to: myLane, color: lanes[k]!.color, kind: 'in' });
    }
    // Outgoing: myLane → each parent's lane (drawn in bottom half).
    for (const pl of parentLanes) {
      segments.push({ from: myLane, to: pl.lane, color: pl.color, kind: 'out' });
    }

    rows.push({
      lane: myLane,
      color: myColor,
      isMerge: c.parents.length > 1,
      isStash: !!c.isStash,
      segments,
    });

    laneCount = Math.max(laneCount, width);
    lanes = next;
  }

  return { rows, laneCount };
}

export function laneColorVar(colorIndex: number): string {
  return `var(--b-${(colorIndex % PALETTE_SIZE) + 1})`;
}
