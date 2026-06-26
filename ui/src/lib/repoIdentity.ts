import type { RepoIcon, RepoMeta, Worktree } from './types';

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

function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export function pathLeaf(path: string): string {
  const parts = pathParts(path);
  return parts[parts.length - 1] ?? path;
}

function pathParentLeaf(path: string): string | null {
  const parts = pathParts(path);
  return parts.length > 1 ? parts[parts.length - 2] : null;
}

/**
 * Stable repository label for every worktree in a repo family. `RepoMeta.name`
 * is the active worktree directory basename, so a linked worktree can look like
 * the branch. The shared `.git` common dir points back to the main repo name.
 */
export function repoFamilyName(meta: Pick<RepoMeta, 'name' | 'common_dir'> | null | undefined): string {
  if (!meta) return '—';
  const commonLeaf = pathLeaf(meta.common_dir);
  if (commonLeaf === '.git') return pathParentLeaf(meta.common_dir) ?? meta.name;
  return commonLeaf || meta.name;
}

export function worktreeName(worktree: Pick<Worktree, 'branch' | 'head' | 'is_detached' | 'path'>): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.is_detached && worktree.head) return worktree.head.slice(0, 7);
  return pathLeaf(worktree.path);
}

export function tabWorktreeName(meta: Pick<RepoMeta, 'branch' | 'detached' | 'path' | 'name'>): string {
  if (meta.branch && meta.branch !== 'HEAD') return meta.branch;
  if (meta.detached && meta.branch) return meta.branch;
  return pathLeaf(meta.path) || meta.name;
}

export function repoTabLabel<T extends { meta: RepoMeta }>(tab: T): {
  repo: string;
  worktree: string | null;
  primary: string;
  secondary: string | null;
  title: string;
  ariaLabel: string;
} {
  const repo = repoFamilyName(tab.meta);
  if (!tab.meta.is_linked_worktree) {
    return {
      repo,
      worktree: null,
      primary: repo,
      secondary: tab.meta.branch,
      title: tab.meta.path,
      ariaLabel: `${repo}, ${tab.meta.branch}`,
    };
  }

  const worktree = tabWorktreeName(tab.meta);
  return {
    repo,
    worktree,
    primary: repo,
    secondary: worktree,
    title: `${repo} · worktree ${worktree}\n${tab.meta.path}`,
    ariaLabel: `${repo}, worktree ${worktree}`,
  };
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
