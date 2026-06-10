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
- ☑ Tags (lightweight + annotated) — create / delete / checkout, plus push /
  delete on a remote
- ☑ Cherry-pick, revert, merge (ff / no-ff / squash), rebase + **interactive
  rebase** (reorder / pick / reword / squash / fixup / drop)
- ☑ Conflict resolution UI (three-way view) — Pierre `<UnresolvedFile>` resolver
  with accept current/incoming/both; in-progress banner + Abort + Continue.
  (External mergetool fallback still ☐ in TASKS.)
- ☑ Discard changes (hunk / file) with single-undo — file-level + per-change-block
  Discard, both with the 6s Undo toast; per-row Discard in the file-tree right-click
  menu. (Line-level sub-block discard needs a line-selection UI — deferred, tracked
  ◐ in TASKS.)
- ☑ Stacked + split diff layouts (persisted per-repo)
- ☑ **Theme management**
  - Light + dark themes with system-preference follow
  - Persisted per-user via settings store
  - Theme switcher in settings UI + command palette action
  - Live swap without reload (CSS variables already token-driven)
- ☑ Command palette: real action set (branches, files, commits, recents) — grouped,
  scoped, fuzzy-scored with match highlighting
- ☑ Windows 11 build — MSI builds on a Windows 11 box (`Strand_0.0.1_x64_en-US.msi`,
  10.5 MB) and the installed app's runtime chrome (titlebar, theme, window controls)
  validated on Windows 11 (see 2026-06-07 below)
- ☐ Linux build (deb / rpm / AppImage)
- ◐ Tauri auto-update: real pubkey + signed manifests done (minisign keypair
  wired, `createUpdaterArtifacts` on); real endpoint still pending
- ◐ Performance pass to hit PRD §8 targets on medium repos
  (open <2s for 100k commits ☑, status refresh <200ms on 10k files ☑; webview-side
  targets — cold start, diff render, memory — still need a running-app pass)

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

**Tags create/delete/checkout (2026-06-01):** Second 0.5 vertical.
`strand-core::tag` adds `create_tag` (lightweight when the message is empty,
annotated via `git2`'s `tag` + a config-derived signature otherwise; `force`
overwrites) and `delete_tag` (`tag_delete`); tag *reads* already lived in
`refs.rs`. Two new IPC commands (`repo_tag_create` / `repo_tag_delete`) +
store actions (`createTag` / `deleteTag`, refreshing refs + log so sidebar
rows and graph chips update). Sidebar Tags rows are now interactive: click
checks out the tagged commit (detached HEAD), hover-× deletes with an inline
confirm (the branch-row affordance, generalized — `BranchLeaf` gained `icon`
+ `deleteLabel`), and the section header `+` opens a new `views/TagDialog.tsx`
(name + optional annotation message, lightweight/annotated chosen by message
presence). The dialog is reachable from the sidebar `+`, ⌘K ("Create tag…"),
and a "Tag…" action in the commit-detail panel (targets that commit). Verified
with `cargo check`/`clippy`, a new std-only `tag` integration test (both
flavours + force + delete + readback), `tsc`, and `vite build`.

**Tag remote push/delete (2026-06-01):** Closed the "still open" item from the
same day. `network.rs` gains `Repo::push_tag` (`git push <remote> [--delete]
refs/tags/<tag>`) and `push_all_tags` (`git push <remote> --tags`), shelled out
+ streamed through the existing `run_git_streaming` so credentials and progress
come for free; `repo_tag_push` / `repo_tag_push_all` async IPC + `pushTag` /
`deleteRemoteTag` / `pushAllTags` store actions. The default remote resolves to
HEAD's upstream remote → `origin` → the first configured remote (exported as
`defaultRemote(refs)`, shared by the store and sidebar). The flat `BranchLeaf`
reuse for tags was replaced by a dedicated `TagLeaf` (push / delete-on-remote /
delete-local hover tools, single inline confirm; remote tools hidden when no
remote exists); tag network ops toast success/failure, and ⌘K has "Push all
tags". Verified with `cargo check`/`clippy`/`test`, `tsc`, and `vite build`.
A follow-up added `Repo::remote_tags` (`git ls-remote --tags`, loaded lazily
when the Tags section opens) so "delete on remote" grays out for tags the
remote doesn't have — fetched tags share `refs/tags/`, so ls-remote is the
only way to tell. The `remoteTags` set is optimistically updated on push/delete
to avoid re-fetching. Made it **stale-while-revalidate**: a persisted
`remoteTagsCache` (SQLite `settings`, per repo path) paints the gray-out state
instantly on open, then `ls-remote` revalidates in the background at most once
per repo per session — so it feels instant and doesn't re-hit the network on
every tab switch.

