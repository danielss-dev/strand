/**
 * Mirrors of the Serde-derived types in `strand-core`. Keep in sync with
 * `crates/strand-core/src/{repo,status,log,diff}.rs`.
 */

export interface RepoMeta {
  name: string;
  path: string;
  branch: string;
  /** Full OID HEAD resolves to; `null` on an unborn branch. Pins baselines. */
  head_oid: string | null;
  ahead: number;
  behind: number;
  /** True when HEAD is detached; `branch` then holds the short OID. */
  detached: boolean;
  /**
   * Multi-step history op paused mid-flight, or `null` in a normal state.
   * Drives the in-progress banner + Abort affordance.
   */
  operation: 'rebase' | 'cherry-pick' | 'revert' | 'merge' | null;
  /**
   * The shared git dir (`commondir`), identical for every worktree of the same
   * repository. The tab strip groups worktree tabs on this value.
   */
  common_dir: string;
  /** True when this tab is a *linked* worktree rather than the main one. */
  is_linked_worktree: boolean;
}
