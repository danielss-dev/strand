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

/** Global git identity (`user.name` / `user.email`), Settings → Git. */
export interface GlobalIdentity {
  name: string | null;
  email: string | null;
}

/** Merge strategy chosen in the Merge dialog. */
export type MergeMode = 'auto' | 'no_ff' | 'squash';

/** Reset flavour: what happens to the index + working tree. */
export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOutcome {
  /** Short hash of the commit HEAD now points at. */
  target_short: string;
  /** OID of the safety snapshot stash taken before a hard reset of a dirty
   *  tree; `null` for soft/mixed or a clean tree. */
  snapshot_oid: string | null;
}

/** A git interactive-rebase verb the sequence editor exposes (no `edit` in v1). */
export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

/** One planned step against a commit; `message` is read only for `reword`. */
export interface RebaseStep {
  action: RebaseAction;
  oid: string;
  message: string | null;
}

/** A commit in the editable range, oldest→newest, as the sequence editor lists it. */
export interface RebaseEntry {
  oid: string;
  short: string;
  subject: string;
  author: string;
  is_merge: boolean;
}

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

/**
 * A reviewer note attached to a file in the Review view. UI-only (never
 * crosses IPC); persisted per-repo via `reviewSession` in lib/db.
 */
export interface ReviewNote {
  id: string;
  text: string;
  /** New-file line number the note anchors to, or `null` for a whole-file note. */
  line: number | null;
  createdAt: number;
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
  /** First parent of the stash commit — the commit it was taken on. The graph
   *  attaches the stash node here. */
  base: string | null;
  /** Committer time of the stash commit (Unix seconds). */
  time_unix: number;
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

/** A submodule's state relative to the superproject's recorded commit. */
export type SubmoduleState = 'uninitialized' | 'up-to-date' | 'out-of-date' | 'modified';

export interface Submodule {
  name: string;
  /** Path within the superproject working tree (forward-slashed). */
  path: string;
  url: string | null;
  /** Commit OID the superproject records, or `null`. */
  head_id: string | null;
  /** Commit OID actually checked out, or `null` when uninitialized. */
  workdir_id: string | null;
  initialized: boolean;
  status: SubmoduleState;
}

/** One entry in the repository's worktree registry (`git worktree list`). */
export interface Worktree {
  /** Absolute worktree directory, forward-slashed. */
  path: string;
  /** Short branch name; `null` when detached/bare. */
  branch: string | null;
  /** Checked-out HEAD oid; `null` for a bare entry. */
  head: string | null;
  is_bare: boolean;
  is_detached: boolean;
  is_locked: boolean;
  lock_reason: string | null;
  /** git considers this worktree's directory missing/removable. */
  is_prunable: boolean;
  /** The primary worktree (holds the repo's own `.git`). */
  is_main: boolean;
  /** Matches the currently-open repo path. */
  is_current: boolean;
}

/** One line of `git blame` output for a file at HEAD. */
export interface BlameLine {
  /** 1-based line number. */
  line_no: number;
  /** Line text (newline stripped). */
  content: string;
  /** Full OID of the commit that last touched the line; empty if unknown. */
  commit: string;
  short: string;
  author: string;
  author_email: string;
  time_unix: number;
  /** Subject of the blamed commit. */
  summary: string;
}

/** A file's content (working tree, or at a revision) for the Content tab. */
export interface FileContent {
  path: string;
  /** File text, empty when `binary`. Capped server-side (`truncated`). */
  text: string;
  binary: boolean;
  truncated: boolean;
}

/** Raw file bytes (worktree / index / revision) for the image diff preview. */
export interface FileBlob {
  /** Standard base64 (padded). Empty when `too_large`. */
  base64: string;
  /** Byte size of the file — reported even when `too_large`. */
  size: number;
  /** True when the file exceeded the server-side cap (8 MB). */
  too_large: boolean;
}

/** One commit in a file's history (`git log --follow -- path`). */
export interface FileHistoryEntry {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  time_unix: number;
  subject: string;
  adds: number;
  dels: number;
}

/** One entry in a ref's reflog (`git reflog`), newest first. */
export interface ReflogEntry {
  /** Position in the reflog; 0 is the most recent move (`HEAD@{0}`). */
  index: number;
  /** OID the ref points at after this move (full hex) — the jump target. */
  new_oid: string;
  new_short: string;
  /** OID before this move; all-zero for the ref's creation entry. */
  old_oid: string;
  committer_name: string;
  committer_email: string;
  time_unix: number;
  /** Reflog message, e.g. `commit: fix typo` or `checkout: moving from a to b`. */
  message: string;
}

/** Row in the `recent_repos` SQLite table. Frontend-managed. */
export interface RecentRepo {
  path: string;
  name: string;
  last_opened: number;
}

/**
 * One-call refresh bundle (`repo_snapshot`): meta + status + work tree +
 * refs + submodules from a single repo open and one statuses walk.
 */
export interface Snapshot {
  meta: RepoMeta;
  status: FileStatus[];
  work_tree: WorkTreeEntry[];
  refs: Refs;
  submodules: Submodule[];
}
