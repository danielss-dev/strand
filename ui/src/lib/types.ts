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
  operation: 'rebase' | 'cherry-pick' | 'revert' | 'merge' | 'mailbox' | 'bisect' | null;
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
  output: string;
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

export interface ProviderConnectionStatus {
  installed: boolean;
  connected: boolean;
  account: string | null;
  detail: string;
}

export interface HostingConnectionStatus {
  github: ProviderConnectionStatus;
  azure_dev_ops: ProviderConnectionStatus;
}

export type PullRequestProvider = 'git_hub' | 'azure_dev_ops' | 'git_lab' | 'bitbucket';
export type PullRequestMergeStrategy = 'merge_commit' | 'squash' | 'rebase';
export type PullRequestLifecycleAction = 'close' | 'reopen';
export type PullRequestReviewEvent = 'comment' | 'approve' | 'request_changes';

export interface PullRequestRepository {
  provider: PullRequestProvider;
  remote: string;
  label: string;
  /** Signed-in provider account; null when the CLI cannot identify it. */
  viewer: string | null;
}

export interface PullRequestReviewer {
  name: string;
  status: string;
  required: boolean;
}

export interface PullRequestCheck {
  id?: string;
  name: string;
  status: string;
}

export interface PullRequestCommit {
  id: string;
  title: string;
  author: string;
  avatar_url: string | null;
  committed_at: string;
  url: string | null;
}

export interface PullRequestComment {
  id: string;
  author: string;
  avatar_url: string | null;
  body: string;
  created_at: string;
  url: string;
  is_system: boolean;
  /** Inline review comments report their file; top-level comments are null. */
  path: string | null;
}

export interface PullRequestReviewThread {
  suggestion_range_valid?: boolean;
  iteration_id?: number | null;
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  side: 'deletions' | 'additions';
  is_resolved: boolean;
  is_outdated: boolean;
  can_reply: boolean;
  can_resolve: boolean;
  can_unresolve: boolean;
  comments: PullRequestComment[];
}

export interface PullRequestReviewThreadUpdate {
  id: string;
  is_resolved: boolean;
  is_outdated: boolean;
  can_reply: boolean;
  can_resolve: boolean;
  can_unresolve: boolean;
}

export interface PullRequestReview {
  source_commit?: string | null;
  id: string;
  author: string;
  avatar_url: string | null;
  state: string;
  body: string;
  submitted_at: string;
  url: string;
  /** Provider-confirmed capability for editing this review's summary. */
  can_update: boolean;
  /** Provider-confirmed capability for dismissal, or resetting an Azure vote. */
  can_dismiss: boolean;
}

export interface PullRequestCompletion {
  kind: 'github_queue' | 'github_auto_merge' | 'azure_auto_complete';
  status: 'disabled' | 'queued' | 'waiting_for_policies' | 'merged' | 'closed';
  source_commit: string;
  position: number | null;
  can_enable: boolean;
  can_cancel: boolean;
  blockers: string[];
  strategies: PullRequestMergeStrategy[];
}

export interface PullRequest {
  completion?: PullRequestCompletion | null;
  data_pages?: PullRequestPageCursor[];

  capabilities?: { can_comment: boolean; can_review: boolean; can_request_changes: boolean; can_close: boolean; can_reopen: boolean; merge_strategies: PullRequestMergeStrategy[] };
  id: number;
  title: string;
  state: string;
  is_draft: boolean;
  /** True only when activated detail confirms the signed-in viewer may publish this draft. */
  can_mark_ready: boolean;
  author: string;
  source_branch: string;
  source_commit: string;
  target_branch: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  url: string;
  description: string;
  merge_status: string;
  review_status: string;
  comment_count: number;
  commit_count: number;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  labels: string[];
  reviewers: PullRequestReviewer[];
  checks: PullRequestCheck[];
  /** True when the provider's complete check/policy query succeeded. */
  checks_complete: boolean;
  comments: PullRequestComment[];
  review_threads: PullRequestReviewThread[];
  reviews: PullRequestReview[];
  authored_by_viewer: boolean;
  commits: PullRequestCommit[];
}

