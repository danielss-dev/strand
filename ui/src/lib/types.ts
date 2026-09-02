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

/** Local crash-log state from `crash_report_check` — `entry` is the newest
 * panic past the acknowledged offset, or null when nothing new happened. */
export interface CrashCheck {
  path: string;
  len: number;
  entry: string | null;
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

/** A git interactive-rebase verb the sequence editor exposes. */
export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

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

export type CommitSignatureKind = 'gpg' | 'ssh' | 'x509' | 'unknown';
export type CommitSignatureStatus =
  | 'unsigned'
  | 'verified'
  | 'good_untrusted'
  | 'bad'
  | 'expired_signature'
  | 'expired_key'
  | 'revoked_key'
  | 'cannot_verify'
  | 'unknown';

/** Lazily verified signature metadata for one immutable commit. */
export interface CommitSignature {
  kind: CommitSignatureKind | null;
  status: CommitSignatureStatus;
  signer: string | null;
  key: string | null;
  fingerprint: string | null;
  primary_fingerprint: string | null;
  trust: string | null;
}

/**
 * Field a full-history commit search matches against (the Rust `SearchMode`).
 * `content` is the pickaxe (`git log -G`) — commits whose diff added or removed
 * a matching line, which the loaded-window highlight can't do. `hash` is
 * deliberately absent: hash lookup stays a client-side prefix match.
 */
export type CommitSearchMode = 'message' | 'author' | 'content';

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
  /** Line number the note anchors to, or `null` for a whole-file note. */
  line: number | null;
  /**
   * Which side `line` counts on: `'old'` for a note on a deletion-only block
   * (the deleted line has no new-side number). Absent = `'new'` — notes
   * persisted before this field existed are all new-side.
   */
  side?: 'new' | 'old';
  /** Accepted AI findings stay distinguishable from human-authored notes. */
  source?: 'ai';
  severity?: CodeReviewSeverity;
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
  /** Tip is reachable from the primary branch; primary and HEAD stay false. */
  merged: boolean;
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
  /** Remote tip is contained by the primary branch; safe for merged cleanup. */
  merged: boolean;
}

export interface Remote {
  name: string;
  url: string | null;
  /** Explicit push-only URL; null means pushes use `url`. */
  push_url: string | null;
  fetch_refspecs: string[];
  push_refspecs: string[];
  /** Mirrors Git's repository-local `remote.pushDefault`. */
  is_default: boolean;
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
  primary_branch: string | null;
  remotes: Remote[];
  remote_branches: RemoteBranch[];
  tags: Tag[];
}

export type AzdoAuthMode = 'pat' | 'windows';

export interface AzdoServerProfile {
  id: string;
  name: string;
  collection_url: string;
  auth_mode: AzdoAuthMode;
  remote_prefixes: string[];
  ca_certificate: string | null;
}

export interface AzdoHelperStatus {
  enabled: boolean;
  installed: boolean;
  present: boolean;
  version: string | null;
  protocol_version: number | null;
  profiles: AzdoServerProfile[];
  authentication: Array<{
    profile_id: string;
    configured: boolean;
  }>;
  error: string | null;
}
