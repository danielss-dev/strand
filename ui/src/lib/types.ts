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

export interface NetworkOutcome {
  /** Combined stdout/stderr from `git`, trimmed. Show in a toast/log. */
  output: string;
}

/** Row in the `recent_repos` SQLite table. Frontend-managed. */
export interface RecentRepo {
  path: string;
  name: string;
  last_opened: number;
}