export interface PullRequestList {
  next_cursor?: string | null;
  total_count?: number | null;
  repository: PullRequestRepository;
  pull_requests: PullRequest[];
}

export interface PullRequestBranchMatch {
  repository: PullRequestRepository;
  pull_request: PullRequest;
}

export interface PullRequestCreateOutcome {
  id: number;
  url: string;
}

export interface PullRequestCheckoutPreparation {
  branch: string;
  start_point: string;
}

export interface PullRequestSuggestion {
  title: string;
  description: string;
}

export interface PullRequestActivityComment {
  id: string;
  author: string;
  kind: string;
  is_system: boolean;
}

export interface PullRequestActivityReview {
  id: string;
  author: string;
  state: string;
}

export interface PullRequestActivityCheck {
  id: string;
  name: string;
  status: string;
}

export interface PullRequestActivitySnapshot {
  repository: PullRequestRepository;
  id: number;
  title: string;
  url: string;
  state: string;
  source_branch: string;
  source_commit: string;
  updated_at: string;
  comments: PullRequestActivityComment[];
  reviews: PullRequestActivityReview[];
  checks: PullRequestActivityCheck[];
  checks_complete: boolean;
}

/** The branch a ref was forked from + the fork point to review against. */
export interface BaseBranch {
  name: string;
  merge_base: string;
}

export interface CheckoutOutcome {
  branch: string;
}

export interface PullRequestPendingComment {
  path: string;
  start_line: number;
  end_line: number;
  side: 'deletions' | 'additions';
  body: string;
}

export interface PullRequestReviewDraft {
  head_sha: string;
  body: string;
  comments: PullRequestPendingComment[];
}

