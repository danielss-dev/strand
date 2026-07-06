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
  - ☑ Dialog flow (native picker via ⌘O + topbar `+` dropdown, drag-and-drop folder onto window; picker + drop are **multi-select** — open several repos at once, each as a tab)
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
  - ✗ Recent commit messages dropdown — removed 2026-07-02 on user feedback
    (stale old messages made no sense next to AI suggestions; the SQLite
    table stays, unused)
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
- ☑ **macOS packaging** — *release CI builds, signs, and notarizes the
  universal DMG (v0.5.0, 2026-06-12). See `docs/packaging.md` for the runbook.*
  - ☑ Real app icon (squircle on the Apple grid — commit `aefc189`)
  - ☑ Apple Developer ID signing + notarization (release CI signs + notarizes
    `Strand_0.5.0_universal.dmg`)
  - ☑ First DMG ships — superseded by the public v0.5.0 GitHub Release
    (2026-06-12)

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
- ☑ Linux build (deb / rpm / AppImage) — built + published by release CI
  (v0.5.0, 2026-06-12)
- ☑ Tauri auto-update: real pubkey + signed manifests done (minisign keypair
  wired, `createUpdaterArtifacts` on); in-app UI done (Settings → Updates:
  check / download / restart + auto-check & auto-install prefs); release CI
  publishes a signed all-platform `latest.json` per release (since v0.5.0); the
  updater endpoint now points at the GitHub Releases manifest
  (`releases/latest/download/latest.json`) — the dead `strand.danielss.dev/updates`
  host was dropped in 0.6.1 (`ce1ffd0`). Operational note: CI opens a **draft**
  release; `releases/latest/download/` only resolves once it's published.
- ☑ **Settings view** — multi-section dialog (Appearance / Diff / Git /
  Integrations / Updates): density + fonts exposed, diff appearance (layout
  default, font, indicators, line numbers, word highlight), global git
  identity, default clone/open folder, external editor + terminal
  (presets + custom command, wired to header buttons + palette)
- ☑ Performance pass to hit PRD §8 targets on medium repos — **closed
  2026-07-06** (open <2s for 100k commits ☑, status refresh <200ms on 10k
  files ☑; webview-side targets measured on the running app 2026-06-29 — see
  `docs/perf-baseline.md` § "Webview / full-app baseline": **cold start ☑**
  (~407ms shell / ~568ms repo-interactive), **perceived stage ☑** (~34ms),
  **diff render ☑** (~87ms normal; the ~1460ms whole-file 5,000-line case was
  the non-virtualized Local Changes pane — **virtualized 2026-07-06**, now
  ~200 mounted rows like Review), **idle memory ☑** (target restated
  per-platform in PRD §8, 2026-07-06: macOS < 250MB / Windows < 300MB private
  + < 50MB app-attributable / Linux TBD — the WebView2 six-process floor is
  ~248MB before any app data with no supported trim switch, while the app
  itself adds ~32MB; Windows passes both restated figures). Every PRD §8
  target now passes on its measured platform.)

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

**Settings view shipped (2026-06-10):** The single-section settings modal grew
into a five-section dialog — sidebar `tablist` (↑/↓ select-on-focus, Home/End,
same focus trap) over **Appearance** (theme + accent moved over; density / UI
font / mono font finally get UI), **Diff** (default layout — now the fallback
`loadRepoDiffMode` applies when a repo has no per-repo row — plus diff font via
`--diffs-font-family`, `classic`/`bars`/`none` indicators, line numbers, word
highlight, all flowing through `diffAppearanceOptions()` into `Diff` and
LocalChanges with a live Pierre preview; MergeResolver deliberately pinned),
**Git** (global `user.name`/`user.email` via `git2::Config` — new
`strand-core::gitconfig` + `git_global_identity`/`git_set_global_identity`
IPC — and a default clone/open folder seeding CloneDialog + the open picker),
**Integrations** (editor/terminal per-OS presets + custom `{file}`/`{line}`/
`{dir}` templates; `strand-core::external` tokenizes *before* substituting so
repo paths can't inject argv, spawns detached; the MainHeader Terminal /
Open-externally stubs are finally live, plus palette actions), and **Updates**
(version, check / download / restart on plugin-updater + new plugin-process,
auto-check-on-launch + auto-install prefs; soft-fails while the endpoint is
offline). Verified: `cargo test -p strand-core` (57 tests, +7 new),
`vitest` (36, +7 for integrations), `tsc`, and a keyboard-only Playwright
pass over all five sections in browser mode.

**Native macOS menubar (2026-06-10):** The default Tauri menu (About/Hide/Quit
only) is replaced with a real one (`ui/src/lib/menu.ts`, JS `Menu.new` +
`setAsAppMenu`): Strand (About, Settings ⌘,, Check for Updates), File (Open
Repository ⌘O, Clone), Edit (native clipboard), View (palette ⌘K, the five
views ⌘1–5, theme toggle ⌘⇧T), Repository (Sync ⌘⇧S — previously shown in the
palette but never actually bound — Pull, Push, Open in Editor/Terminal), and
Window. Items call the same callbacks as the in-app UI through a ref, so the
menu only reinstalls when repo-scoped items flip enabled/disabled (repo
open/close). AppKit dispatches menu accelerators before the webview sees the
keydown; App's key handler also skips menu-owned combos (`appMenuInstalled()`)
so handling is single-fire either way. macOS only — the Win/Linux in-window
menubar stays tracked in TASKS. The status-bar settings button also swapped
its sun glyph for a proper gear (Feather `settings`, 24-grid with compensated
stroke).

