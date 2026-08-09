import type { Branch, Refs, RemoteBranch, Worktree } from './types';

export interface BranchCleanupCandidate {
  local: Branch;
  /** Matching remote-tracking ref, when it is still known locally. */
  remote: RemoteBranch | null;
  /** Provider confirmed this exact tip was merged even though ancestry did not. */
  providerMerged: boolean;
}

export interface BranchCleanupPlan {
  candidates: BranchCleanupCandidate[];
  /** Merged branches that stay protected because another worktree has them checked out. */
  checkedOut: string[];
}

function matchingRemote(branch: Branch, refs: Refs): RemoteBranch | null {
  let match: RemoteBranch | undefined;
  if (branch.upstream) {
    match = refs.remote_branches.find((remote) => remote.name === branch.upstream?.name);
  } else {
    // A local branch can outlive its upstream configuration. Origin's
    // same-named tracking ref is the conservative fallback requested by the
    // cleanup flow; never guess across arbitrary remotes.
    match = refs.remote_branches.find(
      (remote) => remote.remote === 'origin' && remote.branch === branch.name,
    );
  }

  // The remote tip can move after the local branch was merged. Only expose it
  // when its own ancestry is safe, and never offer a primary-branch ref even
  // if unusual upstream configuration points a feature branch at it.
  return match?.merged && match.branch !== refs.primary_branch ? match : null;
}

/**
 * Build the safe, display-ready cleanup plan from already-loaded ref/worktree
 * state. No ancestry walk or network request belongs on the dialog-open path.
 */
export function mergedBranchCleanupPlan(
  refs: Refs,
  worktrees: Worktree[],
  providerMergedBranches: ReadonlySet<string> = new Set(),
): BranchCleanupPlan {
  const checkedOutBranches = new Set(
    worktrees.map((worktree) => worktree.branch).filter((branch): branch is string => !!branch),
  );
  const merged = refs.branches.filter(
    (branch) => (branch.merged || providerMergedBranches.has(branch.name))
      && !branch.is_head
      && branch.name !== refs.primary_branch,
  );

  const checkedOut = merged
    .filter((branch) => checkedOutBranches.has(branch.name))
    .map((branch) => branch.name);
  const candidates = merged
    .filter((branch) => !checkedOutBranches.has(branch.name))
    .map((local) => ({
      local,
      remote: matchingRemote(local, refs),
      providerMerged: !local.merged && providerMergedBranches.has(local.name),
    }));

  return { candidates, checkedOut };
}
