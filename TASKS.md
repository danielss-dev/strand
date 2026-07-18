# Tasks

Granular work to take Strand from "scaffold that boots" to "shippable app".
Grouped by area. Priority `P0`/`P1`/`P2`/`P3` matches PRD §6.

Legend: ☐ not started · ◐ in progress · ☑ done · ✗ blocked

---

## Blockers (resolve before starting dependent work)

- ☑ **PRD Q1: Pierre library licensing.** Approved 2026-05-25 — both
  `@pierre/diffs` and `@pierre/trees` cleared for use. Diff, tree, and
  commit-graph rendering can proceed.
- ☑ **PRD Q2: OSS vs source-available.** AGPL-3.0 for the public source
  + dual-license commercial SKU as the honor-system path for companies.
  LICENSE (AGPL-3.0) and COMMERCIAL.md landed 2026-06-12; still needs a
  CLA before the repo opens to outside contributions.
- ☑ **PRD Q5: Pricing model.** Free for all individuals; one-time
  commercial license available for companies that want to support the
  project. No feature gating, no nag dialogs.

---

## 1.0 Git-client parity program (audited 2026-07-16)

Detailed comparison and sequencing: [`docs/git-client-1.0-audit.md`](./docs/git-client-1.0-audit.md).

- ☑ **Network/ref ergonomics — first slice.** Explicit pull modes (Git config,
  merge+FF, rebase, FF-only), normal / follow-tags / all-tags pushes, guarded
  force-with-lease with a dedicated confirmation, toolbar + palette access,
  current-branch network submenus, ref/SHA copy actions, and branch/worktree
  creation from tags (`PullMode` / `PushMode`, `ForcePushDialog`, sidebar menus).
- ☑ **Network/ref ergonomics — second slice.** Set/change/unset upstream,
  push a chosen non-current local branch to a chosen remote/ref, fetch/pull a
  selected remote branch, and persist a per-repo default pull strategy
  (`Repo::{set_branch_upstream,push_branch,fetch_branch,pull_branch}`,
  `BranchNetworkDialog`, `repoPullMode`).
- ☑ **Daily local Git close-out.** Initialize repository, line-level staging,
  stash-to-branch, ordered multi-commit cherry-pick, merge-mainline
  cherry-pick/revert, commit/ref comparison, interactive-rebase edit, and
  merge-preserving rebase are shipped.
- ☑ **Repository maintenance + activity history.** Cancellable integrity,
  incremental-maintenance, and guarded garbage-collection runs retain bounded
  per-repository command/output transcripts (`Repo::run_maintenance`,
  `repo_maintenance`, `MaintenanceDialog`, `repoActivity`).
- ☑ **Working-tree file actions.** Create file/folder, exact folder targeting,
  external editor/reveal, relative/absolute path copy, direct history/blame,
  rename, and confirmed deletion are available from the Files tree and Quick
  Launch (`Repo::{create_worktree_entry,delete_worktree_entries,reveal_in_file_manager}`,
  `FileEntryDialog`, `Sidebar.fileMenu`).
- ☑ **Commit metadata + selection actions.** Commit detail lazily verifies
  GPG/SSH/X.509 signatures, copies subject/body, and exports exact commits;
  graph multi-selection adds ordered patch-series export plus SHA/subject/full-
  message copy actions (`Repo::{commit_signature,export_commit_patches}`,
  `CommitDetail.SignatureSummary`, `Commits.openCommitMenu`).
- ☑ **Hosted review close-out.** Exact-head Azure Services/Server inline
  comments and batched-review drafts resolve iteration/change-tracking
  coordinates before writing (`azure_review_coordinates`, Server protocol v5,
  shared Code composer).
- ◐ **Stable-release hardening.** Production CSP, the exact least-privilege
  desktop capability allowlist, signed stable-update policy enforcement, and
  the fresh-clone hook warning, and the typed English localization baseline are
  shipped. Linux AppImages are keyless-signed with Sigstore and the full
  keyboard/accessibility pass is closed. Windows publisher signing, real
  macOS/GNOME/KDE candidate validation and the
  release-quality checklist remain (`docs/release-checklist.md`).
- ☑ **Power parity selection.** Keep the already-shipped signature verification
  and exact patch/series export in 1.0; defer guided bisect, LFS management,
  signing controls/key selection, Git-flow, sparse checkout, patch import/
  mailbox/bundles, expanded submodule lifecycle, and custom actions explicitly
  to 1.1 (`docs/git-client-1.0-audit.md`, decision recorded 2026-07-18).

---

## strand-core (Rust git engine)

### Reads
- ☑ `Repo::discover`
- ☑ `Repo::meta` (branch + real ahead/behind via `git2::graph_ahead_behind`;
  `detached` flag via `git2::head_detached`, short OID as the branch label)