**Review view, sharpened for AI review (2026-06-10):** The Review tab now
reads like a review of what the agent did, not a second staging surface.
Diffs carry **whole-file context** — every changed file renders in its
entirety with the edits inline (`diff_unstaged_full`/`diff_since_full` +
`repo_diff_*_full` IPC; the inbox pool lives in its own
`reviewUnstagedDiffs` store slice, refreshed only while the view is live so
Local Changes' diff hot path is untouched). The flat file queue became a
Pierre tree, matching Local Changes: git-status colors, a new `rowDecoration`
lane on the `PierreTree` wrapper showing ✓ (reviewed) / "changed" (stale),
right-click verdict + stage/discard actions, double-click/Enter to toggle
reviewed (folders mark their subtree). Verified: `cargo test -p strand-core`
(new whole-file-context test), `tsc`.

A same-day follow-up made it **fast**: whole-file patches had made j/k
navigation stall, because `@pierre/diffs` was tokenizing every file with
Shiki *synchronously on the main thread*. Pierre's highlight worker pool is
now mounted app-wide (`DiffWorkerPool`, 2 workers, dual pierre-dark/light
themes; vite `worker.format = 'es'` for its lazy wasm chunk), parsed patches
carry a `cacheKey` so the pool's AST cache makes revisits free, the Review
pane defers its heavy mount until the queue position settles (`useSettled` —
single steps stay instant, scrubbing renders nothing in between), and the
next few queue entries pre-highlight in the background while the reviewer
reads. Verified: `tsc`, `vite build`, `vitest` (36).

Round two of the same push: ↑/↓ in the queue tree now *select* the file they
land on (`followFocus` on `PierreTree` — armed on keydown, resolved via a
model subscription so it can't race Pierre's own focus move), Space toggles
the reviewed mark without auto-advancing, programmatic navigation replaces
the tree selection instead of accumulating highlighted rows, and the diff
pane is wrapped in Pierre's `<Virtualizer>` so multi-megabyte whole-file
diffs (bun.lock) window-render instead of freezing the app. Verdict hashing
is cached per fetch and prefetch priming skips >1 MB patches. Verified:
`tsc`, `vite build`, `vitest` (36).

**File-view Preview tab (2026-06-11):** Renderable text files get a rendered
view next to their source. The file view grew a **Preview** tab (eye icon,
offered only for SVG / markdown paths): SVG renders through the existing
image pipeline (data-URL `<img>` — scripts can't run there), markdown through
a new hand-rolled renderer (`ui/src/lib/markdown.tsx`) that emits React
elements directly, so repo content can never inject HTML into the
IPC-privileged webview (raw HTML shows as literal text; no sanitizer dep).
GitHub-subset coverage: headings, fenced code, nested + task lists, quotes,
pipe tables, emphasis/links/images/autolinks. Relative links open the target
file in the file view (md → md stays in Preview), http(s)/mailto links open
in the system browser (`shell:default` capability finally granted —
the plugin was registered but unreachable), and repo-relative images load
off the worktree. The preview revalidates on watcher ticks, so an agent
editing docs updates it live. A same-day follow-up added the
**"Open files on"** setting (Settings → Appearance: Preview / Source,
default Preview): `selectFile` now picks the initial tab per the setting
for renderable files (`lib/preview.ts` shared by the store and the view);
doc → doc links stay in Preview either way. Verified: `vitest` (105, +17
markdown), `tsc`, `cargo check -p strand-tauri`.

**Landing page (2026-06-12):** First pass at the public face, ahead of the
beta: `website/` holds a static, no-build-step landing page for
`strand.danielss.dev`. It reuses the app's identity wholesale — the OKLCH
token palette from `tokens.css`, self-hosted Geist + JetBrains Mono, the
single-hue accent system (a row of hero dots rotates `--accent-h` live,
exactly like Settings → Appearance) — so the site *is* the product's design
system at poster scale. The hero is a keyboard-driven replica of the actual
app shell — topbar (repo tab, sync group, stash split button, branch button,
⌘K pill), sidebar (primary rows, Git/Files tabs, filter, ref sections),
breadcrumb header, Review toolbar, queue tree with file-type icons, diff pane,
hint footer, and statusbar, all built to `chrome.css`'s real metrics with
pierre-dark's actual token colors. It's a working multi-view demo: the sidebar
switches between **Local Changes** (staging header + the app's commit bar,
which "commits"), **Review** (`j`/`k` queue, `space`/Mark-reviewed toggles,
live progress + discard counts), and **All Commits** (hand-drawn lane graph
with branch/tag/HEAD/ai chips and a stash diamond, `j`/`k` walks rows); tree
folders collapse like the Pierre tree. **⌘K opens the app's command palette**
(same grouped/fuzzy/highlighted UI) repurposed to drive the page — jump to
sections, switch demo views, set the accent, open GitHub / @danielss_dev on X.
The pitch is the demo. Content covers the agent-review
loop (watch / baseline / whole-file context / feedback export), an
accountability band ("the commits carry your signature" — a mock `git log`
showing the agent's work signed by you, kicker "don't ship shit to prod"),
the measured perf numbers (47ms / 42ms / 10MB, linked to
`docs/perf-baseline.md`), the keyboard map, the full-client feature grid, and
the AGPL-3.0 + honor-system commercial pricing. Degrades gracefully: no-JS gets a fully visible static
page, reduced-motion is respected, mobile drops the keyboard affordances.
Verified with a live Playwright pass (hero/sections/mobile screenshots, j/k +
space interaction, accent switch). **Still pending:** hosting, real release
links, og:image, and the updater manifest on the same domain (tracked in
TASKS → Pre-launch checks).

**Open-sourced (2026-06-12):** The repo is public —
`github.com/danielss-dev/strand`, AGPL-3.0 (`LICENSE` at root) with the
honor-system commercial offer described in `COMMERCIAL.md`. The website's
GitHub/releases/licensing/roadmap links now point at the real repo (the
interim `strand-releases` placeholder was never created, so every link 404'd
until this). Still open: CLA workflow before accepting outside contributions,
and a first GitHub release so the download buttons resolve.

**Repo nav choice (2026-06-25):** Settings → Appearance now has an "Open
repositories" toggle (`repoNav`, persisted) between the default vertical icon
rail and a horizontal toolbar **tab strip** — the strip (`components/RepoTabs.tsx`)
renders inside the topbar in place of the repo-name title, with color-dot pills
that cluster a repo's worktrees, a hover close button, a `+` open/clone/recents
menu, and the same right-click icon-customization menu as the rail. Tab dots
reuse each repo's customized tile color (falling back to a stable hashed hue so
repos stay distinguishable). Switching between open repos got a keyboard path
that works in **both** layouts: rebindable `tab-next` / `tab-prev` commands
(`⌘`/`Ctrl+Tab`, `+Shift` to reverse; palette "Next/Previous repository"),
cycling in on-screen order via `App.cycleTab`. The strip never clips — its pill
lane scrolls (wheel-to-horizontal, active tab auto-scrolls into view on switch)
and a ▾ jump menu appears only while it overflows, listing every open repo.
For a search-driven jump there's now a **repo quick-switcher** (`switch-repo`,
`⌘`/`Ctrl+E`, rebindable + palette entry) — `views/RepoSwitcher.tsx`, a
repo-only sibling of the command palette that reuses its shell and fuzzy
matcher to filter open repos (switch the active tab) and recents not yet open
(opens them); ⌘K stays the full palette. Verified: `tsc`, `vitest` (131).

**Workspaces — Phase 1 (2026-07-01):** Open repos can now be grouped into named
**workspaces** (the repos behind one product). A workspace is a list of repo
paths (`Workspace` in `lib/types.ts`) owned by a dedicated `stores/workspaces.ts`
(`useWorkspaces`), persisted whole in the generic `settings` table
(`workspacesDb`, no new SQLite table) — the single-repo engine in `repo.ts` is
deliberately left untouched. A workspace **filters** the rail/strip rather than
owning the open set: while one is active the rail/strip shows only its repos
(`workspaceMemberSet`, worktrees inherit via `common_dir`) and the rest stay
**open but hidden**. The **Default view is itself a reserved workspace**
(`DEFAULT_WORKSPACE_ID`, active when `activeWorkspaceId === null`) with its own
membership — so opening and closing a named workspace never leaks its repos into
Default (the earlier bug); on first run Default is seeded from the open repos no
named workspace already claims. Opening a workspace opens any missing members
and focuses the first (it never closes anything); while active, membership
tracks *deltas* — a repo opened joins the active workspace (Default included),
one closed leaves it — via a `useRepo` subscription (`enableSync`, armed by `App`
only *after* session restore, keeping the active tab visible). Chrome:
`components/WorkspaceSwitcher.tsx` (Default row + named list + create / rename /
delete / manage) in the rail and strip, plus `views/WorkspaceManagerDialog.tsx`
to curate each workspace's repositories (add from recents/open, remove;
rename/delete named). Multi-membership stays possible at the model level (a path
can be listed in several workspaces). Phase 2 (the payoff) is the aggregated
cross-repo review surface; Phase 3 is palette + `.code-workspace` import — both
open in TASKS. Verified: `tsc`, `vite build`.

