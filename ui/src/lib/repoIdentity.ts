import type { RepoIcon } from './types';

/**
 * Order tabs so worktrees of the same repository cluster together: groups keyed
 * by `common_dir` in first-open order, and within a group the main worktree
 * leads its linked ones. Render-only — the store's tab order is untouched.
 * (Moved out of Topbar when repo tabs became the vertical rail.)
 */
export function groupTabs<T extends { meta: { common_dir: string; is_linked_worktree: boolean } }>(
  tabs: T[],
): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const t of tabs) {
    const key = t.meta.common_dir;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(t);
  }
  return order.flatMap((key) => {
    const g = groups.get(key)!;
    // Main worktree (not linked) first, the rest in open order.
    return [...g.filter((t) => !t.meta.is_linked_worktree), ...g.filter((t) => t.meta.is_linked_worktree)];
  });
}

/** Stable tile color for a repo group, hashed from its common git dir into the
 *  branch-lane palette (`--b-1…--b-7`). */
export function groupColor(commonDir: string): string {
  let h = 0;
  for (let i = 0; i < commonDir.length; i++) h = (h * 31 + commonDir.charCodeAt(i)) | 0;
  return `var(--b-${(Math.abs(h) % 7) + 1})`;
}

/** OKLCH hue of each branch-lane swatch — keep in sync with the `--b-N`
 *  definitions in tokens.css. Used to re-theme the app accent to the active
 *  repo's custom color (a hue rotation, matching how `[data-accent]` works). */
const SWATCH_HUE: Record<string, number> = {
  '--b-1': 55, '--b-2': 220, '--b-3': 150, '--b-4': 320,
  '--b-5': 95, '--b-6': 270, '--b-7': 190,
};

/**
 * The accent hue (0–360) a repo's stored custom color should drive, or null if
 * it has no custom color (the app then keeps its configured accent). Only the
 * fixed swatch palette maps to a hue; anything else returns null.
 */
export function accentHueForColor(color: string | undefined | null): number | null {
  if (!color) return null;
  const m = color.match(/--b-\d/);
  return m ? SWATCH_HUE[m[0]] ?? null : null;
}

/**
 * Default 1–2 character glyph for a repo, derived from its name: the initials
 * of the first two word-parts ("Portal_Backend" → "PB", "swops-terraform" →
 * "ST"), or the first two letters of a single-word name ("strand" → "ST").
 * Falls back to "?" for an empty name.
 */
export function deriveInitials(name: string): string {
  const parts = name.split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** The glyph to render on a tile given its custom icon + repo name (image is
 *  handled separately by the caller). Emoji wins over letter override, which
 *  wins over derived initials. */
export function tileGlyph(icon: RepoIcon | undefined, name: string): string {
  if (icon?.emoji) return icon.emoji;
  if (icon?.letter && icon.letter.trim()) return icon.letter.trim().slice(0, 2);
  return deriveInitials(name);
}
