# PRD — Strand

> A fast, friendly, cross-platform Git client.

**Status:** Draft v1
**Owner:** Daniel
**Last updated:** 25 May 2026

---

## 1. Summary

Strand is a desktop Git client for Windows, macOS, and Linux. It targets developers who want the _speed_ of a terminal workflow with the _clarity_ of a great visual UI — without the bloat, sluggishness, or platform-locked feel of the current alternatives.

It will be built as a **Tauri 2** application with a **Rust** git backend and a **React + TypeScript** frontend that uses [`@pierre/diffs`](https://diffs.com) for code/diff rendering and [`@pierre/trees`](https://trees.software) for the file tree. Both libraries are built on Shiki for syntax highlighting and theming, which gives Strand a coherent visual identity from day one.

---

## 2. Goals & non-goals

### Goals

- **Fast.** Cold start under 1s. Open a 100k-commit repo in under 2s. Status refresh on a 10k-file working tree under 200ms.
- **Friendly.** Discoverable UI, sensible defaults, no Git jargon thrown at users without context. Keyboard-first, but never keyboard-only.
- **Native on every platform.** Native window chrome, native menus, native shortcuts (⌘ on macOS, Ctrl on Windows/Linux). One codebase, three first-class targets.
- **Good-looking out of the box.** Pierre's Shiki theme integration means consistent typography, color, and density across the diff, tree, and editor surfaces.
- **Complete enough to replace Tower / Fork / Sublime Merge / GitKraken** for the day-to-day workflows listed in §6.

### Non-goals (v1)

- A full code editor. Strand shows diffs and file contents at any commit — it does not edit working-tree files. Users edit in their editor of choice.
- A web/cloud product. Strand is a local-first desktop app. No accounts, no telemetry by default.
- A built-in CI/CD or code review system. Strand may _display_ CI status from GitHub/GitLab in later versions, but reviews happen on the host.
- Mobile / tablet versions.

---

## 3. Target users

- **Primary:** Professional developers who use Git daily on macOS, Windows, or Linux and currently rely on either the CLI, Tower, Fork, Sublime Merge, GitHub Desktop, or GitKraken.
- **Secondary:** Designers, technical writers, and PMs who interact with Git but don't live in a terminal — they need the friendly UI more than the power features.

### Personas

- **The CLI veteran.** Wants speed, keyboard shortcuts, a command palette, and the ability to fall through to `git` when needed. Will judge the app on whether it loads a big repo as fast as `git log`.
- **The visual collaborator.** Uses Git but doesn't memorize it. Needs a sane staging UI, conflict resolution that doesn't terrify them, and "what changed?" answered in two clicks.

---

## 4. Tech stack

| Layer                 | Choice                                                           | Rationale                                                                                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App shell             | **Tauri 2**                                                      | True cross-platform, small bundles (~10MB vs Electron's ~100MB+), native webview per OS, signed installers built-in.                                                                                                                         |
| Backend language      | **Rust**                                                         | Speed, safety, and a great Git ecosystem (`gix`, `git2`). Pairs natively with Tauri.                                                                                                                                                         |
| Git engine (read)     | **`gix` (gitoxide)**                                             | Pure-Rust, modern, dramatically faster than libgit2 for log/diff/status on large repos.                                                                                                                                                      |
| Git engine (write)    | **`git2` (libgit2)** + shell-out to `git`                        | Use `git2` for commit/branch/merge/rebase where stable. Shell out to the user's `git` binary for ops that need it: interactive rebase, GPG signing, Git LFS, Git-flow, hooks. This is what Sublime Merge and Tower do — it's the right call. |
| Frontend              | **React + TypeScript**                                           | Required by `@pierre/diffs` and `@pierre/trees`.                                                                                                                                                                                             |
| Diff & code rendering | **`@pierre/diffs`**                                              | Split/stacked diffs, merge conflict UI, line selection, annotations, Shiki themes. Covers most of §6.3.                                                                                                                                      |
| File tree             | **`@pierre/trees`**                                              | Virtualized (handles 100k+ files), Git status badges built in, drag-and-drop, search, keyboard nav, accessible. Covers §6.5.                                                                                                                 |
| Theming               | **Shiki + Pierre Theme pack**                                    | Light + dark out of the box, custom themes possible later.                                                                                                                                                                                   |
| State                 | **Zustand**                                                      | Small, fast, no Redux ceremony.                                                                                                                                                                                                              |
| Persistence           | **SQLite** via `tauri-plugin-sql`                                | Recent repos, settings, command palette history, blame cache.                                                                                                                                                                                |
| IPC                   | **Tauri commands + events**                                      | Rust↔frontend, with streaming events for long-running ops (clone, fetch).                                                                                                                                                                   |
| Updates               | **Tauri updater**                                                | Signed auto-updates on all three platforms.                                                                                                                                                                                                  |
| Packaging             | Tauri bundler → `.dmg`, `.msi`/`.exe`, `.deb`/`.AppImage`/`.rpm` | Single CI pipeline produces all three.                                                                                                                                                                                                       |

### Why not Electron?

Bundle size, memory footprint, and startup time. Strand's "fast" goal is non-negotiable and Electron makes it materially harder. Tauri also has stronger sandboxing and better native menu / window APIs.

---

## 5. Information architecture & UI

The app has two primary regions plus a topbar and a status bar: a **left sidebar** that acts as the navigation source, and a **main pane** that is the workspace — its content changes based on what's selected in the sidebar.

### Topbar

- **Quick Launch** (⌘K / Ctrl+K) — command palette: every action, every branch, every recent repo, fuzzy-searchable.
- **Fetch / Pull / Push** — primary git network actions, with subtle indicators for "X behind / Y ahead".
- **Stash** — split button: stash all, stash staged, pop, apply.
- **Branch** — current branch + dropdown to switch / create.
- **Open in…** — editor, terminal, file manager, web (GitHub/GitLab URL).
- **Work** — toggle that focuses the main pane on Local Changes (staging mode).
- **Repo tabs** — multi-repo, like browser tabs. Reorderable, persisted across launches.

### Sidebar (left) — navigation source

- **Local Changes** — working tree + index status. Shows a badge with file count when there are uncommitted changes.
- **All Commits** — commit graph.
- _(divider)_
- **Filter** field — scopes branches / tags / stashes / files.
- **Branches** — local, grouped by folder (`feat/`, `fix/`, etc).
- **Remotes** — one folder per remote (`origin`, `upstream`, …) with their branches inside.
- **Tags**.
- **Stashes**.
- **Submodules**.
- _(divider)_
- **Files** — file tree of the repo, rendered with `@pierre/trees`. Shows Git status badges (M/A/D/R/U) and folder-descendant indicators. By default it shows the working tree at HEAD; if a commit is selected in the graph, the tree re-roots to that commit's state.

### Main pane — contextual workspace

The main pane fills the right side and shows different content based on the sidebar selection.

#### When **"Local Changes"** is selected — staging workspace

A three-section vertical layout with a commit form pinned to the bottom:

1. **Unstaged** — list of unstaged files with per-row "Stage" and a "Stage all" bulk action. Right-click for discard, ignore, open externally.
2. **Diff view** _(middle)_ — `@pierre/diffs` rendering of the currently selected file, supporting line-by-line and hunk-level **stage / unstage / discard** directly inline. Split or stacked layout, user choice.
3. **Staged** — list of staged files with per-row "Unstage" and "Unstage all".
4. **Commit form** — subject, description, **Amend** checkbox, **Commit** button. Recent commit messages accessible via a dropdown on the subject field.

This is the main workspace for committing — all staging, diff inspection, discarding, and committing happens here without leaving the main pane.

#### When **"All Commits"** is selected — commit graph

- Commit graph with author avatar/name, hash, date, branch/tag chips. Selectable, multi-selectable.
- Selecting a commit reveals an inline **commit detail panel** (collapsible) with:
  - Commit metadata (message, author, date, parents, sign status).
  - Changed files list + `@pierre/diffs` rendering.

#### When **a file is selected** (from the sidebar Files tree) — four tabs

1. **Content** — file content at the current revision (working tree by default, or at the selected commit). Syntax-highlighted via Shiki. Read-only.
2. **History** — commits that touched this file, with a per-commit diff preview. Click a commit to jump to it in the graph.
3. **Compare** — pick any two revisions (commits, branches, tags, or "working tree") and render the diff for this file using `@pierre/diffs`.
4. **Blame** — per-line author + commit attribution. Click a line to jump to the commit that introduced it.

If the file has uncommitted changes, the Content tab shows the working-tree version with a banner offering to switch to the unstaged diff. Tab state persists per-file across the session.

#### When a **branch / tag / remote / stash / submodule** is selected

- **Branch / tag**: commit graph filtered to that ref, plus a header with ahead/behind, last commit, and ref actions (checkout, merge into current, rebase onto, delete, push, …).
- **Stash**: full diff of the stash + actions (apply, pop, drop, branch from stash).
- **Submodule**: status + actions (update, init, sync, open in new tab).

### Status bar (bottom)

Branch, ahead/behind, last fetch time, sync state, GPG status, LFS status.

### Command palette (⌘K)

Every action in the app is reachable here. Fuzzy-matches over actions, branches, tags, commit messages, file paths, and recent repos. Same surface used for "checkout branch", "switch repo", "find commit", "open file at HEAD".

---

## 6. Feature requirements

Priority levels: **P0** = required for first public release, **P1** = required before 1.0, **P2** = nice to have for 1.0, **P3** = post-1.0.

### 6.1 Repository management

| Feature                                           | Priority | Notes                                    |
| ------------------------------------------------- | -------- | ---------------------------------------- |
| Create new local repo                             | P0       | With `.gitignore` template picker.       |
| Clone existing repo (HTTPS / SSH)                 | P0       | Streaming progress; credential prompts.  |
| Add existing local repo                           | P0       | Drag-and-drop folder onto the app.       |
| Open recent repository quickly                    | P0       | In sidebar dropdown and command palette. |
| Multi-repo via tabs                               | P0       | Up to ~20 open.                          |
| Create remote repo on GitHub / GitLab / Bitbucket | P1       | OAuth device flow.                       |
| Delete remote repo                                | P2       | With strong confirmation.                |

### 6.2 Basic git operations

| Feature                            | Priority | Notes                                               |
| ---------------------------------- | -------- | --------------------------------------------------- |
| Fetch / Pull / Push                | P0       | With per-remote progress events streamed from Rust. |
| Commit                             | P0       | With recent message picker (last 20).               |
| Amend last commit                  | P0       | Soft warning if pushed.                             |
| Create / delete branches           | P0       | Including from any commit.                          |
| Create / delete tags               | P0       | Lightweight + annotated.                            |
| Checkout branch or revision        | P0       | Detached HEAD warning.                              |
| Cherry-pick                        | P0       | Multi-select supported.                             |
| Revert                             | P0       |                                                     |
| Merge                              | P0       | Fast-forward, no-ff, squash.                        |
| Rebase                             | P0       | Onto branch, onto commit.                           |
| Stashes (create, apply, pop, drop) | P0       | Visible inline in the commit graph (P1).            |
| Submodules (clone, update, status) | P1       | Recursive operations supported.                     |

### 6.3 Commit & diff view (uses `@pierre/diffs`)

| Feature                                            | Priority | Notes                               |
| -------------------------------------------------- | -------- | ----------------------------------- |
| Stage / unstage at line, hunk, file                | P0       | Direct manipulation in the diff UI. |
| Stacked (unified) and split (side-by-side) layouts | P0       | Persisted per-repo.                 |
| Syntax highlighting for all common languages       | P0       | Via Shiki.                          |
| Inline word/character-level highlights             | P0       | Pierre supports this.               |
| Recent commit messages dropdown                    | P0       |                                     |
| Discard changes (line / hunk / file)               | P0       | With single-undo.                   |
| Diff arbitrary files / commits / branches          | P1       | Pierre supports this natively.      |
| Token hover tooltips                               | P2       | Type info via LSP — explore later.  |

### 6.4 Merge conflict resolution (uses `@pierre/diffs` conflict primitive)

| Feature                             | Priority | Notes                              |
| ----------------------------------- | -------- | ---------------------------------- |
| Visual three-way conflict view      | P0       | Current / Incoming / Both buttons. |
| Per-file resolved state tracker     | P0       |                                    |
| Open in external mergetool fallback | P1       | Honor `git config merge.tool`.     |

### 6.5 Repository navigation (uses `@pierre/trees`)

| Feature                                        | Priority | Notes                                                                     |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| File tree in sidebar (working tree by default) | P0       | Always-visible navigation surface.                                        |
| File tree reflects selected commit             | P0       | Selecting a commit in the graph re-roots the tree to that commit's state. |
| Git status badges (M/A/D/R/U)                  | P0       | Built into `@pierre/trees`.                                               |
| Folder descendant-changed indicator            | P0       | Built-in.                                                                 |
| Search / filter by name                        | P0       | Built-in.                                                                 |
| Four-tab file view (see below)                 | P0       | The main pane when a file is selected from the sidebar tree.              |
| Drag-and-drop to move files                    | P1       | Renames tracked as Git renames.                                           |
| Custom right-click menu                        | P0       | Open in editor, copy path, history, blame, ignore, reveal in finder, etc. |
| Compact / default / relaxed density            | P1       | Pierre supports this; expose as a setting.                                |

**Four-tab file view.** Clicking a file in the sidebar tree opens it in the main pane with four tabs:

- **Content** — file content at the current revision (working tree by default, or at the selected commit). Syntax-highlighted with Shiki, read-only.
- **History** — commits that touched this file, with per-commit diff previews. Click a commit to jump to it in the graph.
- **Compare** — pick any two revisions (commits, branches, tags, or "working tree") and render the diff for this file using `@pierre/diffs`.
- **Blame** — per-line author + commit attribution. Click a line to jump to the commit that introduced it.

Tab state persists per-file across the session so jumping back to a file restores the last-used view.

### 6.6 More features

| Feature                                                 | Priority | Notes                                                                                                                                  |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive rebase                                      | P1       | Full editor: reorder, squash, fixup, edit, drop. Shells out to `git rebase -i` with a custom sequence-editor pointing back at the app. |
| Blame view                                              | P1       | Per-line author + commit; click to jump.                                                                                               |
| Reflog browser ("restore lost commits")                 | P1       |                                                                                                                                        |
| Stashes shown inline in commit graph                    | P1       | Pierre / Tower pattern.                                                                                                                |
| Git-flow                                                | P2       | Start/finish feature/release/hotfix. Shells out to `git-flow`.                                                                         |
| Git LFS                                                 | P2       | Status badges + push/pull progress.                                                                                                    |
| GPG / SSH commit signing                                | P2       | Honor `user.signingkey` and `commit.gpgSign`.                                                                                          |
| File history (log for a path)                           | P1       |                                                                                                                                        |
| Search commits (message, author, hash, content `-G/-S`) | P1       |                                                                                                                                        |
| Hooks editor                                            | P3       |                                                                                                                                        |

### 6.7 Cross-cutting

| Feature                           | Priority | Notes                                        |
| --------------------------------- | -------- | -------------------------------------------- |
| Command palette ⌘K                | P0       |                                              |
| Keyboard shortcuts (customizable) | P0       | Sensible defaults; vim mode P3.              |
| Full keyboard operability         | P0       | Almost every action keyboard-reachable; "keyboard-first, never keyboard-only" (§2). Inherently drag-only affordances are the rare exception. |
| Light / dark / system theme       | P0       | Via Shiki Pierre theme pack.                 |
| Auto-update                       | P0       | Tauri signed updates.                        |
| Crash reporting (opt-in)          | P0       | Sentry or similar, off by default.           |
| Telemetry (opt-in only)           | P0       | Off by default; clearly disclosed.           |
| Localization framework            | P1       | English at launch; structure ready for more. |

---

## 7. Cross-platform requirements

| Concern             | macOS                                              | Windows                                       | Linux                                              |
| ------------------- | -------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Window chrome       | Native traffic lights, hide-on-fullscreen titlebar | Native titlebar, Mica/Acrylic where available | GNOME and KDE conventions; client-side decorations |
| Shortcuts           | ⌘ family                                           | Ctrl family                                   | Ctrl family                                        |
| Menus               | Native menubar                                     | In-window menubar                             | In-window menubar                                  |
| File pickers        | Native                                             | Native                                        | Native via XDG portals                             |
| Notifications       | Native                                             | Native                                        | libnotify                                          |
| Code signing        | Apple Developer ID + notarization                  | EV cert                                       | Optional sigstore for AppImage                     |
| Installer           | `.dmg` (universal: x86_64 + aarch64)               | `.msi` and `.exe` (x86_64; aarch64 P1)        | `.deb`, `.rpm`, `.AppImage` (x86_64; aarch64 P1)   |
| Auto-update channel | Stable + beta                                      | Stable + beta                                 | Stable + beta                                      |
| Credential storage  | Keychain                                           | Windows Credential Manager                    | libsecret / kwallet                                |

All three platforms are first-class. No "Windows port" feel — visual parity, performance parity, feature parity.

---

## 8. Performance targets

| Metric                                      | Target                                                     |
| ------------------------------------------- | ---------------------------------------------------------- |
| Cold start (splash → interactive)           | < 1.0s on M-series Mac, < 1.5s on mid-range Windows laptop |
| Open a 100k-commit repo (log fully visible) | < 2.0s                                                     |
| Working-tree status refresh, 10k files      | < 200ms                                                    |
| Diff render for a 5,000-line file           | < 100ms                                                    |
| Stage/unstage a hunk                        | < 50ms perceived                                           |
| Memory at idle, 1 medium repo open          | < 250MB                                                    |
| Installer size                              | < 25MB per platform                                        |

Achieving these is the entire reason for choosing Rust + `gix` + Tauri over the alternatives. They're not aspirational — they're table stakes.

---

## 9. Visual & interaction design

- Type: matches Pierre's defaults but allows the user to pick any font (`@pierre/diffs` already adapts to any font/size/feature-settings).
- Density: three presets (compact / default / relaxed) leveraging `@pierre/trees`'s density API; matched in the diff view.
- Color: Pierre Light and Pierre Dark by default. The full Shiki theme ecosystem is available — user can install/select any Shiki theme and the diff + tree restyle together.
- Icons: Pierre Icons set (file icons match the Pierre VS Code extension, so users get one consistent visual identity across editor and Git client).
- Motion: subtle. Tab switches, panel slides, and commit-list scrolling are smooth at 60fps; nothing decorative.
- Empty states: every panel has a friendly, instructive empty state. No "no data" labels.

---

## 10. Security, privacy, and trust

- **Local-first.** No data leaves the device by default.
- **Telemetry & crash reports:** opt-in at first launch, clearly explained, fully disabled by default.
- **Credentials:** stored only in the OS keychain. SSH keys are never read into memory longer than needed; passphrase prompts use OS-native dialogs.
- **GPG / signing:** never store passphrases. Delegate to the user's `gpg-agent` / SSH agent.
- **Code execution:** hooks run as `git` always has — Strand doesn't sandbox them but warns clearly when a fresh clone has them.
- **Auto-update:** signed update manifests; refusal to apply unsigned updates.
- **Open source:** plan to open-source the app (license TBD, likely AGPL or source-available like Sublime Merge). Decided before launch.

---

## 11. Release plan

### 0.1 — Internal alpha (≈ 6 weeks from start)

Repo management, basic ops (fetch/pull/push/commit/branch/checkout), diff & stage, commit graph, file tree, one platform (whichever ships fastest — likely macOS).

### 0.5 — Public beta (≈ 12 weeks)

All P0 features. All three platforms. Auto-update. Light & dark themes. Performance targets met for medium repos.

### 1.0 — Stable (≈ 20 weeks)

All P1 features. Performance targets met for 100k-commit repos. Signed installers on all three platforms. Localization framework in place.

### 1.1+

- P2 features (Git-flow, LFS, GPG UI), additional themes, plugin/extension surface.
- **CLI companion binary (`strand`).** Talks to a local daemon. Lets power users script the app: `strand open .`, `strand commit -m "…"`, `strand switch <branch>`, `strand diff <a> <b>`, etc. Same set of actions available in the command palette, scriptable from the shell.

---

## 12. Risks & open questions

| Risk                                                            | Mitigation                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@pierre/trees` is still v1.0.0-beta — API may change           | Pin versions; contribute upstream; budget for one major-version migration before 1.0.                              |
| Pierre libraries' licenses not yet confirmed for commercial use | **Open Q1: verify licenses** before committing. Both are described as "open source" but the exact license matters. |
| `gix` does not yet cover 100% of write operations               | Hybrid with `git2` and shell-out is fine and proven (Sublime Merge does it).                                       |
| Interactive rebase UX is hard                                   | Plan a custom sequence-editor protocol with the shelled-out `git rebase -i`. Tower's implementation is the bar.    |
| Windows code signing requires an EV cert (~$300/yr)             | Budget for it. Required for trusted installs.                                                                      |
| Code-signing review on macOS takes 1–2 weeks first time         | Start notarization process during alpha.                                                                           |
| Tauri 2 native menu API is still maturing on Linux              | Acceptable. Test on GNOME + KDE early.                                                                             |

### Open questions

1. **Pierre library licensing** — confirm both libraries are usable in a commercial desktop app, or arrange a license.
2. **Open source or source-available?** — affects positioning and contribution model. Decide before 0.5.
3. **AI features?** — commit message suggestions, conflict resolution hints, PR description drafts. Not in v1, but worth designing the extension point now.
4. **Built-in code review surface for GitHub/GitLab PRs?** — `@pierre/diffs` literally has comment & annotation primitives for this. Tempting v1.1 feature.
5. **Pricing model?** — Tower-style subscription, Sublime Merge-style one-time, or free / OSS. Affects everything downstream.

---

## 13. Naming & domain

**Strand.** A single thread or fiber — clean, technical, and a natural fit alongside `@pierre/trees`. Suggests something light and fast without being cute about it. The name evokes the visual metaphor of Git itself: branches, threads of history, things woven together.

**Domain:** [`strand.danielss.dev`](https://strand.danielss.dev) — landing page, downloads, docs, and auto-update manifest live here.

Remaining pre-launch checks:

- Trademark search (USPTO, EUIPO, WIPO).
- App store IDs (macOS App Store, Microsoft Store) — reserve early.
- GitHub repo / org.
- Social handles (X, Mastodon).

---

## 14. Out of scope (for clarity)

- Web-hosted version
- Mobile apps
- Built-in code editor
- Built-in chat / collaboration
- Project management features
- Self-hosted Git server features

---

_End of PRD v1._
