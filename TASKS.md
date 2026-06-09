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
  Still needs: LICENSE (AGPL-3.0), COMMERCIAL.md, and a CLA before the
  repo opens to outside contributions.
- ☑ **PRD Q5: Pricing model.** Free for all individuals; one-time
  commercial license available for companies that want to support the
  project. No feature gating, no nag dialogs.

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
- ☐ Tree listing for a commit (powers file tree at a revision)
- ☑ File content at a revision (`Repo::file_content` — working tree from disk via
  `safe_workdir_path`, or a blob at a revision; binary heuristic + 2 MB cap)
- ◐ Commit search (message, author, hash) — in-graph highlight over the loaded
  log is done **client-side** (no backend; `Commits.tsx` `commitMatches`), so no
  `Repo` search command exists yet. Full-history search + `-G` / `-S` content
  search (which need `git log --grep`/`-G`) are still ☐.

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
- ☐ Stage / unstage line (sub-block; currently a whole change block is
  the smallest unit. Would need character/line-range selection UI.)
- ☑ Discard working-tree changes (path) — file-level
- ◐ Discard hunk / line + single-undo handle (per-block Discard:
  `Repo::apply_patch(ApplyTarget::WorkdirReverse)` reverse-applies the
  sliced patch to the working tree. Single-undo shipped: `ApplyTarget::Workdir`
  forward-applies the same slice back, surfaced as an Undo toast for 6s via
  `discardPatch` / `undoDiscard` + `lastDiscard` handle. Line-level discard
  still pending.)
- ☑ Commit (subject + body + amend; no GPG signing yet)
- ◐ Create / delete branch (`Repo::create_branch` from any revspec —
  HEAD, commit, remote-tracking branch; auto-sets upstream when starting
  from a remote branch. `Repo::delete_branch` refuses HEAD. Checkout
  from commit still pending.)
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
  `--follow-tags` on a branch push still not wired.)
- ◐ Stash create / snapshot / apply / pop / drop (`stash_save` via `stash_save2`
  with `INCLUDE_UNTRACKED` / `KEEP_INDEX` flags — a clean tree returns
  `StashOutcome { oid: None }` instead of erroring; `stash_snapshot` keeps the
  changes in place via `git stash create` + `store` (or `push -u` + `apply
  --index` when including untracked); `stash_drop` by index). `stash_apply` /
  `stash_pop` shell out to `git` (`run_git` helper) so a dirty index merges
  like real git instead of git2's blanket "uncommitted changes in the index"
  refusal. **branch-from still pending** — no direct git2 API; needs
  branch-at-stash-base + checkout + apply/drop.)
- ◐ Cherry-pick (single + multi) — `Repo::cherry_pick(&[oid])` shells out to
  `git cherry-pick` (accepts a list); the commit-detail panel wires single-commit
  cherry-pick. Bulk cherry-pick from the graph multi-selection still ☐.
- ☑ Revert (`Repo::revert(&[oid])` — `git revert --no-edit`; commit-detail
  "Revert" button. Reverting a merge commit needs `-m`, not yet exposed.)
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
  (keyboard-operable reorder/pick/reword/squash/fixup/drop), launched from the
  commit context menu + `CommitDetail` ("Rebase from here…"), the current-branch
  sidebar menu, and ⌘K "Interactive rebase…". Conflicts route to Local Changes
  → resolve → Continue. (Std-only round-trip + conflict/continue tests in
  `history.rs`.)
- ☐ Interactive rebase: `edit` (pause-to-amend) action — needs an amend-during-
  rebase flow on top of the continue path
- ☐ Interactive rebase: preserve merges (`--rebase-merges`) — v1 flattens; the
  editor warns when the range contains a merge
- ☐ Cherry-pick / revert a merge commit (mainline `-m` selection UI)
- ☑ Submodule init / update / sync (`Repo::submodule_update` — `git submodule
  update [--init] [--recursive] [-- paths]`, shelled out + streamed like the
  other network ops)

