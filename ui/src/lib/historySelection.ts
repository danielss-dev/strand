/**
 * The graph is newest→oldest. Git sequencer operations need a dependent
 * selection oldest→newest, so preserve graph topology while reversing it.
 */
export function selectedCommitsOldestFirst<T extends { hash: string }>(
  graphCommits: readonly T[],
  selected: ReadonlySet<string>,
): T[] {
  return graphCommits.filter((commit) => selected.has(commit.hash)).reverse();
}