**3-pane merge resolver (2026-06-03):** Reworked the conflict UI from the inline
unified `<UnresolvedFile>` into a full-screen **three-way** resolver
(`views/MergeResolver.tsx`): incoming (theirs) + current (ours) side-by-side on
top, the assembled result below, an N/M counter with ‹ › conflict nav, and
Cancel/Resolve. Markers are parsed in `lib/conflictParse.ts` (pure: segments +
per-conflict line spans in each view) and each pane renders with Pierre's
read-only `<File>`, highlighting the focused conflict via `selectedLines`;
pick theirs/ours/both per conflict (or click a side's block) and Resolve writes
the merged file + stages it. The earlier inline `ConflictResolver.tsx` was
removed. Verified: tsc + vite build (Rust unchanged).

**Theme management (2026-06-04):** Light / dark / **system** as a first-class
preference, applied live with no reload and no flash. `lib/theme.ts` is the new
home: a `useTheme` hook (called once at the app root) subscribes to the OS
`prefers-color-scheme`, resolves the stored preference to a concrete theme,
writes `data-theme` on `<html>`, and publishes the resolved theme into the
settings store so Pierre diffs (`Diff`, `HunkAnnotatedDiff`, `MergeResolver`)
and the settings hint read it reactively without each running their own OS
subscription. The preference persists through the existing zustand-`persist`
localStorage store (consistent with every other setting — *not* the SQLite
`settings` table the task sketched; localStorage rehydrates synchronously, which
the SQLite path can't, and that's what makes the no-flash guarantee cheap). A
tiny inline script in `index.html` paints the correct `data-theme` before first
paint by reading the same persisted key (so `--bg-os` resolves on the very first
frame); the store seeds `resolvedTheme` from that attribute, so there's no
second resolution and no flicker on React's first commit. A new
`views/SettingsDialog.tsx` (status-bar gear, ⌘,, or ⌘K) hosts an Appearance →
Theme picker: a `role="radiogroup"` of three cards with live mini-UI swatches
(each swatch carries its own `data-theme` so it previews that theme's tokens
regardless of the app theme), roving-tabindex arrow nav, focus trap. The command
palette gained **Settings…** + **Theme: Light/Dark/System**; ⌘⇧T is now a real
global handler that toggles light ↔ dark (skipping system — from system it flips
away from the current appearance), with a confirming toast. The
theme set is a registry (`THEME_OPTIONS` + per-`[data-theme]` token blocks), so a
future custom theme (high-contrast, solarized) is add-a-block + add-an-entry.
**Accent color** is the same idea one axis over: a `data-accent` attribute
rotates a single `--accent-h` hue, and every accent token (`--accent`,
`--accent-2`, `--accent-fg`, `--accent-glow`, `--selection`, the selected-row
tint, and the window's ambient glow) is now `oklch(L C var(--accent-h))` — so the
8 presets (amber / rose / magenta / violet / blue / cyan / teal / green) recolor
the whole app live in both themes from one hue, with each theme's lightness/chroma
preserved. It's a second radiogroup of hue dots in the same Settings dialog,
persisted + restored pre-paint alongside the theme (`ACCENT_OPTIONS` registry).
Token audit: hardcoded popover/menu/modal `rgba(0,0,0,…)` shadows replaced with
new per-theme `--shadow-1…4` elevation tokens (dark values byte-identical, light
softened/warmed); context-menu danger color/bg and the merge/conflict accept
checks routed onto `--del`/`--del-bg`/`--accent-fg`; two dead `box-shadow`
duplicates removed. Verified: tsc + vite build, an adversarial 5-dimension review
(4 confirmed findings fixed, 1 rejected as dead CSS), and a live Playwright pass
(no-flash theme + accent attributes, dialog open, light↔dark live swap, ⌘⇧T
cycle + toast, accent hue rotation propagating app-wide, both radiogroups'
roving arrow-key nav, persistence round-trips).

**Per-repo diff layout + discard close-out (2026-06-04):** Closed the two
remaining alpha-era diff items. The stacked/split toggle already existed
(MainHeader buttons → `useSettings.diffMode` → Pierre `unified`/`split` for
Local Changes + commit detail); the missing half was **per-repo persistence**.
`useRepo.setDiffMode` now writes the choice to the SQLite `settings` table
(keyed `diff-mode:<repoPath>` via a new `repoDiffMode` db helper), and
`loadRepoDiffMode` restores it whenever a repo becomes the active tab (wired into
`setActiveTab` + `openRepo`). The persisted localStorage `diffMode` stays the
last-used default for repos that haven't picked one, so an unseen repo opens in a
familiar layout and an explicit choice always wins on return. Discard is
otherwise complete: file-level + per-change-block Discard with the 6s Undo toast,
plus a per-row Discard in the file-tree right-click menu (`FileSection.menuItems`
→ `discardMany`, confirm-gated) — the only gap left is line-level sub-block
discard, which needs a line-selection UI and is deferred. Verified with `tsc` +
`vite build` (Rust unchanged).

**Conflict resolution UI (2026-06-03, superseded same day by the 3-pane modal):**
Finishes the history-ops vertical with a three-way resolver built on
`@pierre/diffs`' `<UnresolvedFile>`. `status.rs`
now surfaces every unmerged entry as a `CONFLICTED` row (a pure conflict carries
no wt/index bit and was being dropped). `strand-core::conflict` adds
`read_conflict_file` (raw text + markers) and `resolve_conflict` (write back +
stage = `git add`, marking it resolved); both guard against path traversal. IPC
`repo_read_conflict_file` / `repo_resolve_conflict` + a `resolveConflict` store
action. UI: a **conflict bar** above the Local Changes workspace lists unmerged
files (auto-opens the first during a merge); selecting one renders
`views/ConflictResolver.tsx`, which shows Pierre's structured conflict regions
and anchors **Accept current / incoming / both** on each via
`renderMergeConflictUtility`. Because the React `<UnresolvedFile>` keeps the
resolved file in internal controlled state (its `onMergeConflictAction` is
mutually exclusive with `onMergeConflictResolve`), we drive resolution
ourselves: each pick re-slices the contents exactly like Pierre's
`getResolvedConflictReplacementLines` and remounts (`key`) to re-parse, so we
always hold the resolved text — "Mark resolved" writes + stages it, the bar
shrinks, and committing finishes the merge. Verified: cargo test (+2 `conflict`),
clippy, tsc, vite build.

**History ops — cherry-pick / revert / merge / rebase (2026-06-03):** Third 0.5
vertical. New `strand-core::history` shells out to `git` for all four (the stash
apply/pop precedent — real git resolves conflicts with on-disk markers, signs the
resulting commits, and runs hooks; git2's merge/cherrypick/revert primitives do
none of that and have no rebase driver). `cherry_pick(&[oid])` / `revert(&[oid])`
(`--no-edit`) / `merge(refname, MergeMode {Auto|NoFastForward|Squash})` / `rebase(onto)`,
plus `abort_operation` which detects the live op from `.git/` markers
(`rebase-merge`/`rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD`) and
runs the matching `--abort`. `RepoMeta` gained `operation: Option<String>` so the UI
can show an in-progress banner. Five new `repo_*` IPC commands + `tauri.ts` wrappers
+ store actions (each refreshes meta + local changes + log + refs). UI: commit-detail
**Cherry-pick** / **Revert** buttons (single commit onto HEAD); sidebar branch menu
**Merge into <current>** (opens a new `MergeDialog` with FF-when-possible / No-FF /
Squash) and **Rebase <current> onto this** (confirm); an `OpBanner` above the main view
with **Abort** whenever an op is paused, plus a ⌘K "Abort <op>" action. Conflicts
aren't hidden — git's message toasts, the repo stays mid-op, and Abort/resolve-in-
Local-Changes are the two exits (the three-way resolution UI is still its own line).
Verified with `cargo test` (+3 `history` tests: no-ff merge + revert, cross-branch
cherry-pick, conflict→abort round-trip), `clippy`, `tsc`, and `vite build`.

**Sidebar row actions → right-click menu (2026-06-01):** Per-row actions moved
off inline hover tools into a reusable right-click `ContextMenu`
(`components/ContextMenu.tsx`) — portal-rendered at the cursor, keyboard-
operable (Menu key / Shift+F10 to open, ↑/↓/Enter/Esc to drive), viewport-
clamped, with a "Confirm: …" step for destructive items. Branches, remotes,
tags, and stashes now share one `SideLeaf` (primary action stays on click; the
menu lists every action including the primary); the per-type `*Leaf` components
and the `.row-tools`/`.armed` CSS were deleted. Keeps with the keyboard-first
track — actions are reachable without the mouse. Verified with `tsc` +
`vite build`.

**Perf/UX/security audit — safe quick-wins (2026-06-04):** A 7-dimension
multi-agent audit (each finding adversarially verified against the code) drove
a batch of low-risk fixes that don't touch a hot-path contract. **Correctness:**
the store's `refreshStatus/Log/Diffs/Refs` now re-check `activePath` after their
await, so a tab switch mid-flight can't paint another repo's data into the
active tab. **Perf:** `meta()` reuses one git2 handle instead of re-opening;
`App.tsx` subscribes to settings with per-field selectors (no whole-tree
re-render on a `diffMode`/`theme` write). **a11y:** the five modal dialogs
restore focus to their opener on close, and a persistent visually-hidden
`aria-live` region announces toasts/network progress. **Security:** every
`git` shell-out prepends `GIT_SAFE_CONFIG` (`-c core.fsmonitor=` closes a
reproduced repo-config RCE), conflict file I/O canonicalizes to block symlink
escape, the unused `shell:allow-open` capability was dropped. **Stability:** UI
fonts are self-hosted (latin/latin-ext woff2 under `ui/public/fonts`) — no
Google CDN on the cold-start path. **Honesty:** the command palette only
surfaces repo-scoped actions when a repo is open; dead/stub controls (commit
search, Terminal, Open-externally) are disabled rather than presenting a
no-op affordance. **Visual:** light-theme override for the branch palette
(`--b-1..--b-7`, AA contrast as text), a real `--warn` token (warnings were
tinted with the user's accent), accent-following OS glow. The bigger unlocks
(repo handle cache, `spawn_blocking` read commands, `repo_snapshot` batch,
commit-graph virtualization, CSP) are tracked under TASKS.md → Performance /
Security "Audit follow-ups." Verified with `cargo test -p strand-core`, `tsc`,
`vite build`.

**Command palette — real action set (2026-06-05):** The palette went from a
substring filter over static commands to a grouped, scoped, fuzzy-scored command
surface. `PaletteAction` gained `group` / `keywords` / `meta` / `metaLabel` /
`icon`; `App.tsx` builds the candidate set from the store — **Actions** (open /
clone / show / snapshot / stash / tag / push-tags / sync / settings / theme /
abort), **Branches** (checkout a local branch, current reveals in the graph,
remote branches checkout-and-track), **Tags** (reveal the tagged commit),
**Files** (open in the file view, from a lazily-loaded `workTree`), **Commits**
(reveal + open detail), and **Recent** (open repo). Repo-data groups are built
only while the palette is open, so a 100k-commit / 10k-file repo costs nothing
when it's closed. `Palette.tsx` scores matches (contiguous-substring >
subsequence > keyword, word-boundary bonus) with inline `.hl` highlighting,
groups results under section headers, and caps per group (`CAP_PER_GROUP` /
`CAP_SCOPED`) so the list never renders thousands of rows. Adaptive **scope
pills** (All + every present group) filter by category — `role=group` toggle
buttons with `aria-pressed`, cycled with Tab / Shift+Tab. Accessibility was a
first-class part of the build: the input is a `role=combobox` driving a
`role=listbox` of `role=option` rows via `aria-activedescendant` (no focus leaves
the input), an `aria-live` region announces the result count, each section is a
labelled `role=group`, opaque metas get a spoken `metaLabel` ("M" → "modified",
"↑2 ↓1" → "2 ahead, 1 behind"), and focus is restored to the opener on close
(captured before `autoFocus`). Verified with `tsc`, `vite build`, an adversarial
4-dimension review (correctness / perf / conventions / a11y — 14 findings
confirmed and fixed, incl. a remote-branch start-point bug that broke upstream
auto-tracking), and a live Playwright pass (combobox/listbox semantics,
filtering + highlight, ↑↓ nav, Tab scope cycle, focus-restore round-trip).

**Clone/open progress popup (2026-06-05):** Long operations now show a persistent
bottom-center progress popup (`components/ProgressPopup.tsx`) instead of leaving
the user staring at a frozen-looking UI. **Clone**: the dialog collects URL +
destination, then closes and hands off to `App.runClone`, which shows a
determinate bar with a per-phase ETA derived from git's streamed `--progress`
output (the estimate tracks the dominant "Receiving objects" phase, since git's
percent resets each phase), then switches the same popup in place to "Opening"
and opens the clone. **Open**: opening any repo (`openByPath`) shows an
indeterminate sweep + elapsed time, after a 200ms delay so a small repo doesn't
flash a bar — so opening a huge repo no longer looks hung. A **failed clone/open
switches the popup to a persistent, dismissible error state** (reason + Dismiss,
`role="alert"`, Escape to close) rather than vanishing, so a clone that dies
(network drop, out of disk space) shows *why* instead of leaving the user
guessing. Each operation carries a monotonic id so overlapping opens/clones only
ever clear their own popup, and a single coarse `sr-only` live region announces
the op without flooding screen readers with per-tick percentages. Verified with `tsc`, `vite build`, an
adversarial 3-dimension review (correctness / UX-perf / a11y — 11 findings, all
actionable ones fixed: the concurrent-op popup stomp, a toast-overlap collision,
the clone→open hand-off, SR spam, and orphaned CSS), and a live Playwright pass
of both popup variants + the stacking fix.

**0.5 remaining (as of 2026-06-05):** the public-beta milestone's open items are
now all platform/infra rather than features: Windows 11 + Linux builds (need the
target OSes to build/validate — can't be done from the macOS dev box), the
auto-update *endpoint* (`strand.danielss.dev` must be live; pubkey + signed
manifests already done), and the **performance pass** to hit PRD §8 targets —
the concrete code items live in TASKS.md → Performance → "Audit follow-ups" and
want benchmarking against large repos before merge (the prime directive forbids
regressing a hot path blind).

**Windows 11 build (2026-06-07):** First Windows artifact — and the first proof
the "untested" Windows variant actually compiles. The dev box is now Windows 11
(not the macOS box the note above assumed), which unblocks the Windows half of
the platform work. `cargo check --workspace` is clean on `x86_64-pc-windows-msvc`
(no platform-specific code beyond the one `windows_subsystem` attr in `main.rs`),
and `pnpm tauri build --bundles msi` produces a WiX MSI at
`target/release/bundle/msi/Strand_0.0.1_x64_en-US.msi` (10.5 MB — under the PRD §8
<25 MB installer target); the raw `strand.exe` is 17.3 MB. WebView2 runtime 148 is
present, so the app renders. **Caveat:** the updater `.sig` is signed with the
`TAURI_SIGNING_PRIVATE_KEY` in this box's env, which does **not** match the
configured `plugins.updater.pubkey` (key `84FCBFD2A981CE5D`) — Tauri warns the
signature won't be accepted at runtime. The MSI installs fine; only auto-update
verification is affected, and it's the same key/endpoint reconciliation already
tracked open under TASKS → strand-tauri.

**Windows runtime platform pass (2026-06-07):** Launched the bundled release
`strand.exe` on Windows 11 and observed the live window. The WebView2 frontend
loads and renders the full UI (sidebar with Git/Files tabs, "No repository open"
empty state, Local Changes with the UNSTAGED/STAGED panes + diff pane, the commit
form), the dark theme + amber accent apply cleanly with no flash-of-white (the
pre-paint theme bootstrap + self-hosted fonts hold up off the macOS box), and the
native Windows window frame is intact — titlebar, min/max/close, and
maximize/restore all behave. Chrome looks correct on Windows. **Still pending:**
EV signing and the universal/Linux builds.

**Perf pass — `log` first-page latency (2026-06-08):** First optimization off the
2026-06-08 baseline, targeting the highest-leverage finding. `Repo::log` moved off
git2's whole-DAG revwalk (whose `Sort::TOPOLOGICAL` buffers the entire reachable set
before yielding the first row — a ~0.48s floor on 100k commits, independent of
`limit`, and the thing that breaks the <2s open target at ~1M commits) onto a
shell-out: `git log -z --date-order -n <limit> HEAD --branches --remotes --tags`,
which does an incremental, commit-graph-backed walk that stops at `limit`. Re-measured
on the 100k-commit fixture (M1 Pro): **`log(1000)` 480→22ms (~22×), `log(10000)`
484→73ms, and `discover+log(5000)` — the real per-IPC cost the app pays per
refresh — 478→47ms (~10×)**. `--date-order` (not the lead's suggested `--topo-order`)
reproduces git2's `Sort::TIME | Sort::TOPOLOGICAL` ordering *exactly* — the topo
invariant `lib/graph.ts` lanes depend on, broken ties by commit time — so the graph
layout is unchanged; this is a pure perf change with no visual regression. Ref
selectors mirror the previous `push_head` + `push_glob` set (not `--all`, which would
also pull in `refs/stash`/notes). Verified with `cargo test -p strand-core` (+3 `log`
tests: empty/unborn repo → empty, subject/body/parent parsing, and a branchy merge
repo asserting the topo invariant holds), `clippy`, and a before/after `perfcheck` run
(numbers above). Remaining perf items (webview cold start, diff render, idle memory)
need a running-app pass; engine follow-ups (repo-handle cache, `spawn_blocking` reads,
`repo_snapshot` batch, diff `collect()`) stay tracked under TASKS → Performance.

**Interactive rebase (2026-06-09):** Closed the last big history-editing gap. A
custom sequence editor (`views/RebaseEditor.tsx`) drives `git rebase -i` with **no
editor in the loop**: the todo plan is fed via `GIT_SEQUENCE_EDITOR=cat
"$STRAND_REBASE_PLAN" >` (git runs the editor through its own shell, so the trailing
`>` plus the appended todo path forms a redirect — no helper script, no path
quoting), `GIT_EDITOR=true` keeps `squash` on git's default combined message, and a
`reword` is applied as `pick` + `exec git commit --amend -F <msg>` so the new message
maps to the right commit deterministically. v1 covers reorder / pick / reword / squash
/ fixup / drop (no `edit`; merges are flattened with a warning). The editor is
keyboard-operable (listbox + ⌥↑/⌥↓ reorder + `p`/`r`/`s`/`f`/`d`), launched from the
commit context menu + `CommitDetail` ("Rebase from here…"), the current-branch sidebar
menu, and ⌘K. A necessary companion landed too: **`Repo::continue_operation`** + an
`OpBanner` **Continue** button — a paused rebase only advances via `git rebase
--continue` (not a commit), which the banner's old "resolve and commit" guidance got
wrong. Verified with `cargo test -p strand-core` (+5 history tests: reorder/drop,
fixup/squash, reword, and a conflict → resolve → continue round-trip) and `tsc`.

---

## 1.0 — Stable (≈ 20 weeks)

- ☑ Submodules (list + status, init/update --recursive)
- ☑ Worktree management (overview dashboard + sidebar section + grouped tabs +
  create/remove) — the AI-review workflow's primary organizing unit
- ☑ Interactive rebase (custom sequence-editor protocol) — shipped 2026-06-09
  under the 0.5 history-ops line; see that milestone's changelog entry
- ☑ Blame view (per-line author + commit jump)
- ☑ Reflog browser
- ☑ File history (log for a path)
- ◐ Commit search — in-graph message/author/hash search shipped (highlight + ‹/›
  nav, lanes intact); `-G` / `-S` content search still pending (needs a backend
  `git log` search)
- ☑ Stashes shown inline on the graph (synthetic node per stash, attached to its
  base commit; distinct diamond marker + `stash@{n}` chip; right-click Apply/Pop/Drop)
- ☐ Drag-and-drop renames in file tree
- ☐ Compact / default / relaxed density (settings UI; CSS already supports it)
- ☐ Crash reporting (opt-in, off by default)
- ☐ Telemetry (opt-in, clearly disclosed)
- ☐ Localization framework + English baseline
- ☐ Performance pass on 100k-commit repos
- ☐ Signed installers on all three platforms

**File view + submodules (2026-06-06):** First 1.0 vertical — the four-tab file
view (PRD §6.5) and submodules went from placeholders to wired features.
- **File content.** `Repo::file_content(path, rev)` reads the working-tree copy
  from disk (behind the same `safe_workdir_path` traversal/symlink guard the
  conflict reader uses) or a blob at a revision via `git2`; binary heuristic +
  2 MB cap (`truncated` flag). The Content tab renders it through Pierre's
  read-only `<File>` (syntax-highlighted, app-themed) — not Shiki, which stays
  a future polish.
- **Blame.** `Repo::blame(path)` maps each HEAD line to its commit via
  `git2::blame_file`, paired with the HEAD blob content (per-commit summary
  cache, 50k-line cap). The Blame tab renders a **fixed-height virtual list**
  (only the viewport slice mounts — a 50k-line blame would otherwise freeze the
  main thread and flood Tab nav); click a line to jump to its commit in the graph.
- **File history.** `Repo::file_history(path)` shells out to
  `git log --follow --numstat` (rename-following history + per-path add/del
  counts — both painful over a git2 revwalk). The History tab lists revisions
  and shows that commit's change to the file via a new pathspec-limited
  `Repo::diff_commit_file`; the Compare tab diffs the file between any two of
  its revisions (`diff_between` filtered to the path).
- **Submodules.** `Repo::submodules()` (git2 list + status reduced to
  uninitialized / up-to-date / out-of-date / modified, with recorded vs
  checked-out OIDs) and `Repo::submodule_update(paths, init, recursive)`
  (shell-out + streamed progress, like the other network ops). The sidebar
  Submodules section is now live: status badges, double-click to open a
  submodule as its own tab, right-click Update / Init & update / Copy path, and
  an "Update all" header action.
- Six new IPC commands (`repo_file_content` / `_file_history` / `_blame` /
  `_diff_commit_file` / `_submodules` / `_submodule_update`), TS types +
  wrappers, a `submodules` store slice refreshed on open / tab-switch /
  checkout / focus / manual refresh. Verified with `cargo test -p strand-core`
  (+4 new tests: blame line-mapping, history rename-follow, content
  working-tree/revision + traversal rejection, submodule listing), `clippy`,
  `tsc`, `vite build`, and an adversarial 5-dimension review (FFI contract /
  security / logic / React-perf-a11y / conventions — one confirmed finding, the
  non-virtualized blame list, fixed).

**Reflog browser (2026-06-08):** Second 1.0 vertical. The reflog is the local,
chronological record of where HEAD has pointed — and the only UI path back to
commits orphaned by a reset / rebase / amend (the commit graph only shows
reachable history). `strand-core::reflog` reads it via `git2::Repository::reflog`
(a pure local read — no shell-out needed): `Repo::reflog(selector, limit)` returns
per-entry old→new OID + committer + time + message, newest-first, mapping an
unborn HEAD's missing reflog to an empty list (mirrors `log` on an empty repo).
New `repo_reflog` IPC (selector defaults to `HEAD`) + `repoReflog` wrapper +
`ReflogEntry` type. A lazy `reflog` store slice (`refreshReflog`, guarded on
`activePath`, reset per tab like `workTree`/`submodules`) feeds a new
`views/Reflog.tsx`. **Placement:** the graph and the reflog are two lenses on
the same history, so rather than a third sidebar primary row, a shared
`[Graph | Reflog]` segmented toggle (`components/HistoryModeToggle.tsx`) sits in
the All Commits header actions — the sidebar's "All Commits" row stays active across both,
and ⌘3 + ⌘K "Show: Reflog" jump straight to the reflog lens. Each row shows
`HEAD@{n}`, an op badge parsed from the
message (commit / checkout / reset / merge / rebase …, colored by family so
rewriting moves stand out), the message, time, and short OID; clicking or
pressing Enter jumps to that entry's commit in the graph (`revealInGraph`).
Keyboard-first: `role=listbox` with roving `aria-activedescendant` and ↑/↓ focus
movement. Verified with `cargo test -p strand-core` (+3 `reflog` tests:
unborn-HEAD→empty, newest-first ordering with parsed messages + null old-OID on
the creation entry, and `limit` bounding), `clippy`, `tsc`, and `vite build`.

**File view follow-ups (2026-06-06):** Three polish items from first use.
- **Uncommitted changes in History.** The History tab now leads with a
  "Working tree" entry whenever the file has local (uncommitted) changes,
  selected by default; it shows the net working-tree-vs-HEAD diff via a new
  `Repo::diff_workdir_file` (`diff_tree_to_workdir`, pathspec-limited, staged +
  unstaged combined; untracked files appear as additions).
- **Blame syntax highlighting.** The blame code column is tokenized through
  **Pierre's own shared highlighter** (`lib/highlight.ts` →
  `getSharedHighlighter` + `getFiletypeFromFileName`, with the `pierre-dark` /
  `pierre-light` themes), so blame is colored *identically* to the Content tab
  — same engine, same theme, same language detection. Capped at 12k lines, only
  the virtualized viewport rows paint spans, graceful fallback to plain text.
  No second highlighter and no extra cold-start cost (Pierre already loads it).
- **Back navigation.** The file-view tab + a `fileReturn` marker moved into the
  store, so jumping from a blame line / history row to a commit shows a "Back to
  <file>" bar in the commits view that returns you to the file *at the same
  tab*. Any normal navigation (opening a file, switching tabs) clears the
  marker. Verified with `cargo test -p strand-core`, `tsc`, and `vite build`.

**Commit search (2026-06-08):** The long-inert search box in the All Commits
header is now live. The key design call: **highlight matches in place, don't
filter** — `lib/graph.ts` lays out lanes in a single pass that assumes every
parent stays present, so dropping rows would break lane continuity (the exact
reason the input was disabled). Instead, matching rows get a faint `--accent-glow`
wash and the matched substring in the searched column is accent-bolded (the
palette's `.hl` convention); the graph is never touched. A field picker
(Message / Author / Hash, via the shared `ContextMenu`) sits in the search pill;
‹/› (or ↵ / ⇧↵ in the field) step through matches against an N/M counter that's
*derived from the focused row* (no separate index to desync), each step scrolling
the row into view via the existing focus effect while keeping DOM focus in the
input. Keyboard-first per the project contract: `/` focuses the field (ignored
while typing elsewhere), ⌘K → "Search commits…" jumps to it (one-shot
`commitSearchFocus` store signal, mirroring `revealCommit`), Esc clears.
Matching is **client-side over the loaded log** (message *subject* / author
name+email / hash prefix) — so it's instant and needs no backend, but it only
covers the loaded window and can't do content search. The body is deliberately
**not** searched: every commit here ends with a `Co-Authored-By:` trailer, so a
body search for a common substring ("auth") would light up nearly the whole log. Full-history +
`-G`/`-S` pickaxe search (a `git log`-backed `Repo` command) stay open under
TASKS → strand-core → Reads. Verified with `tsc` + `vite build` (frontend-only;
no Rust change).

**Worktree management (2026-06-09):** Built around Strand's differentiating use
case — reviewing what AI agents change, where agents commonly run one worktree
per feature in the same repo. The design leans on **reuse**: a linked worktree's
directory is itself a valid repo path, so opening one is just `openRepo`, and the
overview's per-worktree stats reuse the existing `repo_status`/`repo_meta`/
`repo_log` commands against each worktree path — no dedicated stat backend.
`strand-core::worktree` shells out to `git worktree list --porcelain` / `add` /
`remove` / `prune` (module-local `run_git` + `GIT_SAFE_CONFIG`, per the shell-out
rules); `RepoMeta` gained `common_dir` (gix `common_dir()`) + `is_linked_worktree`
(git2 `is_worktree()`) so the tab strip can group. Four IPC commands + store slice
(`worktrees`, eager-refreshed on open/tab-switch). Three UI surfaces: a **Worktrees
overview** (`views/Worktrees.tsx`, ⌘4 / ⌘K) listing each worktree with branch,
ahead/behind, dirty count, last commit, and one-click **Review** (opens the worktree
tab on Local Changes); a **sidebar Worktrees section** (first in the Git tab,
current marked with the accent check, context-menu open/remove/force-remove/prune,
header `+` to create); **grouped tabs** (`Topbar.groupTabs` clusters a repo's
worktrees by `common_dir` with a shared dot color, linked tabs labelled by branch);
and a **create dialog** (`views/WorktreeDialog.tsx`, new/existing branch + default
sibling `<repo>.worktrees/<branch>` path + open-in-tab). Verified with
`cargo test -p strand-core` (35 pass, +2 worktree tests), `cargo check`, `tsc`, and
`vite build`. **Open:** a live in-app pass on the
Tauri window is still pending (the webview can't be driven by the browser harness).
("Review worktree vs base branch" shipped 2026-06-10 — see below.)

**Stashes inline on the graph (2026-06-09):** Stashes now render as nodes in the
All Commits graph, not just the sidebar list. The design avoids touching the
hot `log()` path: rather than adding `refs/stash` to the `git log` walk (which
would drag in git's synthetic "index on…"/"untracked files on…" parent commits
and regress the tuned first-page latency), the backend exposes each stash's
**base** (first parent) + **commit time** (two new `Stash` fields filled in
`stash_list` after the `stash_foreach` walk, since the closure holds a `&mut`
borrow), and the **frontend injects** a synthetic row per stash. `mergeStashRows`
(in `Commits.tsx`) splices each stash immediately above the commit it was taken
on, with that base as its only parent — so the lane algorithm draws it hanging
off that point and the topological invariant holds with no re-sort (the base
always sorts below). Stashes whose base isn't in the loaded window are dropped
from the graph (still listed in the sidebar). The merged list feeds both
`computeGraph` and the row map so they stay index-aligned; navigation,
multi-select, and search continue to run over the real `commits` only — stash
rows are mouse-reachable and their actions (Apply / Pop / Drop / Copy SHA) live
in the right-click `ContextMenu`, mirroring the sidebar (keyboard path to stash
ops stays the sidebar Stashes section). `GraphRow` gained `isStash`, rendered as
a neutral hollow **diamond** (vs the lane-colored commit/merge circles) in
`CommitGraphCell`; the message cell shows a `stash@{n}` chip + the stash message.
Clicking a stash opens the **detail panel** showing its content — `CommitDetail`
resolves the (off-`commits`) stash from the stash list into a synthetic header,
and the diff is the base→stash tree diff (`repo_diff_commit` against the first
parent = `git stash show -p`), with **Apply / Pop** actions in place of
Checkout/Tag/Cherry-pick/Revert (Pop/Drop close the panel as the stash leaves
the stack). Verified with
`cargo test -p strand-core` (+1 `stash` test asserting `base`/`time_unix`),
`cargo check`, `clippy` (no new warnings), `tsc`, and `vite build`. **Open:** a
live in-app pass on the Tauri window (the webview can't be driven by the browser
harness).

**Select commits since baseline (2026-06-10):** Closed the open AI-review
graph item. With a review baseline pinned, the All Commits toolbar shows a
"Select since <short>" button (and ⌘K gains "Review: select commits since
baseline") that selects the agent session's commits — `commitsSinceBaseline`
in `Commits.tsx` walks parents from HEAD over the loaded log, stopping at the
baseline (the client-side `baseline..HEAD`), and feeds the existing
multi-selection, focusing HEAD. The palette path uses a one-shot
`selectSinceBaseline` store signal (mirrors `commitSearchFocus`) so it
survives the view switch; an empty range toasts instead of clearing the
selection. Verified with `tsc`, `vitest` (29 pass), and `vite build`.
A same-day follow-up made the baseline pinnable at **any commit**, not just
HEAD: `setBaseline(oid?)` takes an optional target, and the commit
right-click menu gained "Review changes since this" — pin there + jump to
the Review view in one step.

**Review worktree vs base branch (2026-06-10):** Closed the worktree vertical's
last open item by composing existing pieces. The Worktrees overview's **Review**
button now computes `merge-base(worktree, main worktree's branch)` — a new
`Repo::merge_base` (`refs.rs`, git2 `revparse_single` + `merge_base`; pure
read) exposed as `repo_merge_base` — pins the review baseline there, and opens
the worktree tab on the **Review view in session mode**: committed + staged +
unstaged work since the fork point in one diff, via the existing `diff_since`
path (per-worktree baselines already persist per repo path, so each worktree
keeps its own session). The main worktree, or a worktree where no merge-base
resolves (toasted), falls back to opening on Local Changes as before. Verified
with `cargo test -p strand-core` (+1 `refs` test: fork-point, same-commit, and
unknown-revspec cases), `clippy`, `tsc`, `vitest` (29 pass), and `vite build`.

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
