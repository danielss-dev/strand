# Roadmap

Milestones map to PRD §11. Status as of 2026-05-25 (after Phase A — diff,
stage, commit, fetch/pull/push, resizable panes, session restore).

Legend: ☐ not started · ◐ in progress · ☑ done

---

## 0.0 — Scaffold ☑

Tauri 2 + Rust + React shell boots on macOS. IPC plumbed end-to-end with
4 read-only git commands (open / meta / status / log). Prototype design
system ported verbatim. No real feature surface yet.

---

## 0.1 — Internal alpha (≈ 6 weeks)

> PRD: "Repo management, basic ops (fetch/pull/push/commit/branch/checkout),
> diff & stage, commit graph, file tree, one platform — likely macOS."

- ◐ **Open / clone / add existing repo**
  - ☑ Dialog flow (native picker via ⌘O + topbar `+` dropdown, drag-and-drop folder onto window)
  - ☑ SQLite-backed recent-repo list with last-opened timestamp
  - ☑ Multi-repo tabs (open, switch, close, **persist across launches**)
  - ☐ Clone (HTTPS / SSH) with streaming progress
- ◐ **Local Changes — real staging UI**
  - ☑ Unstaged + staged file lists (folder tree, status badges, hover Stage/Unstage)
  - ☑ Pierre `<PatchDiff>` integration themed to app tokens
  - ☑ Commit form: subject + body + amend; ⌘↵ shortcut; spinner state
  - ☑ File-level stage / unstage / discard via `git2`
  - ◐ Line / hunk stage + unstage (hunk: unstaged → Stage / Discard;
    staged → Unstage, all backed by `Repo::apply_patch`. Line-level
    still pending.)
  - ☐ Discard with single-undo handle
  - ☐ Recent commit messages dropdown
- ◐ **Commit graph**
  - ☑ Table view from `repo_log`
  - ☑ SVG lane/edge rendering with branch colors
  - ☑ Inline commit detail panel (changed files, message body)
  - ☐ Multi-select + keyboard navigation
