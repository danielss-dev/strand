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
  - ☑ Clone (HTTPS / SSH) with streaming progress (shell-out `git clone
    --progress`; `CloneDialog` with URL + destination picker + live progress
    bar; opens the cloned repo on success)
- ◐ **Local Changes — real staging UI**
  - ☑ Unstaged + staged file lists (folder tree, status badges, hover Stage/Unstage)
  - ☑ Pierre `<PatchDiff>` integration themed to app tokens
  - ☑ Commit form: subject + body + amend; ⌘↵ shortcut; spinner state
  - ☑ File-level stage / unstage / discard via `git2`
  - ☑ Hunk + sub-hunk change-block stage / unstage (Pierre
    `<FileDiff/>` with `lineAnnotations` driving inline Stage / Discard
    / Unstage on each `ChangeContent`; `sliceChangeBlock` carves the
    synthetic per-block patch fed to `Repo::apply_patch`.) Line-level
    still pending.
  - ☑ Discard with single-undo handle (per-change-block; undo toast
    forward-applies the discarded slice back)
  - ☑ Recent commit messages dropdown (SQLite `commit_messages` history per
    repo; dropdown on the subject field, keyboard-navigable)
- ◐ **Commit graph**
  - ☑ Table view from `repo_log`
  - ☑ SVG lane/edge rendering with branch colors
  - ☑ Inline commit detail panel (changed files, message body)
  - ☑ Keyboard navigation (focuses current commit on open; ↑/↓ moves row
    focus; Enter opens details; Esc closes details)
  - ☑ Multi-select (⌘/Ctrl-click toggles, Shift-click ranges, Shift+↑/↓
    extends, ⌘/Ctrl+A selects all; selection-count pill + Clear; distinct
    from the single-select detail panel)
