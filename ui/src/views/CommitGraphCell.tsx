import type { GraphRow } from '../lib/graph';
import { laneColorVar } from '../lib/graph';

/**
 * Visual constants the column width is computed from. Kept in sync with
 * the inline `width` set on `td.graph-col` in `Commits.tsx`.
 */
export const LANE_W = 14;
export const NODE_R = 4;
const STROKE = 1.5;
const DEFAULT_VB_H = 26;

export function graphColWidth(laneCount: number): number {
  return Math.max(40, laneCount * LANE_W + 8);
}

export function CommitGraphCell({
  row,
  laneCount,
  rowH = DEFAULT_VB_H,
}: {
  row: GraphRow;
  laneCount: number;
  rowH?: number;
}) {
  // viewBox width matches the actual rendered cell width so horizontal
  // scale stays 1:1. Without this, when laneCount=1 the min-width cell
  // (40px) stretches a 14-wide viewBox ~2.86×, flattening the node into
  // a wide ellipse.
  const vbW = graphColWidth(laneCount);
  const VB_H = rowH;
  const cy = VB_H / 2;
  const lx = (k: number) => k * LANE_W + LANE_W / 2;

  return (
    <div className="graph-cell">
      <svg viewBox={`0 0 ${vbW} ${VB_H}`} preserveAspectRatio="none">
        {row.segments.map((s, i) => {
          const x1 = lx(s.from);
          const x2 = lx(s.to);
          let d: string;
          if (s.kind === 'pass') {
            d = `M ${x1} 0 L ${x1} ${VB_H}`;
          } else if (s.kind === 'in') {
            // Drop from top of row, then bend across to the node at center.
            d = `M ${x1} 0 C ${x1} ${cy / 2}, ${x2} ${cy / 2}, ${x2} ${cy}`;
          } else {
            // 'out' — leave node at center, bend across to bottom of row.
            d = `M ${x1} ${cy} C ${x1} ${cy + cy / 2}, ${x2} ${cy + cy / 2}, ${x2} ${VB_H}`;
          }
          return (
            <path
              key={i}
              d={d}
              stroke={laneColorVar(s.color)}
              strokeWidth={STROKE}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {row.isStash ? (
          // Stash nodes aren't on a branch — a neutral hollow diamond reads as
          // auxiliary, distinct from the lane-colored commit/merge circles.
          <rect
            x={lx(row.lane) - NODE_R}
            y={cy - NODE_R}
            width={NODE_R * 2}
            height={NODE_R * 2}
            transform={`rotate(45 ${lx(row.lane)} ${cy})`}
            fill="var(--bg-base)"
            stroke="var(--text-muted)"
            strokeWidth={STROKE}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <circle
            cx={lx(row.lane)}
            cy={cy}
            r={NODE_R}
            fill={row.isMerge ? 'var(--bg-base)' : laneColorVar(row.color)}
            stroke={laneColorVar(row.color)}
            strokeWidth={STROKE}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}
