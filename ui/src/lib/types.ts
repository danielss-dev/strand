/**
 * Mirrors of the Serde-derived types in `strand-core`. Keep in sync with
 * `crates/strand-core/src/{repo,status,log,diff}.rs`.
 */

export interface RepoMeta {
  name: string;
  path: string;
  branch: string;
  ahead: number;
  behind: number;
  /** True when HEAD is detached; `branch` then holds the short OID. */
  detached: boolean;
  /**
   * Multi-step history op paused mid-flight, or `null` in a normal state.
   * Drives the in-progress banner + Abort affordance.
   */
  operation: 'rebase' | 'cherry-pick' | 'revert' | 'merge' | null;
}

/** Merge strategy chosen in the Merge dialog. */
export type MergeMode = 'auto' | 'no_ff' | 'squash';

export type StatusKind = 'MODIFIED' | 'ADDED' | 'DELETED' | 'RENAMED' | 'UNTRACKED' | 'CONFLICTED';

export interface FileStatus {
  path: string;
  kind: StatusKind;
  staged: boolean;
}

export interface Commit {
  hash: string;
  short_hash: string;
  subject: string;
  /** Message minus the subject line; empty when the commit had no body. */
  body: string;
  author_name: string;
  author_email: string;
  time_unix: number;
  parents: string[];
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: DiffStatus;
  adds: number;
  dels: number;
  binary: boolean;
  /** Unified-diff text for this single file. Feed to `<Diff />`. */
  patch: string;
}

export interface CommitOutcome {
  oid: string;
  amended: boolean;
}

export interface UpstreamRef {
  name: string;
  remote: string;
}

export interface Branch {
  name: string;
  full_name: string;
  target: string;
  is_head: boolean;
  upstream: UpstreamRef | null;
  ahead: number;
  behind: number;
}

export interface RemoteBranch {
  name: string;
  remote: string;
  branch: string;
  full_name: string;
  target: string;
}

export interface Remote {
  name: string;
  url: string | null;
}

export interface Tag {
  name: string;
  full_name: string;
  target: string;
  annotated: boolean;
  message: string | null;
}

export interface Refs {
  branches: Branch[];
  remotes: Remote[];
  remote_branches: RemoteBranch[];
  tags: Tag[];
}

export interface CheckoutOutcome {
  branch: string;
}

export interface Stash {
  /** Stash index; 0 is the most recent (git's `stash@{0}`). */
  index: number;
  /** OID of the stash commit. */
  oid: string;
  /** Full stash message, e.g. `WIP on main: 1a2b3c4 Subject`. */
  message: string;
  /** Branch the stash was taken on, parsed from the message when possible. */
  branch: string | null;
}

export interface StashOutcome {
  /** OID of the new stash commit, or `null` when there was nothing to stash. */
  oid: string | null;
}

export interface NetworkOutcome {
  /** Combined stdout/stderr from `git`, trimmed. Show in a toast/log. */
  output: string;
}

/** Streamed progress fragment from a network op (clone/fetch/pull/push). */
export interface Progress {
  /** Phase label, e.g. "Receiving objects"; empty for plain status lines. */
  phase: string;
  /** Parsed `NN%` when the fragment carried one. */
  percent: number | null;
  /** Raw git fragment, trimmed — shown verbatim when there's no percent. */
  raw: string;
}

export interface CloneOutcome {
  /** Absolute path of the cloned working tree, ready to open. */
  path: string;
  output: string;
}

/** One file in the working-tree view (Files sidebar tab). */
export interface WorkTreeEntry {
  path: string;
  /** Change status, or `null` for a clean tracked file. */
  status: StatusKind | null;
}

/** Row in the `recent_repos` SQLite table. Frontend-managed. */
export interface RecentRepo {
  path: string;
  name: string;
  last_opened: number;
}
