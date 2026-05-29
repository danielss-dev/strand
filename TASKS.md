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
- ☑ `Repo::log` (basic revwalk, no graph lane data)
- ☑ `Repo::diff_unstaged` / `diff_staged` / `diff_between` — emit per-file
  unified-patch text consumed by `<PatchDiff>` (Pierre parses hunks);
  untracked files include their full content via `show_untracked_content`
- ☑ Rename detection (`DiffFindOptions::renames(true).copies(true)`)
- ☑ Resolve refs (branches, remotes, tags) into typed structs
  (`Repo::refs` → `Refs { branches, remotes, remote_branches, tags }`;
  exposed via `repo_refs` IPC; per-branch upstream + ahead/behind)
- ☑ `Repo::work_tree` — working-tree file listing (index entries ∪ untracked,
  ignored excluded, overlaid with change status) powering the Files sidebar tab
- ☐ Stash list
- ☐ Submodule list + status
- ☐ Reflog reader
- ☐ Blame (`git2::Blame`)
- ☐ File history for a path
- ☐ Tree listing for a commit (powers file tree at a revision)
- ☐ File content at a revision (powers Content tab)
- ☐ Commit search (message, author, hash) — and `-G` / `-S` content search

### Writes
- ☑ Stage / unstage path (`Repo::stage_path` / `unstage_path` via git2)
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
- ☐ Create / delete tag (lightweight + annotated)
- ☐ Stash create / apply / pop / drop / branch-from
- ☐ Cherry-pick (single + multi)
- ☐ Revert
- ☐ Merge (ff / no-ff / squash)
- ☐ Rebase (onto branch, onto commit)
- ☐ Interactive rebase (custom sequence-editor; shells out)
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
- ☑ Write commands: `repo_stage`, `repo_unstage`, `repo_discard`,
  `repo_commit`, `repo_checkout`, `repo_checkout_commit`, `repo_branch_create`,
  `repo_branch_delete`
- ☑ Network commands: `repo_fetch`, `repo_pull`, `repo_push`, `repo_clone`
  (all `async`, streaming progress over a `Channel`)
- ☑ Plugins: sql, updater, dialog, shell, os
- ☑ SQLite migrations stub (`recent_repos`, `settings`)
- ☑ Capabilities: granted `sql:allow-execute` so SQLite writes land
  (`sql:default` only covers reads — silent failure trap, see
  `docs/learnings.md`)
- ☑ SQLite migration v2: `commit_messages` (per-repo commit message history)
- ☑ Stream events for long-running ops (clone, fetch, push, pull) — via
  `tauri::ipc::Channel<Progress>`, no extra capability needed
- ☐ Real updater pubkey + endpoint (currently placeholder)
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
- ☐ Stash split button

### Sidebar
- ☑ Local Changes + All Commits primary rows
- ☑ Git / Files tab toggle
- ☑ Branches list from real data — names with `/` render as nested
  folders (e.g. `feature/foo` lives under a `feature/` folder), default
  expanded, click chev to collapse. Leaf rows checkout on click, show
  drift, hover × to delete non-HEAD branches with a confirm.
- ☑ Remotes list as a tree rooted at the remote name (e.g. `origin/` is
  the top folder; click a leaf to create + track locally)
- ☑ Tags list (folder tree; create/delete pending writes)
- ☐ Stashes list
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
- ☑ Per-row Stage / Unstage actions (file-level, hover-revealed)
- ☑ Bulk "Stage all" / "Unstage all"
- ☑ Commit form: subject + body + amend
- ☑ Commit kbd shortcut (⌘↵)
- ☐ Per-row Discard action (currently store-level only; needs right-click menu)
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
- ☐ **Theme management**
  - ☐ Define theme contract (`light` / `dark` / `system`) as CSS-variable sets
  - ☐ `theme` key in `settings` SQLite table with default `system`
  - ☐ `useTheme` hook: read setting, subscribe to OS `prefers-color-scheme`,
    apply `data-theme` on `<html>`
  - ☐ Settings UI section: theme picker (Light / Dark / System) with live preview
  - ☐ Command palette actions: "Switch to Light", "Switch to Dark", "Use System Theme"
  - ☐ Cycle-theme keyboard shortcut (⌘⇧T)
  - ☐ Persist last manual choice across launches; restore before first paint
    (no flash of wrong theme)
  - ☐ Audit components for hardcoded colors; route everything through tokens
  - ☐ Extension point for future custom themes (high-contrast, solarized, etc.)
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

- ☐ Detect conflicted files from `status`
- ☐ Per-file resolved-state tracker
- ☐ Three-way visual conflict view (likely Pierre's conflict primitive)
- ☐ "Take current / incoming / both" actions
- ☐ Fallback to external mergetool (`git config merge.tool`)

---

## Platform / packaging

- ☐ Replace placeholder icon with a real 1024×1024 source
- ☐ Apple Developer ID + notarization pipeline (start during alpha — 1-2
  week review on first submission)
- ☐ Windows EV cert (~$300/yr — budget per PRD §12)
- ☐ Linux sigstore signing for AppImage
- ☐ CI: GitHub Actions matrix for mac/win/linux × x86_64/aarch64
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

---

## Security & privacy

- ☐ Opt-in crash reporting (off by default)
- ☐ Opt-in telemetry (off by default, clearly disclosed at first launch)
- ☐ SSH passphrase prompts via OS-native dialogs
- ☐ GPG passphrase delegation to `gpg-agent` (no in-app caching)
- ☐ Hook execution warning on fresh clones
- ☐ Signed update manifest enforcement
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
