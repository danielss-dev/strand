import type { PullRequestList, Refs } from './types';

/**
 * Local branches whose source was completed into this repository's primary
 * branch according to GitHub/Azure DevOps. Squash and rebase merges do not
 * preserve ancestry, so the provider record is the signal — not tip equality.
 *
 * Tip equality is intentionally not required: Azure DevOps completed PRs often
 * omit or rewrite `lastMergeSourceCommit` after squash, and a local tip that
 * still carries only the merged work would otherwise never light up. An open
 * or active PR from the same source branch into the primary branch means the
 * name was reused for new work, so those stay unmarked.
 */
export function providerMergedBranchNames(
  refs: Refs,
  data: PullRequestList,
): Set<string> {
  const primary = refs.primary_branch;
  if (!primary) return new Set();

  const localNames = new Set(
    refs.branches
      .filter((branch) => !branch.is_head && branch.name !== primary)
      .map((branch) => branch.name),
  );

  const openSourceBranches = new Set<string>();
  for (const pr of data.pull_requests) {
    const state = pr.state.toLowerCase();
    if (
      (state === 'open' || state === 'active')
      && pr.target_branch === primary
      && localNames.has(pr.source_branch)
    ) {
      openSourceBranches.add(pr.source_branch);
    }
  }

  const names = new Set<string>();
  for (const pr of data.pull_requests) {
    const state = pr.state.toLowerCase();
    if (
      (state === 'merged' || state === 'completed')
      && pr.target_branch === primary
      && localNames.has(pr.source_branch)
      && !openSourceBranches.has(pr.source_branch)
    ) {
      names.add(pr.source_branch);
    }
  }
  return names;
}
