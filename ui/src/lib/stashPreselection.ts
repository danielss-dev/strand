import type { LocalSelection } from '../stores/repo';

export interface LocalTreeSelection {
  unstaged: string[];
  staged: string[];
}

/** Paths on one side of Local Changes that match the current selection. */
export function pathsForLocalSelection(
  selection: LocalSelection,
  sidePaths: readonly string[],
): string[] {
  if (selection.all) return [...sidePaths];
  const exact = sidePaths.find((p) => p === selection.file);
  if (exact) return [exact];
  const prefix = selection.file.replace(/\/+$/, '') + '/';
  return sidePaths.filter((p) => p.startsWith(prefix));
}

/**
 * Compute which stashable paths should start checked in the stash preview.
 * Pierre multi-select on the active side wins; otherwise honour
 * {@link LocalSelection}; default is every stashable path.
 */
export function computeStashPreselection(
  localSelection: LocalSelection | null,
  unstagedPaths: readonly string[],
  stagedPaths: readonly string[],
  treeSelection: LocalTreeSelection,
  stashablePaths: readonly string[],
): Set<string> {
  const stashable = new Set(stashablePaths);
  const pick = (paths: readonly string[]) =>
    paths.filter((p) => stashable.has(p));

  if (localSelection) {
    const multi = localSelection.staged ? treeSelection.staged : treeSelection.unstaged;
    if (multi.length > 1) {
      const fromMulti = pick(multi);
      if (fromMulti.length > 0) return new Set(fromMulti);
    }
    const fromSel = pick(
      pathsForLocalSelection(
        localSelection,
        localSelection.staged ? stagedPaths : unstagedPaths,
      ),
    );
    if (fromSel.length > 0) return new Set(fromSel);
  }

  const unstagedMulti = pick(treeSelection.unstaged);
  if (unstagedMulti.length > 1) return new Set(unstagedMulti);
  const stagedMulti = pick(treeSelection.staged);
  if (stagedMulti.length > 1) return new Set(stagedMulti);

  return new Set(stashablePaths);
}