- ◐ **Fetch / Pull / Push**
  - ☑ Rust commands (shell-out to user's `git`; credentials + SSH agent + GPG
    inherited from the user's config)
  - ☑ Topbar wired: real ahead/behind, click handlers, directional pulse + shimmer
    animation while in flight, toast on success/failure with git stderr
  - ☑ Streaming progress events (git `--progress` stderr parsed into
    `Progress { phase, percent, raw }`, streamed over a Tauri `Channel`;
    live progress toast in the topbar — no longer blocks blind)
  - ☐ Native credential helper via OS keychain (auth-git2 path; defer until
    we have a reason to leave shell-out)
- ◐ **Branch ops**
  - ☑ List branches, remotes, remote-tracking branches, tags via
    `Repo::refs` (per-branch upstream + ahead/behind)
  - ☑ Checkout, create from HEAD or commit, delete (`Repo::checkout_branch`
    + `Repo::create_branch` + `Repo::delete_branch`; `Repo::checkout_commit`
    detaches HEAD onto any commit — `RepoMeta.detached` drives a topbar chip,
    and the commit-detail panel has a "Checkout" action)
  - ☑ Sidebar wired to real data — Branches / Remotes / Tags rendered
    as folder trees (`feature/foo` nests under `feature/`; remote names
    are the top folders), click-to-checkout, hover-delete with confirm
  - ☑ Topbar branch dropdown wired end-to-end: checkout a local branch,
    create + track a remote branch, or `Create branch…` via prompt
- ☑ **File tree**
  - ☑ Working-tree view, status badges, click to file detail (`Repo::work_tree`
    lists index entries overlaid with status; Sidebar Files tab renders a
    folder tree with per-file status badges; click opens the file in FileView)
  - Built as a custom tree reusing the existing `buildTree`/`sortTree`
    primitives rather than pulling in `@pierre/trees` — no new dependency,
    matches the Branches/Local-Changes trees. (FileView's Content/History/
    Compare/Blame tabs are still placeholders — that's 0.5 work.)
- ◐ **macOS packaging** — *signed DMG now builds on a Mac with the
  Developer-ID cert in the Keychain; notarization + alpha distribution still
  pending. See `docs/packaging.md` for the exact runbook.*
  - ☑ Real app icon (squircle on the Apple grid — commit `aefc189`)
  - ◐ Apple Developer ID signing + notarization (signing done; notarization
    pending Apple credentials)
  - ☐ First DMG ships to a small alpha group

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

**Hunk-level staging (2026-05-28, superseded same day by sub-hunk):**
Initial pass split the per-file patch into one Pierre `<Diff/>` per hunk
with hover-overlay Stage / Discard / Unstage buttons above each.
`Repo::apply_patch` gained three targets (`Index`, `IndexReverse`,
`WorkdirReverse`) backed by a Rust-side `reverse_patch` helper, which
all survived into the sub-hunk pipeline; the TS-side per-hunk
`splitPatchByHunk` helper was replaced by `sliceChangeBlock` later the
same day (see next paragraph).

**Sub-hunk staging (2026-05-28):** Per-change-block actions land on top
of the per-hunk pipeline. `LocalChanges.tsx` swaps `<PatchDiff>`-per-hunk
for a single `<PierreFileDiff/>` per file, parsed via `getSingularPatch`
and decorated with one annotation per `ChangeContent` group. Clicking
Stage / Discard (unstaged) or Unstage (staged) on a block calls a new
`sliceChangeBlock` helper that builds a synthetic single-hunk patch
isolating that block — rewriting other blocks in the same hunk to
context (forward) or omitting them (reverse) — and routes it through
`Repo::apply_patch` (`Index` / `WorkdirReverse` / `IndexReverse`). The
old hover-overlay hunk action UI and `splitPatchByHunk` render path are
gone; the old `splitPatchByHunk` helper, no longer used, was removed
along with them.

**Discard single-undo (2026-05-28):** Discarding a change block now records
a single-undo handle. The key symmetry: discard reverse-applies a sliced
patch to the working tree (`ApplyTarget::WorkdirReverse`), so undo is just
the same slice forward-applied to the working tree. A new
`ApplyTarget::Workdir` (forward apply to `WorkDir`) is the exact inverse;
`repo_apply_patch` accepts the `"workdir"` target string. The store's
`discardPatch` performs the discard and stashes the slice in `lastDiscard`
(path-pinned so it can't be replayed into another tab); `undoDiscard`
forward-applies it. `LocalChanges.tsx` routes only the Discard button
through `discardPatch` (stage/unstage are non-destructive). A self-contained
`UndoToast` in `App.tsx` surfaces an Undo button for 6s per discard
("Undo send" model) — single-undo only ever recovers the most recent
discard. Line-level discard + a persistent undo stack are still future work.

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
`Commit` struct gained a `body` field. Multi-select and file-tree
re-rooting still pending.

**Commit graph keyboard nav (2026-05-28):** The graph pane is now
keyboard-focusable and ArrowUp / ArrowDown move row focus through the
visible log. Opening the graph focuses the current branch tip; Enter opens
the detail panel for the focused commit; Esc closes it; focused rows scroll
into view. Multi-select remains pending.

**0.1 feature close-out (2026-05-29):** Cleared the remaining code items for
the internal alpha in one batch.
- **Streaming network progress.** `network.rs` now spawns `git` with piped
  stdout/stderr (stdout drained on a side thread to avoid pipe deadlock),
  splits stderr on `\r`/`\n`, and parses each fragment into
  `Progress { phase, percent, raw }`. `fetch`/`pull`/`push` take an
  `on_progress` callback; `repo_fetch`/`_pull`/`_push` became `async` +
  `tokio::spawn_blocking` and stream over a `tauri::ipc::Channel<Progress>`.
  A live progress toast surfaces phase + percent in the topbar.
- **Clone.** New `network::clone` free fn (`git clone --progress`) +
  `repo_clone`; `CloneDialog.tsx` (URL, native destination picker, derived
  folder name, progress bar) reachable from the topbar `+` menu and the
  command palette; opens the clone on success.
- **Detached checkout.** `Repo::checkout_commit` (safe `set_head_detached`);
  `RepoMeta.detached` (detected via `git2::head_detached`); `repo_checkout_commit`;
  a "Checkout" action in `CommitDetail`; a "detached" chip on the topbar
  branch button.
- **Working-tree file tree.** `tree.rs::work_tree` (index entries overlaid
  with status, ignored excluded); `repo_tree`; the Sidebar Files tab renders
  a folder tree with status badges, lazily fetched and refreshed on status
  change.
- **Recent commit messages.** SQLite migration v2 (`commit_messages`); a
  `commitMessages` db module (dedupe-to-top); the store records on commit;
  a keyboard-navigable dropdown on the commit subject field.
- **Commit graph multi-select.** Local `Set` selection in `Commits.tsx`
  (⌘/Ctrl-click toggle, Shift-click range, Shift+↑/↓ extend, ⌘/Ctrl+A all),
  a selection-count pill with Clear, and selected-row styling — kept distinct
  from the single-select detail panel.

Verified with `cargo check`/`test` (+ 4 new `network` unit tests), `clippy`,
`tsc`, and `vite build`, then an adversarial multi-agent review pass.

**macOS artifact (2026-06-01):** First signed bundle off a real Mac.
`pnpm tauri build --target aarch64-apple-darwin` with
`APPLE_SIGNING_IDENTITY` set produces `Strand_0.0.1_aarch64.dmg` (~10 MB),
signed with the Developer-ID Application cert (chain to Apple Root CA;
embedded `Strand.app` is valid + satisfies its Designated Requirement).
Gatekeeper still reports "Unnotarized Developer ID" — notarization needs
`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` (or an API key), which aren't in
the environment yet. **Still open for 0.1:** notarization + stapling, then
shipping the first DMG to the alpha group. Universal (arm64 + x86_64) build
also pending (only `aarch64-apple-darwin` is installed).

---

## 0.5 — Public beta (≈ 12 weeks)

> PRD: "All P0 features. All three platforms. Auto-update. Light & dark
> themes. Performance targets met for medium repos."

- ☑ Stashes (create, apply, pop, drop)
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
- ◐ Tauri auto-update: real pubkey + signed manifests done (minisign keypair
  wired, `createUpdaterArtifacts` on); real endpoint still pending
- ☐ Performance pass to hit PRD §8 targets on medium repos
  (open <2s for 100k commits, status refresh <200ms on 10k files)

**Stashes shipped (2026-05-30):** First 0.5 vertical. `strand-core::stash`
(`stash_list` via `stash_foreach`; `stash_save` via `stash_save2` with
`INCLUDE_UNTRACKED` / `KEEP_INDEX` flags; `stash_apply` / `stash_pop` /
`stash_drop` by index) — a clean working tree maps git2's `NotFound` to a
no-op `StashOutcome { oid: None }` so "nothing to stash" isn't an error.
Five `repo_stash_*` IPC commands; store gained a `stashes` slice eager-
refreshed alongside refs (reset per tab). Sidebar **Stashes** section is a
flat list — click a row to apply, hover for Pop / Drop (Drop behind an inline
confirm), reusing the branch-row/`armed` styling. Topbar **Stash split button**
(reuses `.sync-group`): primary stashes all; chevron menu offers
±untracked / keep-index variants + "Pop latest" with a live count badge.
Verified with `cargo check`/`test` (+4 `stash` unit tests), `clippy`, `tsc`,
`vite build`, and a 3-dimension adversarial review pass. **Still open:**
`branch-from` (no direct git2 API — needs base-commit + checkout + apply/drop).

**Save snapshot + stash apply/pop fix (2026-06-01):** `stash_snapshot` (core)
records a stash but keeps the changes in the working tree — `git stash create`
+ `store` (no working-tree round-trip, staging preserved), or `push
--include-untracked` + `apply --index` when untracked files are included. At
the same time, `stash_apply` / `stash_pop` were moved off git2 onto a `git`
subprocess (`run_git` helper): git2 refused to apply/pop whenever the index
held *unrelated* staged changes ("uncommitted changes exist in the index",
code Uncommitted -22), where real `git stash pop` merges — that was the
reported "Pop failed" bug. New `repo_stash_snapshot` IPC command +
`stashSnapshot` store action. `views/StashDialog.tsx` (reusing the
`.clone-dialog` shell) gives both flavours a message field + "Include
untracked" / "Keep changes in working directory" checkboxes; the CTA flips
Stash / Save Snapshot. Reachable from a hover-`+` on the sidebar **Stashes**
header (`SideSection` grew an optional `action` prop), the Topbar stash menu's
"Save snapshot…" item, and ⌘K. Verified with `cargo check`/`test` and the git
command sequences exercised against a scratch repo (snapshot keeps the tree
unchanged; pop merges past a dirty index).

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
- **Keyboard accessibility.** Almost every action must be keyboard-operable,
  not just the command palette (PRD §2, §6.7). New surfaces in each
  milestone ship with a focus model + shortcuts; audit before each release
  that nothing meaningful is mouse-only without a reason.
- **Open questions.** PRD §12 lists 5 open Qs.
  1. ☑ Pierre licensing — approved 2026-05-25.
  2. ☑ OSS vs source-available — AGPL-3.0 + dual-license commercial.
  3. ☐ AI features extension point — design before 1.0.
  4. ☐ PR review surface — 1.1 candidate.
  5. ☑ Pricing — free for all, honor-system paid commercial license.
- **Naming & trademark.** USPTO/EUIPO/WIPO search before 0.5 public launch.