export interface InitOutcome {
  path: string;
  initial_branch: string;
  initial_commit: string | null;
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

export type MaintenanceTask = 'maintenance' | 'garbage-collect' | 'integrity-check';

export interface MaintenanceOutcome {
  command: string;
  output: string;
  success: boolean;
  duration_ms: number;
}

export interface RepoActivityEntry extends MaintenanceOutcome {
  id: string;
  task: MaintenanceTask | 'commit' | 'amend';
  started_at: number;
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

/** One-off integration strategy for a pull. `default` honors git config. */
export type PullMode = 'default' | 'merge' | 'rebase' | 'fast-forward-only';

/** Per-repository defaults for primary network actions and Sync. */
export interface NetworkPreferences {
  fetchPrune: boolean;
  pullAutostash: boolean;
}

/** Push variants exposed by Strand. Unsafe plain force is intentionally absent. */
export type PushMode = 'default' | 'follow-tags' | 'force-with-lease';

/** Explicit refspec push; the source branch does not need to be checked out. */
export interface BranchPushRequest {
  branch: string;
  remote: string;
  remoteBranch: string;
  mode: PushMode;
  setUpstream: boolean;
}

export interface CloneOutcome {
  /** Absolute path of the cloned working tree, ready to open. */
  path: string;
  output: string;
}

export interface CloneOptions {
  branch: string | null;
  depth: number | null;
  single_branch: boolean;
  filter: 'blob-none' | null;
  recurse_submodules: boolean;
}

export interface CloneScope {
  shallow: boolean;
  remotes: { name: string; filter: string | null; fetch_refspecs: string[] }[];
}

export type HistoryExpansion = { kind: 'deepen'; commits: number } | { kind: 'unshallow' };

export interface SparseCheckout {
  enabled: boolean;
  cone: boolean;
  sparse_index: boolean;
  directories: string[];
  available: string[];
  patterns: string;
}

/** One file in the working-tree view (Files sidebar tab). */
export interface WorkTreeEntry {
  path: string;
  /** Change status, or `null` for a clean tracked file. */
  status: StatusKind | null;
  /** Git-ignored local file; intentionally not represented as a change status. */
  ignored: boolean;
  excluded?: boolean;
}

/** Shell used by Work's embedded terminal. Commands are tokenized into argv
 * and launched directly; Strand never inserts an intermediary shell. */
export type EmbeddedShellChoice =
  | { kind: 'system' }
  | { kind: 'preset'; id: string }
  | { kind: 'wsl'; distribution: string }
  | { kind: 'custom'; command: string };

export interface TerminalHandle {
  id: string;
  label: string;
}

export interface ShellCheck {
  available: boolean;
  label: string;
  executable: string | null;
  error: string | null;
}

export type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

export type FilesTreeMutationChange =
  | { kind: 'create'; path: string; directory: boolean }
  | { kind: 'delete'; paths: string[] }
  | { kind: 'move'; moves: Array<{ from: string; to: string }> }
  | { kind: 'refresh' };

export type FilesTreeMutation = FilesTreeMutationChange & {
  revision: number;
  repoPath: string;
};

/** A submodule's state relative to the superproject's recorded commit. */
export type SubmoduleState = 'uninitialized' | 'up-to-date' | 'out-of-date' | 'modified';

export type LfsAction =
  | { action: 'environment' | 'install' | 'patterns' | 'status' | 'objects' }
  | { action: 'track' | 'untrack'; pattern: string }
  | { action: 'fetch' | 'pull' | 'push'; remote: string }
  | { action: 'locks'; path: string }
  | { action: 'lock'; path: string }
  | { action: 'unlock'; id: string };

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

export type SubmoduleAction =
  | { action: 'add' | 'set-url'; path: string; url: string }
  | { action: 'remove' | 'deinit' | 'inspect'; path: string }
  | { action: 'sync' | 'update'; path: string; recursive: boolean };

export interface SubmodulePage {
  modules: Submodule[];
  next_offset: number | null;
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
  /** Why git considers it prunable, when a reason was given. */
  prune_reason: string | null;
  /** The primary worktree (holds the repo's own `.git`). */
  is_main: boolean;
  /** Matches the currently-open repo path. */
  is_current: boolean;
}

/** Ref-level health of a worktree's branch relative to its detected base. */
export interface WorktreeHealth {
  /** The branch this one forked from; `null` when undetectable. */
  base_branch: string | null;
  /** Every commit lives in some other local branch (safe to retire). */
  merged: boolean;
  /** The branch `merged` refers to; `null` when not merged. */
  merged_into: string | null;
  /** Commits on the branch that are not in the base. */
  ahead_of_base: number;
  /** Base tip is still the fork point, so integrating is a pure fast-forward. */
  can_fast_forward: boolean;
  has_upstream: boolean;
  /** Commits not on the upstream; 0 when `has_upstream` is false. */
  unpushed: number;
}

/** Workdir-level stats for one worktree (fleet-dashboard row data). */
export interface WorktreeStats {
  /** Total size of the working directory, `.git` excluded. */
  disk_bytes: number;
  /** Newest file mtime outside `.git` (Unix seconds); `null` for an empty tree. */
  last_activity_unix: number | null;
  /** Inserted lines across staged + unstaged tracked changes. */
  insertions: number;
  /** Deleted lines across staged + unstaged tracked changes. */
  deletions: number;
}

/** Where a snapshot restore put the worktree, and the re-attached branch. */
export interface RestoredWorktree {
  path: string;
  /** `null` when the restore stayed detached (branch held or moved on). */
  branch: string | null;
}

/** One archived worktree snapshot under `refs/strand/archive/`. */
export interface WorktreeArchive {
  /** Full ref name, e.g. `refs/strand/archive/feature-x/1751871234`. */
  ref_name: string;
  /** Slug segment — the branch (or `detached`) at archive time. */
  name: string;
  /** Snapshot commit oid. */
  oid: string;
  /** Creation time (Unix seconds). */
  time_unix: number;
  subject: string;
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
  /** Complete UTF-8 text that can safely be written back to the working tree. */
  editable: boolean;
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
 * A named group of repositories worked on together (e.g. the repos behind one
 * product). Membership is by canonical repo path (`RepoMeta.path`, == a tab's
 * `path`); a repo may belong to several workspaces. Opening a workspace opens
 * all its repos — adding to whatever's already open — and marks it active,
 * which clusters its members into their own rail/strip section. Persisted whole
 * in the generic `settings` table under the `workspaces` key.
 */
export interface Workspace {
  id: string;
  name: string;
  /** Canonical workdir paths of member repos (main repos; worktrees of a
   *  member inherit the section via their shared `common_dir`). */
  repoPaths: string[];
  /** Optional section accent — a `var(--b-N)` swatch or CSS color. */
  color?: string;
  /** Unix ms the workspace was created. */
  createdAt: number;
  /** Tab path last focused while this workspace was active — reopening the
   *  workspace lands here instead of on the first member. */
  lastActivePath?: string;
}

/**
 * User customization for a repo's square tile in the rail. Every field is
 * optional — an unset field falls back to the derived default (initials from
 * the repo name, a color hashed from the repo's git dir). `image`, when set,
 * wins over `emoji`, which wins over `letter`; `color` is the tile background
 * in all cases. Persisted per-repo path in the generic `settings` table.
 */
export interface RepoIcon {
  /** 1–2 character glyph override (e.g. "PB"). Empty/unset ⇒ derived initials. */
  letter?: string | null;
  /** Tile background — a CSS color or palette var (`var(--b-3)`). Unset ⇒ hashed. */
  color?: string | null;
  /** Emoji glyph; takes precedence over `letter`. */
  emoji?: string | null;
  /** Tile image as a data URL — a downscaled PNG, or an SVG kept as vector
   *  markup. Takes precedence over everything. */
  image?: string | null;
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

/** AI provider for writing suggestions (matches Rust `AiProvider`). */
export type AiProvider = 'openai' | 'anthropic';

export type HeroiAgentProvider = 'claude' | 'codex' | 'cursor';

export interface HeroiReasoningOption {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface HeroiModel {
  slug: string;
  name: string;
  isDefault: boolean;
  reasoning: HeroiReasoningOption[];
}

export interface HeroiModelCatalog {
  provider: HeroiAgentProvider;
  models: HeroiModel[];
}

export interface HeroiSkill {
  name: string;
  description: string | null;
  scope: 'user' | 'project';
}

export interface HeroiAgentRequest {
  path: string;
  provider: HeroiAgentProvider;
  prompt: string;
  sessionId: string | null;
  model: string;
  thinking: string;
  agentMode: 'plan' | 'build';
  permissionMode: 'read' | 'build' | 'full';
  cliPath: string | null;
}

export type HeroiAgentEvent =
  | { type: 'status'; message: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'activity'; id: string; label: string; detail: string | null; done: boolean };

export interface HeroiAgentOutcome {
  sessionId: string | null;
}

/** Status of a vendor CLI + login session (Settings → AI). */
export interface AiProviderStatus {
  provider: AiProvider;
  installed: boolean;
  logged_in: boolean;
  account_hint?: string | null;
  /** The CLI exists but failed its status probe. */
  error?: string | null;
}

/** Suggested commit message from `repo_suggest_commit_message`. */
export interface CommitMessageSuggestion {
  subject: string;
  body: string | null;
}

export type CodeReviewSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface CodeReviewFinding {
  path: string;
  line: number | null;
  side: 'new' | 'old';
  severity: CodeReviewSeverity;
  title: string;
  body: string;
}

export interface CodeReviewSuggestion {
  findings: CodeReviewFinding[];
}

export type AiSensitiveDecision =
  | { mode: 'scan' }
  | { mode: 'exclude'; fingerprint: string }
  | { mode: 'include'; fingerprint: string };

export interface AiGenerationRequest {
  opId: string;
  sensitiveDecision: AiSensitiveDecision;
  styleInstruction: string | null;
}

export type AiInputScope = 'staged' | 'unstaged' | 'committed' | 'review';

export interface AiInputCoverage {
  scope: AiInputScope;
  totalFiles: number;
  manifestFiles: number;
  patchFiles: number;
  omittedPatchFiles: number;
  truncatedPatchFiles: number;
  sensitiveExcludedFiles: number;
}

export type AiSensitiveKind =
  | 'environment_file'
  | 'credential_file'
  | 'private_key'
  | 'certificate'
  | 'credential_pattern';

export interface AiSensitiveFile {
  path: string;
  kinds: AiSensitiveKind[];
}

export type AiGenerationOutcome<T> =
  | {
      status: 'needs_confirmation';
      fingerprint: string;
      coverage: AiInputCoverage;
      sensitiveFiles: AiSensitiveFile[];
    }
  | {
      status: 'generated';
      suggestion: T;
      coverage: AiInputCoverage;
      provider: AiProvider;
    };

export interface PullRequestPageCursor {
  kind: 'comments' | 'commits' | 'reviews' | 'threads' | 'replies' | 'checks';
  thread_id: string | null;
  cursor: string | null;
  total: number | null;
  error: string | null;
}
export interface PullRequestDataPage {
  source_commit: string;
  request: PullRequestPageCursor;
  pending: PullRequestPageCursor[];
  comments: PullRequestComment[];
  commits: PullRequestCommit[];
  reviews: PullRequestReview[];
  review_threads: PullRequestReviewThread[];
  checks: PullRequestCheck[];
}

export interface PullRequestBoundary { head: string; label: string; iteration: number | null }
export interface PullRequestComparison { from: string; to: string; history_rewritten: boolean; diffs: FileDiff[] }
export interface PullRequestFeedback { source_commit: string; threads: PullRequestReviewThread[] }
export interface PullRequestSuggestionRequest {
  thread_id: string; comment_id: string; suggestion_index: number;
  expected_head: string; expected_body: string;
}
export interface PullRequestSuggestionPreview {
  path: string; start_line: number; end_line: number;
  before: string; after: string; expected_file: string;
}

export interface RemoteHostingProvider { remote: string; url: string; provider: string }
export interface PublishDestination { id: string; label: string; kind: string }
export interface PublishAccount { account: string; account_id: string; destinations: PublishDestination[] }
export interface PublishRequest { provider: 'github' | 'gitlab' | 'bitbucket'; host: string; account_id: string; destination: string; name: string; visibility: 'private' | 'public'; remote: string }
export interface PublishState {
  id: string; request: PublishRequest; account: string; destination: PublishDestination;
  url: string; clone_url: string; branch: string; head: string;
  stage: 'review' | 'uncertain' | 'created' | 'remote_ready' | 'pushed'; error: string | null;
}

export interface ScopedValue {
  value: string;
  scope: string;
  origin: string;
}
export interface EffectiveIdentity {
  identity: string | null;
  error: string | null;
  name_source: ScopedValue;
  email_source: ScopedValue;
}
export interface RepositoryIdentity {
  author: EffectiveIdentity;
  committer: EffectiveIdentity;
  local: GlobalIdentity;
}

export type SigningMode = 'inherit' | 'sign' | 'unsigned';
export type SigningScope = 'local' | 'worktree';
export interface SigningSettings {
  effective: Record<string, ScopedValue>;
  local: Record<string, ScopedValue>;
  worktree: Record<string, ScopedValue>;
  worktree_enabled: boolean;
  commit_sign: boolean;
  tag_sign: boolean;
  tag_force_annotated: boolean;
}
export interface TagVerification {
  oid: string;
  status: 'unsigned' | 'verified' | 'failed';
  output: string;
}
