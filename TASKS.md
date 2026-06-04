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
- ☐ Submodule list + status
- ☐ Reflog reader
- ☐ Blame (`git2::Blame`)
- ☐ File history for a path
- ☐ Tree listing for a commit (powers file tree at a revision)
- ☐ File content at a revision (powers Content tab)
- ☐ Commit search (message, author, hash) — and `-G` / `-S` content search

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
- ☐ Interactive rebase (custom sequence-editor; shells out)
- ☐ Cherry-pick / revert a merge commit (mainline `-m` selection UI)
- ☐ Submodule init / update / sync

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

### Hybrid concerns
- ☑ Write-engine policy decided: `git2` for index/commit ops (stable
  Rust API, no spawn overhead); shell-out to user's `git` for network
  ops (credentials, hooks, LFS, GPG come for free)
- ☐ Repo cache to avoid re-`discover` per command on hot paths
- ☐ Tracing spans on every public fn for perf diagnostics

---

## strand-tauri (IPC + app shell)

- ☑ Read commands: `repo_open`, `repo_meta`, `repo_status`, `repo_log`,
  `repo_refs`, `repo_diff_unstaged` / `_staged` / `_between`, `repo_tree`
- ☑ Write commands: `repo_stage`, `repo_unstage`, `repo_stage_many`,
  `repo_unstage_many`, `repo_discard_many`, `repo_discard`,
  `repo_commit`, `repo_checkout`, `repo_checkout_commit`, `repo_branch_create`,
  `repo_branch_delete`, `repo_tag_create`, `repo_tag_delete`,
  `repo_cherry_pick`, `repo_revert`, `repo_merge`, `repo_rebase`,
  `repo_abort_operation`, `repo_read_conflict_file`, `repo_resolve_conflict`,
  `repo_stash_list`, `repo_stash_save`,
  `repo_stash_snapshot`, `repo_stash_apply`, `repo_stash_pop`, `repo_stash_drop`
- ☑ Network commands: `repo_fetch`, `repo_pull`, `repo_push`, `repo_clone`,
  `repo_tag_push`, `repo_tag_push_all`, `repo_remote_tags` (all `async`;
  streaming progress over a `Channel` where applicable)
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
  (URL + native destination picker + live progress bar; opens on success)
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
- ☐ Submodules list
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
- ☐ Search bar (currently visible but inert)
- ☐ Graph style preset switching (classic / bold / subtle)
- ☐ GPG sign status indicator in commit-detail meta

### File view (4-tab)
- ☑ Tab strip + header
- ☐ Content tab — Shiki-highlighted file content at revision
- ☐ History tab — log for the file path
- ☐ Compare tab — two-revision picker + diff
- ☐ Blame tab — per-line author + commit jump
- ☐ Tab state persistence per-file (settings store)

### Command palette
- ☑ Open / close, ⌘K, fuzzy filter, run-on-Enter
- ◐ Real action registry (open + recents wired; sync/show/theme stubbed)
- ☑ Include recent repos in the index (branches, files, commits still pending)
- ☑ Keyboard navigation (↑↓ to highlight + scroll-into-view; mouse hover also moves selection)
- ☐ Scope pills (All / Actions / Branches / Files / Commits)

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

## Conflict resolution

- ◐ In-progress op surfaced + abort: `RepoMeta.operation` (rebase / cherry-pick
  / revert / merge, read from `.git/` markers) drives an `OpBanner` above the
  main view with an Abort button + ⌘K "Abort <op>". The three-way *resolution*
  UI below is still the open work; today conflicts are resolved in Local Changes
  (conflicted files show via the `CONFLICTED` status) and committed by hand.
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
- ☐ Fallback to external mergetool (`git config merge.tool`)

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
- ☐ Auto-update beta channel + stable channel
- ☐ Windows 11 platform pass (chrome styled but never tested)
- ☐ Linux platform pass on GNOME + KDE
- ☐ Per-platform credential storage:
  - macOS Keychain
  - Windows Credential Manager
  - libsecret / kwallet

---

## Performance (PRD §8 targets)

- ☐ Cold start < 1.0s on M-series Mac (measure baseline)
- ☐ Open 100k-commit repo < 2.0s
- ☐ Status refresh on 10k-file working tree < 200ms
- ☐ Diff render for 5,000-line file < 100ms
- ☐ Stage/unstage hunk < 50ms perceived
- ☐ Idle memory < 250MB for one medium repo
- ☐ Installer < 25MB per platform

### Audit follow-ups (2026-06-04 perf/UX audit)

Larger items surfaced by the audit and verified against the code; the safe
quick-wins from that audit already landed (see ROADMAP changelog).

- ☐ Cache the opened repo per path in `AppState` + open git2 once per `Repo`
  (reused handle) — every IPC command currently re-runs `gix discover` + git2
  open. Needs explicit invalidation tied to the refresh path. (`meta()` already
  reuses one git2 handle.)
- ☐ Move CPU/disk-bound read commands (`repo_log`/`status`/`diff_*`/`tree`/`refs`)
  to `spawn_blocking` so a slow op can't head-of-line-block the IPC thread.
- ☐ `repo_snapshot(path)` batch command (meta + status + diffs + refs in one
  open) to collapse the ~6 IPC round-trips per post-commit/checkout refresh.
- ☐ Virtualize the commit-graph table (`Commits.tsx`) — every row mounts today;
  prerequisite for the 100k-commit target. Preserve `scrollIntoView` +
  `aria-activedescendant` + ⌘A.
- ☐ Diff `collect()` (`diff.rs`): index deltas by a map (drop the
  O(files×lines) linear scan + per-line alloc), merge the adds/dels count into
  the print pass, and route by delta index (also fixes deleted-file mis-routing).
- ☐ Share one `statuses()` walk between `status` and `work_tree` (the UI calls
  both for one refresh).
- ☐ Sidebar: memoize ref-tree builds / `leafCount`; debounce `refreshTree` off
  the `status` dep so stage toggles don't re-walk the whole tree.
- ☐ Wire commit-graph search (filtering must preserve graph lane continuity —
  that's why the input is disabled today). `Commits.tsx`.

---

## Security & privacy

- ☐ Opt-in crash reporting (off by default)
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