### Network
- ☑ `fetch` (shell-out to `git fetch --prune`)
- ☑ `pull` (shell-out; rebase flag supported, no UI yet)
- ☑ `push` (shell-out; `--force-with-lease` flag supported, no UI yet)
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
  ops (credentials, hooks, LFS, GPG come for free)
- ☐ Repo cache to avoid re-`discover` per command on hot paths
- ☐ Tracing spans on every public fn for perf diagnostics

---

## strand-tauri (IPC + app shell)

- ☑ Read commands: `repo_open`, `repo_meta`, `repo_status`, `repo_log`,
  `repo_refs`, `repo_diff_unstaged` / `_staged` / `_between`, `repo_tree`,
  `repo_submodules`, `repo_blame`, `repo_reflog`, `repo_file_content`,
  `repo_file_history`, `repo_diff_commit_file`
- ☑ Write commands: `repo_stage`, `repo_unstage`, `repo_stage_many`,
  `repo_unstage_many`, `repo_discard_many`, `repo_discard`,
  `repo_commit`, `repo_checkout`, `repo_checkout_commit`, `repo_branch_create`,
  `repo_branch_delete`, `repo_tag_create`, `repo_tag_delete`,
  `repo_cherry_pick`, `repo_revert`, `repo_merge`, `repo_rebase`,
  `repo_rebase_todo`, `repo_interactive_rebase`,
  `repo_abort_operation`, `repo_continue_operation`,
  `repo_read_conflict_file`, `repo_resolve_conflict`,
  `repo_stash_list`, `repo_stash_save`,
  `repo_stash_snapshot`, `repo_stash_apply`, `repo_stash_pop`, `repo_stash_drop`
- ☑ Network commands: `repo_fetch`, `repo_pull`, `repo_push`, `repo_clone`,
  `repo_tag_push`, `repo_tag_push_all`, `repo_remote_tags`,
  `repo_submodule_update` (all `async`; streaming progress over a `Channel`
  where applicable)
- ☑ Plugins: sql, updater, dialog, shell, os
- ☑ SQLite migrations stub (`recent_repos`, `settings`)
- ☑ Capabilities: granted `sql:allow-execute` so SQLite writes land
  (`sql:default` only covers reads — silent failure trap, see
  `docs/learnings.md`)
- ☑ SQLite migration v2: `commit_messages` (per-repo commit message history)
- ☑ Stream events for long-running ops (clone, fetch, push, pull) — via
  `tauri::ipc::Channel<Progress>`, no extra capability needed
- ◐ Real updater pubkey + endpoint. Pubkey done: minisign keypair generated
  (key ID `84FCBFD2A981CE5D`, private key at `~/.strand/`, off-repo) and wired
  into `tauri.conf.json` → `plugins.updater.pubkey`; `bundle.createUpdaterArtifacts`
  enabled so signed `latest.json` + bundles are produced. **Still pending:** the
  `endpoints` host `strand.danielss.dev` isn't live, so no updates are served yet.
  (2026-06-07: on the Windows box the `TAURI_SIGNING_PRIVATE_KEY` in env does
  **not** match this pubkey — Tauri warns the generated `.sig` won't validate at
  runtime. Reconcile the key/config before shipping Windows auto-updates.)
- ☐ Native menus (PRD §7): full macOS menubar, in-window Win/Linux menubar
- ☐ Window state persistence (size, position, maximized)
- ☐ Multi-window for "open file detached" if needed
- ☑ Drag-and-drop folder onto window → opens repo
- ☐ Deep-link handler (`strand://open?path=…`) for CLI companion

---

## Frontend — components & wiring

### Repo opening
- ☑ "Open repository" command (palette + ⌘O + topbar `+` dropdown) using `plugin-dialog`
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
- ☑ Drag-and-drop a folder → calls `useRepo.openRepo`
- ☑ Recent-repos UI (sidebar empty-state + topbar `+` dropdown + command palette)
- ☑ Multi-repo tabs (open, switch active, close; deduplicates by canonical path)
- ☑ Tab persistence across launches (via `settings.session.tabs` in SQLite)
- ☐ Tab reordering by drag and overflow scrolling

