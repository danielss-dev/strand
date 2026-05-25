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
- ☑ `Repo::meta` (branch only — ahead/behind hardcoded to 0)
- ☑ `Repo::status` (via git2)
- ☑ `Repo::log` (basic revwalk, no graph data)
- ☐ Compute real ahead/behind against upstream ref
- ☐ Resolve refs (branches, remotes, tags) into typed structs
- ☐ Stash list
- ☐ Submodule list + status
- ☐ Reflog reader
- ☐ Blame (`git2::Blame`)
- ☐ File history for a path
- ☐ Tree listing for a commit (powers file tree at a revision)
- ☐ File content at a revision (powers Content tab)
- ☐ Diff between two oids — produce the `FileDiff`/`Hunk`/`DiffLine` types
  already defined in `diff.rs`
- ☐ Diff for working tree vs index, index vs HEAD, working vs HEAD
- ☐ Rename detection threshold + classification
- ☐ Commit search (message, author, hash) — and `-G` / `-S` content search

### Writes
- ☐ Stage / unstage path
- ☐ Stage / unstage hunk
- ☐ Stage / unstage line
- ☐ Discard working-tree changes (path / hunk / line)
- ☐ Commit (subject + body + amend)
- ☐ Create / delete branch (from HEAD, from commit)
- ☐ Checkout branch / commit
- ☐ Create / delete tag (lightweight + annotated)
- ☐ Stash create / apply / pop / drop / branch-from
- ☐ Cherry-pick (single + multi)
- ☐ Revert
- ☐ Merge (ff / no-ff / squash)
- ☐ Rebase (onto branch, onto commit)
- ☐ Interactive rebase (custom sequence-editor; shells out)
- ☐ Submodule init / update / sync

### Network
- ☐ `fetch` with progress events (stream via Tauri event)
- ☐ `pull` (fetch + merge or rebase, configurable)
- ☐ `push` with progress + force/lease flags
- ☐ Clone with progress + credential prompts
- ☐ Credential helper integration (OS keychain via `auth-git2` or similar)

### Hybrid concerns
- ☐ Decide write engine per op: pure `git2` vs shell-out to user's `git`
  (matters for GPG, hooks, LFS, sparse-checkout, partial clone)
- ☐ Repo cache to avoid re-`discover` per command on hot paths
- ☐ Tracing spans on every public fn for perf diagnostics

---

## strand-tauri (IPC + app shell)

- ☑ 4 commands: `repo_open`, `repo_meta`, `repo_status`, `repo_log`
- ☑ Plugins: sql, updater, dialog, shell, os
- ☑ SQLite migrations stub (`recent_repos`, `settings`)
- ☐ Stream events for long-running ops (clone, fetch, push)
- ☐ Surface every `strand-core` op as an IPC command
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
- ☑ Drag-and-drop a folder → calls `useRepo.openRepo`
- ☑ Recent-repos UI (sidebar empty-state + topbar `+` dropdown + command palette)
- ☑ Multi-repo tabs (open, switch active, close; deduplicates by canonical path)
- ☐ Tab persistence across launches (open tabs are not restored on relaunch)
- ☐ Tab reordering by drag and overflow scrolling

### Topbar
- ☑ Layout + native-chrome alignment
- ☐ Fetch / Pull / Push handlers (currently toast-only)
- ◐ Branch picker dropdown (shell exists; needs real branch list from #3 and create-branch wired in #4)
- ☐ Stash split button

### Sidebar
- ☑ Local Changes + All Commits primary rows
- ☑ Git / Files tab toggle
- ☐ Branches list from real data (sections are placeholders)
- ☐ Remotes list grouped by remote
- ☐ Tags list
- ☐ Stashes list
- ☐ Submodules list
- ☐ Files tree — depends on `@pierre/trees` decision

### Local Changes view
- ☑ Three-section layout (placeholder rows)
- ☐ Real per-file rows from `useRepo.status`
- ☐ Diff view in middle panel — depends on `@pierre/diffs` decision
- ☐ Per-row Stage / Unstage / Discard actions
- ☐ Bulk "Stage all" / "Unstage all"
- ☐ Commit form: subject + body + amend + recent-messages dropdown
- ☐ Commit kbd shortcut (⌘↵)

### Commits view
- ☑ Table from `repo_log`
- ☐ SVG lane rendering
- ☐ Branch / tag / HEAD chips on the right
- ☐ Selectable + multi-selectable rows
- ☐ Inline commit detail panel (message, files, diff)
- ☐ Search bar (currently visible but inert)
- ☐ Graph style preset switching (classic / bold / subtle)

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
- ☐ Tweaks panel UI (settings exposed, no UI to change them yet)
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