- ☑ `Repo::status` (via git2)
- ☑ `Repo::log` (revwalk across **all refs** — local + remote branches + tags +
  HEAD, so the graph shows the whole repo regardless of the checked-out branch;
  no graph lane data — that's computed UI-side in `lib/graph.ts`)
- ☑ `Repo::diff_unstaged` / `diff_staged` / `diff_between` — emit per-file
  unified-patch text consumed by `<PatchDiff>` (Pierre parses hunks);
  untracked files include their full content via `show_untracked_content`
- ☑ Rename detection (`DiffFindOptions::renames(true).copies(true)`)
- ☑ Resolve refs (branches, remotes, tags) into typed structs
  (`Repo::refs` → `Refs { branches, remotes, remote_branches, tags }`;
  exposed via `repo_refs` IPC; per-branch upstream + ahead/behind)
- ☑ `Repo::work_tree` — working-tree file listing (index entries ∪ untracked,
  ignored excluded, overlaid with change status) powering the Files sidebar tab
- ☑ Stash list (`Repo::stash_list` via `git2::stash_foreach`; `Stash { index,
  oid, message, branch }`, newest-first; `parse_stash_branch` reads the branch
  out of git's `WIP on <branch>:` / `On <branch>:` message)
- ☑ Submodule list + status (`Repo::submodules` via git2 — recorded vs
  checked-out OIDs, status reduced to uninitialized / up-to-date / out-of-date /
  modified)
- ☑ Reflog reader (`Repo::reflog(selector, limit)` via `git2::Repository::reflog`
  — per-entry old→new OID, committer, time, message; newest-first; unborn HEAD →
  empty. `reflog.rs`, with std-only tests covering empty/ordering/limit.)
- ☑ Blame (`Repo::blame` via `git2::blame_file` — per-line commit/author/summary
  against HEAD, per-commit summary cache, 50k-line cap)
- ☑ File history for a path (`Repo::file_history` — `git log --follow --numstat`,
  rename-following with per-path add/del counts)
- ☑ Merge base of two commit-ishes (`Repo::merge_base` in `refs.rs` — git2
  `revparse_single` + `merge_base`; powers the worktree review-vs-base baseline)
- ☑ Tree listing for a commit (`Repo::tree_at` + `repo_tree_at`, path-sorted
  blob/gitlink walk with focused revision tests)
- ☑ File content at a revision (`Repo::file_content` — working tree from disk via
  `safe_workdir_path`, or a blob at a revision; binary heuristic + 2 MB cap)
- ☑ Raw file blob at worktree / index / revision (`Repo::file_blob` in `file.rs` —
  `FileBlob` + `BlobSource`, base64 over IPC via a std-only `base64_encode`, 8 MB
  cap with a metadata pre-check on the worktree path, behind `safe_workdir_path`;
  powers the image diff preview)
- ☑ Commit search (message, author, hash, content). In-graph highlight over the
  loaded log stays **client-side** (`Commits.tsx` `commitMatches`); full-history
  search is now backed by `Repo::search_log(query, mode, limit)` (`log.rs`):
  `--grep` / `--author` (`--fixed-strings -i`) reach beyond the loaded window,
  and **`-G` (the pickaxe)** searches commit diffs — exposed via `repo_search_log`
  and a Content field mode + results dropdown. (`-S` occurrence-count pickaxe is
  a possible refinement; hash search stays a client-side prefix match.)

### Writes
- ☑ Stage / unstage path (`Repo::stage_path` / `unstage_path` via git2)
- ☑ Stage / unstage / discard **many** paths in one call (`Repo::stage_paths` /
  `unstage_paths` / `discard_paths` — open the repo + write the index once, vs
  the old per-path loop; `reset_default` takes the whole pathspec list)
- ☑ Stage / unstage hunk + sub-hunk change block (unstaged: per-block
  Stage via `Repo::apply_patch(ApplyTarget::Index)`. Staged: per-block
  Unstage via `Repo::apply_patch(ApplyTarget::IndexReverse)`. TS-side
  `sliceChangeBlock` carves a synthetic single-hunk patch matching
  Pierre's `DiffAcceptRejectHunkConfig.changeIndex` semantics, so each
  click acts on one `ChangeContent` group.)
- ☑ Stage / unstage line (`sliceSelectedLines` rewrites unselected change
  lines to apply-side context; `HunkAnnotatedDiff` supports Pierre drag
  selection plus a keyboard-operable `LinePicker` with exact line checkboxes.)
- ☑ Discard working-tree changes (path) — file-level
- ☑ Discard hunk / line + single-undo handle (per-block / selected-line Discard:
  `Repo::apply_patch(ApplyTarget::WorkdirReverse)` reverse-applies the
  sliced patch to the working tree. Single-undo shipped: `ApplyTarget::Workdir`
  forward-applies the same slice back, surfaced as an Undo toast for 6s via
  `discardPatch` / `undoDiscard` + `lastDiscard` handle. Partial new/deleted
  files normalize to modification headers so one-line operations cannot be
  mistaken for whole-file creation/deletion.)
- ☑ Commit (subject + body + amend). **Signing works** (`commit.rs` rewrite):
  when `commit.gpgSign=true` in the merged config (`signing_enabled`), the
  commit shells out via `commit_via_git` — the user's real `git commit -F
  <tempfile> --cleanup=whitespace [--amend]` — so gpg/ssh format config, key
  lookup, and hooks come for free, and a signing failure surfaces as `Err`
  instead of a silent unsigned commit. Default (unsigned) path stays git2,
  byte-identical to before. (The GPG sign *status indicator* is still ☐ under
  Commits view.)
- ◐ Create / delete branch (`Repo::create_branch` from any revspec —
  HEAD, commit, remote-tracking branch; auto-sets upstream when starting
  from a remote branch. `Repo::delete_branch` refuses HEAD. Checkout
  from commit still pending.)
- ☑ Rename branch (`Repo::rename_branch` in `branch.rs` — git2 `find_branch` +
  `rename`, no force; upstream config moves with the rename and HEAD follows a
  current-branch rename for free. Sidebar branch menu "Rename branch…" + palette
  "Rename current branch…" → `RenameBranchDialog`.)
- ☑ Remote add / remove / rename / separate URLs / default / prune / refspec
  inspection (`remote.rs` via git2 — blank-input
  validation, URL/name safety gates (no `ext::`/`fd::`, no leading `-`),
  duplicate name mapped to "remote X already exists", rename "problems"
  returned for a warning toast (the rename has already happened by then),
  native `remote.pushDefault` follows rename/remove, and `Remote` exposes
  fetch/push refspecs. Sidebar/palette actions cover scoped prune, default
  selection, read-only refspec inspection, Edit URLs, Rename, copy URLs, and
  confirmed Remove via `RemoteDialog`.)
- ☑ Reset soft / mixed / hard (`Repo::reset` in `reset.rs` — `ResetMode` /
  `ResetOutcome`; refuses while a merge/rebase/cherry-pick/revert is paused; a
  hard reset of a tracked-dirty tree first stashes a safety snapshot ("Safety:
  before hard reset to <short>", tracked changes only — `reset --hard` never
  touches untracked files), reported in the outcome + toast.
  UI: graph context menu "Reset <branch|HEAD> to here…" → `ResetDialog`
  (radiogroup, mixed default, danger-styled hard) and the Reflog's "Reset HEAD
  here…"; palette "Undo last commit (soft reset)" = soft reset to `HEAD~1`,
  gated on a non-root HEAD.)
- ☑ Rename / move a working-tree entry (`Repo::move_path` in `rename.rs` —
  `to` is the full destination path. Tracked sources (any index entry at the
  path or under it) shell out to `git mv` so the index entry moves with the
  file: staged content preserved, directory moves and case-only renames on
  case-insensitive filesystems handled natively. Untracked sources are a
  plain fs rename. Refuses to overwrite; creates missing destination parent
  dirs (inert to git); both ends path-guarded — `safe_workdir_path` for the
  source, an ancestor-walking variant for the not-yet-existing destination.
  Std-only tests: tracked/untracked/directory moves, overwrite + missing +
  no-op guards, traversal/absolute rejection. Powers the Files-tree
  drag-and-drop + Rename dialog.)
- ☑ Gitignore quick-add (`Repo::gitignore_add` in `ignore.rs` — validates
  (non-empty, no `\n`/`\r`), no-ops on an exact duplicate line, newline-safe
  append to the workdir-root `.gitignore`, creating it if absent. Context menus
  on a *single untracked* file — Local Changes Unstaged tree + sidebar Files
  tab — offer "Add to .gitignore" (root-anchored `/path`) and "Ignore all
  *.<ext> files"; patterns built by `ignorePatterns` in `lib/ignore.ts`.)
- ☑ Checkout branch / commit (`Repo::checkout_branch` — safe checkout,
  errors on dirty conflicts; `Repo::checkout_commit` — safe detached-HEAD
  checkout of any revspec via `set_head_detached`.)
- ☑ Create / delete tag (`Repo::create_tag` — lightweight when message is
  empty, annotated via `git2::Repository::tag` + config signature when set;
  `force` overwrites; `Repo::delete_tag` via `tag_delete`. `tag.rs`, with a
  std-only integration test covering both flavours + force + delete.)
- ☑ Push / delete tags on a remote (`Repo::push_tag` — `git push <remote>
  [--delete] refs/tags/<tag>`; `Repo::push_all_tags` — `git push <remote>
  --tags`; both shell out via `run_git_streaming` like the other network ops.
  Default remote resolves to HEAD's upstream remote → `origin` → first remote.
  Branch push now exposes `--follow-tags` through `PushMode::FollowTags`.)
- ☑ Stash create / snapshot / apply / pop / drop / branch-from (`stash_save` via `stash_save2`
  with `INCLUDE_UNTRACKED` / `KEEP_INDEX` flags — a clean tree returns
  `StashOutcome { oid: None }` instead of erroring; `stash_snapshot` keeps the
  changes in place via `git stash create` + `store` (or `push -u` + `apply
  --index` when including untracked); `stash_push_paths` for partial stashes via
  `git stash push -- <pathspec…>` (+ snapshot re-apply); `stash_drop` by index).
  `stash_apply` / `stash_pop` shell out to `git` (`run_git` helper) so a dirty
  index merges like real git instead of git2's blanket "uncommitted changes in
  the index" refusal. `Repo::stash_branch` shells out to `git stash branch`,
  exposed in the sidebar and command palette through `BranchDialog`.)
- ☑ Cherry-pick (single + multi) — `Repo::cherry_pick(&[oid], mainline)` shells
  out to `git cherry-pick`; the detail/context actions handle single commits and
  merge-parent selection, while the graph toolbar orders a multi-selection
  oldest-to-newest via `selectedCommitsOldestFirst` before applying it.
- ☑ Revert (`Repo::revert(&[oid], mainline)` — `git revert --no-edit`;
  commit-detail/context actions include merge-parent selection via
  `MainlineDialog`.)
- ☑ Merge (ff / no-ff / squash) (`Repo::merge(refname, MergeMode)` — `git merge`
  `[--no-ff|--squash] --no-edit`; sidebar branch menu "Merge into <current>" →
  `MergeDialog` with the three strategies. Squash leaves the result staged.)
- ☑ Rebase (onto branch, onto commit) (`Repo::rebase(onto)` — `git rebase <onto>`,
  any revspec; sidebar branch menu "Rebase <current> onto this", confirm step.)
- ☑ Abort in-progress op (`Repo::abort_operation` — detects rebase / cherry-pick
  / revert / merge from `.git/` markers and runs the matching `--abort`; surfaced
  by `RepoMeta.operation` + the in-progress banner and a ⌘K "Abort <op>" action.)
- ☑ Continue in-progress op (`Repo::continue_operation` — same marker detection,
  runs the matching `--continue` with `GIT_EDITOR=true` so it never blocks; a
  paused rebase only advances this way, not via a commit. Surfaced by the
  `OpBanner` "Continue" button, gated until conflicts clear.)
- ☑ Interactive rebase (custom sequence-editor; shells out) — `Repo::rebase_todo`
  lists `base..HEAD`; `Repo::interactive_rebase(base, steps)` drives `git rebase
  -i` with **no editor**: the todo is fed via `GIT_SEQUENCE_EDITOR=cat
  "$STRAND_REBASE_PLAN" >`, `GIT_EDITOR=true` keeps squash on git's default
  combined message, and `reword` is `pick` + `exec git commit --amend -F <msg>`
  so a new message maps to the right commit. UI = `views/RebaseEditor.tsx`
  (keyboard-operable reorder/pick/reword/edit/squash/fixup/drop), launched from the
  commit context menu + `CommitDetail` ("Rebase from here…"), the current-branch
  sidebar menu, and ⌘K "Interactive rebase…". Conflicts route to Local Changes
  → resolve → Continue. (Std-only round-trip + conflict/continue tests in
  `history.rs`.)
- ☑ fixup! commits + autosquash (frontend-only). Graph context menu "Create
  fixup! commit" commits the staged set as `fixup! <subject>` via the existing
  store `commit` (disabled with a "(stage changes first)" hint). Opening the
  rebase editor then auto-arranges the plan like `git rebase --autosquash`:
  `autosquashPlan` in `lib/rebase.ts` (pure; exact-subject → subject-prefix →
  oid-prefix target resolution, stacked prefixes stripped, unmatched stay
  `pick`) seeds `RebaseEditor.tsx`, which shows an "Autosquash: N fixup
  commits moved…" notice; the seeded plan stays fully editable.
- ☑ Interactive rebase: `edit` (pause-to-amend) action (`RebaseAction::Edit`
  leaves Git's rebase markers active; Local Changes amend + OpBanner Continue
  completes the plan, with later reword files persisted across the pause)
- ☑ Interactive rebase: preserve merges (`--rebase-merges`) — enabled by
  default for merge ranges; Strand's sequence editor retains Git's generated
  label/reset/merge topology while applying pick/reword/edit/drop actions
- ☑ Cherry-pick / revert a merge commit (validated `-m` support in
  `Repo::{cherry_pick,revert}` + keyboard-operable `MainlineDialog`)
- ☑ Submodule init / update / sync (`Repo::submodule_update` — `git submodule
  update [--init] [--recursive] [-- paths]`, shelled out + streamed like the
  other network ops)

### Network
- ☑ `fetch` (shell-out to `git fetch --prune`)
- ☑ `pull` (shell-out; typed `PullMode` exposes Git-config default, explicit
  merge with fast-forward when possible, rebase, and fast-forward-only through
  the toolbar network menu, current-branch context menu, and command palette)
- ☑ `push` (shell-out; typed `PushMode` exposes normal, `--follow-tags`, and
  guarded `--force-with-lease` pushes through the toolbar/branch menus and
  command palette; plain `--force` is intentionally unavailable;
  `Repo::push` creates `origin/<branch>` and sets it as upstream on the first
  push of an otherwise unconfigured local branch — DAN-10)
- ☑ Set / change / unset a local branch's upstream from the branch menu
  (`Repo::set_branch_upstream`, `BranchNetworkDialog`).
- ☑ Push a chosen non-current local branch to a chosen remote/ref without
  checking it out first; first-push naming + set-upstream are explicit
  (`Repo::push_branch`, `repo_branch_push`).
- ☑ Pull/fetch a chosen remote branch from its context menu, with the same
  strategy and progress/cancellation model as the current-branch toolbar
  (`Repo::{pull_branch,fetch_branch}`, remote-branch context menu).
- ☑ Persist fetch-prune, pull-strategy, and pull-autostash defaults per
  repository, with explicit one-operation overrides (`repoNetworkPreferences`,
  `Repo::{fetch,pull,pull_branch}` explicit flags, topbar/palette actions).
- ☑ Edit a remote's fetch and push URLs independently (`RemoteDialog`,
  `repo_remote_set_urls`, native Git remote config).
- ☑ Credentials: inherit user's `git` config (helper, SSH agent) via
  shell-out + `GIT_TERMINAL_PROMPT=0`. Native `auth-git2` integration
  with OS keychain is a future polish.
- ☑ Streaming progress events for fetch / pull / push (`git --progress`
  stderr parsed to `Progress { phase, percent, raw }`, streamed over a Tauri
  `Channel`; commands are `async` + `spawn_blocking`; stdout drained on a
  side thread so neither pipe deadlocks)
- ☑ Clone (HTTPS / SSH) with streaming progress (`network::clone` shells out
  to `git clone --progress`; returns the dest path to open)
- ☑ Push / delete tags on a remote (`Repo::push_tag` /
  `Repo::push_all_tags` — `git push <remote> [--delete] refs/tags/<tag>` and
  `git push <remote> --tags`, shelled out + streamed like the other net ops)
- ☑ Delete a branch on a remote (`Repo::delete_remote_branch` —
  `git push <remote> --delete refs/heads/<branch>`, shelled out + streamed; the
  push drops the local `refs/remotes/<remote>/<branch>` tracking ref too, so a
  refs refresh clears the sidebar row)
- ☑ Remote tag listing (`Repo::remote_tags` via `git ls-remote --tags` —
  fetched tags share `refs/tags/`, so ls-remote is the only way to know which
  tags a remote has; used to gray out "delete on remote" for absent tags)
- ☑ Cancellation for clone/fetch/pull/push (`network::CancelHandle` parks the
  spawned child so `cancel()` can kill it → `Error::Cancelled`; ops register
  under a frontend op id in `AppState.ops`, `repo_cancel_op` kills by id;
  Cancel button on the network pill + clone popup, cancelled ops toast
  quietly instead of erroring)

### Hybrid concerns
- ☑ Write-engine policy decided: `git2` for index/commit ops (stable
  Rust API, no spawn overhead); shell-out to user's `git` for network
  ops (credentials, hooks, LFS, GPG come for free) — and, since the signing
  work, for commits when `commit.gpgSign=true` (see Writes → Commit)
- ✗ Repo cache to avoid re-`discover` per command on hot paths — declined by
  measurement 2026-07-06 (discover ~1ms flat; the real per-command waste was
  redundant git2 opens *within* one command, fixed by the per-`Repo` cached
  handle — see Performance → Audit follow-ups)
- ☐ Tracing spans on every public fn for perf diagnostics

---

## strand-tauri (IPC + app shell)

- ☑ Read commands: `repo_open`, `repo_meta`, `repo_status`, `repo_log`,
  `repo_search_log`,
  `repo_refs`, `repo_diff_unstaged` / `_staged` / `_between`, `repo_tree`,
  `repo_tree_at`,
  `repo_submodules`, `repo_blame`, `repo_reflog`, `repo_file_content`,
  `repo_file_blob`, `repo_file_history`, `repo_diff_commit_file`,
  `repo_merge_base`
- ☑ Write commands: `repo_stage`, `repo_unstage`, `repo_stage_many`,
  `repo_unstage_many`, `repo_discard_many`, `repo_discard`,
  `repo_commit`, `repo_checkout`, `repo_checkout_commit`, `repo_branch_create`,
  `repo_branch_delete`, `repo_branch_delete_remote`, `repo_branch_rename`,
  `repo_remote_add`,
  `repo_remote_remove`, `repo_remote_rename`, `repo_remote_set_urls`,
  `repo_remote_set_default`,
  `repo_reset`, `repo_gitignore_add`, `repo_move_path`,
  `repo_tag_create`, `repo_tag_delete`,
  `repo_cherry_pick`, `repo_revert`, `repo_merge`, `repo_rebase`,
  `repo_rebase_todo`, `repo_interactive_rebase`,
  `repo_abort_operation`, `repo_continue_operation`,
  `repo_read_conflict_file`, `repo_resolve_conflict`,
  `repo_stash_list`, `repo_stash_save`,
  `repo_stash_snapshot`, `repo_stash_push_paths`, `repo_stash_apply`, `repo_stash_pop`, `repo_stash_drop`
- ☑ Network commands: `repo_fetch`, `repo_pull`, `repo_push`, `repo_clone`,
  `repo_tag_push`, `repo_tag_push_all`, `repo_remote_tags`,
  `repo_submodule_update` (all `async`; streaming progress over a `Channel`
  where applicable)
- ☑ Plugins: sql, updater, dialog, shell, os, process (relaunch for updates)
- ☑ SQLite migrations stub (`recent_repos`, `settings`)
- ☑ Capabilities: granted `sql:allow-execute` so SQLite writes land
  (`sql:default` only covers reads — silent failure trap, see
  `docs/learnings.md`)
- ☑ SQLite migration v2: `commit_messages` (per-repo commit message history —
  the feature it backed was removed 2026-07-02; the migration stays, applied
  migrations are append-only, the table is just unused)
- ☑ **Heal stale migration checksums (data-persistence bug fixed 2026-06-29).**
  sqlx records a SHA-384 checksum of each migration's SQL and refuses to open a
  DB whose stored checksum no longer matches the binary ("migration N was
  previously applied but has been modified"). Commit `3e1f0bb` reindented
  migration 1's SQL (whitespace-only), changing its checksum — so **every DB
  created before it, including public 0.x installs, failed to open**, which
  silently disabled session restore **and** all SQLite-backed settings
  persistence (the frontend caught the load error and fell back to defaults).
  Reverting the SQL can't fix it (it would break the newer cohort instead).
  Fix: `state::repair_migration_checksums` (`strand-tauri`) recomputes each
  migration's checksum and rewrites any stale `_sqlx_migrations` row **before**
  the SQL plugin's migrator runs (Tauri `setup`, before the webview's first
  `Database.load`). Safe because every migration is idempotent
  `CREATE … IF NOT EXISTS` — the applied schema is identical regardless of SQL
  whitespace — so no migration re-runs and no user data is touched. Verified
  against the real broken DB: v1 checksum healed (`5E02…`→`6D23…`), v2 then
  applied, session restore + persistence work, no console error. (sqlx + sha2
  added as direct deps — already in the tree via tauri-plugin-sql.)
  **Process rule going forward:** migrations are append-only; never edit an
  applied migration's SQL (even whitespace) — add a new versioned migration.
- ☑ Stream events for long-running ops (clone, fetch, push, pull) — via
  `tauri::ipc::Channel<Progress>`, no extra capability needed
- ☑ Real updater pubkey + endpoint. Pubkey done: minisign keypair generated
  (key ID `84FCBFD2A981CE5D`, private key at `~/.strand/`, off-repo) and wired
  into `tauri.conf.json` → `plugins.updater.pubkey`; `bundle.createUpdaterArtifacts`
  enabled so signed `latest.json` + bundles are produced (and published per
  release by CI since v0.5.0, all platforms). **Endpoint resolved (0.6.1,
  `ce1ffd0`):** the updater now points at the GitHub Releases manifest
  (`https://github.com/danielss-dev/strand/releases/latest/download/latest.json`),
  which `tauri-action` publishes per release — the dead `strand.danielss.dev/updates`
  host (it only ever served the landing page, so checks 404'd) is gone. CI opens a
  **draft** release; `releases/latest/download/` only resolves once it's published.
  (2026-06-07: on the Windows box the `TAURI_SIGNING_PRIVATE_KEY` in env does
  **not** match this pubkey — Tauri warns the locally-built `.sig` won't validate
  at runtime; CI builds sign with the matching secret. Reconcile the local
  key/config before relying on locally-built Windows auto-updates.)
- ◐ Native menus (PRD §7): **macOS menubar done** (`ui/src/lib/menu.ts`, built
  via `@tauri-apps/api/menu` + `setAsAppMenu`; Strand/File/Edit/View/Repository/
  Window menus wired to the same callbacks as the in-app UI — Settings ⌘,,
  Open ⌘O, Clone, palette ⌘K, views ⌘1–5, theme ⌘⇧T, Sync ⌘⇧S, Pull/Push,
  Open in Editor/Terminal; repo-scoped items disable when no repo is open and
  the menu reinstalls when that flips; App's keydown handler skips menu-owned
  accelerators via `appMenuInstalled()`). In-window Win/Linux menubar still ☐.
- ☑ Window state persistence: cross-platform Tauri window-state plugin restores
  size, position, and maximized state without startup flash; exact production-
  protocol binary verified maximize → close → relaunch with Computer Use
  (`tauri-plugin-window-state`, 2026-07-18).
- ☐ Multi-window for "open file detached" if needed
- ☑ Drag-and-drop folder onto window → opens repo
- ☐ Deep-link handler (`strand://open?path=…`) for CLI companion

---

## Frontend — components & wiring

### Repo opening
- ☑ Create a new local repository (initial branch + optional `.gitignore` /
  first commit), as required by PRD §6.1 P0 (`init_repository`, `repo_init`,
  `InitRepoDialog`, topbar/rail menus + command palette).
- ☑ "Open repository" command (palette + ⌘O + topbar `+` dropdown) using `plugin-dialog`.
  The picker is **multi-select** (`pickRepoDirectories`, `multiple: true`) — pick
  several folders at once and each opens as its own tab via `App.openMany`
  (sequential opens, mirroring session restore).
- ☑ "Clone repository" command (palette + topbar `+` dropdown) → `CloneDialog`
  (URL + native destination picker). The dialog now closes on submit and hands
  `(url, dest)` to `App.runClone`, which drives a **persistent progress popup**
  (`ProgressPopup`) — determinate bar + per-phase ETA from streamed git output —
  that stays until the clone finishes, then switches in place to "Opening" and
  opens the repo. **Clone/open failures switch the popup to a persistent,
  dismissible error state** (reason + Dismiss button, `role="alert"`, Escape to
  close) instead of vanishing — so a clone that dies (e.g. out of disk space) is
  never silently swallowed.
- ☑ Open progress: any repo open (`App.openByPath`) shows a persistent
  `ProgressPopup` — an **indeterminate** bar + elapsed time ("Opening <name>… 3s")
  for big repos that take a moment (200ms delay so small repos don't flash). Each
  op carries a generation id so overlapping opens/clones don't clear each other's
  popup.
- ☑ Drag-and-drop one or more folders → each opens as a tab (`App.openMany`)
- ☑ Recent-repos UI (sidebar empty-state + topbar `+` dropdown + command palette)
- ☑ Multi-repo tabs (open, switch active, close; deduplicates by canonical path)
- ☑ Tab persistence across launches (via `settings.session.tabs` in SQLite)
- ☑ Open-repositories presentation toggle (Settings → Appearance, `repoNav`):
  the default vertical icon rail (`components/RepoRail.tsx`) or a horizontal
  toolbar tab strip (`components/RepoTabs.tsx`, rendered in `Topbar` in place of
  the repo-name title). Both share the repo's customized tile color and the
  right-click icon-customization menu.
- ☑ Switch active repo from the keyboard — `tab-next` / `tab-prev` commands
  (`⌘`/`Ctrl+Tab` and `+Shift`, rebindable, palette entries "Next/Previous
  repository"); `App.cycleTab` wraps in on-screen order, works in both nav
  layouts.
- ☑ Tab-strip overflow handling: the pill lane scrolls (`components/RepoTabs.tsx`
  — wheel-to-horizontal, active auto-scrolls into view on switch) and a ▾ jump
  menu (shown only while overflowing) lists every open repo.
- ☑ Repo quick-switcher overlay (`switch-repo`, `⌘`/`Ctrl+E`, rebindable +
  palette entry "Switch repository…"): `views/RepoSwitcher.tsx` — a repo-only
  sibling of the command palette (reuses its shell + `lib/fuzzy`), fuzzy over
  open repos (switch active tab) and recents not open (opens them). ⌘K stays
  the full palette.
- ☐ Tab reordering by drag

### Workspaces (multi-repo groups)
- ☑ Workspace model + persistence + switcher + manager (Phase 1, reworked). A
  workspace is a named group of repo paths (`Workspace` in `lib/types.ts`),
  persisted whole in the generic `settings` table (`workspacesDb` in
  `lib/db.ts`, keys `workspaces` / `active-workspace`), owned by a dedicated
  `stores/workspaces.ts` (`useWorkspaces`) so the single-repo engine in
  `repo.ts` is untouched.
  **A workspace filters the rail/strip; it doesn't own the open set.** Active →
  the rail/strip shows only its repos (`workspaceMemberSet` in
  `lib/repoIdentity.ts`; worktrees inherit via `common_dir` even when the main
  tab is closed); non-members stay **open but hidden**. **The Default view is
  itself a reserved workspace** (`DEFAULT_WORKSPACE_ID`,
  `activeWorkspaceId === null`) with its own membership, so a named
  workspace's repos never leak into Default. **Membership changes only through
  explicit actions** (no delta tracking — the old open/close mirror corrupted
  memberships when async flows overlapped): `openRepoInActive` (every
  user-initiated open joins the active workspace), `closeRepo` (leaves the
  active workspace; tabs truly close only when no other workspace holds the
  repo; an emptied named workspace falls back to Default), and the manager's
  `addRepo`/`removeRepo` (removal from the *last* holding workspace closes the
  tabs). Open repos claimed by no workspace are adopted into Default
  (`initAfterRestore` at startup, and on workspace delete). The only
  subscription is a pure **focus reconciler** (keeps the active tab inside the
  visible set; guarded by a counter during switches — a mistimed guard can
  only delay a focus fix, never lose data). Switching is smooth:
  `openWorkspace` filters instantly, keeps the current repo when it's a member
  (else the workspace's persisted `lastActivePath`, else the first open
  member), and opens missing members via `openRepoBackground` (`repo.ts`) —
  parallel, unfocused, no per-repo full refresh; session restore uses the same
  background path (one full refresh for the final active tab). ⌘Tab cycling
  and the repo quick-switcher are workspace-aware (cycle skips hidden tabs;
  picking a hidden repo joins it to the active workspace). UI:
  `components/WorkspaceSwitcher.tsx` (Default row + named list + create /
  rename / delete / manage) in `RepoRail`/`RepoTabs`, and
  `views/WorkspaceManagerDialog.tsx` to curate each workspace's repos (add
  from recents/open **or from disk via the native folder picker**, remove;
  rename/delete named). Multi-membership holds at the model level (a path can
  be listed in several workspaces). **Path identity:** every repo-path
  comparison goes through `pathKey` (`lib/repoIdentity.ts` — separator,
  trailing-slash, and Windows `\\?\` verbatim tolerant): tab dedupe
  (`samePath` in `repo.ts` — git porcelain/`common_dir` spell paths
  differently than gix workdirs on Windows, which used to open the same repo
  twice), membership checks, recents (duplicate spellings healed + shadowed
  rows forgotten in `refreshRecents`), and persisted memberships (healed to
  native spelling + deduped in `load`). Never fabricate a re-spelled path to
  open or store — derive from the original string (`derivedMainPath`).
- ☑ Aggregated cross-repo review (Phase 2): `views/WorkspaceReview.tsx` shows
  changes from every member repo of the active workspace grouped repo→files,
  backed by a dedicated `stores/workspaceReview.ts` slice that fans the
  already-path-parameterized diff IPC across members (no Rust changes). Each
  member reviews in its own mode — **session** (`diff_since_full`) when that
  repo has a persisted baseline, **inbox** (`diff_unstaged_full`) otherwise —
  and reviewed marks read/write the same per-repo `reviewSession` records, so
  the aggregated view and each repo's own Review are two lenses on one state
  (the active repo's in-memory marks are mirrored via `useRepo.setState`).
  UI: one collapsible section per member (group-color dot, branch, mode chip,
  n/m reviewed, open-in-repo) each with its own `PierreTree`; a single
  whole-file-context diff pane (virtualized, read-only `<Diff>`; images via
  `ImageDiff`'s new `repoPath`/`refetch` props); `j`/`k` walks the merged
  queue across repo boundaries in tree display order (`workspaceQueueOrder`
  in `lib/workspaceReview.ts`, unit-tested), Space toggles reviewed, `s`
  stages, `d`-`d` discards (both per-member via `repo_stage_many` /
  `repo_discard_many`, rename-aware), `o` jumps into the file's own repo
  Review (pool pre-refreshed so the file selection sticks). **Live-follow:**
  the `repo://changed` listener now also feeds
  `useWorkspaceReview.handleExternalChange`, which refreshes the matching
  member slice while the view is open — including background members the
  single-repo store ignores. **One sidebar destination:** the Review row
  covers both lenses (active on either view; clicking lands on the
  single-repo lens), and a `[Repository | Workspace]` segmented control
  (`components/ReviewModeToggle.tsx`, the `HistoryModeToggle` pattern) in the
  main header flips between them — rendered only when the active workspace
  has ≥2 members. Also reachable via palette "Show: Workspace Review" and
  rebindable `view-workspace-review` (`Mod+6`). The v1 cuts have since
  landed under Phase 3: hunk-level stage/discard (2026-07-03), notes +
  repo-grouped feedback export (2026-07-04), ⌘F across member pools
  (2026-07-04), and per-worktree review members (2026-07-04).
- ☑ Workspace polish (Phase 3) — complete 2026-07-04:
  - ☑ Command-palette entries for workspace management (2026-07-02): a
    **Workspaces** palette group — one row per workspace (Default included;
    active one check-marked, others show a repo-count meta; the group appears
    once a named workspace exists and is included in the empty-query groups,
    so ⌘K → pick is a two-keystroke switch) running `openWorkspace`; Actions
    gain "New workspace…" + "Manage workspaces…". "New workspace…" opens
    `WorkspaceManagerDialog` in create mode (new `initialCreate` prop) — the
    manager grew its own create path (a "+ New workspace" row in the list;
    creating was switcher-menu-only before): the workspace is spawned with a
    placeholder name and the name field autofocuses with the text selected.
  - ☑ `.code-workspace` import (2026-07-02): palette "Import
    .code-workspace…" and an "Import .code-workspace…" row in the manager's
    workspace list create a named workspace from a VS Code workspace file.
    Parsing is pure TS (`lib/codeWorkspace.ts`, unit-tested): JSONC-tolerant
    (string-aware comment + trailing-comma stripping), local `path` entries
    only (remote `uri` ignored), relative paths joined against the file's
    directory *without* canonicalizing — each folder is validated through
    `repoOpen` and the canonical `meta.path` is what gets stored (the
    Windows re-spelling rule). File reading is a new gated IPC command
    (`workspace_file_read` in `strand-tauri` — name must end
    `.code-workspace`, ≤1 MB, so it can't be repurposed as a generic file
    reader; unit-tested). `useWorkspaces.importCodeWorkspace` returns
    added/skipped; non-repo folders are reported (toast / manager message),
    only zero-repos is an error. Verified end-to-end against the running
    Tauri app over CDP (import → open → members tabbed; error + gate probes).
  - ☑ Hunk-level stage / discard in Workspace Review (2026-07-03):
    inbox-mode member diffs render through the shared `HunkAnnotatedDiff`
    (was read-only `<Diff>`), with a new `onApplyBlock` override prop that
    routes each sliced change block to the owning member repo —
    `useWorkspaceReview.applyBlock` → `repo_apply_patch(path, …)` — instead
    of the active tab; session-mode diffs stay read-only, matching the
    single-repo Review. A block discard records the global single-undo
    handle pinned to the member's path, and `undoDiscard` (repo.ts) now
    forward-applies to the *recorded* repo rather than dropping the handle
    when another tab is active — the Undo toast recovers a background-member
    discard. Verified end-to-end against the running Tauri app over WebView2
    CDP (stage one block of a background member → `MM` with only that block
    staged; discard → toast → Undo restores the block while another repo is
    active; session-mode member renders zero hunk buttons). The perf-gated
    `window.__strand` hook now also exposes the `workspaces` +
    `workspaceReview` stores for such harness runs.
  - ☑ Notes + repo-grouped feedback export in Workspace Review (2026-07-04):
    the note loop from the single-repo Review works in the workspace lens —
    `m` / header "Note" / per-block "Note" open the same editor, notes render
    as chips above the diff and ✎n tree decorations, all persisted to the
    *owning member's* review session (`MemberReview.notes` mirrors the
    `reviewed` pattern: active repo reads the in-memory `reviewNotes`, others
    the DB; writes mirror back into `useRepo` when the member is the active
    tab — one note store, two lenses). A shared `makeReviewNote` factory
    (repo.ts) keeps note shape/id identical across both stores. "Copy
    feedback (N)" exports every member's notes as one **repo-grouped**
    Markdown prompt — `buildWorkspaceReviewFeedback` in `lib/reviewExport.ts`:
    `## repo (branch …)` sections with per-repo baseline context and the
    per-file rendering demoted to `###` (extracted `fileSection` helper
    shared with the single-repo builder); noted files that left the pool
    still export (same `collectFeedbackFiles` union), repos without notes
    are skipped, and the closing line tells the agent paths are
    per-repository. Verified: `tsc`, `vitest` (179, +3 workspace-export),
    and a live browser-mode pass against the dev vite (seeded members:
    m → editor → chip + ✎1 + count, block-Note pre-anchors L2, export
    matched the format byte-for-byte across 2 repos, × removal recounts).
  - ☑ ⌘F across member pools in Workspace Review (2026-07-04): the in-diff
    search bar works in the workspace lens — Mod+F (and the palette "Search
    in diff…" signal, which now stays on `workspace-review` instead of
    bouncing to Local Changes) opens the shared `DiffSearchBar` over a pool
    flattening every member's diffs, each entry `tag`ged with its owning
    repo path so identical file paths in two members stay distinct. Stepping
    selects across repo boundaries (`select({repo, file})`) and un-collapses
    the landing member's section; the preview line is repo-prefixed
    ("alpha · src/auth.ts") via a new optional `pathLabel` prop on
    `DiffSearchBar` (single-repo callers unchanged). A same-day follow-up
    (user feedback) made every ⌘F jump land on the matched **line**, not
    just the file — see the in-diff search line under Local Changes for the
    `lib/diffJump.ts` mechanics, shared by all three views. Verified: `tsc`,
    `vitest` (184), and live browser-mode passes against the dev vite
    (seeded members sharing a file path: 5-match census, cross-repo
    stepping + wrap landing dead-center on a deletion 4,501 rows into a
    5,003-row virtualized diff in both stacked and split layouts,
    collapsed-section un-collapse on jump, Esc close, palette signal opens
    in place).
  - ☑ Per-worktree review members (2026-07-04): every **open linked-worktree
    tab** of a member repo reviews as its own section in Workspace Review,
    right after its family's — `activeWorkspaceMembers` appends worktree tabs
    matched via `mainPathFromCommonDir(common_dir)`, so workspace membership
    itself stays family-level (main paths only; opening the worktree tab is
    the explicit act that adds it to the review, mirroring how worktrees
    inherit rail visibility). Each worktree slice reviews in its own mode
    with its own baseline, reviewed marks, and notes — those already persist
    per repo *path*, so a worktree's records were always distinct. A new
    `MemberReview.worktree` label (branch-derived, refreshed with meta)
    disambiguates every surface: "web · feat-auth" in the diff-pane repo
    chip, ⌘F preview lines, section aria-labels, and the feedback export's
    `##` heading; a neutral `worktree` tag chip (`.wsr-wt`) marks the section
    header, and the toolbar + main-header counts split into "N repos + M
    worktrees". `ReviewModeToggle` now counts review members, so one repo
    with an agent worktree open surfaces the [Repository | Workspace] toggle
    — aggregating the main checkout and the worktree is exactly what the
    workspace lens adds. Verified: `tsc`, `vitest` (185, +1
    ordering/exclusion test), `vite build`, and a live browser-mode pass
    against the dev vite (seeded main + worktree + second-repo tabs:
    resolution order & labels, worktree chip, j/k crossing into the worktree
    slice, ⌘F preview "web · feat-auth · src/auth.ts", note → export heading
    `## web · feat-auth (branch feat-auth)`, toggle appearing at 1 repo +
    1 worktree).

### Topbar
- ☑ Layout + native-chrome alignment
- ☑ Fetch / Pull / Push handlers (shell out to `git`; spinner + shimmer
  + directional bobbing animation while in flight; success flashes an
  inline accent-colored check on the button — `.sync-done` in chrome.css,
  `flashDone` in App.tsx — no longer a toast; failures still toast git stderr).
  A keyboard-operable chevron menu adds pull via Git config / merge / rebase /
  FF-only and push current / follow-tags / all-tags / force-with-lease; force
  push crosses `ForcePushDialog` and names the lease protection.
- ☑ Real ahead/behind counts (driven by `Repo::meta`)
- ☑ Branch picker dropdown (lists local + remote branches with upstream
  + ahead/behind; checkout local branch, track a remote branch, and an
  inline create-branch field with prefix autocomplete — ↑↓ chooses among
  prefix matches, Tab fills only the next `/` segment of the highlighted
  match, never a full leaf name)
- ☑ Stash split button (reuses `.sync-group`: primary face stashes all
  changes; chevron opens a menu with "Save snapshot…" plus ±untracked /
  keep-index create variants and "Pop latest", plus a live count badge.
  Self-contained — reads the store, takes `onToast` + `onSaveSnapshot`, like
  `BranchSwitcherButton`.)

### Sidebar
- ☑ Local Changes + All Commits primary rows
- ☑ Git / Files tab toggle
- ☑ Per-row actions via a right-click **`ContextMenu`** (`components/ContextMenu.tsx`):
  portal-rendered at the cursor (or the row corner when opened from the
  keyboard — Menu key / Shift+F10), ↑/↓/Enter/Esc navigable, viewport-clamped,
  closes on outside click. Destructive items carry a `confirm` flag that swaps
  to a "Confirm: …" step (replacing the old inline-`armed` row affordance).
  All leaf rows share one `SideLeaf` (icon + label + meta + primary click +
  `onMenu`); the old `BranchLeaf`/`TagLeaf`/`StashLeaf` + `.row-tools`/`.armed`
  CSS were removed.
- ☑ Branches list from real data — names with `/` render as nested
  folders (e.g. `feature/foo` lives under a `feature/` folder), default
  expanded, click chev to collapse. Leaf rows checkout on click; right-click
  menu = Checkout / New branch from here… (opens `BranchDialog` — named branch
  from any start point, optional checkout; also on remote rows, the Branches
  section `+`, and palette "Create branch…" from HEAD) / Merge into <current>
  (opens `MergeDialog`) / Rebase <current> onto this (confirm) / Delete branch
  (confirm). HEAD shows a disabled "Current branch".
- ☑ Merged-branch indicators (DAN-19 — `refs::Branch.merged` uses commit
  ancestry against the repository's primary branch; sidebar icons and
  commit-graph ref chips mark contained non-current branches that are safe to
  delete, without mislabeling the primary branch while a feature is checked out).
- ☑ Clear merged branches in bulk (`BranchCleanupDialog` +
  `mergedBranchCleanupPlan`: palette action with per-branch local selection,
  opt-in matching upstream/origin deletion, checked-out-worktree exclusion,
  remote-tip containment via `RemoteBranch.merged`, and a deletion-time
  `Repo::delete_branch(force=false)` containment/worktree guard).
- ☑ Ref clipboard/context expansion (2026-07-16): local branches copy name /
  full ref / SHA and the current branch exposes Pull + Push strategy submenus;
  remote branches copy short name / remote ref / SHA; tags copy name / SHA and
  can create a branch or worktree; stashes copy `stash@{n}` / SHA.
- ☑ Remotes list as a tree rooted at the remote name (e.g. `origin/` is
  the top folder). **All** remote-tracking branches show, including ones a
  local branch already tracks (`origin/main` stays visible with only `main`
  local, so you can branch from it). Tracked leaves activate by checking out
  their local branch (`tracked` meta tag, disabled "Tracked by current
  branch" when it's HEAD); untracked leaves — or the menu's "Create local
  branch & track" — create + track locally (name collision → `remote/branch`
  local name). Leaf menu also has "Delete branch on <remote>" (confirm,
  danger) → `deleteRemoteBranch` → `git push <remote> --delete`.
- ☑ Tags list (folder tree). Click checks out the tagged commit (detached HEAD
  via `checkoutCommit`); right-click menu = Checkout / Push to <remote> /
  Delete on <remote> (confirm) / Delete tag (confirm) — the two remote items
  hide when no remote is configured, and "Delete on <remote>" is grayed out
  for tags the remote doesn't have. Remote-tag knowledge is **stale-while-
  revalidate**: the `remoteTagsCache` (SQLite `settings`, keyed by repo path)
  paints the gray-out instantly on open, then a background `ls-remote`
  revalidates — at most once per repo per session, since our own push/delete
  keep the cache fresh (optimistic `setRemoteTags`). Section header `+` opens
  the New-tag dialog. Tag network ops toast success/failure; ⌘K "Push all tags".
- ☑ Stashes list — flat list under the Git tab. Click inspects and reveals the
  stash in All Commits without changing the worktree; double-click / Enter
  applies it. Right-click menu = Inspect changes / Apply / Pop (apply & remove)
  / Create branch / copy / Drop (confirm). Respects the sidebar filter (matches
  message + branch). Section header `+` action (`SideSection`'s optional
  `action` prop) opens the Save-snapshot dialog.
- ☑ Save-snapshot dialog (`views/StashDialog.tsx`, reuses the `.clone-dialog`
  shell): message field + selectable file checklist (pre-filled from Local
  Changes multi-select / active row / folder / show-all via
  `lib/stashPreselection.ts`) + "Include untracked files" + "Keep changes in
  working directory" checkboxes; primary CTA flips Stash / Save Snapshot.
  Partial stashes call `repo_stash_push_paths`. Reachable from the sidebar `+`,
  the Topbar stash menu (preview before confirm), Local Changes "Stash…"
  context menu, and ⌘K ("Save snapshot…" / "Stash changes…"). Clean tree
  surfaces "Nothing to stash" inline.
- ☑ New-tag dialog (`views/TagDialog.tsx`, reuses the `.clone-dialog` shell):
  name field + optional message (non-empty ⇒ annotated, else lightweight, with
  a live hint). Targets HEAD from the Tags `+` and ⌘K ("Create tag…"), or a
  specific commit from the commit-detail "Tag…" action. App owns the dialog
  state; the target is plumbed App → Commits → CommitDetail.
- ☑ Submodules list — flat list under the Git tab from `repo_submodules`, with a
  status badge (uninit / out of date / modified). Double-click opens the
  submodule as its own tab (joins the superproject path + sub path via
  `openByPath`); right-click menu = Open submodule / Update (or Init & update) /
  Copy path; the section header `sync` action updates all (`--init --recursive`).
- ☑ Files tree — working-tree folder tree from `repo_tree`, status badges,
  click-to-open; lazily loaded when the Files tab is shown and refreshed on
  status change. `PierreTree` now reports whether a selected row is a file or
  synthesized folder; `FileView.DirectoryTab` renders a folder's immediate
  children with the shared tree file-type icons, descendant/change counts, and
  keyboard navigation without sending the directory path to
  `repo_file_content`.
- ☑ Language-aware icons for source types missing from Pierre's complete set
  (`lib/treeIcons.ts`: real Material Icon Theme SVG marks in one static custom
  sprite + file-rule maps shared by every `PierreTree`, including C#, F#,
  Visual Basic, JVM, scripting, CMake, Razor, and XML files).
- ☑ Drag-and-drop rename / move in the Files tree (2026-07-06). `PierreTree`
  grew an opt-in `onMove(sources, targetDir)`: **pointer-based** drag (rows
  live in Pierre's shadow root where nothing can be marked `draggable`, but
  mouse events compose across the boundary like the existing click/menu
  handlers), imperative refs + direct DOM so the 60Hz mousemove never
  re-renders the tree. 5px threshold keeps plain clicks intact; a
  cursor-chasing ghost chip (`.tree-drag-ghost`) names the entry and its
  prospective target ("rootfile.txt → src/", dashed when invalid); folder
  rows get a `--bg-sel` wash (inline style — the diff-jump shadow-boundary
  precedent); a file row targets its containing folder, bare tree space the
  repo root; Escape cancels. Dragging a multi-selected file moves the whole
  selection, dragging a folder row moves the folder. Drops route through
  `useRepo.moveEntries` (sequential `repo_move_path` calls, one snapshot
  refresh, per-entry failure strings so one collision doesn't hide the
  rest — failures toast; an open file view follows its file's new path).
  Keyboard parity: context-menu "Rename / move…" opens `RenameFileDialog`
  (full-path field, filename preselected, engine creates missing parent
  dirs). Verified end-to-end against the running app over WebView2 CDP:
  tracked root file → `src/` (git shows `R`), untracked file → `docs/`
  (stays untracked, index untouched), dialog rename of a modified file →
  `RM` with the worktree edit preserved, ghost text + cleanup asserted.
  (CDP-harness gotcha, paid for: run the standalone vite with
  `STRAND_NO_HMR=1` — its HMR client otherwise polls the user's 1421
  socket and force-reloads the page mid-test.)

### Local Changes view
- ☑ Three-section layout, vertically resizable unstaged / staged panes
- ☑ Real per-file rows from `useRepo.unstagedDiffs` / `stagedDiffs`,
  rendered as a hierarchical folder tree with colored status badges
- ☑ Diff view in middle panel — `<PatchDiff>` themed via `pierre-dark`
  with `disableBackground` so it inherits app tokens
- ☑ Folder row selection aggregates the diffs of every changed file beneath
  it, stacked in the diff pane (`selectedDiffs` in `LocalChanges.tsx` →
  `FileDiffSection`; each file keeps its sticky header + per-block actions)
- ☑ "Show all" diff view: Local Changes opens showing every changed file
  stacked (default `LocalSelection.all`), re-selectable by clicking the
  Unstaged / Staged column title (per-side: the side's full changeset)
- ☑ Folder rows toggle expansion only via the disclosure chevron, not the
  whole row (`PierreTree` `toggleDirOnRowClick={false}` + microtask
  reverse-toggle); a double-click on the chevron no longer stages the folder
- ☑ Collapsible file diffs in the pane: each `FileDiffSection` has a clickable
  sticky header that folds its body; a single header-toolbar toggle
  (`useSettings.diffsCollapsed`, session-only) collapses/expands all, with
  per-file overrides cleared on each bulk toggle
- ☑ Per-row Stage / Unstage actions (file-level, hover-revealed)
- ☑ Bulk "Stage all" / "Unstage all" (single batched IPC — `repo_stage_many` /
  `repo_unstage_many` open the repo + write the index once, not once per file;
  matters for big changesets like a squash-merge staging hundreds of files)
- ☑ Stacked diff pane is **viewport-lazy + row-virtualized**: the pane is wrapped
  in Pierre's `<Virtualizer>` (2026-07-06) so each file window-renders only its
  on-screen rows (a 5,000-line file mounts ~200, not ~7,500); *and* each file's
  body only mounts once its block scrolls near the viewport (IntersectionObserver,
  ~900px pre-roll, height-estimated placeholder until then), so "show all" over
  hundreds of files doesn't instantiate every file diff at once. The two compose:
  lazy-mount bounds file *instances*, the Virtualizer bounds *rows* per instance
- ☑ Stacked / split diff layout toggle, **persisted per-repo** (MainHeader
  buttons map `useSettings.diffMode` `stacked`/`split` → Pierre `unified`/`split`
  for `LocalChanges` + `CommitDetail`; `useRepo.setDiffMode` writes the choice to
  the SQLite `settings` table keyed `diff-mode:<repoPath>` via `repoDiffMode`, and
  `loadRepoDiffMode` restores it on tab activate / repo open. A repo with no saved
  choice follows the last-used layout.)
- ☑ Commit form: subject + body + amend
- ☑ Commit kbd shortcut (⌘↵)
- ☑ Per-row Discard action (`FileSection.menuItems` adds a confirm-gated
  "Discard…" item to the Unstaged file-row right-click menu, wired to
  `discardMany`; acts on the row or the whole multi-selection)
- ✗ Recent-messages dropdown on the subject field — **removed 2026-07-02**
  (shipped 2026-05-29, cut on user feedback: resurfacing stale old commit
  messages made no sense next to AI suggestions). The `commit_messages`
  table stays (migration v2 is applied and append-only) but is no longer
  read or written.
- ☑ Hunk / change-block / line stage + unstage UI (`HunkAnnotatedDiff` renders
  one `<PierreFileDiff/>` per file with `lineAnnotations` driving an
  inline Stage / Discard pair on each change block — Unstage on the
  staged side. `sliceChangeBlock` carves the synthetic single-hunk patch
  routed through `useRepo.applyPatch`; line-number drag selection and the
  keyboard-operable `LinePicker` route through `sliceSelectedLines`.)
- ☑ Copy diff as patch / Markdown (`concatPatches` / `patchesToMarkdown` in
  `lib/patchExport.ts` — raw multi-file patch with trailing-newline
  normalization, or `### path` + ```` ```diff ```` fences with CommonMark
  backtick-run lengthening and `_binary file changed_` notes. Context menu on
  any file/folder/multi-selection in Local Changes (both sides) and the Review
  queue; palette "Copy unstaged/staged/review diff" actions gated on
  length-only selectors and reading the live arrays via `useRepo.getState()`.)
- ☑ In-diff text search (⌘F in Local Changes + Review, also palette "Search in
  diff…" via the one-shot `diffSearchSignal`/`requestDiffSearch` store signal.
  `searchDiffs` in `lib/diffSearch.ts` scans every patch in the pool — both
  staging sides here, the whole review set there — tracking old/new line
  numbers across hunks; `DiffSearchBar.tsx` floats over the diff pane with
  Enter/⇧Enter wrap-stepping, i/N counter, and a path+line preview of the
  current match. Stepping selects the matched *file* and — since 2026-07-04 —
  lands on the matched **line**: `lib/diffJump.ts` finds the row in Pierre's
  shadow DOM (`data-line`/`data-alt-line`/`data-line-type` on content rows)
  and centers + accent-flashes it (inline style — outer CSS can't cross the
  shadow boundary, inherited `--accent` can); when the row isn't mounted
  (virtualized panes, lazy bodies) it first seeks proportionally via
  `lineToRow` (`lib/changeMap.ts`, same rendered-row space as the minimap so
  fractions agree) and retries until the row exists. Deletions anchor
  old-side, adds/context new-side; a jump that swaps files parks a pending
  target the settled pane consumes — and the first probe waits a frame so it
  can't false-match the old file's rows. Shared by Local Changes, Review,
  and Workspace Review.)
- ☑ Image diff preview (binary images — png/jpg/gif/webp/bmp/ico/avif/svg —
  render side-by-side Before/After panes (`components/ImageDiff.tsx`, blobs
  via `repo_file_blob`) instead of "Binary file": token-based checkerboard,
  dims + byte size, single pane for added/deleted. Wired in Local Changes
  (unstaged HEAD→worktree, staged HEAD→index), Review (inbox + session), and
  CommitDetail (`hash^`→`hash`); `isImagePath`/`imageMime` in `lib/image.ts`.)
- ☑ Line-level (sub-change-block) stage / unstage / discard
  (`sliceSelectedLines`, Pierre line-range selection, and accessible
  `LinePicker`; focused patch tests cover forward/reverse plus partial
  creation/deletion headers, with Computer Use stage/unstage verification.)

### Commits view
- ☑ Table from `repo_log`
- ☑ SVG lane rendering (`ui/src/lib/graph.ts` lane algo + `CommitGraphCell` SVG; multi-color via `--b-1..--b-7`)
- ◐ Branch / tag / HEAD chips inline in the message cell (`indexRefs` in `Commits.tsx` + `.ref-chip` CSS; right-side chip column still open)
- ☑ Selectable rows (single-select drives the detail panel via
  `useRepo.selectCommit`; multi-select via ⌘/Ctrl-click toggle, Shift-click
  range, Shift+↑/↓ extend, ⌘/Ctrl+A select-all, with a count pill + Clear;
  exactly two expose Compare, and any selection exposes ordered bulk
  cherry-pick)
- ☑ Inline commit detail panel (`CommitDetail.tsx` — subject, body, meta, file list, `<Diff />` of the focused file; right-side resizable Panel `strand:commits-split`)
- ☑ Keyboard nav (`Commits` focuses the current commit on open; ↑/↓ move
  row focus; Enter opens details; Esc closes details)
- ☑ Commit-detail actions: Checkout (detached) + "Tag…" (opens the New-tag
  dialog targeting that commit) + Cherry-pick + Revert (single commit onto HEAD;
  merge commits choose a mainline parent; conflict/success surfaced via toast)
- ☑ Right-click a graph row → `ContextMenu` with the same actions (Checkout /
  Tag… / Cherry-pick / Revert / Copy SHA); keyboard-operable via Menu key /
  Shift+F10 on the focused row (opens at the row corner)
- ☑ Files tab re-roots to the selected commit (`repo_tree_at` feeds a read-only
  Pierre tree; opened Content/Preview files stay pinned to that revision)
- ☑ Search bar — wired in the All Commits header (`Commits.tsx`). A field picker
  (Message / Author / Hash, via `ContextMenu`) + text input highlight matching
  rows **in place** (`.match` wash + accent-bolded substring) without filtering,
  so graph lanes stay continuous. ‹/› (or ↵ / ⇧↵) step through matches with an
  N/M counter; `/` focuses the field, ⌘K "Search commits…" jumps to it, Esc
  clears. Client-side over the loaded log (message **subject**, author
  name/email, hash prefix — body is excluded so `Co-Authored-By:`/`Signed-off-by:`
  trailers don't match nearly every commit). **Full-history + content search
  shipped (2026-06-24):** a **Content** field mode + a "Search all history"
  button (⌘↵, or ↵ in Content) run `Repo::search_log` and open a
  keyboard-navigable results dropdown (combobox + listbox) over `--grep` /
  `--author` / `-G` matches across all history; an out-of-window hit opens in the
  detail panel (`CommitDetail` falls back to `commitSearchResults`). The
  loaded-window highlight + ‹/› are untouched.
- ☑ Stashes shown inline on the graph (`mergeStashRows` in `Commits.tsx` splices a
  synthetic node per stash above its base commit; `Stash` gained `base` + `time_unix`
  from `stash_list`; `GraphRow.isStash` → neutral diamond in `CommitGraphCell`;
  `stash@{n}` chip; right-click Apply/Pop/Drop/Copy SHA. Stashes off-window are
  dropped from the graph but stay in the sidebar.)
- ☑ Activity-timeline rail (`views/CommitTimeline.tsx` — vertical commit-density
  histogram + scrubber down the right edge of the graph; time axis top→bottom with
  date-labeled gridlines so it reads as a timeline, a translucent band marks the
  visible window, hover shows the bucket's date span + count, click/drag seeks the
  list to that time. Toolbar toggle persisted as
  `settings.showTimeline`. Pointer-only/`aria-hidden` — a redundant nav aid over
  arrow-key list navigation.)
- ☐ Graph style preset switching (classic / bold / subtle)
- ☑ Commit signature status in detail metadata (`CommitDetail.SignatureSummary`:
  lazy GPG/SSH/X.509 verification with valid/invalid/unverifiable/unsigned state)

### Reflog view
- ☑ Reflog browser (`views/Reflog.tsx` — reached via a `[Graph | Reflog]`
  segmented toggle (`components/HistoryModeToggle.tsx`) in the All Commits header
  actions, plus ⌘3 + ⌘K "Show: Reflog"; the sidebar "All Commits" row stays
  active across both lenses, so reflog doesn't claim a third primary row. Lists
  HEAD reflog newest-first from `repo_reflog` via a lazy `reflog` store slice /
  `refreshReflog` action; each row shows `HEAD@{n}`, an op badge parsed from the
  message (commit/checkout/reset/merge/…, colored by family), the message, time,
  and short OID. Keyboard-operable: `role=listbox` with roving
  `aria-activedescendant`, ↑/↓ to move focus, Enter or click jumps to the entry's
  commit in the graph via `revealInGraph`. Recovery path for commits orphaned by
  reset/rebase/amend.)
- ☑ Reflog recovery actions (`Reflog.tsx` context menu — right-click or
  ContextMenu key / Shift+F10 on the focused row: Jump to in graph / Checkout
  (detached) / Create branch here… (`BranchDialog`) / Reset HEAD here…
  (`ResetDialog` targeting `HEAD@{n}`) — so an orphaned commit is actually
  recoverable, not just visible, keyboard included.)

### Worktrees
- ☑ Worktree engine (`strand-core/src/worktree.rs` — `Repo::worktrees()` parses
  `git worktree list --porcelain`; `add_worktree` / `remove_worktree` /
  `prune_worktrees` shell out via a module-local `run_git` + `GIT_SAFE_CONFIG`;
  `Worktree` struct carries branch/head/bare/detached/locked/prunable/main/current.
  +2 tests: list→add→remove round-trip, dash-arg rejection.)
- ☑ `RepoMeta.common_dir` + `is_linked_worktree` (gix `common_dir()` + git2
  `is_worktree()`) so the tab strip can group a repo's worktrees.
- ☑ IPC `repo_worktrees` / `repo_worktree_add` / `repo_worktree_remove` /
  `repo_worktree_prune` + `tauri.ts` wrappers + store slice (`worktrees`,
  `refreshWorktrees` eager on open/tab-switch, `addWorktree` / `removeWorktree` /
  `pruneWorktrees` / `openWorktree` = `openRepo` reuse). Removing/pruning a
  worktree closes its open tab (`samePath` match) so no dead tab lingers.
- ☑ Worktrees overview (`views/Worktrees.tsx` — peer view, ⌘5 + ⌘K "Show:
  Worktrees"; AI-agent dashboard with stable repo-family heading, per-worktree
  branch/session labels, lazy `repoStatus`/`repoMeta`/`repoLog` enrichment →
  dirty count, ahead/behind, last commit; Review opens the worktree tab without
  a row-jump and pins the review baseline when possible; keyboard `role=listbox`
  + ↑/↓ + Enter).
- ☑ Sidebar Worktrees section (first section in the Git tab; current marked with
  the accent check; single-click → overview, double-click/Enter → open as tab;
  context menu open/show/copy/remove/force-remove/prune; header `+` opens dialog).
- ☑ Grouped worktree tabs (`Topbar.tsx` `groupTabs` clusters by `common_dir`,
  shared dot color via `groupColor`, linked tabs show stable repo-family name +
  branch/worktree context + worktree glyph).
- ☑ Create dialog (`views/WorktreeDialog.tsx` — new/existing branch, default
  sibling `<repo>.worktrees/<branch>` path, "open in new tab" toggle).
- ☑ Review worktree vs base branch (the overview's **Review** button pins the
  review baseline at `merge-base(worktree, main worktree's branch)` — new
  `Repo::merge_base` in `refs.rs` (git2 `revparse` + `merge_base`),
  `repo_merge_base` IPC + `repoMergeBase` wrapper — then opens the worktree tab
  on the Review view in session mode, so committed + uncommitted work since the
  fork point shows in one diff via the existing `diff_since`. The main worktree,
  or a failed merge-base (toast), falls back to Local Changes as before.)
- ☑ Worktree health + dirty-aware cleanup (W2 — `Repo::worktree_health` in
  `worktree.rs`: detected base, ahead-of-base, can-fast-forward,
  upstream/unpushed, and **merged via a containment scan across all local
  branches** (`merged_into`) — detect_base_branch alone misses a branch merged
  into main when sibling worktrees sit at the fork, the canonical
  parallel-agent shape; `repo_worktree_health` IPC; overview rows
  fetch it lazily and badge **merged** / **unpushed** / **unmerged**, with
  `lock_reason` + new `prune_reason` surfaced as badge tooltips; hero gains a
  merged metric, a **Clean up (N)** action that lists clean+merged worktrees in
  a confirm dialog and removes them + deletes their branches, and a **Prune
  stale** button.)
- ☑ Merge & clean up (W1 — `Repo::integrate_worktree_branch` in `worktree.rs`:
  squash / merge-commit / ff of a worktree branch into its detected base,
  running in whichever worktree holds the base (clean-workdir guard, conflict
  auto-abort) or as a pure ref fast-forward when the base isn't checked out;
  `repo_worktree_integrate` IPC; `views/WorktreeMergeDialog.tsx` previews the
  exact git commands, warns about uncommitted files, offers an editable base
  picker (detected base preselected; per-base ff-possibility recomputed via
  `repoMergeBase`) since the detection heuristic can name a sibling, and
  optionally removes the worktree + deletes the branch after merging.
  +3 engine tests.)
- ☑ Archive-before-remove snapshots (W3 — `Repo::archive_worktree_state` in
  `worktree.rs` snapshots HEAD+staged+unstaged+untracked into
  `refs/strand/archive/<slug>/<secs>` via a throwaway `GIT_INDEX_FILE`, without
  touching the real index; `worktree_archives` / `restore_worktree_archive`
  (puts the original identity back: recorded directory when free, branch
  recreated-or-reattached when unambiguous — commit subject carries the exact
  branch, body a `Path:` line — else fallback dir/detached; archived changes
  return as uncommitted state on the original commit) /
  `delete_worktree_archive`; four
  `repo_worktree_archive*` IPC commands; the store's `removeWorktree` archives
  best-effort before every removal, and the overview grows a collapsible
  "Archived snapshots" strip with Restore / Delete. +1 engine test.)
- ☑ Surface worktree actions beyond the overview (2026-07-08 — sidebar worktree
  context menu grows **Review vs base** (store-shared `reviewWorktree` action,
  same flow as the overview button) and **Merge & clean up…** (fetches
  health+dirty on demand, renders the same `WorktreeMergeDialog`); palette
  gains **Clean up merged worktrees…** (switches to the overview and fires a
  `strand:worktrees-cleanup` event the view listens for) and **Prune stale
  worktrees**. The review-header entry point was dropped — the header already
  carries the baseline chip and the sidebar/overview cover the flow.)
- ☑ Auto-prune old worktree archive snapshots (2026-07-08 —
  `auto_prune_archives` in `worktree.rs` runs after every
  `archive_worktree_state`: keeps the newest 10 per slug and drops anything
  older than 60 days. +1 engine test.)
- ☑ W4 setup copy-list (2026-07-08 — `.worktreeinclude` honored (the Claude
  Code convention): `Repo::worktree_include_patterns` +
  `Repo::copy_worktree_include` copy gitignored files matching the patterns
  (own gitignore-subset matcher: anchoring, `**`, `*`/`?`, trailing-`/`,
  basename patterns) from the source worktree into a fresh one;
  `repo_worktree_include_patterns` / `repo_worktree_copy_include` IPC; the
  create dialog offers "Copy setup files" (checked) only when the file names
  something, and toasts the copied count. Tool badge: overview rows tag
  worktrees created by known agent tools (`.claude/worktrees/` path, `vk/`
  branches). +2 engine tests.)
- ☑ W5 fleet stats (2026-07-08 — `Repo::worktree_stats` walks the workdir once
  (skipping `.git`, no symlink-follow) for **disk size** + **last-activity
  mtime**, and parses `git diff HEAD --shortstat` for **±lines**;
  `repo_worktree_stats` IPC fetched per-row in the background, separate from
  the cheap row stats so a huge tree never delays badges. Overview rows show
  "+412 −38 · touched 3m ago · 1.2 GB"; rows sort most-recently-touched first
  within their rank. +2 engine tests.)
- ☑ W6 best-of-N compare, v1 (2026-07-08 — overview rows of linked worktrees
  grow a selection checkbox (Space toggles the focused row); "Compare (N)"
  opens `views/WorktreeCompareDialog.tsx`: one column per attempt, each diffed
  vs its own detected fork point (`repoDetectBaseBranch` + `repoDiffSince`),
  files touched by ≥2 attempts highlighted, per-column **Review** (full
  session) and **Pick winner…** (hands off to Merge & clean up; losers retire
  via the existing Clean up).)
- ☑ W7 overlap warnings (2026-07-08 — pairwise uncommitted-file intersection
  across the family's dirty worktrees, computed client-side from the row
  status fetches already in hand; overview rows badge "overlaps <name>: N"
  with the file list in the tooltip, and `WorktreeMergeDialog` warns when a
  sibling's uncommitted changes touch the same files.)
- ☑ W8 create-from-anything (2026-07-08 — `add_worktree` grows
  `start_point`/`track` (`worktree add [--track] -b <branch> <dest> [<start>]`);
  the dialog gains a **Start at** picker (HEAD / branches / remote branches /
  tags, plus the handed-in commit), auto-tracking + a checked-by-default
  **Fetch first** for remote start points (with task-branch name prefill);
  "New worktree from here…" added to the sidebar's local+remote branch menus
  and the commit graph's context menu (prefills the start). Engine also gains
  `lock_worktree(reason)` / `unlock_worktree` + `repo_worktree_lock`/`_unlock`
  IPC, surfaced as Lock/Unlock in the sidebar worktree menu. +2 engine tests.)
- ☑ Overview row "last commit" line shows the row's own HEAD (2026-07-08 —
  was the family's newest commit: `repoLog(w.path, 1)` walks all refs, which
  worktrees share, so every row read the same subject when one worktree just
  committed. `Repo::log_head` walks HEAD's ancestry only (shared `run_log`
  behind `log`), surfaced as an optional `head_only` flag on `repo_log` /
  `repoLog(path, limit, headOnly)`; the overview's per-row stats fetch passes
  it. +2 engine tests: side-branch tip excluded, unborn HEAD → empty.)
- ☑ W8 leftovers closed (2026-07-08). Engine: `Repo::move_worktree`
  (`git worktree move [--force] <src> <dest>` — registry-aware, unlike a
  manual rename) and `Repo::repair_worktrees` (`git worktree repair
  [<path>…]` — no paths fixes worktree→repo links after the repo moved;
  the new directories of manually-moved worktrees fix the repo→worktree
  side), both dash-guarded, with std-only tests (move round-trip keeps the
  branch + clears prunable; a manual `fs::rename` reads prunable until
  repair relinks it). `repo_worktree_move` / `repo_worktree_repair` IPC +
  `tauri.ts` wrappers — engine + IPC only, still no UI surface (deliberate;
  nothing in the UI needs a move yet). UI: "Review vs base" and
  "Merge & clean up…" joined the **rail and tab-strip** worktree context
  menus (`RepoRail` / `RepoTabs` → new `onWorktreeReview` / `onWorktreeMerge`
  props; App owns the handlers + a `WorktreeMergeDialog` instance). Review
  reuses the store's `reviewWorktree` flow; merge resolves the registry
  entry relative to the active tab and — since the dialog reads
  refs/worktrees from the active repo — first focuses a family member when
  the target belongs to another family, preferring the main checkout so
  cleanup (which can't remove the current worktree) stays available.
  Verified: `cargo test -p strand-core` (113, +2 worktree), clippy, `tsc`,
  `vitest` (200), `vite build`, and a live WebView2-CDP pass against the
  running app (scratch repo + `feat-cart` worktree: both items in the rail
  tile menu and the strip pill menu; Review vs base pinned the baseline at
  the fork commit and toasted "Reviewing feat-cart vs main"; the merge
  dialog opened from both surfaces with `main (detected base)`, cleanup
  checked, and the dirty-file warning; a cross-family invocation re-anchored
  the active tab to the family's main checkout before opening).
- ☐ W4 leftover: optional post-create command (per-repo setting, e.g.
  `pnpm i`, `STRAND_WORKTREE_PATH` env, streamed output) — deliberately
  deferred; Strand is a client, not a launcher.
- ☐ `detect_base_branch` tie-break revisit: with several sibling branches at
  one fork point it picks a sibling (smallest `base_ahead`) over the real
  parent. Harmless for review baselines (same merge-base) but it seeds the
  merge dialog's base picker; consider preferring the branch another worktree
  has checked out, or main-ish names, on exact rank ties.

### File view (4-tab)
- ☑ Tab strip + header (opened via `selectFile` from the Files tab / palette;
  a Close action returns to Local Changes)
- ☑ Content tab — working-tree (or revision) content via `repo_file_content`,
  rendered with Pierre's read-only `<File>` (syntax-highlighted, app-themed).
  Shiki-direct highlighting deferred — `<File>` already covers it. Mod+F
  searches the source with wrap-around match navigation and virtualized-line
  scrolling (`FileSearchBar` + `searchFileText`).
- ☑ Preview tab — rendered view for renderable text files, tab only offered
  for them (`PreviewTab` in `FileView.tsx`): SVG through the image pipeline
  (`ImagePreview`, data-URL `<img>`), markdown through `lib/markdown.tsx`
  (hand-rolled → React elements, no raw HTML; unit-tested). Relative links
  open the target file in the file view, http(s)/mailto open externally
  (`shell:default` capability added), repo-relative images load off the
  worktree (`RepoImage`). A `fileOpenTab` setting (Settings → Appearance,
  "Open files on": Preview / Source, default Preview) picks the initial tab
  for renderable files — applied in `selectFile` via `lib/preview.ts`.
- ☑ History tab — `repo_file_history` (`--follow`) revision list; selecting a
  commit shows this file's change there (`repo_diff_commit_file`, pathspec-
  limited), double-click jumps to the commit in the graph
- ☑ Compare tab — two-revision picker (from the file's history) + the file's
  diff between them (`repo_diff_between` filtered to the path)
- ☑ Blame tab — `repo_blame` per-line author + commit; **virtualized** fixed-row
  list (only the viewport slice mounts, since blame can run to 50k lines); click
  a line to jump to its commit in the graph
- ☐ Tab state persistence per-file (settings store)

### Command palette
- ☑ Open / close, ⌘K, fuzzy filter, run-on-Enter
- ☑ Real action registry — grouped command set (`PaletteAction.group`):
  **Actions** (open/clone/show/snapshot/stash/tag/push-tags/sync/settings/theme/abort),
  **Branches** (checkout local; current branch reveals in graph; remote branches
  checkout-and-track), **Tags** (reveal tagged commit), **Files** (open in file
  view from `workTree`), **Commits** (reveal + open detail), **Recent** (open
  repo). Built in `App.tsx` (`repoActions` + `paletteActions`); repo groups are
  gated on `paletteOpen` so a big log/tree costs nothing when closed.
- ☑ Index branches, files, commits, and recents (was: recents only). File search
  pulls `workTree` lazily on palette open (`refreshTree`, keyed on activePath).
- ☑ Fuzzy scorer with match highlighting (`match`/`subsequence` in `Palette.tsx`:
  contiguous-substring > subsequence > keyword, word-boundary bonus; `.hl` spans)
  + per-group result caps (`CAP_PER_GROUP`/`CAP_SCOPED`) so large repos stay fast.
- ☑ Keyboard navigation (↑↓ to highlight + scroll-into-view; mouse hover also moves selection)
- ☑ Scope pills (All + every group present) — `role=group` toggle buttons with
  `aria-pressed`; **Tab / Shift+Tab** cycles scope. Adaptive: repo groups drop
  out when no repo is open (stale scope falls back to All).
- ☑ a11y: combobox/listbox/option semantics with `aria-activedescendant`, an
  `aria-live` result-count region, section `role=group` labels + spoken `metaLabel`,
  and focus-restore to the opener on close (captured pre-`autoFocus`).

### Cross-cutting
- ☑ Resizable panes everywhere (`react-resizable-panels`); sizes
  persisted per-region via `autoSaveId` (`strand:body`, `strand:lc-main`,
  `strand:lc-files`)
- ☑ Auto-refresh on window focus / visibility (status + diffs + log + meta)
- ☑ Refresh button in MainHeader wired with spinner
- ☑ Tweaks panel UI → **multi-section Settings dialog** (`views/SettingsDialog.tsx`
  shell + `views/settings/*Section.tsx`): sidebar `role="tablist"` (↑/↓ move &
  select, Home/End, focus trap kept) over five sections; compact controls render
  as label-left / control-right rows grouped in `.settings-rows` hairline cards
  (`SegRow`/`SelectRow`/`CheckRow` in `views/settings/shared.tsx`) so sections
  fill the pane width —
  - ☑ **Appearance**: theme + accent (moved from the old single-section dialog),
    plus the previously UI-less `density` / `uiFont` / `monoFont` store fields
    (segmented `SegRow` + selects in `views/settings/shared.tsx`)
  - ☑ **Diff**: default layout (`defaultDiffLayout`, seeds repos without a
    per-repo `diff-mode:` row — `loadRepoDiffMode` falls back to it), diff font
    (`--diffs-font-family`, pierces Pierre's shadow DOM), change indicators
    (`classic`/`bars`/`none`), line numbers, word-level highlight; live Pierre
    preview. Options flow through `diffAppearanceOptions()` (`components/Diff.tsx`)
    into both `Diff` and LocalChanges' `fileDiffOptions` memo. MergeResolver
    deliberately stays pinned (gutter measurement).
  - ☑ **Git**: global `user.name`/`user.email` read/write
    (`gitconfig::global_identity` / `set_global_identity`, IPC
    `git_global_identity` / `git_set_global_identity`) + default clone/open
    folder (`defaultCloneDir`, seeds CloneDialog parent + dialog `defaultPath`)
  - ☑ **Integrations**: external editor + terminal — per-OS presets + custom
    template (`lib/integrations.ts`), safe tokenize-then-substitute launcher
    (`strand-core::external::build_argv`/`spawn_detached`, IPC
    `repo_open_in_editor` / `repo_open_in_terminal`); wired to the MainHeader
    Terminal / Open-externally buttons (formerly disabled stubs) and palette
    "Open in editor" / "Open in terminal"; single-file context menus in Files,
    Local Changes, Review, and Workspace Review pass the clicked path to the
    configured editor (`App.openEditorTarget`)
  - ☑ **Updates**: version + check/download/restart (`stores/updates.ts` on
    plugin-updater/plugin-process) + `updateAutoCheck` / `updateAutoInstall`
    prefs read by App's delayed launch auto-check (soft-fails while the
    endpoint is offline)
- ☐ Verify editor/terminal presets launch correctly on Windows and Linux
  (`code.cmd` PATHEXT shim, `wt -d`, gnome-terminal/konsole/alacritty/kitty —
  written blind on macOS)
- ☑ **Theme management**
  - ☑ Define theme contract (`light` / `dark` / `system`) as CSS-variable sets
    (`[data-theme]` token blocks in `tokens.css`; `system` resolves to one of
    the concrete themes via `prefers-color-scheme`)
  - ☑ `theme` preference persisted with default `system` — kept in the existing
    zustand-`persist` localStorage store (`strand.settings`), not the SQLite
    `settings` table: localStorage rehydrates **synchronously**, which is what
    lets the pre-paint inline script restore the theme with no flash. Type is
    `ThemePref = 'dark' | 'light' | 'system'`; old persisted `'dark'`/`'light'`
    users keep their choice.
  - ☑ `useTheme` hook (`lib/theme.ts`): reads the preference, subscribes to OS
    `prefers-color-scheme`, applies `data-theme` on `<html>`, and publishes the
    resolved concrete theme into the store (`resolvedTheme`) so Pierre diffs +
    the settings hint read it reactively. Single applier — called once at the
    app root.
  - ☑ Settings UI section (`views/SettingsDialog.tsx`, reuses the `.clone-dialog`
    shell): theme picker (System / Light / Dark) as a `role="radiogroup"` of
    cards with live mini-UI swatches (each swatch carries its own `data-theme`
    so it previews that theme), roving-tabindex arrow nav + focus trap. Opens
    from a status-bar gear, ⌘,, or ⌘K. Selecting applies live (no Save step).
  - ☑ **Accent color picker** — 8 hue presets (amber / rose / magenta / violet /
    blue / cyan / teal / green) in a second `role="radiogroup"` of hue dots in
    the same dialog. Applied via `[data-accent]` on `<html>`, which rotates a
    single `--accent-h`; every accent token (`--accent`/`-2`/`-fg`/`-glow`,
    `--selection`, selected-row tint, ambient window glow) is
    `oklch(L C var(--accent-h))`, so an accent is a hue rotation that recolors
    the whole app live in both themes. Persisted (`accent` in the store) +
    restored pre-paint by the same inline script; `ACCENT_OPTIONS` registry in
    `lib/theme.ts`.
  - ☑ Command palette actions: "Settings…", "Theme: Light", "Theme: Dark",
    "Theme: System"
  - ☑ Cycle-theme keyboard shortcut (⌘⇧T) — a real global handler that toggles
    light ↔ dark (skips system; from system, flips away from the current
    appearance), with a confirming toast
  - ☑ Persist last choice across launches; restore before first paint via a tiny
    inline script in `index.html` that reads the same persisted key and sets
    `data-theme` before the stylesheet paints (no flash of wrong theme). The
    store seeds `resolvedTheme` from that attribute, so React's first commit
    doesn't flicker.
  - ☑ Audit components for hardcoded colors; route through tokens — popover /
    menu / modal `rgba(0,0,0,…)` shadows → new per-theme `--shadow-1…4`
    elevation tokens (dark values unchanged, light softened); context-menu
    danger + merge/conflict accept-checks → `--del`/`--del-bg`/`--accent-fg`;
    Pierre diff theme follows the resolved theme (`pierre-light`/`pierre-dark`)
    everywhere it renders. (Mac/Win traffic-light chrome colors left fixed by
    design; three `.avatar` rules are dead CSS for unbuilt blame/detail views.)
  - ☑ Extension point for future custom themes — `THEME_OPTIONS` registry +
    `[data-theme]` token blocks; adding high-contrast / solarized is add-a-block
    + add-an-entry, no other code changes.
- ☑ **Keyboard operability pass.** Almost every action reachable from the
  keyboard, not just the palette (PRD §6.8, `docs/learnings.md`). Per-surface
  focus models + palette entries; the final audit added file-history and
  commit-file activation, tablist arrow/Home/End/Delete handling, and separate
  focusable recent/workspace secondary actions. Drag-and-drop (folder open,
  tab / file reorder) may stay pointer-only (`RepoTabs`, `FileHistoryTab`,
  `CdFileRow`, verified in the exact production-protocol app 2026-07-18).
  - ☑ Configurable global-shortcut registry (`ui/src/lib/keys.ts` `COMMANDS` +
    `resolveBindings`/`eventToBinding`/`formatBinding`/`toMudaAccelerator`,
    tested in `keys.test.ts`). Window keydown (`App.tsx`), native menu
    (`lib/menu.ts`), palette chips, and Settings all resolve through it.
  - ☑ Push = `Mod+P`, Pull = `Mod+Shift+P` (+ Fetch `Mod+Shift+Y`, Sync
    `Mod+Shift+S`, open-editor/terminal, refresh `Mod+R`).
  - ☑ Settings → Keyboard section: rebind (record-a-combo) / unassign / reset /
    restore-all, shared-binding warnings, context-shortcut reference
    (`views/settings/KeyboardSection.tsx`). Persisted as `settings.keybindings`.
  - ☑ Binding scope closed for 1.0: global commands are rebindable; standard
    surface-local editing/navigation keys remain fixed and are fully listed in
    Settings → Keyboard plus the user guide. They are keyboard access, not
    hidden commands requiring a second binding registry.
- ☑ Status-bar truth pass: branch/ahead/behind plus real derived sync state
  (up to date, ahead, behind, diverged, or conflicts) and modified/staged
  counts. Commit signing belongs to `SignatureSummary`; LFS/auth remain system-
  Git concerns rather than fake global indicators (`StatusBar`, 2026-07-18).
- ☑ Proper notification viewport (`ToastViewport`): timed success/error pills,
  cancellable network progress, one stable assertive live region, and animated
  mount/unmount through `Presence`; error duration remains longer than success.
- ☑ Empty-state copy audit: every primary panel and dialog has contextual,
  instructive empty/loading/error copy (44 explicit empty-state surfaces; no
  "no data" labels remain in `ui/src`, audited 2026-07-18).
- ☑ Localization framework, English at launch (`lib/i18n.ts`: typed catalog,
  fail-fast interpolation, English plurals, browser-locale date/number/percent
  helpers; app navigation/settings shell and clone/update flows migrated;
  contract in `docs/localization.md`, 2026-07-18)

---

## AI-change review (primary use case — added 2026-06-09)

Strand's main focus is reviewing changes AI coding agents make to a working
tree: watch the agent work, review fast, accept or reject safely.

- ☑ Working-tree file watcher (`strand-core/src/watch.rs`, `notify`-based:
  recursive workdir watch, `.git` noise filtered down to HEAD/index/refs/op
  markers, 400ms trailing debounce; `repo_watch`/`repo_unwatch` per open tab
  in `AppState.watchers`; emits `repo://changed`, the store's
  `handleExternalChange` refreshes the active tab — no more waiting for
  window focus while an agent edits next door. Focus-refresh kept as fallback.
  Known tradeoff: doesn't consult `.gitignore`, so build storms in `target/`
  cost one debounced status walk per quiet period.)
- ☑ **Dedicated Review view** (`views/Review.tsx`, sidebar "Review" row with
  a pending-count badge, ⌘4, palette "Show: Review") — review lives in its
  own surface; Local Changes stays a pure staging workspace. Two modes:
  **inbox** (no baseline → the unstaged set; diffs keep per-hunk
  Stage/Discard via the shared `HunkAnnotatedDiff`) and **session** (baseline
  pinned → everything since that commit incl. the agent's commits, rendered
  read-only with file-level actions). Queue on the left (Pierre tree),
  one file at a time on the right, progress bar + verdict actions in the
  toolbar, keyboard-hint footer.
- ☑ Review diffs carry **whole-file context** — the agent's edits read
  inside the entire file, not isolated hunks (`diff_unstaged_full` /
  `diff_since_full` in `strand-core/src/diff.rs`,
  `repo_diff_unstaged_full` / `repo_diff_since_full` IPC; inbox pool lives
  in `reviewUnstagedDiffs`, refreshed only while the Review view is live so
  Local Changes' hot path doesn't pay for it).
- ☑ Review queue is a Pierre tree (`PierreTree` with the new
  `rowDecoration` lane: ✓ = reviewed, "changed" = stale; right-click →
  Mark reviewed / Stage / Discard / Copy path; double-click or Enter
  toggles the reviewed mark, a folder marks everything under it).
- ☑ Fast review navigation: Pierre's highlight **worker pool** is mounted
  app-wide (`components/DiffWorkerPool.tsx` + `worker: { format: 'es' }`
  in vite config) so Shiki runs off the main thread; parsed patches carry a
  `cacheKey` (`parseCacheablePatch` in `components/Diff.tsx`) so the pool's
  LRU makes revisits instant; the Review pane defers its whole-file mount
  until j/k settles (`useSettled` in `views/Review.tsx`) and pre-highlights
  the next queue entries while the reviewer reads
  (`primeDiffHighlightCache`).
- ☑ Review pane is virtualized: Pierre's `<Virtualizer>` wraps
  `.rv-diff-scroll` (Review.tsx), so a whole-file lockfile diff mounts only
  the rows on screen instead of freezing the app. `stepChangeBlock` already
  page-scrolls when markers are absent, and `HunkAnnotatedDiff`'s overlay
  re-measures on scroll, so both degrade gracefully to the mounted window.
  Gotcha: `VirtualizedFileDiff` pins the first `fileDiff` it renders
  (`this.fileDiff ??=`), so the diff components are keyed by
  `path:contentHash` to remount on file swap, and the pane scrolls back to
  the top per file (a stale deep offset would land a short file in an
  empty virtual window).
  Verdict hashes are cached per `FileDiff` (`hashOf`) and prefetch priming
  skips >1 MB patches — both were main-thread costs that scaled with file
  size. (Local Changes keeps non-virtualized rendering: its patches are
  hunk-sized.)
- ☑ Review baseline ("everything since this commit"): `Repo::diff_since`
  (`diff_tree_to_workdir_with_index` against the baseline tree, so committed +
  staged + unstaged agent work shows in one diff), `repo_diff_since` IPC,
  `RepoMeta.head_oid` to pin it, persisted per-repo (`reviewSession` in
  `lib/db.ts`); pin/move/clear from the Review toolbar or the palette.
- ☑ Review-state tracking: reviewed map (`path → FNV hash of the diff`,
  `hashPatch` in `lib/patch.ts`) — a file the agent touches after review
  flips back to unreviewed (row shows "changed"); persisted per-repo in
  SQLite; drives the sidebar badge + toolbar progress bar.
- ☑ Review keyboard loop (Review view): `j`/`k` queue step, ↑/↓ in the tree
  follow focus and drive the diff pane (`followFocus` on `PierreTree`;
  plain arrows only — Shift-extend keeps Pierre's native behavior), Space =
  toggle the reviewed mark **and stay on the file**, `n`/`p` change-block
  step (page-scroll fallback on read-only session diffs), `s` stage, `d`-`d`
  discard, `c` jump to the commit form. Local Changes keeps its own staging
  loop (j/k/n/p/s/d-d/c, no review marking).
- ☑ Change map in the Review diff pane (`components/DiffMinimap.tsx` — an
  overview ruler beside the `.rv-diff-scroll` scrollbar marking every change
  block in the file: add / del / mixed marks + a visible-region thumb;
  click or drag jumps. Positions come from `computeChangeMap` in
  `lib/changeMap.ts` — patch text → rendered-row fractions, layout-aware
  (split collapses mixed runs to the taller column). Shared by Review and
  Workspace Review; Local Changes untouched, its pane concatenates files.)
- ☑ Bulk verdicts with a safety net: "Stage reviewed (n)" stages files whose
  review mark still matches; "Discard unreviewed (n)" is two-step-armed; any
  multi-file `discardMany` takes an automatic snapshot stash first
  (`Safety: before discarding N files`) and surfaces a 15s Restore toast
  (`BulkUndoToast`) — and the snapshot stays on the stash stack after the
  toast, so a missed window is still recoverable.
- ☑ AI commit chips in the graph (`isAgentCommit` in `Commits.tsx`:
  `Co-Authored-By` trailer / bot-flavored author → an `ai` chip next to the
  ref chips).
- ☑ "Select all commits since baseline" in the graph (one-click review of an
  agent session's commits; pairs with `diff_since`. `commitsSinceBaseline` in
  `Commits.tsx` walks parents from HEAD over the loaded log, stopping at the
  baseline — the client-side `baseline..HEAD` — and puts the result in the
  existing multi-selection. A "Select since <short>" toolbar button shows in
  the graph while a baseline is pinned; ⌘K "Review: select commits since
  baseline" routes through a one-shot `selectSinceBaseline` store signal,
  mirroring `commitSearchFocus`. Empty range toasts "No commits since
  baseline".)
- ☑ Review changes since an arbitrary commit (commit right-click menu →
  "Review changes since this": pins the baseline at that commit and jumps to
  the Review view. `setBaseline(oid?)` in `stores/repo.ts` takes an optional
  target, defaulting to HEAD — the pin-at-HEAD palette/toolbar paths are
  unchanged.)
- ☑ Review annotations (`m` key — or the file-head / per-hunk "Note" buttons —
  opens an inline editor in `Review.tsx`; Enter saves, Esc cancels, editor
  captures its target path at open so j/k scrubbing can't re-target. Notes
  show as a compact list above the diff with `L<line>` chips + × removal and
  as `✎N` badges in the queue tree (count folded into `decorationKey`).
  UI-only `ReviewNote` type; `reviewNotes` store slice with
  `addReviewNote`/`removeReviewNote`/`clearReviewNotes`, persisted per-repo in
  SQLite via `reviewSession.getNotes/setNotes` (`review-notes:<repoPath>`),
  loaded in `loadReviewSession`. The per-hunk button rides the existing
  `HunkAnnotatedDiff` via an optional `onNoteBlock` — Local Changes untouched.)
- ☑ Feedback export (`buildReviewFeedback` in `lib/reviewExport.ts` — one
  markdown prompt: header + branch + baseline, per noted file `## path`, line
  notes quote a ±4-line hunk-clipped excerpt in a fenced diff block (shared
  `fencedDiff` from `patchExport.ts`), file notes as bullets, closing
  instruction line — ready to paste back into the coding agent. Toolbar "Copy
  feedback (N)" + palette "Review: copy feedback as prompt" / "Review: clear
  notes". Exports the *union* via `collectFeedbackFiles`: pool files with
  notes plus noted paths that left the pool (those skip the excerpt), so a
  stored note never silently drops. Notes on deletion-only blocks anchor
  old-side (`ReviewNote.side`) and the excerpt locator counts the matching
  side.)
- ☐ Watcher: optional `.gitignore`-aware path filtering if build storms show
  up in profiles.

---

## Hosted pull requests (started 2026-07-13)

- ◐ Provider-neutral Pull Requests workspace for the active repository.
  - ☑ GitHub + Azure DevOps list/detail overview (`pull_requests.rs`,
    `repo_pull_requests` + lazy `repo_pull_request`, `views/PullRequests.tsx`):
    detects the provider from `origin`/supported remotes, loads a shallow latest
    100 open/closed/merged PR index through the signed-in `gh` or `az` CLI, then
    fetches description, counts, labels, reviewers, merge/review status, and
    provider-reported checks only when a PR is opened, avoiding GitHub's
    GraphQL possible-node cap. The browser is a list → full-width detail flow:
    an active PR matching the checked-out branch opens automatically; otherwise
    arrow or j/k selects and Enter/click opens. Back restores list focus, and
    refresh, open-on-host, command-palette entry, and actionable CLI/auth errors
    remain available.
  - ☑ Azure DevOps Server 2020+ adapter (`strand-azdo-protocol`,
    `strand-azdo`, `azdo_helper.rs`, Settings → Hosting): optional signed,
    independently updated REST helper covers the existing Azure PR operations through
    API 6.0, with native-vault PAT auth on every desktop platform, WinHTTP
    Negotiate/NTLM on Windows, private-CA PAT profiles, automatic HTTPS
    collection matching with project/repository coordinates derived from each
    HTTPS/SSH Git remote, an optional collection field that derives and saves
    the active remote's collection boundary, optional longest-prefix alias matching, strict bounded
    JSON RPC, Server 2020-compatible connection probing, and signed rolling
    download with protocol compatibility gating.
    Settings surfaces an indeterminate download/verification indicator while
    `strand-azdo` is being installed and a three-provider accordion reports the
    signed-in `gh` / `az` accounts plus helper/profile authentication readiness
    (`hosting_connection_status`, `HostingSection`).
    Azure DevOps Services continues to use the official `az` CLI. Both Azure
    adapters support iteration-tracked inline comments and review submission;
    replies/resolution on existing Azure threads remain out of scope.
  - ☑ Hide provider write controls for terminal pull requests: merged/completed
    PRs expose read-only Summary, Timeline, Code, and thread cards; closed/
    abandoned PRs keep only their Reopen lifecycle action
    (`isOpenPullRequest`, `PullRequestDetails`, `PullRequestInlineThread`).
  - ☑ Persistent followed-PR monitoring (`repo_pull_request_for_branch`,
    `repo_pull_request_activity`, `stores/pullRequests.ts`,
    `PullRequestMonitor`): the active branch's open PR auto-follows without the
    PR view mounted; manual Follow/Unfollow, muted auto-follow keys, hosted-PR
    worktree deduplication, SQLite-backed baselines, bounded two-PR polling,
    native coalesced notifications, and terminal auto-unfollow survive
    navigation and relaunch. Windows permission hydration bypasses Tauri
    2.3.3's false-denied Web Notification shim (`lib/notifications.ts`).
  - ☑ Create pull requests from the checked-out branch
    (`repo_pull_request_create`, `PullRequestCreateDialog`): the PR toolbar and
    command palette create GitHub or Azure DevOps PRs with title, description,
    target branch, and draft state through the signed-in provider CLI, then
    open and automatically follow the result. When the checked-out source branch
    is missing from the detected remote, Strand pushes current `HEAD` first and
    sets upstream only when none exists (`push_current_to_remote`). **Fill with Codex/Claude Code** uses
    the configured AI subscription to draft editable title/description text
    from the committed merge-base diff (`repo_suggest_pull_request`). The
    creation shell is viewport-bounded with a scrolling body and pinned footer,
    so resizing a long description cannot hide Cancel/Create PR. GitHub's
    missing-head/base GraphQL failures are translated into actionable guidance
    instead of exposing raw SHA errors.
  - ☑ Seamless stale-while-revalidate refresh (`PullRequests.tsx`): populated
    list/detail/tabs/drafts/scroll stay mounted during updates and failures;
    lightweight activity gates rich-detail reloads, patches reload only for a
    changed head, and a stale patch remains readable but cannot submit inline
    comments until its replacement succeeds.
  - ☑ Hosted diff and changed-file browser (`repo_pull_request_diff`,
    `PullRequestChanges`): provider patches load only when Code opens; the
    keyboard-operable 22% Pierre folder tree and compact Local Changes-style
    file header mount one selected, edge-to-edge diff at a time, leaving the
    rest of the full-width detail workspace for code and following the app's
    split/stacked appearance settings. Code now adds a source → target summary,
    aggregate commit/file/line totals while a flex-height owner protects the
    diff; line totals stay in the selected-file header rather than crowding
    every tree row. The file header exposes the same
    persisted stacked/split controls in context. Azure comparisons
    fetch source/target objects without updating repository refs or FETCH_HEAD.
  - ◐ Discussion threads and comment creation: Timeline reads GitHub
    issue comments, GitHub review-thread comments, and Azure thread comments
    (including inline file context) as safe
    Markdown and creates top-level Markdown comments through the signed-in
    provider CLI. The shared Summary/Timeline composer now includes a
    keyboard-operable Write/Preview composer, Markdown formatting toolbar,
    hosted screenshot/image insertion, explicit click-to-load image previews,
    character count, provider avatars with initials fallback, and comment
    permalinks. File-backed timeline comments expose a keyboard-operable
    **View in Code** action that selects the file and focuses its fetched
    GitHub thread when coordinates exist. GitHub Code uses Pierre's native hover-gutter `+`,
    line-range selection, persistent fetched thread cards with replies and
    resolved/outdated state, and an annotation-row composer through
    `repo_pull_request_inline_comment`, with
    exact-head validation before publishing. GitHub thread cards now publish
    immediate replies and Resolve/Reopen writes through provider-capability-
    gated GraphQL mutations, patching Code + Timeline locally without a
    detail/patch reload (`repo_pull_request_thread_reply`,
    `repo_pull_request_thread_resolve`). Azure replies/resolution on existing
    threads, direct binary attachment uploads, and suggestions remain.
  - ☑ Submit reviews: comment, approve, and request changes through one
    exact-head review draft (`repo_pull_request_submit_review`, GitHub atomic
    review payload, Azure Services/Server iteration-tracked inline writes plus
    vote mappings, protocol v5).
  - ☑ Dismiss/update an existing review where supported
    (`PullRequestReview`, `repo_pull_request_update_review`,
    `repo_pull_request_dismiss_review`, GitHub capability-gated mutations,
    Azure signed-in vote reset).
  - ◐ PR review ledger + merge-readiness model (see
    `docs/pull-request-improvements.md`).
    - ☑ Header readiness strip (`pullRequestReadiness`, `.pr-readiness`):
      combines state, required reviews, checks, conflicts, provider freshness,
      and expandable blocker evidence; missing Azure policy/check fields remain
      explicitly incomplete instead of appearing ready.
    - ☑ Add viewed-file progress and unresolved-thread counts
      (`pullRequestReview`: exact-head + per-file patch fingerprints,
      viewed/changed decorations, All/Unviewed/Threads filters, and `v` / `n`
      keyboard review flow while retaining one mounted diff).
  - ☑ Inline review workspace: GitHub/Azure hover-gutter line/range selection,
    immediate publishing, and fetched review-thread annotations are present
    (`ParsedDiff` controlled selection + native gutter utility + inline
    composer/thread cards); local exact-head/content-hash viewed marks,
    unviewed/thread filters, and keyboard next-thread navigation now ship while
    retaining one mounted Pierre diff. Exact-head pending-comment drafts and
    batched submission use GitHub's atomic review payload or Azure's bounded
    latest-iteration/change-tracking resolver (`azure_review_coordinates`,
    `azure_server_review_coordinates`).
  - ☐ Paginate GitHub review threads and replies beyond the current bounded
    100-thread / 100-comment detail query.
  - ☑ Batched review submission: pending comments plus Comment / Approve /
    Request changes, summary preview, exact-head stale guard, and draft
    preservation when a provider write fails (`pullRequestReview` drafts,
    `PullRequestChanges` review composer, `repo_pull_request_submit_review`).
  - ☑ Searchable repository PR inbox (`filterPullRequests`, `.pr-inbox-*`):
    All, Authored, and Completed filter the shallow latest-100 list locally;
    search covers number/title/author/source/target branches; provider-account
    identity drives Authored without hiding All when identity lookup fails;
    selection, j/k/arrows/Home/End/Enter, focus restoration, and palette search
    remain keyboard-operable. Completed retains distinct merged/closed badges.
  - ☑ Lazy commit chronology + integrated checks (`PullRequestCommit`,
    `buildPullRequestTimeline`, `PullRequestSummary`): only opened PR detail
    fetches normalized GitHub/Azure commits; Timeline combines commits,
    flattened comments, and opened/merged/closed lifecycle markers with stable
    ordering, while Summary keeps checks collapsible and readiness persistent.
  - ◐ Review evolution + local action: safe exact-head **Open branch in
    worktree…** for GitHub and Azure plus expected-head GitHub **Update branch
    from target** are shipped (`repo_pull_request_prepare_checkout`,
    `repo_pull_request_update_branch`, `PullRequestDetails.openBranchInWorktree`).
    Reliable “since my last review” compare where the provider exposes a
    boundary, suggestions, and unresolved-feedback export for external agents
    remain.
  - ◐ Checks render provider states as green success, yellow running, red
    failure, or neutral. Azure PR policy evaluations now join readiness and
    background activity when their query succeeds; incomplete policy calls
    remain neutral. Merge queue/auto-complete and richer required-review detail
    remain.
  - ◐ Hosted PR lifecycle actions.
    - ☑ Mark permission-backed drafts ready for review
      (`PullRequest.can_mark_ready`, `repo_pull_request_ready`, GitHub viewer
      capability + Azure author match, and the substituted header action).
    - ☑ Merge with provider-supported strategies (`repo_pull_request_merge`,
      stale-head guard, keyboard-operable `PullRequestMergeControl`, and command-palette action).
    - ☑ Update/check out the PR branch (`repo_pull_request_update_branch`,
      `repo_pull_request_prepare_checkout`, exact-head `WorktreeDialog`
      handoff, and contextual overflow/command-palette actions).
    - ☑ Close/reopen the PR (`repo_pull_request_lifecycle`; GitHub `gh pr`,
      Azure Services `az repos pr update`, and Azure Server helper protocol v2
      `Operation::SetStatus`; keyboard-operable confirmed overflow action).
  - ☐ GitLab merge-request adapter.
  - ☐ Bitbucket Cloud pull-request adapter; scope Bitbucket Server separately.
  - ☐ Direct OAuth + OS-keychain credentials if/when Strand stops delegating auth
    to provider CLIs (blocked on Platform → per-platform credential storage).

---

## Conflict resolution

- ◐ In-progress op surfaced + abort/continue: `RepoMeta.operation` (rebase /
  cherry-pick / revert / merge, read from `.git/` markers) drives an `OpBanner`
  above the main view with **Continue** + **Abort** buttons (⌘K "Abort <op>").
  Continue (`Repo::continue_operation`) is gated until no `CONFLICTED` files
  remain — the correct way to advance a paused rebase, which a commit can't do.
  The three-way *resolution* UI below is still the open work; today conflicts are
  resolved in Local Changes (conflicted files show via the `CONFLICTED` status).
- ☑ Detect conflicted files from `status` (`status.rs` now emits every
  `is_conflicted()` entry as a single `CONFLICTED` row — a pure unmerged entry
  has no wt/index bit and was otherwise dropped; the Local Changes **conflict
  bar** lists them)
- ☑ Per-file resolved-state tracker (status-driven: resolving writes + stages
  the file via `Repo::resolve_conflict`, so it leaves the conflicts list; the
  bar shrinks as files are resolved, merge completes on commit)
- ☑ Conflict entry point: selecting a conflicted file shows an in-pane
  **landing** (`views/ConflictLanding.tsx`) — explains the conflict, offers
  tick-a-side quick-resolve (take incoming / current / both for the whole file),
  and an "Open merge editor" button. Auto-opens the first conflict during a
  merge so it isn't hidden; conflicted files are filtered out of the normal
  Unstaged/Staged lists (they listed as confusing M/M duplicates).
- ☑ Three-way visual conflict view (`views/MergeResolver.tsx` — full-screen
  modal: incoming/theirs + current/ours side-by-side on top, assembled result
  below, ‹ › conflict nav + red→green N/M counter, **scroll-synced** source
  panes. Per-side "take all from this side" checkboxes in the branch headers.
  Markers parsed in `lib/conflictParse.ts`; each pane is Pierre's read-only
  `<File>` with the focused conflict highlighted via `selectedLines`.)
- ☑ "Take current / incoming / both" actions (per-conflict via the mid action
  bar or clicking a side's highlighted block; per-side bulk via the header
  checkboxes; result assembled from picks, "Resolve" writes + stages once all
  are picked. Pick-sides only — no free editing.)
- ☑ Fallback to external mergetool (`Repo::open_mergetool` shells out to
  `git mergetool --no-prompt -- <file>` with the path-traversal guard;
  `repo_open_mergetool` runs it off the IPC thread; "External tool" button in
  `ConflictLanding`, refreshes on exit since a successful tool run stages the file)

---

## Platform / packaging

- ☑ Replace placeholder icon with a real 1024×1024 source (squircle on the
  Apple grid; commit `aefc189`)
- ☑ Apple Developer ID + notarization pipeline. Local signing:
  `pnpm tauri build --target aarch64-apple-darwin` + `APPLE_SIGNING_IDENTITY`
  yields a Developer-ID-signed DMG. Release CI signs **and notarizes** the
  universal build (`Strand_0.5.0_universal.dmg` on the v0.5.0 GitHub Release,
  2026-06-12).
- ☐ Windows EV cert (~$300/yr — budget per PRD §12)
- ☑ Linux Sigstore signing for AppImage: release CI creates and immediately
  identity-verifies a keyless Cosign bundle, then uploads it beside the
  AppImage (`.github/workflows/release.yml`, `docs/packaging.md`, 2026-07-18).
- ☑ CI: GitHub Actions matrix for mac/win/linux × x86_64/aarch64
  (`.github/workflows/release.yml` — tag-driven `tauri-action` matrix:
  macOS universal, Windows `.msi`, Linux `.deb`/`.rpm`/`.AppImage` → draft
  GitHub Release. Secrets documented in `docs/packaging.md` § "Release CI".
  Validated end-to-end on `v0.5.0`, 2026-06-12: all three platforms green,
  installers + signed `latest.json` published.)
- ☑ Optional Azure DevOps Server helper release pipeline
  (`.github/workflows/release.yml`, `scripts/azdo-helper-*.mjs`): builds
  universal macOS, Windows x86_64, and Linux x86_64 archives under the same
  exact tag, signs/notarizes macOS, publishes a minisign-authenticated manifest
  with archive/binary hashes, and promotes the same signed workflow artifacts
  to the rolling helper release. Windows CI compiles and tests WinHTTP.
- ☑ PR-level CI gate (`.github/workflows/ci.yml` — on push to main + PRs:
  `cargo test -p strand-core`, `cargo clippy -p strand-core -p strand-tauri
  -- -D warnings` (clippy-clean as of 2026-06-09; `result_large_err` allowed
  crate-wide with rationale in `lib.rs`), `tsc --noEmit`, `vitest run`.
  The review backstop for agent-authored changes.)
- ☑ Frontend unit tests (Vitest: `lib/patch.test.ts` — slice rules, marker
  travel, header recount, the file-corrupting failure modes; `lib/graph.test.ts`
  — lanes/merges/invariants; `lib/conflictParse.test.ts` — parse + resolution
  assembly; `lib/fuzzy.test.ts` — palette scoring, extracted to `lib/fuzzy.ts`.
  `pnpm --filter ./ui test`.)
- ☑ Stable auto-update channel is signed and fail-closed; GitHub's stable
  `releases/latest` endpoint excludes prereleases. A user-selectable beta
  channel is explicitly 1.1 scope so 1.0 cannot silently change trust channels
  (`tauri.conf.json`, `check-release-security.mjs`, 2026-07-18).
- ☑ Windows 11 platform pass — Rust compiles clean and the MSI builds on a
  Windows 11 box (2026-06-07: `Strand_0.0.1_x64_en-US.msi`, 10.5 MB, via
  `pnpm tauri build --bundles msi`). **Runtime validated 2026-06-07:** launched the
  bundled release `strand.exe` on Windows 11 — the WebView2 frontend renders the
  full UI, the dark theme + amber accent apply cleanly with no flash, and the native
  window frame / controls (titlebar, min/max/close, maximize-restore) all work.
  Chrome is correct on Windows.
- ☐ Linux platform pass on GNOME + KDE
- ☑ Credential-storage boundary: the optional Azure DevOps Server PAT uses
  `keyring` 4.1 (macOS Keychain, Windows Credential Manager, Linux Secret
  Service). Git/provider CLI authentication remains in each system's existing
  credential helper; direct OAuth/keychain ownership is a 1.1 follow-on
  (`strand-azdo::credentials`, 2026-07-18).

---

## Performance (PRD §8 targets)

First engine baseline measured 2026-06-08 on M1 Pro — see `docs/perf-baseline.md`
and the `crates/strand-core/examples/perfcheck.rs` harness (100k-commit + 10k-file
synthetic fixtures). Engine-measurable targets pass; webview/app targets still need
a running-app pass.

- ☑ Cold start < 1.0s (measured on the running app 2026-06-29, Win 11 /
  Ryzen 7 7700X — `docs/perf-baseline.md` § webview): **~407ms** launch→shell
  paint, **~568ms** launch→repo-interactive (process+WebView2 init 248ms +
  nav→snapshot 320ms). Per-IPC refresh: snapshot 52ms / log 50ms / diffs 12ms.
  Driven via WebView2 CDP (`--remote-debugging-port`) + the `strand:perf`
  harness and a perf-gated `window.__strand` store hook in `main.tsx`. Caveat:
  WebView2 runtime warm across relaunches, so true post-reboot first launch is
  a bit higher — still well under 1.0s.
- ☑ Open 100k-commit repo < 2.0s (was ~0.5s on the git2 path; the ~0.46s topo-sort
  floor that was the 1M-commit scaling risk is now gone — `log` shells out to an
  incremental `git log`, so `discover + log(5000)` is ~47ms on the 100k fixture)
- ☑ Status refresh on 10k-file working tree < 200ms (measured 42ms; ~85ms with the
  `work_tree` walk the UI also runs per refresh)
- ☑ Diff render for 5,000-line file < 100ms. The realistic hunk-sized change was
  always **~87ms** ✅; the **~1460ms** whole-file case was the non-virtualized
  Local Changes pane mounting all 7,500 line elements. **Resolved 2026-07-06** by
  virtualizing that pane (see "Virtualize the Local Changes stacked diff pane"
  below) — it now caps mounted rows at ~200 like Review, so file size no longer
  drives render cost. (Absolute re-measure on the Windows/WebView2 prod harness
  still wants a rerun, but the 7,500→200 row cap is the structural fix.)
- ☑ Stage/unstage hunk < 50ms perceived (measured 2026-06-29): **~34ms** round
  trip (IPC + `refreshLocalChanges` + repaint) when viewing the file. The old
  ~297ms case (a huge whole-file diff co-mounted in the stacked view) shared the
  Local Changes non-virtualization root cause and is fixed by the same 2026-07-06
  virtualization — the co-mounted file now re-renders only its ~200 windowed rows.
- ☑ Idle memory — **target restated per-platform 2026-07-06** (PRD §8 updated,
  following its own per-platform cold-start precedent). Measured 2026-06-29 on
  Windows: **~280MB private / ~438MB working set** with the strand repo open
  (~248MB private / ~408MB WS empty); JS heap is only 7MB, so the overage was
  WebView2's 6-process baseline (`strand.exe` itself is ~38MB), not app
  allocation — the **empty shell alone consumed 99% of the old flat 250MB
  budget**, and WebView2 offers no supported process-count lever
  (`--single-process`-style switches are unsupported → rendering risk). New
  targets: macOS **< 250MB** (unchanged; confirm on the Mac box), Windows
  **< 300MB private** plus app-attributable **< 50MB over the empty shell**
  (measured ~32MB — the number app code actually controls), Linux TBD at the
  GNOME+KDE platform pass. Windows passes both restated figures.
- ☑ **Virtualize the Local Changes stacked diff pane** (perf follow-up from the
  webview pass) — done 2026-07-06. `DiffPane` (`views/LocalChanges.tsx`) now
  wraps the stacked file list in Pierre's `<Virtualizer className="lc-diff-scroll">`
  (the scroll container); every stacked `<PierreFileDiff>` auto-registers with
  that one virtualizer through context (`useFileDiffInstance` → `useVirtualizer`),
  so each file window-renders its rows — the same mechanism Review uses. A
  whole-file 5,000-line diff now mounts **~200 rows instead of ~7,500** (verified
  live: 200 mounted, `scrollHeight` honestly reserved). Two companion fixes were
  required, not optional: (1) `HunkAnnotatedDiff` is now keyed by
  `hashFileDiff(diff)` because a `VirtualizedFileDiff` pins the first fileDiff it
  renders (`this.fileDiff ??=`), so a content change (staging a block shrinks the
  patch) must remount the instance — the non-virtual `FileDiff` updated on
  re-prop, the virtual one doesn't; (2) the ⌘F jump now passes `{patch, layout}`
  to `scrollToDiffLine` (the selection narrows the pane to one file, so its
  scroll maps 1:1) — a virtualized off-screen row isn't in the DOM to find, so
  the retry-only path would never land on it. The per-file viewport-lazy IO gate
  stays (avoids instantiating hundreds of file diffs at once in a "show all").
  Verified live (browser-mode seeded stores): 200-row cap, content-hash remount
  (200→8 on a patch swap), ⌘F deep-jump lands dead-center, `n`/`p` step,
  collapse/expand, multi-file "show all" (lazy placeholders + virtualization
  compose). **Note:** the per-block action *overlay* markers are still all in the
  light DOM (not virtualized) — pre-existing, unchanged, and far cheaper than the
  highlighted code rows this fixed; a possible future trim.
- ☑ Installer < 25MB per platform (macOS DMG ~10MB, Windows MSI 10.5MB — recorded)

### Perf-pass leads (2026-06-08 baseline)

- ☑ **`log` first-page latency: shell out to `git log` instead of git2's whole-DAG
  revwalk** (`Repo::log`, `log.rs`). git2's `Sort::TOPOLOGICAL` buffered the entire
  reachable set before yielding, so `limit` didn't bound the work (~0.48s floor on
  100k). Now `git log -z --date-order -n <limit> HEAD --branches --remotes --tags`
  does an incremental, commit-graph-backed walk that stops at `limit`:
  `log(1000)` 480ms→**22ms**, `discover+log(5000)` (per-IPC cost) 478ms→**47ms** on
  the 100k fixture. Used `--date-order` (not the lead's suggested `--topo-order`):
  it reproduces git2's `Sort::TIME | Sort::TOPOLOGICAL` ordering *exactly* (topo
  invariant the lanes need + time tiebreak), so the graph layout is unchanged — a
  pure perf change, no visual regression. Ref selectors mirror the old `push_head` +
  `push_glob` set (not `--all`, which would add `refs/stash`/notes).

### Audit follow-ups (2026-06-04 perf/UX audit)

Larger items surfaced by the audit and verified against the code; the safe
quick-wins from that audit already landed (see ROADMAP changelog).

- ☑ Open git2 once per `Repo` (reused handle) — done 2026-07-06. `Repo` holds a
  `OnceCell<git2::Repository>`; `git2()` returns `&git2::Repository`, opened on
  first use and shared by every op in the same command (`snapshot` alone opened
  git2 four times — directly, then via `meta`/`refs`/`submodules`). The stash
  ops keep a fresh `git2_owned()` (the only `&mut` callers). The win is bigger
  than the ~0.65ms open: a warm handle keeps its loaded index + pack mmaps, so
  per-IPC `discover+snapshot` dropped **54→36ms on the 10k-file fixture**,
  8.3→5.6ms on the 100k-commit fixture, 44.5→39.8ms on the strand repo
  (Windows fixtures regenerated; see `docs/perf-baseline.md`).
- ✗ Cache the opened repo per path in `AppState` — **declined by measurement
  2026-07-06.** The audit assumed re-discover was the cost; it isn't: gix
  `discover` is ~1ms and `git2 open` ~0.65ms, flat across repo sizes (100k
  commits / 10k files, Windows). What a cross-command cache *would* keep warm
  is the git2 index/odb state (~18ms/snapshot residual on a 10k-file tree —
  warm `snapshot` 18ms vs per-command 36ms), but `git2::Repository` is `!Sync`,
  so a shared handle means a per-repo `Mutex` that serializes exactly the
  concurrent reads `spawn_blocking` (2026-07-06) just unblocked, plus config
  staleness + invalidation machinery. Revisit only if the 1.0 perf pass shows
  refresh latency still mattering; the numbers to beat are in
  `docs/perf-baseline.md`.
- ☑ Move CPU/disk-bound read commands (`repo_log`/`status`/`diff_*`/`tree`/`refs`)
  to `spawn_blocking` so a slow op can't head-of-line-block the IPC thread
  (2026-07-06). `#[tauri::command(async)]` had already moved sync bodies off
  the main thread, but they still occupied one of the async runtime's few
  *core* workers for their whole duration — a fan-out of slow reads (a
  workspace refresh walking several big repos) could occupy every worker and
  stall all pending commands. A `run_blocking(label, work)` helper in
  `commands.rs` now routes every repo-size-scaled read (open / meta / status /
  snapshot / log / search / refs / all `diff_*` / merge-base / file content-
  blob-history / blame / reflog / tree / submodules / worktrees / stash list)
  and every subprocess-waiting AI command (status / login — which can sit for
  minutes on interactive auth — / logout / suggest) onto tokio's blocking
  pool; the network commands' hand-rolled `spawn_blocking` + join-error
  boilerplate was collapsed onto the same helper. Quick writes (stage, branch,
  tag, …) deliberately stay plain sync bodies.
- ☑ `repo_snapshot(path)` batch command (`snapshot.rs`: meta + status +
  work-tree + refs + submodules from one open and **one statuses walk**;
  `refreshLocalChanges`/`refreshSnapshot` in `stores/repo.ts` route every
  post-op and watcher refresh through it — the old five-call bundle is gone).
- ☑ Virtualize the commit-graph table (`Commits.tsx` — viewport slice +
  spacer `<tr>`s keyed to the density row height; `scrollIntoView` falls back
  to index-math scrolling when the focused row isn't mounted;
  `aria-activedescendant` + ⌘A preserved since selection state never left).
- ☑ Diff `collect()` (`diff.rs`): single `print` pass with adds/dels counted
  inline and a path→index `HashMap` (the foreach pre-pass and O(files×lines)
  linear scan are gone).
- ☑ Share one `statuses()` walk between `status` and `work_tree`
  (`status::from_statuses` + `tree::from_index_and_statuses`, shared by
  `Repo::snapshot`; the standalone methods still walk independently when
  called directly).
- ☑ Sidebar: memoize ref-tree builds / `leafCount`; debounce `refreshTree` off
  the `status` dep — done 2026-07-06, root-caused one level down. The tree
  builds were already `useMemo`d; they rebuilt anyway because
  `refreshSnapshot` replaced `status`/`workTree`/`refs`/`submodules`/`meta`
  with freshly deserialized objects on every refresh, so input identity
  churned on every stage toggle / watcher tick. New `lib/stable.ts`
  (`stable(prev, next)` returns the previous reference when structurally
  equal; unit-tested) now guards every snapshot-fed slice plus the standalone
  `refreshStatus`/`refreshRefs`/`refreshTree`/`refreshSubmodules` setters —
  unchanged slices keep identity, so the sidebar ref trees, palette index,
  and Files `PierreTree` stop rebuilding (and their subscribers stop
  re-rendering) for identical data. `leafCount` is precomputed once per tree
  build (`countLeaves` fills `TreeNode.leaves`) instead of recursing per
  folder row per render. The `refreshTree`-on-`status` dep was **removed**
  rather than debounced: since the `repo_snapshot` batch, every
  status-changing path already refreshes `workTree` from the same statuses
  walk, so the effect's IPC re-walk was a redundant second walk of the
  working tree — it now runs only on Files-tab show / repo switch (the lazy
  first load). Verified: `tsc`, `vitest` (198, +13 `stable`), `vite build`.
- ☑ Wire commit-graph search (`Commits.tsx`). Resolved by **highlighting matches
  in place instead of filtering** — every commit stays in the list, so the lane
  algorithm's parent→child continuity is never broken. (Backend `git log`-based
  full-history / `-G` content search shipped 2026-06-24 — `Repo::search_log`,
  surfaced in a results dropdown; see strand-core → Reads.)

---

## Security & privacy

- ☑ Opt-in crash reporting (off by default) — **user-mediated, no upload
  path** (2026-07-06). Local half: a panic hook (`install_crash_log` in
  `main.rs`) appends panics + backtraces to `app_log_dir()/crash.log`,
  always, nothing leaves the machine. Reporting half: `crash_report_check`
  IPC (a pure local read — log path + byte length + the newest panic entry
  past the frontend's persisted ack offset, entry capped at 8 KB) feeds an
  opt-in launch prompt (`crashPrompt`, default off; `crashAck` offset in
  the settings store) — a persistent CrashToast offers **Report…** (opens a
  *prefilled GitHub issue* in the browser via `buildCrashIssueUrl` in
  `lib/crashReport.ts`, URL-budgeted to ~7 KB, so the user reviews exactly
  what leaves the machine and submitting is their explicit act) or Dismiss;
  both acknowledge. Settings → **Privacy** (new section, future telemetry
  home) hosts the toggle, a "Report last crash…" button (grayed when the
  log is empty), and the disclosure line with the log path. There is
  deliberately no automatic-upload backend — the project has none, and the
  user-reviewed issue keeps PRD §10 honest.
- ☑ 1.0 privacy decision: no product telemetry. The opt-in crash-report flow is
  user-reviewed and opens a browser; no automatic-upload backend exists.
- ☑ SSH passphrases stay with the system SSH agent and configured
  `SSH_ASKPASS`/`GIT_ASKPASS` provider inherited by system Git; Strand never
  reads or caches private keys (`network::run_git_streaming`).
- ☑ GPG passphrases delegate to `gpg-agent`/pinentry on the system-Git commit
  path with no in-app caching (`Repo::commit`, `commit.gpgSign=true`).
- ☑ Hook execution warning on fresh clones (`CloneDialog` trust notice, placed
  before URL entry and verified in the built app with Computer Use, 2026-07-18)
- ☑ Signed update manifest enforcement (`check-release-security.mjs` locks
  `createUpdaterArtifacts`, the HTTPS stable channel, and updater key ID;
  required by CI and every release job)
- ☑ Shell-out config hardening — `GIT_SAFE_CONFIG` (`-c core.fsmonitor=` /
  `core.pager=cat`) prepended on network/history/stash; conflict read/write path
  now canonicalizes to block symlink escape (`crates/strand-core`).
- ☑ Narrowed `shell:default` to `shell:allow-open`: external links remain
  available, while command execution is not granted (least privilege).
- ☑ Set and verify the production CSP (`tauri.conf.json` exact allowlist;
  self-hosted scripts/fonts, Tauri IPC/asset protocols, HTTPS images, and only
  the inline styles required by React/Pierre; built custom-protocol app smoke-
  tested with Computer Use, 2026-07-18).
- ☑ Replace broad default capabilities, including `os:default`, with the exact
  commands used by the desktop UI (`capabilities/default.json`, local desktop
  windows only; enforced by `check-release-security.mjs`, 2026-07-18).
- ◐ License decided (AGPL-3.0 + dual-license commercial). Still need:
  - ☑ `LICENSE` file (AGPL-3.0 text) at repo root (added 2026-06-12)
  - ☑ `COMMERCIAL.md` describing the commercial-license offer (added
    2026-06-12; linked from the website pricing card + footer)
  - ☐ CLA workflow before opening to outside contributions

---

## Pre-launch checks (PRD §13)

- ☐ Trademark search: USPTO, EUIPO, WIPO
- ☐ Reserve `dev.danielss.strand` IDs in macOS App Store + Microsoft Store
- ☑ Create GitHub org / repo + decide visibility (`danielss-dev/strand`,
  made public 2026-06-12 — AGPL-3.0 LICENSE + COMMERCIAL.md at root)
- ☐ Social handles (X, Mastodon)
- ◐ Landing page at `strand.danielss.dev` + downloads + auto-update manifest
  (site built: `website/` — static, no build step, design tokens + fonts lifted
  from the app, interactive app-replica demo + ⌘K palette, AGPL/honor-system
  pricing section. **Deployed on Railway** — project `landings`, service
  `strand-landing`, live at https://strand.danielss.dev (custom domain DNS
  flipped). Site links point at the public `danielss-dev/strand` repo as of
  2026-06-12. Download buttons resolve release assets and `latest.json` is
  served from GitHub Releases. Still pending: og:image.)
- ☑ User-guide docs on the website (2026-07-08: `website/docs/` — nine
  fact-checked markdown pages + `manifest.json`, rendered client-side by
  `docs/index.html`/`docs.js` with vendored `marked.min.js`; no build step —
  updating docs = editing the `.md` files and redeploying. Landing page synced
  to 0.9.x: Linux download button live, installer sizes corrected, worktree
  Compare / Merge & clean up + Workspaces + AI commit messages cards, Docs
  link in nav/footer/⌘K.)
- ☐ Keep `website/docs/` in sync with app releases — re-check the guide (and
  landing claims) whenever a release adds or changes user-visible behavior.

---

## Remote repos over SSH (post-1.0 — designed 2026-06-12)

Open a repo on a remote machine over SSH and use Strand locally against
it. Design doc: [`docs/remote-ssh.md`](./docs/remote-ssh.md) — read it
before starting any row here; it records the decided architecture
(headless `strandd` daemon over JSON-RPC/stdio, system `ssh` for
auth/transport) and the rejected alternatives. **Do not start before 1.0
ships** (ROADMAP §1.1+).

### Pre-1.0 guardrails (active now — the only rows not gated on 1.0)

- ☐ Keep every engine call flowing through `tauri.ts` → `commands.rs`;
  no side-channel filesystem access from the frontend
- ☐ Treat repo `path` as an opaque key in UI code — never parse or
  assume local-FS semantics on it
- ☐ Keep local-OS-touching ops (dialogs, shell-outs, reveal) in
  separated modules (`external.rs` pattern) so capability flags can
  fence them later

### Engine & daemon

- ☐ P2 Extract command handlers from `strand-tauri` into a
  transport-agnostic `strand-ops` crate (shared by Tauri shell + daemon)
- ☐ P2 `strandd` headless binary: `strand-ops` behind JSON-RPC over
  stdio; versioned handshake with capability flags; strict serde
  (`deny_unknown_fields`), per-frame size limits
- ☐ P2 Remote watcher: `watch.rs` runs inside `strandd`, events stream
  back as notifications, remote-side debounce/coalescing
- ☐ P2 Static builds of `strandd`: linux x86_64/aarch64 (musl) + darwin;
  SHA-256 manifest baked into the signed app bundle

### Transport & lifecycle

- ☐ P2 Transport router in `strand-tauri`: plain path → in-proc (zero
  overhead, no hot-path regression); `ssh://host/path` → host's stdio
  channel
- ☐ P2 SSH connection manager: spawn system `ssh` (inherits
  `~/.ssh/config`, known_hosts, agent, ProxyJump — Strand never touches
  credentials, never auto-accepts host keys); keepalives; one multiplexed
  connection per host
- ☐ P2 Bootstrap: probe/upload `strandd` over SFTP, verify SHA-256
  before exec, re-bootstrap on version mismatch
- ☐ P2 Reconnect: exponential backoff; reads retry transparently,
  writes never auto-retry (re-query state, user confirms); per-op-class
  timeouts; kill + respawn a hung daemon
- ☐ P2 Connection health UI: topbar indicator, disconnected state for
  remote tabs, manual "reconnect now"; local repos unaffected by a dead
  link

### UI surface

- ☐ P2 Connect-to-host flow (host list from `~/.ssh/config` aliases) +
  remote repo open; `ssh://` paths in recents/tabs
- ☐ P2 Remote directory browser (native dialogs can't browse remote FS)
- ☐ P2 Capability-flag gating: hide `external.rs` ops for remote repos
  (v1); evaluate "open terminal" → `ssh -t` later

---

## `strand` CLI (post-1.0 — designed 2026-06-12)

Headless companion binary: `strand <path>` opens the repo in the app,
data subcommands (`diff`, `log`, `status`, `review`, …) print
terminal-rendered or `--json` output for AI agents. **Read-only by
design** — no push/pull/fetch, no writes (decided 2026-06-12).
Design doc: [`docs/strand-cli.md`](./docs/strand-cli.md). **Same binary
as the remote-SSH daemon** (`--stdio` mode) — shares the `strand-ops`
extraction above as prerequisite. **Do not start before 1.0 ships**
(ROADMAP §1.1+).

### AI writing suggestions

- ☑ Rust `ai/` module + IPC (`ai_provider_*`, `repo_suggest_commit_message`)
- ☑ Settings → AI (ChatGPT / Claude Code sign-in, custom CLI paths)
- ☑ Provider-focused AI settings + persisted per-provider writing models used
  by commit and PR generation (`AiSection`, `openaiModel` / `anthropicModel`,
  model-aware vendor CLI argv, remembered last-checked connection state)
- ☑ CommitBar Suggest + palette / ⌘⇧M shortcut (prefers the staged diff; falls
  back to all unstaged changes when no staged diff exists)
- ☑ Pull-request title/description suggestions from committed merge-base diffs
  (`repo_suggest_pull_request`, Create PR **Fill with Codex/Claude Code**)
- ☑ Windows CLI spawning hardened (DAN-11: `ai/bin.rs` resolves `.exe`/`.cmd`/
  `.bat` only — never npm's extensionless POSIX shims — and runs batch shims
  via `cmd /C`; prompts travel over stdin; null stdin + 30s/120s timeouts so
  an interactive CLI prompt can't hang the spinner forever; `CREATE_NO_WINDOW`
  stops per-call console flashes in the release build; CommitBar surfaces
  suggest failures inline as "Suggestion failed: …" instead of a silently
  disabled sparkle / mislabeled "Commit failed:")
- ☑ Desktop-launch CLI environment restoration (`path_env.rs` asynchronously
  captures the interactive login-shell PATH on Unix and merges persisted
  Windows user/machine PATH entries; shared canonical lookup, Windows batch
  path normalization + absolute `cmd.exe`, blank-override normalization, and
  child PATH propagation make `gh`/`az`/`codex`/`claude` plus npm runtimes
  available in packaged apps without searching the repo)
- ☑ Broken vendor-CLI installs stay distinct from signed-out sessions
  (`AiProviderStatus.error`, auth-failure classification, and `--version`
  login preflight prevent false “browser opened” messages)
- ☑ AI provider execution hardened and cancellable (`AiProviderAdapter`,
  canonical CLI resolution, isolated read-only Codex cwd/argv, bounded
  stdout/stderr, process-group/Windows Job Object teardown, and shared
  network/AI `repo_cancel_op` registry)
- ☑ Sensitive-input confirmation contract (`AiGenerationOutcome` scan →
  exclude/include fingerprint retry; classifications contain paths and kinds
  only, and changed diffs invalidate confirmation)
- ☑ Deterministic large-change context and writing UX (`AiInputCoverage`,
  200-file/4 KB manifest, ranked 8-patch/12 KB context with 3 KB per-file
  caps, recent HEAD subjects, `common_dir` repository writing profiles,
  PR-draft coverage/provider labels and one-step undo, shared Cancel,
  cross-provider retry, and “Draft pull request with AI…” palette action)
- ☑ Content-sized commit descriptions (DAN-21: `CommitBar` now fits the
  textarea to short or wrapped content and caps long drafts at 120px)
- ☑ Compact commit-suggestion result (`CommitBar` applies the editable subject
  and body without persistent coverage or Undo rows)
- ☑ AI subprocess lifecycle tests run in the normal Linux Tauri gate; the
  dedicated Linux/Windows matrix was removed after its Windows full-crate build
  added roughly five minutes to exercise a one-second scoped suite
- ☐ Rebase reword suggestions (share CommitBar generator)
- ☐ Conflict-resolution hints — PRD Q3 follow-up

### Pre-1.0 guardrails (active now)

- ☐ Treat IPC serde types (`FileDiff`, `Commit`, `Snapshot`, …) as a
  public contract in waiting — additive evolution preferred; renames
  become breaking changes once `--json` ships

### Binary & commands

- ☐ P2 `strand-headless` crate: clap front-end over `strand-ops` with
  `cli` + `--stdio` (daemon) entry modes; one static artifact, one hash
  manifest shared with remote-SSH bootstrap
- ☐ P2 Read commands: `status` (+ `--snapshot`), `diff` (`--staged`,
  `--commit`, `--between`, `--since`, `--full-context` via the `*_full`
  review ops), `log`, `blame`, `conflicts`
- ☐ P2 Terminal diff renderer: Rust-native — `syntect` highlighting +
  truecolor ANSI through a pager (the `delta` model), theme ported from
  `tokens.css`. Decided: no JS runtime in the binary; OpenTUI/Pierre
  rejected for in-process use (see `docs/strand-cli.md` open questions)
- ☐ P2 `review` command: one payload (full-context diffs since base +
  log + status) for agent/reviewer consumption
- ☐ P2 Machine output contract: `--json` reusing IPC serde types,
  `schemaVersion` envelope, `strand schema` dump, NDJSON progress
  streaming, JSON errors on stderr + stable exit codes, no pager/locale
  variance

### App integration

- ☐ P2 Wire `tauri-plugin-single-instance` into `strand-tauri` (second
  launch forwards argv to the running instance) — prerequisite for
  `strand <path>`
- ☐ P2 `strand <path>`: forward to running app or launch it with the
  path (macOS `open -a Strand --args`; exec elsewhere)
- ☐ P2 Settings action: install `strand` shim/symlink on PATH (the VS
  Code `code`-command pattern); Windows `strand.cmd` variant
- ☐ P2 Ship the binary inside the app bundle + standalone per-release
  download for headless boxes
