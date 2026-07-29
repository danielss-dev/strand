/** Expand file and directory selections into the concrete file paths they cover. */
export function expandTreeSelection(
  filePaths: readonly string[],
  selectedPaths: readonly string[],
): string[] {
  const selected = new Set(selectedPaths.map((path) => path.replace(/\/+$/, '')));
  return filePaths.filter((file) => {
    if (selected.has(file)) return true;
    let separator = file.lastIndexOf('/');
    while (separator >= 0) {
      if (selected.has(file.slice(0, separator))) return true;
      separator = file.lastIndexOf('/', separator - 1);
    }
    return false;
  });
}

/**
 * Resolve the concrete files for an action invoked on a tree row.
 *
 * An invoked row inside a multi-selection acts on the full selection, including
 * every descendant of selected directories. An unselected row stays scoped to
 * itself so context-menu actions never mutate an unrelated ambient selection.
 */
export function resolveTreeActionTargets(
  filePaths: readonly string[],
  selectedPaths: readonly string[],
  rowPath: string,
): string[] {
  const row = rowPath.replace(/\/+$/, '');
  const rowSelected = selectedPaths.some((path) => path.replace(/\/+$/, '') === row);
  return expandTreeSelection(
    filePaths,
    rowSelected && selectedPaths.length > 1 ? selectedPaths : [row],
  );
}

/**
 * Resolve an action driven by a separately stored active row plus an already
 * expanded tree selection. This is used by view-level keyboard shortcuts that
 * run outside Pierre's event boundary.
 */
export function resolveActiveTreeTargets(
  filePaths: readonly string[],
  selectedFilePaths: readonly string[],
  activePath: string,
): string[] {
  const direct = expandTreeSelection(filePaths, [activePath]);
  const available = new Set(filePaths);
  const selected = selectedFilePaths.filter((path) => available.has(path));
  const selectedSet = new Set(selected);
  return direct.some((path) => selectedSet.has(path)) ? selected : direct;
}