- ◐ **Fetch / Pull / Push**
  - ☑ Rust commands (shell-out to user's `git`; credentials + SSH agent + GPG
    inherited from the user's config)
  - ☑ Topbar wired: real ahead/behind, click handlers, directional pulse + shimmer
    animation while in flight, toast on success/failure with git stderr
  - ☐ Streaming progress events (currently blocks until done)
  - ☐ Native credential helper via OS keychain (auth-git2 path; defer until
    we have a reason to leave shell-out)
- ◐ **Branch ops**
  - ☑ List branches, remotes, remote-tracking branches, tags via
    `Repo::refs` (per-branch upstream + ahead/behind)
  - ◐ Checkout, create from HEAD or commit, delete (`Repo::checkout_branch`
    + `Repo::create_branch` + `Repo::delete_branch` shipped; checkout
    from arbitrary commit / detached HEAD still pending)
  - ☑ Sidebar wired to real data — Branches / Remotes / Tags rendered
    as folder trees (`feature/foo` nests under `feature/`; remote names
    are the top folders), click-to-checkout, hover-delete with confirm
  - ☑ Topbar branch dropdown wired end-to-end: checkout a local branch,
    create + track a remote branch, or `Create branch…` via prompt
- ☐ **File tree**
  - Working-tree view, status badges, click to file detail
  - Likely requires `@pierre/trees`
- ☐ **macOS packaging**
  - Real app icon (currently a placeholder "S")
  - Apple Developer ID signing + notarization
  - First DMG ships to a small alpha group

**Blockers cleared (2026-05-25):** PRD Q1 (Pierre libraries approved),
Q2 (license: AGPL-3.0 + dual-license commercial SKU), Q5 (pricing:
free + honor-system paid commercial license). Pierre diff & tree
integration is now unblocked.

**Phase A shipped (2026-05-25):** `@pierre/diffs` integrated; `Repo::diff_*`
producing per-file unified patches; file-level stage / unstage / discard;
amend-aware commits with ⌘↵; real Local Changes UI with folder tree.
Resizable panes everywhere with persisted sizes. Session restore wired
through SQLite. Refresh button + window-focus auto-refresh.

**Phase C kick (2026-05-25):** Real ahead/behind in `Repo::meta`;
`Repo::{fetch, pull, push}` shelling out to the user's `git` so
credentials, SSH agent, and GPG signing all work out of the box;
topbar buttons wired with directional animation feedback. Streaming
progress and clone still pending.

**Refs reads (2026-05-26):** `Repo::refs` returns typed branches
(with upstream + ahead/behind), remotes, remote-tracking branches, and
tags. Exposed via `repo_refs` IPC and refreshed alongside meta. Topbar
branch dropdown renders real data; checkout/create still toast-stubbed
pending the writes batch.

**Branch writes (2026-05-26):** `Repo::{checkout_branch, create_branch,
delete_branch}` via `git2`, exposed as `repo_checkout`,
`repo_branch_create`, `repo_branch_delete` IPC. `create_branch` accepts
any revspec as start point and auto-tracks when it resolves to a
remote-tracking branch. Topbar dropdown now actually switches, creates,
and tracks branches; refs + meta + log refresh after every op.

**Branch UX polish (2026-05-26):** Sidebar Git tab renders real branches
/ remotes (grouped per remote) / tags — click a local branch to check
it out, hover for a × that deletes it (with confirm). Topbar dropdown's
"Create branch…" is now an inline text field with prefix autocomplete:
spaces are sanitized to dashes, Tab extends to the next `/` segment of
matching existing branches. Untracked files now render their content
in the diff pane (`show_untracked_content` on the diff options).

**Hunk-level staging (2026-05-28):** Unstaged diff splits its per-file
patch into one Pierre `<Diff/>` per hunk, with Stage / Discard buttons
above each. Stage forward-applies the hunk to the index (`Repo::apply_patch
(ApplyTarget::Index)`); Discard reverse-applies it to the worktree
(`ApplyTarget::WorkdirReverse`, via a TS-side `splitPatchByHunk` and a
Rust-side patch reversal). Staged diff gets the symmetric treatment via
`StagedHunkDiff` — per-hunk **Unstage** reverse-applies the hunk to the
index (new `ApplyTarget::IndexReverse`), moving it back to unstaged
without touching disk. Line-level selection still pending.

**Commit graph + detail panel (2026-05-28):** All Commits is now an
actual graph: `ui/src/lib/graph.ts` walks `repo_log`'s topologically-
sorted output and assigns lanes by tracking which oid each lane is
"waiting for", emitting per-row segments (`in` / `out` / `pass`).
`CommitGraphCell` renders each row's segments + node as SVG, colored
from `--b-1…--b-7`. Branch / tag / HEAD chips render inline at the
start of the message cell. Clicking a row opens a right-side resizable
detail Panel (`strand:commits-split`) — `CommitDetail.tsx` shows
subject, body, author, full date, hash, parents, the list of changed
files, and the focused file's diff via the existing `<Diff />` wrapper.
Diffs come from a new `Repo::diff_commit` / `repo_diff_commit`
(handles root commits by diffing against the empty tree). The Rust
`Commit` struct gained a `body` field. Keyboard nav, multi-select, and
file-tree re-rooting still pending.

---

## 0.5 — Public beta (≈ 12 weeks)

> PRD: "All P0 features. All three platforms. Auto-update. Light & dark
> themes. Performance targets met for medium repos."

- ☐ Stashes (create, apply, pop, drop)
- ☐ Tags (lightweight + annotated)
- ☐ Cherry-pick, revert, merge (ff / no-ff / squash), rebase
- ☐ Conflict resolution UI (three-way view)
- ☐ Discard changes (line / hunk / file) with single-undo
- ☐ Stacked + split diff layouts (persisted per-repo)
- ☐ **Theme management**
  - Light + dark themes with system-preference follow
  - Persisted per-user via settings store
  - Theme switcher in settings UI + command palette action
  - Live swap without reload (CSS variables already token-driven)
- ☐ Command palette: real action set (branches, files, commits, recents)
- ☐ Windows 11 build (chrome variant exists but is untested)
- ☐ Linux build (deb / rpm / AppImage)
- ☐ Tauri auto-update: real pubkey, real endpoint, signed manifests
- ☐ Performance pass to hit PRD §8 targets on medium repos
  (open <2s for 100k commits, status refresh <200ms on 10k files)

---

## 1.0 — Stable (≈ 20 weeks)

- ☐ Submodules (clone, update, status, recursive)
- ☐ Interactive rebase (custom sequence-editor protocol)
- ☐ Blame view (per-line author + commit jump)
- ☐ Reflog browser
- ☐ File history (log for a path)
- ☐ Commit search (`-G` / `-S`)
- ☐ Stashes shown inline on the graph
- ☐ Drag-and-drop renames in file tree
- ☐ Compact / default / relaxed density (settings UI; CSS already supports it)
- ☐ Crash reporting (opt-in, off by default)
- ☐ Telemetry (opt-in, clearly disclosed)
- ☐ Localization framework + English baseline
- ☐ Performance pass on 100k-commit repos
- ☐ Signed installers on all three platforms

---

## 1.1+ — Post-1.0

- Git-flow (start/finish feature/release/hotfix; shells out to `git-flow`)
- Git LFS (status badges + progress)
- GPG / SSH commit signing UI
- CLI companion binary (`strand`) over a local daemon
- Plugin / extension surface
- AI features (commit message suggestions, conflict hints) — PRD Q3
- Built-in PR review surface for GitHub / GitLab — PRD Q4

---

## Cross-cutting tracks (run in parallel with all milestones)

- **Security & signing.** EV cert for Windows. macOS notarization pipeline
  must be live by 0.1 alpha.
- **Open questions.** PRD §12 lists 5 open Qs.
  1. ☑ Pierre licensing — approved 2026-05-25.
  2. ☑ OSS vs source-available — AGPL-3.0 + dual-license commercial.
  3. ☐ AI features extension point — design before 1.0.
  4. ☐ PR review surface — 1.1 candidate.
  5. ☑ Pricing — free for all, honor-system paid commercial license.
- **Naming & trademark.** USPTO/EUIPO/WIPO search before 0.5 public launch.