### Topbar
- ☑ Layout + native-chrome alignment
- ☑ Fetch / Pull / Push handlers (shell out to `git`; spinner + shimmer
  + directional bobbing animation while in flight; success flashes an
  inline accent-colored check on the button — `.sync-done` in chrome.css,
  `flashDone` in App.tsx — no longer a toast; failures still toast git
  stderr)
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
  menu = Checkout / Merge into <current> (opens `MergeDialog`) / Rebase <current>
  onto this (confirm) / Delete branch (confirm). HEAD shows a disabled "Current
  branch".
- ☑ Remotes list as a tree rooted at the remote name (e.g. `origin/` is
  the top folder; click a leaf — or its menu's "Create local branch & track" —
  to create + track locally)
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
- ☑ Stashes list — flat list under the Git tab. Click a row to apply;
  right-click menu = Apply / Pop (apply & remove) / Drop (confirm). Respects
  the sidebar filter (matches message + branch). Section header `+` action
  (`SideSection`'s optional `action` prop) opens the Save-snapshot dialog.
- ☑ Save-snapshot dialog (`views/StashDialog.tsx`, reuses the `.clone-dialog`
  shell): message field + "Include untracked files" + "Keep changes in working
  directory" checkboxes; primary CTA flips Stash / Save Snapshot. Reachable
  from the sidebar `+`, the Topbar stash menu, and ⌘K ("Save snapshot…" /
  "Stash changes…"). Clean tree surfaces "Nothing to stash" inline.
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
  status change. Built with the existing `buildTree`/`sortTree` primitives
  (no `@pierre/trees` dependency).

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
- ☑ Stacked diff pane is **viewport-lazy**: each file's Pierre diff body mounts
  only when its block scrolls near the viewport (IntersectionObserver, ~900px
  pre-roll), with a height-estimated placeholder until then — so "show all" over
  hundreds of files no longer freezes on open / after a merge
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
- ☑ Recent-messages dropdown on the subject field (SQLite `commit_messages`
  per-repo history via migration v2; keyboard-navigable popover that fills
  subject + body; opens with the history button or ArrowDown in the field)
- ☑ Hunk / change-block stage + unstage UI (`HunkAnnotatedDiff` renders
  one `<PierreFileDiff/>` per file with `lineAnnotations` driving an
  inline Stage / Discard pair on each change block — Unstage on the
  staged side. `sliceChangeBlock` carves the synthetic single-hunk patch
  routed through `useRepo.applyPatch`.)
- ☐ Line-level (sub-change-block) stage / unstage — current smallest
  unit is the change block. Would require a line/char selection UI.

### Commits view
- ☑ Table from `repo_log`
- ☑ SVG lane rendering (`ui/src/lib/graph.ts` lane algo + `CommitGraphCell` SVG; multi-color via `--b-1..--b-7`)
- ◐ Branch / tag / HEAD chips inline in the message cell (`indexRefs` in `Commits.tsx` + `.ref-chip` CSS; right-side chip column still open)
- ☑ Selectable rows (single-select drives the detail panel via
  `useRepo.selectCommit`; multi-select via ⌘/Ctrl-click toggle, Shift-click
  range, Shift+↑/↓ extend, ⌘/Ctrl+A select-all, with a count pill + Clear —
  ready for cherry-pick/compare bulk ops in 0.5)
- ☑ Inline commit detail panel (`CommitDetail.tsx` — subject, body, meta, file list, `<Diff />` of the focused file; right-side resizable Panel `strand:commits-split`)
- ☑ Keyboard nav (`Commits` focuses the current commit on open; ↑/↓ move
  row focus; Enter opens details; Esc closes details)
- ☑ Commit-detail actions: Checkout (detached) + "Tag…" (opens the New-tag
  dialog targeting that commit) + Cherry-pick + Revert (single commit onto HEAD;
  conflict/success surfaced via toast)
- ☑ Right-click a graph row → `ContextMenu` with the same actions (Checkout /
  Tag… / Cherry-pick / Revert / Copy SHA); keyboard-operable via Menu key /
  Shift+F10 on the focused row (opens at the row corner)
- ☐ Files tab re-roots to the selected commit (PRD §6.2 — needs `repo_tree_at`)
- ☑ Search bar — wired in the All Commits header (`Commits.tsx`). A field picker
  (Message / Author / Hash, via `ContextMenu`) + text input highlight matching
  rows **in place** (`.match` wash + accent-bolded substring) without filtering,
  so graph lanes stay continuous. ‹/› (or ↵ / ⇧↵) step through matches with an
  N/M counter; `/` focuses the field, ⌘K "Search commits…" jumps to it, Esc
  clears. Client-side over the loaded log (message **subject**, author
  name/email, hash prefix — body is excluded so `Co-Authored-By:`/`Signed-off-by:`
  trailers don't match nearly every commit) — full-history + `-G`/`-S` content
  search remain ☐ under Reads.
- ☑ Stashes shown inline on the graph (`mergeStashRows` in `Commits.tsx` splices a
  synthetic node per stash above its base commit; `Stash` gained `base` + `time_unix`
  from `stash_list`; `GraphRow.isStash` → neutral diamond in `CommitGraphCell`;
  `stash@{n}` chip; right-click Apply/Pop/Drop/Copy SHA. Stashes off-window are
  dropped from the graph but stay in the sidebar.)
- ☐ Graph style preset switching (classic / bold / subtle)
- ☐ GPG sign status indicator in commit-detail meta

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
- ☑ Worktrees overview (`views/Worktrees.tsx` — peer view, ⌘4 + ⌘K "Show:
  Worktrees"; each row enriches lazily via `repoStatus`/`repoMeta`/`repoLog` on
  the worktree path → dirty count, ahead/behind, last commit; Review opens the
  worktree tab on Local Changes; keyboard `role=listbox` + ↑/↓ + Enter).
- ☑ Sidebar Worktrees section (first section in the Git tab; current marked with
  the accent check; single-click → overview, double-click/Enter → open as tab;
  context menu open/show/copy/remove/force-remove/prune; header `+` opens dialog).
- ☑ Grouped worktree tabs (`Topbar.tsx` `groupTabs` clusters by `common_dir`,
  shared dot color via `groupColor`, linked tabs show branch + worktree glyph).
- ☑ Create dialog (`views/WorktreeDialog.tsx` — new/existing branch, default
  sibling `<repo>.worktrees/<branch>` path, "open in new tab" toggle).
- ☐ Review worktree vs base branch (a committed-diff comparison surface — opening
  a worktree currently shows its uncommitted Local Changes + branch history only).

### File view (4-tab)
- ☑ Tab strip + header (opened via `selectFile` from the Files tab / palette;
  a Close action returns to Local Changes)
- ☑ Content tab — working-tree (or revision) content via `repo_file_content`,
  rendered with Pierre's read-only `<File>` (syntax-highlighted, app-themed).
  Shiki-direct highlighting deferred — `<File>` already covers it.
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
- ☐ Tweaks panel UI (settings exposed, no UI to change them yet)
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
- ☐ **Keyboard operability pass.** Almost every action reachable from the
  keyboard, not just the palette (PRD §6.7, `docs/learnings.md`). Per-surface
  focus models + palette entries; audit for mouse-only actions. Drag-and-drop
  (folder open, tab / file reorder) may stay pointer-only.
- ☐ Status-bar: real GPG / LFS / sync state
- ☐ Toast system → proper notification component
- ☐ Empty-state copy for every panel (PRD §9: "no 'no data' labels")
- ☐ Localization framework (English at launch)

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
  read-only with file-level actions). Queue on the left (status, name,
  reviewed check, "changed" stale badge), one file at a time on the right,
  progress bar + verdict actions in the toolbar, keyboard-hint footer.
- ☑ Review baseline ("everything since this commit"): `Repo::diff_since`
  (`diff_tree_to_workdir_with_index` against the baseline tree, so committed +
  staged + unstaged agent work shows in one diff), `repo_diff_since` IPC,
  `RepoMeta.head_oid` to pin it, persisted per-repo (`reviewSession` in
  `lib/db.ts`); pin/move/clear from the Review toolbar or the palette.
- ☑ Review-state tracking: reviewed map (`path → FNV hash of the diff`,
  `hashPatch` in `lib/patch.ts`) — a file the agent touches after review
  flips back to unreviewed (row shows "changed"); persisted per-repo in
  SQLite; drives the sidebar badge + toolbar progress bar.
- ☑ Review keyboard loop (Review view): `j`/`k` queue step, Space = mark
  reviewed **and advance to the next pending file**, `n`/`p` change-block
  step (page-scroll fallback on read-only session diffs), `s` stage, `d`-`d`
  discard, `c` jump to the commit form. Local Changes keeps its own staging
  loop (j/k/n/p/s/d-d/c, no review marking).
- ☑ Bulk verdicts with a safety net: "Stage reviewed (n)" stages files whose
  review mark still matches; "Discard unreviewed (n)" is two-step-armed; any
  multi-file `discardMany` takes an automatic snapshot stash first
  (`Safety: before discarding N files`) and surfaces a 15s Restore toast
  (`BulkUndoToast`) — and the snapshot stays on the stash stack after the
  toast, so a missed window is still recoverable.
- ☑ AI commit chips in the graph (`isAgentCommit` in `Commits.tsx`:
  `Co-Authored-By` trailer / bot-flavored author → an `ai` chip next to the
  ref chips).
- ☐ "Select all commits since baseline" in the graph (one-click review of an
  agent session's commits; pairs with `diff_since`).
- ☐ Watcher: optional `.gitignore`-aware path filtering if build storms show
  up in profiles.

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
- ◐ Apple Developer ID + notarization pipeline. Signing works:
  `pnpm tauri build --target aarch64-apple-darwin` + `APPLE_SIGNING_IDENTITY`
  yields a Developer-ID-signed `Strand_0.0.1_aarch64.dmg`. Notarization +
  stapling still pending Apple credentials (`APPLE_ID` / `APPLE_PASSWORD` /
  `APPLE_TEAM_ID`); universal build pending `x86_64-apple-darwin` target.
- ☐ Windows EV cert (~$300/yr — budget per PRD §12)
- ☐ Linux sigstore signing for AppImage
- ◐ CI: GitHub Actions matrix for mac/win/linux × x86_64/aarch64
  (`.github/workflows/release.yml` — tag-driven `tauri-action` matrix:
  macOS universal, Windows `.msi`, Linux `.deb`/`.rpm`/`.AppImage` → draft
  GitHub Release. Secrets documented in `docs/packaging.md` § "Release CI".
  Not yet run end-to-end — needs the Apple signing secrets added + a first
  `v*` tag to validate.)
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
- ☐ Auto-update beta channel + stable channel
- ☑ Windows 11 platform pass — Rust compiles clean and the MSI builds on a
  Windows 11 box (2026-06-07: `Strand_0.0.1_x64_en-US.msi`, 10.5 MB, via
  `pnpm tauri build --bundles msi`). **Runtime validated 2026-06-07:** launched the
  bundled release `strand.exe` on Windows 11 — the WebView2 frontend renders the
  full UI, the dark theme + amber accent apply cleanly with no flash, and the native
  window frame / controls (titlebar, min/max/close, maximize-restore) all work.
  Chrome is correct on Windows.
- ☐ Linux platform pass on GNOME + KDE
- ☐ Per-platform credential storage:
  - macOS Keychain
  - Windows Credential Manager
  - libsecret / kwallet

---

## Performance (PRD §8 targets)

First engine baseline measured 2026-06-08 on M1 Pro — see `docs/perf-baseline.md`
and the `crates/strand-core/examples/perfcheck.rs` harness (100k-commit + 10k-file
synthetic fixtures). Engine-measurable targets pass; webview/app targets still need
a running-app pass.

- ◐ Cold start < 1.0s on M-series Mac (webview measurement harness landed:
  `ui/src/lib/perf.ts` logs cold-start→first-snapshot plus per-refresh
  snapshot/diffs/log timings — on in dev, opt-in via `localStorage['strand:perf']='1'`
  in release. Numbers still need to be recorded in `docs/perf-baseline.md`.)
- ☑ Open 100k-commit repo < 2.0s (was ~0.5s on the git2 path; the ~0.46s topo-sort
  floor that was the 1M-commit scaling risk is now gone — `log` shells out to an
  incremental `git log`, so `discover + log(5000)` is ~47ms on the 100k fixture)
- ☑ Status refresh on 10k-file working tree < 200ms (measured 42ms; ~85ms with the
  `work_tree` walk the UI also runs per refresh)
- ☐ Diff render for 5,000-line file < 100ms (webview/Pierre render — not measured;
  engine-side `diff_unstaged` for a 501-file changeset is ~150ms, see audit follow-up)
- ☐ Stage/unstage hunk < 50ms perceived (webview — not yet measured)
- ☐ Idle memory < 250MB for one medium repo (full app — not yet measured)
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

- ☐ Cache the opened repo per path in `AppState` + open git2 once per `Repo`
  (reused handle) — every IPC command currently re-runs `gix discover` + git2
  open. Needs explicit invalidation tied to the refresh path. (`meta()` already
  reuses one git2 handle.)
- ☐ Move CPU/disk-bound read commands (`repo_log`/`status`/`diff_*`/`tree`/`refs`)
  to `spawn_blocking` so a slow op can't head-of-line-block the IPC thread.
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
- ☐ Sidebar: memoize ref-tree builds / `leafCount`; debounce `refreshTree` off
  the `status` dep so stage toggles don't re-walk the whole tree.
- ☑ Wire commit-graph search (`Commits.tsx`). Resolved by **highlighting matches
  in place instead of filtering** — every commit stays in the list, so the lane
  algorithm's parent→child continuity is never broken. (Backend `git log`-based
  search for full history / `-G`/`-S` is still ☐ under strand-core → Reads.)

---

## Security & privacy

- ◐ Opt-in crash reporting (off by default) — local half landed: a panic hook
  (`install_crash_log` in `main.rs`) appends panics + backtraces to
  `app_log_dir()/crash.log`, nothing leaves the machine. Opt-in *remote*
  reporting still ☐.
- ☐ Opt-in telemetry (off by default, clearly disclosed at first launch)
- ☐ SSH passphrase prompts via OS-native dialogs
- ☐ GPG passphrase delegation to `gpg-agent` (no in-app caching)
- ☐ Hook execution warning on fresh clones
- ☐ Signed update manifest enforcement
- ☑ Shell-out config hardening — `GIT_SAFE_CONFIG` (`-c core.fsmonitor=` /
  `core.pager=cat`) prepended on network/history/stash; conflict read/write path
  now canonicalizes to block symlink escape (`crates/strand-core`).
- ☑ Dropped unused `shell:allow-open` capability (least privilege).
- ☐ Set a production CSP (`tauri.conf.json` `csp` is `null`). Needs a SHA hash
  for the inline theme-bootstrap script in `index.html` (or move it into the
  bundle), `style-src 'unsafe-inline'` for React/Pierre, `connect-src` for IPC;
  smoke-test the built app before merge.
- ☐ Narrow `os:default` capability to the specific perms used (re-verify the
  mac/win platform toggle after).
- ◐ License decided (AGPL-3.0 + dual-license commercial). Still need:
  - ☐ `LICENSE` file (AGPL-3.0 text) at repo root
  - ☐ `COMMERCIAL.md` describing the commercial-license offer
  - ☐ CLA workflow before opening to outside contributions

---

## Pre-launch checks (PRD §13)

- ☐ Trademark search: USPTO, EUIPO, WIPO
- ☐ Reserve `dev.danielss.strand` IDs in macOS App Store + Microsoft Store
- ☐ Create GitHub org / repo + decide visibility
- ☐ Social handles (X, Mastodon)
- ☐ Landing page at `strand.danielss.dev` + downloads + auto-update manifest