**Workspaces — Phase 2, aggregated review (2026-07-02):** The payoff surface:
**Workspace Review** (`views/WorkspaceReview.tsx`) reviews every member repo
of the active workspace in one queue, grouped repo→files. It shares the
sidebar **Review** destination with the single-repo view — the two are lenses
on one review state, so a `[Repository | Workspace]` segmented control in the
main header (`ReviewModeToggle`, the Graph|Reflog pattern; shown once the
workspace has ≥2 members) flips between them in place, and ⌘K "Show:
Workspace Review" / `Mod+6` jump straight to the workspace lens. A dedicated `stores/workspaceReview.ts` keeps one slice per member
and fans the *already path-parameterized* diff IPC across them — exactly the
no-Rust-changes plan: each member reviews in its own mode (**session** via
`diff_since_full` when that repo has a persisted baseline, **inbox** via
`diff_unstaged_full` otherwise), and reviewed marks read/write the same
per-repo `reviewSession` records as the single-repo Review, so the two views
are lenses on one review state. The left column stacks one collapsible section
per member (group-color dot, branch, session/inbox chip, n/m reviewed, its own
Pierre tree); the right pane is the familiar whole-file-context diff
(virtualized, worker-pool prefetch of upcoming queue entries, image diffs via
`ImageDiff`'s new `repoPath` prop). The Review keyboard loop carries over and
crosses repo boundaries: `j`/`k` walk the merged queue in tree display order
(`workspaceQueueOrder`, unit-tested), Space toggles reviewed, `s` stages,
`d`-`d` discards (per-member `repo_stage_many`/`repo_discard_many`,
rename-aware), and `o` opens the file in its repo's own Review for the tools
that deliberately stay per-repo in v1 (hunk-level actions, notes, ⌘F).
**Live-follow** landed with it: the `repo://changed` listener now also feeds
the workspace store, which refreshes the matching member's slice while the
view is open — so agents working in *background* member repos update the
queue live, which the single-repo store never did. Verified: `tsc`, `vitest`
(158, +6 `workspaceReview`), `vite build`, and a live browser-mode pass
(seeded stores: sections + mode chips + toolbar progress render, j/k crosses
repos and clamps, Space flips 0/3 → 1/3 with the section count following,
row-visibility gate at ≥2 members).

**Workspaces — Phase 3 kick, palette entries (2026-07-02):** Workspace
management joined the command palette, closing the keyboard-first gap. A new
**Workspaces** palette group lists every workspace (Default included, active
check-marked, repo counts as meta) — it shows once a named workspace exists
and is part of the empty-query set, so switching is ⌘K → pick; rows run the
same `openWorkspace` path as the switcher menu. The Actions group gains
"New workspace…" and "Manage workspaces…"; create routes into
`WorkspaceManagerDialog` in a new create mode (`initialCreate`), and the
manager itself grew a "+ New workspace" row (creating was switcher-menu-only
before) that spawns the workspace with a placeholder name and autofocuses
the name field with the text selected — type to replace, Enter to commit.
Verified: `tsc`, `vitest` (158), `vite build`. Remaining Phase 3:
`.code-workspace` import + the Workspace Review follow-ups (tracked in
TASKS).

**`.code-workspace` import (2026-07-02):** A VS Code multi-root workspace
file now imports as a Strand workspace — palette "Import .code-workspace…"
or the manager's new "Import .code-workspace…" row. Parsing is pure,
unit-tested TS (`lib/codeWorkspace.ts`): JSONC-tolerant (string-aware
comment/trailing-comma stripping), local `path` folders only (remote `uri`
entries ignored), relative paths joined against the file's directory and
each candidate validated through `repoOpen`, whose canonical `meta.path` is
what gets stored — the join never fabricates a re-spelled path (the Windows
duplicate-tab rule). The file itself is read by a new deliberately narrow
IPC command (`workspace_file_read`: name must end `.code-workspace`, ≤1 MB
— the webview gets no generic file reader out of this). Non-repo folders
are skipped and reported (toast / manager message); the import only errors
when nothing resolves. Verified with `cargo test -p strand-tauri` (+1 gate
test), `clippy`, `tsc`, `vitest` (171, +13 `codeWorkspace`), `vite build`,
and an end-to-end pass against the **running Tauri app** over WebView2 CDP:
a JSONC fixture with two real repos + a non-repo + a remote uri imported as
"acme" (2 added, 1 skipped, uri ignored), the workspace opened with members
tabbed, the all-non-repo fixture threw without creating anything, and the
backend refused a non-workspace path. Remaining Phase 3: the Workspace
Review follow-ups (tracked in TASKS).

**Workspace Review hunk-level stage/discard (2026-07-03):** The biggest gap
between the two review lenses is closed: inbox-mode member diffs in Workspace
Review now carry the same per-block Stage / Discard actions as the single-repo
Review, instead of rendering read-only. The shared `HunkAnnotatedDiff` gained
an `onApplyBlock` override that hands the sliced change block to the caller
instead of the active repo's patch plumbing; Workspace Review routes it through
a new `useWorkspaceReview.applyBlock`, which fans `repo_apply_patch` to the
owning member's path (the member can be a background tab) and refreshes that
member's slice. Session-mode members stay read-only — their diffs span commits,
exactly like the single-repo view. Block discards record the global single-undo
handle pinned to the member's path, and `undoDiscard` now forward-applies to
the repo the handle was *recorded in* rather than dropping it when another tab
is active — so the Undo toast recovers a background-member discard (this also
fixes the single-repo edge where switching tabs inside the 6s window made Undo
a silent no-op). Verified end-to-end on the running Tauri app over WebView2 CDP
with two scratch repos in a throwaway workspace: staging one of two blocks left
the file `MM` with exactly that block in the index; discard → Undo restored the
block in the background member while the other repo held focus; a
baseline-pinned member rendered zero hunk buttons. Plus `tsc`, `vitest` (171),
`vite build`. Remaining Phase 3: notes + repo-grouped feedback export, ⌘F
across member pools, per-worktree members.

**Review change map (2026-07-04):** The Review diff pane (both lenses) grew an
overview ruler beside the scrollbar — `components/DiffMinimap.tsx` marks every
change block in the whole-file diff (add / del / mixed = del-over-add) at its
proportional position, with a translucent visible-region thumb; click or drag
jumps the pane. Positions come from `computeChangeMap` (`lib/changeMap.ts`,
unit-tested): a pure patch-text scan into *rendered row* space, so fractions
line up with Pierre's Virtualizer even before it finishes measuring, and
layout-aware (split collapses a mixed run to its taller column). Verified on
the running app over WebView2 CDP: marker census matched the file's change
blocks in both views, click at fraction f landed at `f·scrollHeight −
clientHeight/2` exactly, `n`/`p` landings agreed with the marker positions,
and flipping `diffMode` to split recomputed totals/heights. Plus `tsc`,
`vitest` (176, +5 `changeMap`).

**Workspace Review notes + repo-grouped feedback export (2026-07-04):** The
agent feedback loop now closes from the workspace lens too. Notes work
exactly like the single-repo Review — `m` (or the header / per-block "Note"
buttons) opens the same editor, chips render above the diff, ✎n decorates the
queue trees — and each note persists to the *owning member's* review session
(`MemberReview.notes` follows the `reviewed` pattern: the active repo reads
the in-memory map, background members the DB, and writes mirror back into
`useRepo` when the member is the active tab — one note store, two lenses; a
shared `makeReviewNote` factory in repo.ts keeps the note shape identical).
The export is the repo-grouped format the v1 cut waited on:
`buildWorkspaceReviewFeedback` (`lib/reviewExport.ts`) emits
`# Review feedback — <workspace> workspace`, one `## repo (branch …)` section
per noted member with its own baseline context, per-file rendering demoted to
`###` (a `fileSection` helper extracted from — and shared with — the
single-repo builder, so excerpt windows and bullet-joining stay
byte-identical), and a closing line telling the agent paths are relative to
each repository. Members without notes are skipped; noted files that left a
pool still export via the same `collectFeedbackFiles` union. "Copy feedback
(N)" sits in the toolbar with the count toast. Verified with `tsc`, `vitest`
(179, +3), and a live browser-mode pass against the dev vite with two seeded
members (m → editor → chip/decoration/count; block-Note pre-anchored L2;
clipboard capture matched the format byte-for-byte across both repos
including the L13 excerpt; × removal recounted 3→2). Remaining Phase 3:
⌘F across member pools, per-worktree members.

**Workspace Review ⌘F across member pools (2026-07-04):** The last
review-lens parity gap. The in-diff search bar now works in the workspace
lens, searching every member's pool at once: Mod+F — or the palette
"Search in diff…", which now stays on the workspace view instead of
bouncing to Local Changes — opens the shared `DiffSearchBar` over a
flattened pool where each entry is `tag`ged with its owning repo path
(the tag mechanism built for Local Changes' mixed unstaged/staged pool),
so two members' identical file paths stay distinct. Stepping through
matches crosses repo boundaries (`select({repo, file})` on the workspace
store) and auto-expands the landing member's collapsed section so the
selected row is visible; the preview line disambiguates with a repo
prefix ("alpha · src/auth.ts") via a new optional `pathLabel` prop on
`DiffSearchBar` (single-repo callers unchanged). A same-day follow-up (user
feedback: "the search just moves you to the file, not the place") closed the
original v1 cut for **all three** search surfaces (Local Changes, Review,
Workspace Review): a ⌘F jump now lands on the matched **line**. New
`lib/diffJump.ts` — `matchTarget` picks the anchor (deletions old-side,
adds/context new-side) and `scrollToDiffLine` finds the row inside Pierre's
`<diffs-container>` shadow DOM (content rows carry `data-line` /
`data-alt-line` / `data-line-type`; gutter rows have no `data-line`, so no
false matches), centers it, and flashes it accent-tinted via inline style
(outer CSS can't cross the shadow boundary; inherited `--accent` can). When
the row isn't mounted — Pierre's Virtualizer windows big diffs to ~300 rows;
Local Changes bodies mount viewport-lazily — it first seeks proportionally
using a new pure `lineToRow` (`lib/changeMap.ts`, +5 tests): the same
rendered-row space as the minimap, so `row/total` is the scroll fraction
even mid-measure, then retries until the row exists. Jumps that swap files
park a pending target that the `useSettled` pane consumes on catch-up (or
drops as stale), and the first DOM probe waits a frame so a file-swap can't
false-match the old file's rows. Verified with `tsc`, `vitest` (184), and a
live browser-mode pass: on a 5,003-row virtualized diff the jump landed
dead-center (0px off) on a deletion 4,501 rows deep in both stacked and
split layouts, the cross-repo pending path landed on the other member's
deletion after the settle swap, and the census/wrap/Esc/palette checks from
the first pass still hold. Remaining Phase 3: per-worktree members.

**Per-worktree review members (2026-07-04) — Phase 3 complete:** The last
Phase 3 item, closing the gap between the two organizing units of the
AI-review workflow: agents run one **worktree** per feature, but Workspace
Review only aggregated each member repo's *main* working tree, so an agent's
worktree changes were invisible from the workspace lens. Now every **open
linked-worktree tab** of a member repo reviews as its own section, right
after its family's — `activeWorkspaceMembers` (`lib/workspaceReview.ts`)
appends worktree tabs matched via `mainPathFromCommonDir(common_dir)`.
Workspace *membership* is deliberately untouched: it stays family-level
(main paths only), and opening the worktree tab is the explicit act that
puts it in the review — the same rule by which worktrees inherit rail
visibility, and consistent with the explicit-only membership model. Each
worktree slice reviews in its own mode (session when its path has a pinned
baseline — the Worktrees dashboard's Review pins merge-base baselines per
worktree path — else inbox) with its own reviewed marks and notes, which
already persisted per repo path, so no persistence changes and no Rust
changes. A `MemberReview.worktree` label (branch-derived, refreshed with
meta so an agent checkout renames it) disambiguates every surface —
"web · feat-auth" in the diff-pane chip, ⌘F previews, aria-labels, and the
feedback export's `##` heading; a neutral `worktree` tag chip marks the
section header; toolbar + main-header counts split into "N repos + M
worktrees". `ReviewModeToggle` counts review members, so **one repo with an
agent worktree open now surfaces the [Repository | Workspace] toggle** —
aggregating the main checkout and the worktree is exactly what the workspace
lens adds there. Verified: `tsc`, `vitest` (185, +1 ordering/exclusion
test), `vite build`, and a live browser-mode pass against the dev vite
(seeded main + worktree + second-repo tabs: resolution order and labels,
worktree chip, j/k crossing into the worktree slice, ⌘F preview
"web · feat-auth · src/auth.ts", a note on the worktree file exporting under
`## web · feat-auth (branch feat-auth)`, and the toggle appearing at 1 repo
+ 1 worktree).

**Local Changes diff pane virtualized (2026-07-06):** Closed the last
diff-render miss from the 2026-06-29 webview baseline. The Local Changes diff
pane rendered every row of the selected file — a whole-file 5,000-line agent
change mounted ~7,500 line elements (~70k spans, ~1.5s), and every refresh
(staging a block) re-paid it. `DiffPane` (`views/LocalChanges.tsx`) now wraps
the stacked file list in Pierre's `<Virtualizer className="lc-diff-scroll">`
(the scroll container); each stacked `<PierreFileDiff>` auto-registers with that
one virtualizer through context (`useFileDiffInstance` → `useVirtualizer`), so
every file window-renders only its on-screen rows — the exact mechanism Review
uses. Measured live in the running app (browser-mode, seeded stores): a
6,250/6,250-line whole-file diff mounts **~200 rows, not ~7,500**, with
`scrollHeight` honestly reserved. Two companion fixes were load-bearing, not
polish: (1) the diff is keyed by `hashFileDiff(diff)` because a
`VirtualizedFileDiff` pins the first fileDiff it renders (`this.fileDiff ??=`) —
without the remount, staging a block would leave the pane showing the pre-stage
diff (the non-virtual `FileDiff` updated on re-prop; the virtual one doesn't);
(2) the ⌘F jump hands `{patch, layout}` to `scrollToDiffLine` so it seeks
proportionally to a row the Virtualizer hasn't mounted yet (a deep off-screen row
isn't in the DOM to find — verified landing dead-center 148,645px down a 150,044px
diff). The per-file viewport-lazy IO gate stays and composes: it bounds file
*instances* in a "show all", the Virtualizer bounds *rows* per instance. Verified:
`tsc`, `vitest` (185), `vite build`, and a live browser-mode pass (200-row cap,
content-hash remount 200→8 on a patch swap, ⌘F deep-jump, `n`/`p` step,
collapse/expand, multi-file "show all" placeholders). The only open perf item is
idle memory (WebView2's process-model floor).

**Perf pass closed — idle memory restated per-platform (2026-07-06):** The last
0.5 perf item. The 2026-06-29 webview baseline showed idle memory ~280MB private
with a medium repo open, over the flat 250MB PRD target — but the empty shell
(no repo) already measured 248MB private, i.e. **WebView2's six-process floor
consumed 99% of the budget while the app added ~32MB** (JS heap 7MB). Trimming
the process count isn't a supported lever — the process model is Chromium's,
and `--single-process`-style switches are unsupported in WebView2 — so the
target was restated per-platform in PRD §8, following that table's own
cold-start precedent (1.0s Mac / 1.5s Windows): **macOS < 250MB** (unchanged;
confirm on the Mac box), **Windows < 300MB private** plus an app-attributable
budget of **< 50MB over the empty shell** (the number app code actually
controls, robust to WebView2 runtime updates moving the floor), **Linux TBD**
at the GNOME/KDE platform pass. Windows passes both (280MB absolute, ~32MB
attributable), which closes the 0.5 performance pass — every PRD §8 target now
passes on its measured platform. Doc-only change: PRD §8, `docs/perf-baseline.md`
(both verdict tables + webview finding 2), TASKS → Performance.

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
- ☑ Commit search — in-graph message/author/hash highlight over the loaded
  window (instant, lanes intact) **plus** full-history message/author + `-G`
  content (pickaxe) search via a backend `Repo::search_log`, surfaced in a
  results dropdown (out-of-window hits open in the detail panel). `-S`
  occurrence-count pickaxe is a possible future refinement.
- ☑ Stashes shown inline on the graph (synthetic node per stash, attached to its
  base commit; distinct diamond marker + `stash@{n}` chip; right-click Apply/Pop/Drop)
- ☑ Drag-and-drop renames in file tree — shipped 2026-07-06 (see changelog
  entry below)
- ☑ Crash reporting (opt-in, off by default) — user-mediated GitHub-issue
  flow, shipped 2026-07-06 (see changelog entry below)
- ☐ Telemetry (opt-in, clearly disclosed)
- ☐ Localization framework + English baseline
- ☑ Performance pass on 100k-commit repos — closed 2026-07-06 with the 0.5
  perf pass: every PRD §8 target passes on its measured platform, and the
  engine numbers are taken on the 100k-commit / 10k-file fixtures
  (`discover+log(5000)` ~47ms, `discover+snapshot` ~5.6ms on 100k commits;
  see `docs/perf-baseline.md` + TASKS → Performance, where the audit
  follow-ups — spawn_blocking reads, per-`Repo` git2 handle, snapshot batch,
  virtualization, stable snapshot slices — are all ☑ or declined by
  measurement)
- ◐ Signed installers on all three platforms (macOS signed + notarized via
  release CI since v0.5.0; Windows EV cert + Linux signing still open)

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

**Second pass, ten features (2026-06-11):** git reset (soft/mixed/hard + safety snapshot) with reflog recovery + undo-last-commit, remote add/rename/set-url/remove + branch rename, signed commits via shell-out when `commit.gpgSign=true`, gitignore quick-add, fixup! creation + autosquash in the rebase editor, copy diff as patch/Markdown, in-diff ⌘F search, image diff previews, and review annotations with feedback export — see `docs/improvements.md` § "Second pass" and TASKS for the per-item detail.

**Version bumped to 0.5.0 (2026-06-12):** First bump off the scaffold's
`0.0.1`. The codebase matches the 0.5 milestone (with chunks of 1.0 already
landed), and no public artifact ever shipped, so the version jumps straight to
the milestone it reflects. Updated in lockstep: workspace `Cargo.toml`,
`tauri.conf.json` (what the auto-updater compares), `ui/package.json`, root
`package.json`, `Cargo.lock`. Build artifacts from here on are named
`Strand_0.5.0_*`.

**v0.5.0 released (2026-06-12):** First public release — installers for all
three platforms on the [GitHub Release](https://github.com/danielss-dev/strand/releases/tag/v0.5.0):
signed + notarized universal DMG, Windows MSI, Linux deb/rpm/AppImage, plus a
signed `latest.json` covering every platform/arch key. Getting the pipeline
green took three fixes: pnpm/action-setup vs `packageManager` version conflict
(`22ee44e`), rebuilt `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` secrets
(the 2026-06-01 originals failed PKCS12 MAC verification on import; re-exported
from the Keychain and repackaged Developer-ID-only), and
`CARGO_NET_RETRY`/`CARGO_HTTP_MULTIPLEXING` hardening after two crates.io
download flakes (`8a53544`). Auto-update remains endpoint-blocked: the manifest
ships, the host doesn't.

**Configurable keyboard shortcuts (2026-06-15):** Global shortcuts moved to a
single registry (`ui/src/lib/keys.ts`) resolved against persisted user overrides
(`settings.keybindings`); the window keydown handler, native menu accelerators,
command-palette chips, and the new **Settings → Keyboard** section all read the
same map, so a remap propagates everywhere and the palette/menu hints stay
platform-correct (⌘ vs Ctrl). Push is `Mod+P` and pull `Mod+Shift+P` per request,
plus fetch / sync / open-in-editor / open-in-terminal / refresh defaults. The
Keyboard section records a combo by listening in the capture phase, with
unassign / reset / restore-all and shared-binding warnings; surface-local keys
(commit, in-diff search, commit search, Review j/k) stay with their views and are
documented there. Verified with `tsc`, `vitest` (123 pass, +18 `keys.test.ts`).
See `docs/learnings.md` "Global shortcuts live in one registry."

**Activity-timeline rail (2026-06-19):** The All Commits graph gained a vertical
activity rail (`views/CommitTimeline.tsx`) down the right edge of the list — a
commit-density histogram on a top→bottom time axis, so bursts read as long bars
and quiet stretches as gaps. It doubles as a scrubber: a translucent band marks
the currently-visible window and click/drag seeks the list to that point in time;
hover surfaces the bucket's date span + commit count. A toolbar toggle persists
as `settings.showTimeline`. The bars memoize so a scroll tick only reconciles the
band (the graph's hot scroll path stays cheap); the rail is `aria-hidden` (a
redundant pointer nav aid over arrow-key list navigation + search). Verified with
`tsc` + `vite build`.

**Delete a remote branch (2026-06-23):** The sidebar remote-branch menu gained
**Delete branch on <remote>** (confirm, danger), closing the gap where a branch
could be pruned locally but not on `origin`. `network.rs` adds
`Repo::delete_remote_branch` — `git push <remote> --delete refs/heads/<branch>`,
shelled out + streamed through `run_git_streaming` like the tag-delete sibling
(credentials/progress free); the ref is fully-qualified to `refs/heads/` behind a
`--` so a stray name can't be read as an option. The push also drops the local
`refs/remotes/<remote>/<branch>` tracking ref, so the `refreshRefs` after a
successful delete clears the row with no optimistic bookkeeping. New
`repo_branch_delete_remote` async IPC + `repoBranchDeleteRemote` wrapper +
`deleteRemoteBranch(remote, branch)` store action. Verified with `cargo check`,
`tsc`, and an end-to-end bare-remote run confirming both the remote branch and
the local tracking ref are removed.

**Full-history commit search (2026-06-24):** Closed the last ◐ on the commit
search line. The in-graph search highlighted matches over the loaded log
client-side — instant, but blind past the loaded window and unable to search
file *contents* (it holds no diffs). A backend `Repo::search_log(query, mode,
limit)` (`log.rs`) now shells out to `git log` with the matching filter:
`--grep` / `--author` (`--fixed-strings -i`, mirroring the client's
case-insensitive substring) reach the whole history, and **`-G` (the pickaxe)**
searches each commit's diff for an added/removed line matching the query — the
one search the client can't do. Refs + empty-repo handling mirror `log`; the
`--format`/parse path is shared (`commit_format`). New `repo_search_log` IPC +
`repoSearchLog` wrapper + a `searchLog` store action that stashes hits in
`commitSearchResults`. UI: the search pill gained a **Content** field mode and a
"Search all history" button (⌘↵, or ↵ in Content mode) that opens a **results
dropdown** — keyboard-navigable (↑/↓/↵, combobox + listbox/`aria-activedescendant`
semantics) — listing matches across history with author/short-hash/date and a
marker for hits older than the loaded graph. Clicking a result scrolls + focuses
it when it's a loaded row, and opens the detail panel either way (`CommitDetail`
falls back to `commitSearchResults` so an out-of-window commit still renders;
its diff loads by oid). The loaded-window highlight + ‹/› stay untouched for
message/author/hash — the deep search is an explicit, separate action so a
`git log -G` over full history never fires per-keystroke. Verified with
`cargo test -p strand-core` (+5 `log` tests: empty query, case-insensitive
message, author name/email, the `-G` pickaxe touching-commit-only invariant, and
limit + cross-branch reach), `clippy`, `tsc`, `vitest` (131), and `vite build`.
`-S` occurrence-count pickaxe is a possible future refinement.

**Worktree UX pass (2026-06-26):** Worktrees now read as one repo with many
agent workspaces instead of unrelated branch-named repos. Shared
`repoIdentity` helpers derive a stable repo-family label from `common_dir`;
topbar titles, breadcrumbs, recents, the repo rail, tab strip, repo switcher,
and sidebar all show the repo name first and the worktree/branch as context.
The Worktrees view became a dashboard for parallel AI tasks: stable repo
heading, total/dirty/locked metrics, lazy per-row dirty/drift/last-commit
stats, clearer current/main/locked/detached/stale badges, and a Review action
that leaves the dashboard before switching worktrees so rows do not jump during
navigation. Verified with Vitest, TypeScript, frontend build, and a Tauri
walkthrough of dashboard → Review on a dirty linked worktree.

**Crash reporting, user-mediated (2026-07-06):** Closed the 1.0 crash-reporting
item — first 1.0 work after the 0.5 close. The design call: **no automatic
upload path exists.** The project has no crash-ingest backend (the one custom
host already died once and took the updater with it), and PRD §10's promise is
easiest to keep when the only reporting channel is one the user can read: a
*prefilled GitHub issue* opened in the browser, reviewed and submitted by the
user. The local half (the `install_crash_log` panic hook appending panics +
backtraces to `app_log_dir()/crash.log`) already existed; on top of it, a new
`crash_report_check` IPC command (pure local read: log path, byte length, and
the newest `=== panic at` entry past a caller-supplied ack offset, capped at
8 KB with head-preserving truncation — the panic message + top frames matter
most). Frontend: `crashPrompt` (opt-in, **off by default**) + `crashAck` (the
acknowledged byte offset) in the settings store; an App launch effect (delayed
3.5s like the update check) checks the log when enabled and surfaces a
**persistent CrashToast** — no expiry, a crash deserves a decision — with
**Report…** (builds the issue URL via `buildCrashIssueUrl` in
`lib/crashReport.ts`: title from the panic message line, review-reminder +
version/OS + fenced log excerpt body, iteratively shrunk to a ~7 KB URL
budget; opened with the shell plugin) and **Dismiss**; both persist the ack so
the same crash never re-prompts, and a shrunken/deleted log realigns the ack.
Settings grew a **Privacy** section (telemetry's future home): the toggle with
its disclosure hint, "Report last crash…" (grayed when the log is empty), and
the crash-log path. Verified: `cargo test -p strand-tauri` (13, +1
`last_panic_entry` boundary/newest-entry/truncation test), `clippy`, `tsc`,
`vitest` (190, +5 `crashReport`), `vite build`.

**Per-`Repo` git2 handle reuse; AppState repo cache declined by measurement
(2026-07-06):** Closed the last open engine item from the 2026-06-04 audit —
by measuring it first. The audit's premise (per-command `gix discover` + git2
re-open is a cacheable cost) didn't hold: on regenerated Windows fixtures
(generator now committed as `scripts/gen_perf_fixtures.py`; harness grew
`git2 open` / `snapshot` / `discover+snapshot` rows) discover is ~1ms and git2
open ~0.65ms, flat across 100k commits / 10k files — so the cross-command
`AppState` cache, with its `!Sync`-forced per-repo `Mutex` (serializing the
very reads `spawn_blocking` just parallelized) and config-staleness
invalidation, was declined and the TASKS items closed ✗ with the numbers to
beat. What *was* real: `snapshot` opened git2 four times per call (directly +
`meta`/`refs`/`submodules`), and every re-open reloads the index + pack
mmaps. `Repo` now lazily opens git2 once per instance (`OnceCell`; `git2()`
returns `&git2::Repository`; stash keeps an owned `git2_owned()` — the only
`&mut` callers). Per-IPC `discover+snapshot`: **54→36.5ms on the 10k-file
fixture**, 8.3→5.6ms on 100k commits, 44.5→39.8ms on strand itself; warm-repo
numbers recorded in `docs/perf-baseline.md` § "Windows re-baseline" bound what
a cross-command cache could still buy (~18ms/snapshot) if the 1.0 perf pass
ever justifies it. Verified: `cargo test -p strand-core` (91), workspace
`clippy` clean, before/after `perfcheck` runs (variance re-checked 3×).

**Drag-and-drop renames in the Files tree (2026-07-06):** The last unstarted
pure-code 1.0 feature. Engine: `Repo::move_path(from, to)` (`rename.rs`) —
tracked sources shell out to `git mv` so the index entry moves with the file
(staged content preserved, directory moves + case-only renames on
case-insensitive filesystems native), untracked sources are a plain fs
rename; overwrite refused, missing destination parents created, and both
ends path-guarded (the destination via an ancestor-walking
`safe_workdir_path` variant, since its parents may not exist yet). One new
IPC command (`repo_move_path`, quick sync write) + `useRepo.moveEntries`
(sequential moves, one snapshot refresh, per-entry failure strings; an open
file view follows its file's new path). UI: `PierreTree` grew an opt-in
**pointer-based** drag (shadow-root rows can't be marked `draggable`, but
mouse events compose across the boundary — the existing click/menu-handler
mechanism), all imperative refs + direct DOM so the 60Hz mousemove never
re-renders the tree: 5px threshold, cursor-chasing ghost chip naming entry +
target ("rootfile.txt → src/", dashed when invalid), `--bg-sel` wash on the
hovered folder row, file rows target their containing folder, bare space the
root, Escape cancels, multi-selection drags together. Keyboard parity via a
context-menu "Rename / move…" → `RenameFileDialog` (full-path field,
filename preselected). Verified: `cargo test -p strand-core` (96, +5
`rename`), `clippy`, `tsc`, `vitest` (198), `vite build`, and an
end-to-end WebView2 CDP pass on the running app (tracked file drag → git
`R`, untracked drag stays untracked, dialog rename of a modified file → `RM`
with the edit preserved, ghost text + cleanup asserted).

---

## 1.1+ — Post-1.0

- **Remote repos over SSH** — open a repo on a remote machine (agent
  devbox, VPS) and use Strand locally against it. Headless `strandd`
  daemon over JSON-RPC/stdio, system `ssh` for auth/transport (Strand
  never touches credentials). Designed 2026-06-12: `docs/remote-ssh.md`
  + task breakdown in TASKS.md. Pre-1.0 guardrails (opaque repo paths,
  everything through the `commands.rs` seam) are active now.
- Git-flow (start/finish feature/release/hotfix; shells out to `git-flow`)
- Git LFS (status badges + progress)
- GPG / SSH commit signing UI
- **CLI companion binary (`strand`)** — `strand <path>` opens the repo
  in the app; `strand diff/log/status/review --json` gives AI agents
  typed, full-context data the `git` porcelain can't (same serde types
  as the IPC layer). Read-only by design — no push/pull, no writes.
  Same static binary as the remote-SSH `strandd` (`--stdio` mode). Designed 2026-06-12:
  `docs/strand-cli.md` + task breakdown in TASKS.md.
- Plugin / extension surface
- AI features (commit message suggestions, conflict hints) — PRD Q3
  - ☑ Commit message suggestions from staged diffs (Codex / Claude Code CLIs)
- Built-in PR review surface for GitHub / GitLab — PRD Q4

**AI commit messages (2026-07-01):** Subscription-first suggestions from staged
diffs — Codex CLI (`codex login` / `codex exec`) for ChatGPT Plus, Claude Code
CLI (`claude -p`) for Anthropic. Rust `ai/` module + four IPC commands; Settings
→ AI for sign-in; CommitBar sparkle button; palette + ⌘⇧M. Verified:
`cargo test -p strand-tauri`, `pnpm --filter ./ui exec tsc --noEmit`.

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
  3. ◐ AI features extension point — `CommitMessageGenerator` trait +
     subscription-first commit suggestions (`repo_suggest_commit_message`,
     Settings → AI, CommitBar Suggest, ⌘⇧M / palette).
  4. ☐ PR review surface — 1.1 candidate.
  5. ☑ Pricing — free for all, honor-system paid commercial license.
- **Naming & trademark.** USPTO/EUIPO/WIPO search before 0.5 public launch.
