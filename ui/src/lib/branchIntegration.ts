import type { PullRequestList, Refs } from './types';

/** Exact local branches whose current tip is the source tip of a completed PR
 * into this repository's primary branch. */
export function providerMergedBranchNames(
  refs: Refs,
  data: PullRequestList,
): Set<string> {
  const primary = refs.primary_branch;
  if (!primary) return new Set();
  const localTargets = new Map(
    refs.branches
      .filter((branch) => !branch.is_head && branch.name !== primary)
      .map((branch) => [branch.name, branch.target.toLowerCase()]),
  );
  const names = new Set<string>();
  for (const pr of data.pull_requests) {
    const state = pr.state.toLowerCase();
    if (
      (state === 'merged' || state === 'completed')
      && pr.target_branch === primary
      && !!pr.source_commit
      && localTargets.get(pr.source_branch) === pr.source_commit.toLowerCase()
    ) {
      names.add(pr.source_branch);
    }
  }
  return names;
}
