# Learnings

## Bisect ratings belong to the expected revision (2026-09-06)

Read `BISECT_*` and refs from Git for every dialog refresh/action; these are
worktree-local and may be driven by another client. Map custom terms and
`BISECT_HEAD` for no-checkout sessions, distinguish skipped ambiguity from a
culprit, and reject a rating when HEAD differs from `BISECT_EXPECTED_REV`.
Require a clean tree/index before checkout transitions and reset; test edits
must not be discarded. Review the original ref's current target again before
reset. A bisect marker remaining after a successful merge/rebase does not mean
that sequencer is still paused. Dialogs that remain open after a busy action
must restore focus once controls are enabled again; disabling the focused
button can move focus out of the modal even with a correct Tab trap.

## Interchange state comes from Git, not a saved UI session (2026-09-06)

`rebase-apply/applying` identifies `git am`; `rebase-apply` alone can mean a
rebase. Test this before the generic rebase check so Continue/Abort dispatch
to the right porcelain. Mailbox previews parse every message with Git's
mailsplit/mailinfo, preserving authors and checking old/new paths. Imported
paths reject administrative entries and symlink traversal, including missing
descendants; never enable `--unsafe-paths`. Preview stamps include file bytes,
index and HEAD because status-row equality does not prove unchanged content.
Bundle imports publish only a new local branch after verification/unbundle,
using non-forcing ref creation to reject concurrent external branch creation.

## Sparse indexes and promised blobs require Git-aware paths (2026-09-06)

libgit2 1.8 cannot read the mandatory sparse-directory index extension and
reports absent skip-worktree entries as deletions even with a full index.
For sparse repositories, use Git for status, working diffs and index mutations;
the compatibility index attached to libgit2 is expanded in memory for readers
only. Never rewrite the user's index merely by opening it. Normal repositories
retain their existing in-process paths. This is a scoped exception to the older
index/commit-engine rule, required by F08's sparse-index semantics.

Sparse selection must go directly through `sparse-checkout set --cone`; an
init-then-set sequence can remove files between steps. Git may delete ignored
files when excluding a directory. Refuse dirty/untracked work and any ignored
boundary the new cone would exclude; do not stash, clean or discard implicitly.
Use worktree-specific Git configuration and preserve external non-cone patterns
until the user explicitly disables them.
After the guard passes, refresh index stat data before changing the cone:
a clean file restored by an editor can otherwise be retained as "not up to
date". Keep Git's successful warnings visible when it retains files.

Partial-clone fixtures must actually omit objects (`rev-list --missing=print`).
A successful open is insufficient: historical content, diffs and blame need
Git's lazy object fetching; shallow blame needs Git's boundary semantics.
Keep those reads on demand. Recursive clone cancellation must terminate the
transport/submodule child processes too, because they hold the progress pipes.

Things we've learned while building Strand that aren't otherwise obvious from
the PRD / ROADMAP / TASKS files. Append here when you discover something
that future work (yours or another agent's) needs to respect.

---

## LFS files need Git's external clean/smudge filters (2026-09-06)

The real Git LFS fixture proved git2 `index.add_path` stored raw asset bytes
instead of the pointer produced by `git hash-object --path`. The historical
index-on-git2 policy has an LFS exception: detect `filter=lfs` attributes and
stage the complete batch with one literal, NUL-delimited Git pathspec input.
Enforce `filter.lfs.required` so missing tooling cannot silently store raw data.
Whole-file checkout/discard and hard reset use Git for LFS; partial patches are refused.
Ordinary status must not start LFS subprocesses. Management reads are explicit,
transcripts bounded, and cancellation must terminate LFS/submodule descendants
that otherwise keep pipes open. Tracking edits attributes, never history.

---

## Submodule removal must preserve ignored local data (2026-09-06)

Git's non-forced submodule deinit can remove ignored files, and a parent status
does not report ignored files inside nested modules. Before remove/deinit,
inspect ignored files and recorded commits in each initialized descendant;
refuse the action when local data remains. Keep this work at the explicit
mutation boundary. Nested browsing reads metadata one level/page at a time,
without adding recursive dirty scans to repository refreshes.

Opening a module from a dialog must go through `useWorkspaces.openRepoInActive`.
Calling `useRepo.openRepo` directly omits workspace membership, and the workspace
reconciler can immediately clear the active repository.

---

## Closeable tabs follow browser closing conventions

**Rule.** Every closeable repository or Work tab supports its visible close
control, Delete/Backspace while focused, and middle-click anywhere on the tab.
Handle middle-click through the existing close action so workspace membership,
terminal shutdown, active-tab fallback, and future confirmation rules remain
centralized.

**Why.** Repository pills, compact rail tiles, files, and terminals are
different presentations of the same tab interaction. Letting any surface omit
the browser-standard shortcut makes tab management feel unpredictable.

---

## Internal WebView drags use pointer state machines

**Rule.** For draggable UI owned by Strand, use a small mouse-movement
threshold plus window-level move/up listeners and geometry-based targets. Do
not depend on HTML5 `draggable` / `dragover` / `drop`. Keep per-frame cursor and
ghost movement imperative; update React state only when the semantic target
changes. For Work pane splitting, the nearest edge owns the outer 40% of the
pane; keep the center 20% for moving a tab into an existing pane.

**Why.** Tauri/WebView2 owns a native window drag/drop path for repository
folders. Browser drag events for internal tabs can consequently disappear
before reaching pane content, especially over separately layered terminal
renderers. Pointer coordinates remain available across those layers and let
the Work view resolve a leaf pane from its full rectangle, so edge splitting
works consistently. The Files tree uses the same pattern across Pierre's
shadow root.

---

## Resizable Work groups persist by split identity

**Rule.** Key each Work `PanelGroup` by the stable ID of its split node, not
by layout path or direction. A newly created split must start 50/50 so its
placed divider matches the drag preview; only that same split instance may
restore a user-resized ratio.

**Why.** Tree paths such as `root.0` are reused as panes are closed and split
again, and direction-only keys also collide across repositories. Reusing those
keys lets a fresh split inherit unrelated saved dimensions, making its divider
jump away from the half-pane preview when the tab is dropped.

---

## Live terminal renderers stay outside the Work pane tree

**Rule.** Work pane nesting and resize may change where a terminal is shown,
but must not change the React parent that owns its xterm renderer. Keep every
`TerminalPane` under the single process-wide runtime layer and position visible
renderers against measured pane-content rectangles. Pane tab membership is
state; renderer ownership is not. Dragging a terminal between panes must update
only that membership and active-pane state.

**Why.** Moving a terminal component between recursive `PanelGroup` branches
remounts its DOM, erasing xterm scrollback and selection even though the native
PTY remains alive. A stable renderer parent preserves that state across
right/down splits, empty-pane collapse, repository switches, and resize while
still letting only the pane-local active terminal receive input.

---

## Extend Pierre's file icons through the shared tree config

**Rule.** All `PierreTree` surfaces use `lib/treeIcons.ts`'s `TREE_ICONS`.
When a source type is missing from Pierre's built-in `complete` set, extend the
static custom SVG sprite and file-rule maps there; do not patch rows in the
shadow DOM or add per-view icon rules. Prefer selected raw SVGs from the pinned
`material-icon-theme` package over handwritten letter badges. Brand-colored
marks intentionally keep their own colors; the filename and status lane remain
the Git-state signals.

**Why.** Pierre resolves custom extension rules before its built-ins and
injects one custom sprite into its shadow root. A shared, module-level config
keeps every tree consistent and pays the parsing/setup cost only when the tree
model is created. Namespace source SVG IDs while converting them to symbols so
gradients and masks cannot collide inside the combined sprite.

---

## Keep Pierre search-row actions inside the shared wrapper

**Rule.** Place an action beside Pierre's built-in search through the React
`FileTree` header slot and `PierreTree`'s wrapper-owned shadow CSS. Install that
CSS when the model is created, then vary reserved width with an inherited host
custom property; `useFileTree` captures its option object once, so toggling an
`unsafeCSS` option later does not update the mounted model. Match the action's
outer box (for `.side-files-create`, content-box `--trees-row-height` plus its
1px pad and border) and reserve that width plus a 2px gap
(`SEARCH_ACTION_SPACE`). Always set `min-width: 0` on
`[data-file-tree-search-container]` and `[data-file-tree-search-input]` in that
same shadow CSS — reserved end padding alone is not enough.

**Why.** Rendering the action outside the tree adds an empty toolbar row. The
header slot keeps the control keyboard-accessible and in the tree's composition
contract, while the host variable lets working-tree and historical views change
the available search width without recreating Pierre's model or losing tree
selection and expansion. Flex items default to `min-width: auto`, and Pierre's
search `<input>` has a large intrinsic minimum, so a narrow Files pane used to
let the field refuse to shrink and paint under the create `+` even when end
padding matched the control (DAN-66).

---

## Desktop CLI children need the user's shell PATH, including dependencies

**Rule.** Packaged GUI apps must not use their inherited process `PATH` as the
only source for hosted-provider and AI CLIs. Resolve the user's interactive
login-shell PATH once, off the launch hot path, merge it ahead of inherited
fallback directories, and pass it explicitly to each child. Keep executable
lookup canonical and complete it before setting an untrusted repository as the
child's working directory.

**Why.** Finder/LaunchServices and Linux desktop launchers commonly omit
Homebrew, `~/.local/bin`, and version-manager directories. That made installed
`gh`, `codex`, and `claude` binaries appear missing in release builds. Resolving
only the launcher path is insufficient: npm shims commonly use
`#!/usr/bin/env node`, so the launched child also needs the recovered PATH or it
still fails at runtime. Searching after switching to a repository working
directory is unsafe on Windows because `CreateProcess` may select a
repository-owned executable.

**How to apply.** `strand-tauri/path_env.rs` owns the bounded, background shell
capture and conventional Homebrew/local-bin fallbacks when shell startup fails.
`ai/bin.rs::resolve_cli` treats blank custom overrides as unset, searches that
effective path, and `base_command` applies it to GitHub, Azure, Codex, and
Claude children. Reuse that boundary for new hosted-provider CLIs; do not add
ad hoc `which` calls or mutate the process environment after Tauri worker
threads have started.

---

## UI must be responsive and resizable

**Rule.** The app needs to feel responsive at any window size, and every
multi-pane layout in the app **must have resizable panes**.

**Why.** Strand is a desktop client people leave running for hours next to
their editor and terminal. Hard-coded pane widths force users to fight the
layout — they shrink the window or pop a long path into a tiny column and
lose work to ellipses. The PRD §8 performance bar and PRD §9 "good-looking
out of the box" goal both depend on the layout actually fitting the user's
screen, whatever that screen is.

**How to apply.**

- Every horizontal or vertical split between content panes uses
  `react-resizable-panels` (`<PanelGroup>`, `<Panel>`, `<PanelResizeHandle>`).
  Don't introduce fixed-width sidebars or `grid-template-columns: 200px 1fr`
  layouts for primary content regions.
- Give each `<PanelGroup>` a stable `autoSaveId` so the user's chosen sizes
  survive relaunch. Existing IDs: `strand:body`, `strand:lc-main`,
  `strand:lc-files`.
- Pick sensible `defaultSize` / `minSize` / `maxSize` so a panel can't be
  resized into uselessness. Sidebars: roughly 12–40%. Diff pane: never
  below 30% (Pierre needs room to render).
- Use the shared `.rs-handle.vert` / `.rs-handle.horiz` classes for resize
  handles so the hover/drag affordance is consistent everywhere. Keep their
  full 9px mouse target above pane content while the pseudo-element draws the
  thin visible rule. The negative margins deliberately overlap both panes, so
  dropping the handle's stacking layer lets surfaces—especially Work's stable
  embedded renderer—cover most or all of the draggable area.
- When adding a new pane: also check that its content reflows. Long file
  paths truncate (`text-overflow: ellipsis`), code lines wrap or scroll —
  never push the layout wider.
- Mobile / narrow widths are out of scope (PRD §2: no mobile), but the
  layout should still degrade gracefully on a laptop screen — nothing
  should require a 1600px viewport to be usable.

**Out of scope here.** This is about content panes. Native window chrome
(traffic lights, titlebar) and the topbar stay where they are.

---

## The app must be keyboard-operable

**Rule.** Almost every action in Strand must be reachable and operable
from the keyboard alone. "Keyboard-first, but never keyboard-only" (PRD
§2) cuts both ways: the mouse stays first-class, but a power user should
be able to drive the whole app without it. A small set of inherently
pointer-driven affordances (drag-to-reorder, drag-and-drop of a folder)
may stay mouse-only — but they're the rare exception, and whatever they
accomplish should also be achievable another way.

**Why.** Our primary persona is the CLI veteran (PRD §3) who judges the
app on whether they can stay on the home row. A feature that is only
clickable is, for that user, missing. Retrofitting keyboard support is
far more expensive than designing each surface with a focus model and a
shortcut from the start — the scattered "☐ keyboard nav" rows already in
TASKS.md are what skipping it looks like.

**How to apply.**

- Every new interactive surface ships with: a focus model (what's
  focused, with a visible focus ring from `tokens.css`), arrow/Tab
  navigation wherever a list or grid is involved, and Enter/Space to
  activate the focused item.
- Every action exposed as a menu item, button, or row should also be
  registered in the command palette (⌘K / Ctrl+K) so it's reachable by
  search even without a dedicated shortcut.
- Esc closes / dismisses, Enter confirms, and the focused element is
  always scrolled into view during keyboard navigation.
- Respect the cross-platform shortcut rule: ⌘ on macOS, Ctrl elsewhere
  (see AGENTS.md). Never hardcode one family.
- If a surface genuinely can't be made keyboard-operable, say so in the
  PR and leave a ☐ in TASKS.md — don't let a mouse-only action pass
  silently.

---

## Never mount every diff at once; bulk index ops go in one call

**Rule.** Two perf traps with large changesets (a squash-merge or a fresh repo
can stage hundreds of files):

1. **Don't mount a Pierre diff per file eagerly.** The "show all" Local Changes
   view stacks one `<HunkAnnotatedDiff/>` (a virtualized Pierre `<FileDiff/>`)
   per changed file. Mounting all of them on open froze the app for seconds.
   `FileDiffSection` now **viewport-lazy mounts** the body: an
   `IntersectionObserver` (~900px pre-roll) flips a `seen` flag the first time
   the block nears the viewport, and a height-estimated `.lc-file-pending`
   placeholder (`(adds+dels)*20`, clamped) reserves space until then so the
   scrollbar stays honest and far-off files aren't counted as near. Once mounted
   it stays mounted (mounting is the cost, not staying mounted). Any new
   multi-file diff surface must do the same — don't render N heavy diffs at once.

2. **Bulk index writes are one call, not N.** Staging/unstaging/discarding a set
   of files must go through `Repo::stage_paths` / `unstage_paths` /
   `discard_paths` (IPC `repo_stage_many` / `_unstage_many` / `_discard_many`),
   which open the repo and write the index **once**. The old store loop did one
   `repo_stage` IPC per file — each re-opened the repo and rewrote the whole
   index, so "Stage all" / "Unstage all" on a squash-merge's hundreds of files
   was hundreds of full index writes. `stageMany`/`unstageMany`/`discardMany`
   and `stageAll`/`unstageAll` all route through the batch path now.

**Why.** PRD §8 perf targets (status refresh < 200ms, diff render < 100ms) are
hard requirements, and "open a repo with a lot of changes" / "squash-merge" are
exactly the cases that blow them. Both fixes were prompted by a real freeze.

---

## A merge/rebase/cherry-pick conflict is an *outcome*, not an error

**Rule.** `git merge`/`rebase`/`cherry-pick`/`revert` exit **non-zero** when they
stop on a conflict — but that's the expected, useful result, not a failure.
`strand-core`'s history ops return `Result<bool>` (via `run_sequencer`):
`Ok(true)` = stopped on conflicts (index has unmerged entries —
`index.has_conflicts()`), `Ok(false)` = clean, `Err` = a *real* failure (dirty
tree, unrelated histories, merge commit without `-m`). The store actions return
that flag, and on `true` they switch to Local Changes with a cleared selection
so the conflict bar opens the first file. **Do not** let these reject on
conflict.

**Why.** The first cut rejected on the non-zero exit, so `MergeDialog` treated a
conflict as a failure: it kept the dialog open ("Merging…") and never routed to
the resolver — the exact "merge is frozen, doesn't open the resolve view" bug.
The distinction (conflict vs. real failure) has to be made where we can inspect
the index — in Rust — not by string-matching git's stderr in the UI.

**How to apply.** New sequencer-style ops go through `Repo::run_sequencer`
(maps a non-zero exit with unmerged entries to `Ok(true)`). UI callers
`await` the flag and toast/route on it; their `catch` is only for genuine
errors. Also: `run_git` here sets `stdin(Stdio::null())` — the app isn't
launched from a terminal, so an inherited stdin can hang git if it ever tries to
read; null makes it error instead.

---

## Conflict resolver is a custom 3-pane modal — we parse the markers ourselves

**Rule.** The merge-conflict UI is `views/MergeResolver.tsx`: a full-screen
modal with the incoming ("theirs") and current ("ours") files side by side on
top and the assembled result below, walked with a ‹ › conflict nav. We parse
the `<<<<<<< / ======= / >>>>>>>` markers ourselves (`lib/conflictParse.ts`)
and render each pane with Pierre's read-only `<File>` (`@pierre/diffs/react`),
highlighting the focused conflict via `selectedLines` (a single
`{start,end}` 1-based range). Resolution is **pick-sides only** (theirs / ours /
both per conflict); the result text is assembled from the picks, and "Resolve"
writes it back + stages via `useRepo.resolveConflict`.

**Why we didn't use Pierre's `<UnresolvedFile>`.** It exists and renders the
conflict regions, but (a) it's a single unified view, not the side-by-side
3-pane the user wanted, and (b) the React wrapper keeps the resolved file in
internal controlled state you can't read: its core supports
`onMergeConflictResolve(file)` but the wrapper always wires the mutually
exclusive `onMergeConflictAction` instead (the core `setOptions` throws if both
are set). Parsing markers ourselves sidesteps all of that and gives full
control over layout + the result text.

**Entry point + bulk.** Selecting a conflicted file shows an in-pane landing
(`views/ConflictLanding.tsx`) — tick a side to take it for the whole file, or
"Open merge editor" for the modal — and the first conflict auto-opens during a
merge (don't hide resolution behind a click). Conflicted files are filtered out
of the normal Unstaged/Staged lists. In the modal, each branch header has a
"take all from this side" checkbox whose checked state is *derived* from the
resolutions (`every` conflict includes that side; `both` includes both), and the
two source panes are scroll-synced (1:1 `scrollTop`/`scrollLeft` with a
`requestAnimationFrame` re-entrancy guard).

**How to apply.**
- `parseConflicts(text)` → segments (`common` | `conflict{ours,theirs}`);
  `buildViews(parsed, resolutions)` → `{theirsText, oursText, resultText,
  ranges}` where each `ConflictRange` carries the 0-based `[start,end)` span of
  that conflict in *each* view, so `toLineRange` feeds Pierre's `selectedLines`
  and `conflictAtLine` maps a `onLineClick` back to a conflict (click a side's
  block = take that side). In git's markers the first block (`<<<<<<< HEAD`) is
  *ours*, the block after `=======` is *theirs*.
- An unresolved conflict contributes one placeholder line to `resultText`; the
  result only loses every marker once all are resolved (`Resolve` gates on it).
- **Highlighting *all* conflict regions**: `<File>`'s `selectedLines` is a single
  range, so it only marks the focused conflict. For the rest, `HighlightLayer`
  measures the rendered gutter rows (each Pierre gutter cell carries a 0-based
  `data-line-index`) and paints a translucent, side-tinted absolute band over
  every non-focused conflict's line span — re-measuring on ResizeObserver (async
  highlight), scroll (virtualization), and window resize. **Pierre renders into
  an *open shadow root* on its `diffs-container` element** (`attachShadow({mode:
  'open'})`), so the gutter rows are NOT in the light DOM — query
  `el.querySelector('diffs-container')?.shadowRoot` (this was the bug: a
  light-DOM query found nothing, so only the focused conflict's `selectedLines`
  showed). `getBoundingClientRect` works across the shadow boundary. The band
  layer lives inside the (now `position: relative`) `.mm-pane-scroll` so it
  scrolls with the content.
- Conflicted files come from `status` (`status.rs` emits every
  `is_conflicted()` entry — they carry no wt/index bit so they'd otherwise be
  dropped); resolving = write + `git add` (`Repo::resolve_conflict`), and the
  op stays in progress (`meta.operation`) until the user commits.

---

## Shell-out helpers are per-module; don't add a second `Repo::run_git`

**Rule.** The "shell out to the user's `git`" modules each carry their own
subprocess helper, and they are deliberately *not* shared: `network.rs` has
`run_git_streaming` (free fn, streams stderr fragments), `stash.rs` has a
`Repo::run_git` **inherent method**, and `history.rs` has a module-private
free fn `run_git`. If you add another shell-out module (submodules, interactive
rebase, …) **do not** define another `fn run_git` as a `Repo` method — Rust
forbids two inherent methods with the same name on the same type across modules,
so it collides with `stash.rs` and won't compile. Use a module-local free
function `run_git(cwd: &Path, args: &[&str])` (the `history.rs` shape) instead.

**Why.** The collision error (`duplicate definitions for run_git`) points at
both modules and is easy to misread as a merge artifact. The duplication is
intentional: each helper differs (streaming vs. plain, conflict-aware
stdout+stderr combining vs. stderr-only) and keeping them self-contained matched
the existing pattern better than a forced shared abstraction.

**How to apply.** Shell-out policy is for ops where matching real `git`
behaviour matters more than staying pure-git2: **conflicts** (git leaves markers
+ the in-progress state on disk), **GPG/SSH signing**, and **hooks** — none of
which git2's `merge`/`cherrypick`/`revert` do for free, and git2 has no rebase
driver. Index operations still use git2; commit/amend always use system Git
(F01, 2026-09-06), including unsigned commits, so Git owns hook discovery,
rejection, message rewriting, merge parents and effective identity. No hook
existence shortcut: conditional/worktree config and installed hooks can change
between operations. Capture bounded stdout/stderr, preserve checkout drafts on
failure, and do not report post-success refresh errors as commit failures.
After any history op, the store refresh
tail is meta + local-changes + log + refs (`refreshAfterHistoryOp`), and a paused
op is detected via `Repo::operation_in_progress` reading `.git/` markers
(`rebase-merge`/`rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD`,
checked in that order) → surfaced as `RepoMeta.operation` + the `OpBanner`.

---

## A caught Tauri error is a `{ message }` object, not an `Error`

**Rule.** A `tauri::command` that returns `Err` rejects the JS `invoke` promise
with the **serialized error value**, not an `Error` instance. Our `CmdError` is
`#[derive(Serialize)] struct CmdError { message: String }`, so the caught value
is a plain object `{ message: "…" }`. Therefore `e instanceof Error` is **false**
and `String(e)` is **`"[object Object]"`**. Never extract a caught message with
`e instanceof Error ? e.message : String(e)` — use **`errMessage(e)`** from
`lib/tauri.ts` (handles `Error`, `string`, `{ message }`, then JSON-stringifies).

**Why.** Every error toast/banner that used the brittle ternary showed
`[object Object]` for any backend failure (a failed clone/checkout/stash/merge/
tag-push…), hiding the actual git reason — reported in the wild on a clone that
ran out of disk space. The whole codebase was swept to `errMessage` once.

**Related.** The streaming network ops (`run_git_streaming` in
`crates/strand-core/src/network.rs`) also condense a *failed* git transcript to
its `fatal:`/`error:` lines via `error_summary` — git streams progress to stderr
too, so returning the whole thing buries the cause ("Cloning into…" shows, not
"Out of diskspace"). New shell-out error paths should do the same.

---

## `tauri-plugin-sql` `:default` doesn't include writes

`sql:default` only grants `allow-close`, `allow-load`, `allow-select`.
**`INSERT`/`UPDATE`/`DELETE` (and any `Database.execute` call) are blocked
unless you also list `sql:allow-execute`** in
`crates/strand-tauri/capabilities/default.json`.

The failure mode is brutal: reads work, schema migrations run, the DB
file is created — but every write throws from the frontend. We caught
those errors with `console.warn`, so the only visible symptom was
"recents and session tabs are always empty across launches."

**How to apply.** Every Tauri plugin uses the same `:default` pattern. If
you wire a new plugin and writes seem to no-op, the first thing to check
is whether the corresponding `allow-execute` (or equivalent write
permission) is in the capabilities list. Plugin default permissions live
in `~/.cargo/registry/src/index.crates.io-*/tauri-plugin-<name>-<version>/permissions/default.toml`
— read them when you grant `<plugin>:default` and confirm the verbs you
need are covered.

### Gotcha: `react-resizable-panels` height plumbing

Two related traps. Both end in "the panel collapses, the pinned bottom bar
floats in the middle of the screen." Verify visually after touching any
PanelGroup site.

**1. Wrap `<PanelGroup>` in a flex-item div.** `<PanelGroup>` writes its
own inline `width: 100%; height: 100%; display: flex; overflow: hidden`.
Putting `className="flex-1-thing"` directly on the group doesn't work —
the inline `height: 100%` competes with `flex-basis`, the group computes
to content height, and siblings collapse.

```tsx
<div className="lc-main">           {/* flex: 1; min-height: 0 — owns layout */}
  <PanelGroup direction="horizontal" autoSaveId="…">
    …
  </PanelGroup>
</div>
```

**2. Panel children need `height: 100%`, not just `flex: 1`.** The library's
`<Panel>` is `display: block` for its content slot — flex rules from the
ancestor don't propagate through it. A child like `.main` that says
`flex: 1` only ends up `flex: 1` *within its own children*, not within
the Panel. Always pair `flex: 1` with `height: 100%` on content that
lives inside a Panel:

```css
.main {
  flex: 1;       /* works when used directly in a flex parent */
  height: 100%;  /* works when used inside a Panel — required */
}
```

Existing sites: `.body`, `.lc-main`, `.lc-files`, `.main`, `.sidebar`.
Copy the pattern when adding a new resizable region.

---

## Pierre per-block controls go through `lineAnnotations`, not a render slot

**Rule.** `@pierre/diffs` ships `diffAcceptRejectHunk(diff, i, opts)` as
a *patch math* helper — it rewrites a `FileDiffMetadata` after a hunk
is accepted/rejected. The React components (`<PatchDiff/>`,
`<FileDiff/>`) do **not** expose a per-hunk render slot. The only
explicit render props on `DiffBasePropsReact` are file-header
(`renderCustomHeader`, `renderHeaderPrefix`, `renderHeaderMetadata`),
gutter (`renderGutterUtility`), `renderAnnotation`, and merge-conflict
actions. There's a `getHunkSeparatorSlotName` constant, but `PatchDiff`
never hydrates anything against it.

**Why.** Don't waste another session grepping Pierre for a hunk-level
render hook that isn't there. The diffs.com docs page describing
`diffAcceptRejectHunk` can mislead you — that API is for client-side
diff *state* mutation, not UI placement.

**How to apply.** For per-change-block controls (Stage, Discard,
Unstage, comment, annotate), use `<FileDiff/>` with `lineAnnotations`,
one annotation per `ChangeContent`. The annotation slot Pierre injects
is anchored to a *column* (additions or deletions side), so a slotted
button drifts horizontally per block — render an invisible marker in
`renderAnnotation` and float a real button in a sibling overlay layer
that measures the marker's Y with `getBoundingClientRect`. Pin the
overlay slot to the diff's right edge for consistent X. Use Pierre's
`options.onLineEnter` (`OnDiffLineEnterLeaveProps`) to map
`(lineNumber, annotationSide)` → block id and update a `hovered`
state; feed the block's `SelectedLineRange` into the
`selectedLines` prop so Pierre tints the affected lines using its
built-in selection background. `DiffAcceptRejectHunkConfig.changeIndex`
indexes `hunk.hunkContent[]` (the mixed context + change array), not a
change-only ordinal — keep that contract when slicing patches.

The canonical site is `HunkAnnotatedDiff` in
`ui/src/views/LocalChanges.tsx`; patch slicing for sub-hunk apply is
`sliceChangeBlock` in `ui/src/lib/patch.ts`. Reverse-apply (the
Discard/Unstage path) is still done on the Rust side by `reverse_patch`
in `crates/strand-core/src/apply.rs` — `git2`'s `ApplyOptions` has no
reverse flag, so we swap `+`/`-` and `@@ -A,B +C,D @@` ourselves.

**Line-selection ownership.** Pierre's native interaction manager can see a
pointer event on an absolutely positioned React overlay before React's bubble-
phase `stopPropagation`, and controlled `selectedLines` changes may re-emit the
previous range through `onLineSelected`. Overlay controls must stop pointer
events in capture phase. A separate checkbox picker must explicitly clear the
inherited range when it opens and ignore Pierre selection callbacks while the
picker owns selection, or cleared lines can silently re-check on the next Tab.
`HunkAnnotatedDiff` uses `linePickerOpenRef` for this boundary; keep the options
callback stable so the diff is not re-virtualized during selection.

---

## `@pierre/trees` couples row-click to select **and** expand

**Rule.** A plain click on a directory row in `@pierre/trees` always does
two things at once: single-select the row *and* toggle its expansion
(`computeFileTreeRowClickPlan` → `toggleDirectory: !hasModifier && isDirectory`).
The chevron is not a separate hit target — the whole row, chevron
included, runs the one `handleRowClick`. There is **no option** to disable
the toggle or to make only the chevron toggle (`FileTreeOptions` /
`FileTreeRenderOptions` expose nothing for it), and the click is handled
inside Pierre's shadow DOM.

**Why.** We needed a folder click in Local Changes to *select* the folder
(which drives the stacked aggregated diff) without folding the tree. Don't
go looking for a Pierre prop — it isn't there.

**How to apply.** `PierreTree` takes `toggleDirOnRowClick` (default `true`
= Pierre's native behaviour). When `false`, an `onClickCapture` on the host
records the folder's expansion *before* Pierre handles the click (React's
capture phase fires before Pierre's bubble-phase preact handler), then a
`queueMicrotask` restores that expansion — neutralizing the toggle with no
flicker (microtasks drain before the next paint), while leaving Pierre's
selection/focus/multi-select untouched. The disclosure cell is
`[data-item-section="icon"]` on a `[data-item-type="folder"]` row; clicks
there are let through so the chevron still toggles. The same chevron check
guards `onDoubleClick` so a double-toggle doesn't fire the stage/unstage
`onActivate`.

Note: "expand/collapse all" in Local Changes operates on the **diff pane**
(folding each file's diff body), not on the tree's folders — the header
toolbar toggle writes `useSettings.diffsCollapsed` and each `FileDiffSection`
header folds its own body. There is intentionally no folder expand/collapse-all.

**Keyboard ownership.** Pierre also consumes printable keys inside its shadow
tree for typeahead and marks those events `defaultPrevented`. Surface-local
shortcuts that must work while a tree row owns focus need a capture-phase
listener and must stop propagation only after they accept the key. A bubbling
listener that first rejects `defaultPrevented` events silently loses shortcuts
such as Local Changes' folder `d d` discard even though selection and target
expansion are correct.

---

## Sidebar leaf rows: single-click reveals, double-click activates

**Rule.** `SideLeaf` in `ui/src/components/Sidebar.tsx` (branches, remote
branches, tags, stashes) runs its *primary* action — checkout / create
tracking branch / checkout tag / apply stash — on **double-click** (`onActivate`),
not single-click. A single click runs `onSelect`, which for refs calls
`revealInGraph(target)`: it switches to the All Commits view and scrolls to +
highlights that ref's tip commit. Stashes have no `onSelect` (single click is a
no-op for them).

**Why.** Single-click checkout was too easy to trigger by accident, and users
wanted a click to just *show* where a branch is in the graph. Keyboard parity
is kept via Enter/Space = `onActivate` (the primary action), since there is no
keyboard double-click.

**How to apply.** The reveal is a transient store signal: `revealInGraph(hash)`
sets `view:'commits'` + `revealCommit`, and `Commits.tsx` consumes it in an
effect (sets `focusedCommit`, which drives the existing `scrollIntoView`), then
calls `clearReveal()`. The effect waits for `commits.length > 0` so a view
switch (empty graph for a beat) does not drop the request. If the tip commit
is outside the loaded log window, the view still switches but nothing scrolls.

---

## Branch / remote sidebar presentation

**Rule.** In `ui/src/components/Sidebar.tsx`: local branches render **flat
with their full name** (`feat/foo`, no `feat/` folder nesting). Remote branches
group **one level** under their remote (`origin`, shown with the `remote` globe
icon, no child count) and then list flat (`feat/foo`). Tags still split on `/`
into folders. The current branch is marked by an **accent `check` icon + bold
label, with no selection-fill** — the filled `--bg-sel` bar stays reserved for
the primary rows (Local Changes / All Commits). Upstream drift renders as a
green `N↑` (`--add`) and red `N↓` (`--del`); a branch in sync with its upstream
shows **nothing** (no fallback to the upstream name).

**Why.** Matches the agreed sidebar design: flat names read faster than deep
folder trees for the common case, and a checkmark is a clearer "you are here"
than a highlight bar that collides with the selection affordance.

**How to apply.** `branchTree` builds with `(b) => [b.name]` (single segment);
`remoteTree` with `(rb) => [rb.remote, rb.branch]`. `SideLeaf` takes numeric
`ahead`/`behind` props (colored spans) instead of a packed `meta` string;
`meta` remains for tags/stashes. `FolderRow` takes an `icon` (default `folder`)
and an optional `count` (omit to hide). The REMOTES section count is
`refs.remotes.length` (remotes), not the remote-branch count.

---

## UI fonts are self-hosted — keep the CDN off the cold-start path

**Rule.** Strand ships its own font files. `ui/index.html` references
`/fonts/fonts.css` (generated, under `ui/public/fonts/`); it must **not** pull
from `fonts.googleapis.com` / `fonts.gstatic.com` or any other remote.

**Why.** A local-first desktop git client that fetches its typeface from a CDN
loses its typography offline or behind a firewall, and `display=swap` reflows
(FOUT) on every cold start — both hit the PRD §8 cold-start budget and the
"works without a network" expectation.

**How to apply.** `ui/public/fonts/fonts.css` mirrors Google's exact
`@font-face` blocks for the **latin + latin-ext** subsets only (cyrillic/greek/
vietnamese are dropped — this is an English-language dev tool), with `src`
rewritten to local `/fonts/*.woff2`. The embedded terminal is the deliberate
exception: its `JetBrains Mono Terminal` variable faces must remain complete
because terminal TUIs depend on box-drawing and block glyphs outside the Latin
subsets. Files in `ui/public/` are copied to `dist` verbatim by Vite and served
at the root. To add/refresh a family: fetch the
Google CSS with a modern-browser UA, keep only the latin/latin-ext blocks,
download those woff2 (via `curl` — system CA), rewrite `src`, and commit the
binaries (they're not git-ignored; `dist/` is). The user font picker
(`settings.ts`) must only offer families that are actually bundled, or picking
one breaks offline.

---

## Git shell-outs prepend `GIT_SAFE_CONFIG`; conflict paths are canonicalized

**Rule.** Every shell-out to the user's `git` (the per-module `run_git*`
helpers in `network.rs`, `history.rs`, `stash.rs`) prepends
`crate::GIT_SAFE_CONFIG` (`-c core.fsmonitor= -c core.pager=cat`) **before** the
subcommand. A new shell-out module does the same.

**Why.** Opening an untrusted repo is a real flow (P0 "add existing / open
recent"). A repo-local `.git/config` key like `core.fsmonitor=/path/to/prog`
runs that program as a side effect of an internal git step — a *silent* RCE
(empirically reproduced on `git status`/`fetch`). git2/gix don't honor
fsmonitor's exec, so only the shell-out paths are exposed. `GIT_SAFE_CONFIG`
(command-line `-c` wins over repo config) neutralizes it.

**Do not** clear `core.sshCommand`, `credential.helper`, `GIT_ASKPASS`/
`SSH_ASKPASS`, or the SSH passphrase prompt — those are how the user
authenticates (see the `network` module docs). Hooks remain the same accepted,
git-equal trust boundary (PRD §10); we don't sandbox them. `GIT_SAFE_CONFIG` is
a single `pub(crate)` const in `lib.rs` (one source of truth) even though the
`run_git*` helpers themselves stay per-module — see the per-module helper rule
above.

**Conflict file I/O** (`conflict.rs`) resolves a relative path against the
working tree, but the `..`/absolute lexical check isn't enough: an in-tree
**symlink** (`link/target` where `link` → outside) escapes it with no `..`. So
`workdir_path` also `canonicalize()`s (the parent dir, for a not-yet-created
file) and requires the result to stay under the canonical working tree.

---

## The command palette is a combobox/listbox — add actions, don't re-skin it

**Rule.** `views/Palette.tsx` is a `role=combobox` text input driving a
`role=listbox` of `role=option` rows via `aria-activedescendant`. **Focus never
leaves the input** — Arrow keys move a `sel` index (the option gets
`aria-selected`, the input's `aria-activedescendant` points at its id), Enter
runs `items[sel]`, and **Tab / Shift+Tab cycle the scope pills** (the input owns
Tab, so it's never a focus trap). Results are grouped by `PaletteAction.group`
under `role=group` section headers, scored by `match()` (contiguous-substring >
subsequence > keyword, word-boundary bonus, inline `.hl` highlight), and **capped
per group** (`CAP_PER_GROUP` / `CAP_SCOPED`) so a huge repo never renders
thousands of rows. The candidate list is assembled in `App.tsx` (`repoActions` +
`paletteActions`); repo-data groups (branches/tags/files/commits) are built
**only while `paletteOpen`**, and the file group pulls `workTree` lazily on open
(`refreshTree`, keyed on `activePath`).

**Why.** The design tokens (`.palette-scope .pill`, `.palette-sect`,
`.palette-item .meta`, `.label .hl`) were already there for exactly this — the
substring-over-static-commands version was a stub. The a11y wiring (combobox +
activedescendant, `aria-live` count, spoken `metaLabel`, focus-restore) is the
project's keyboard-first contract on its marquee surface; the first cut shipped
none of it and a 4-dimension review flagged each gap.

**How to apply.**
- **Add a command** = push a `PaletteAction` (`{id,label,group,run, keywords?,
  meta?, metaLabel?, icon?}`) in `App.tsx`. Pick the right `group`; the scope
  pill set is derived from the groups present, so a new group needs nothing else.
- **Opaque metas need a `metaLabel`** (spoken form): `"M"`→`"modified"`,
  `"↑2 ↓1"`→`"2 ahead, 1 behind"`. The visible `meta` is `aria-hidden`; the
  option's accessible name is `label + ", " + (metaLabel ?? meta)`.
- **Restore focus to the opener.** `openerRef` is captured on the component's
  *first render* (`if (openerRef.current === null) openerRef.current =
  document.activeElement`), **before** the input's `autoFocus` runs, then
  re-focused on unmount. The mount-effect pattern the other dialogs use captures
  the input instead (autoFocus already fired by the time a passive effect runs);
  for a surface whose own input autofocuses, capture during render.
- Scope pills are toggle buttons (`role=group` + `aria-pressed`), **not**
  `role=tab` — there are no tab panels, and the codebase models toggles with
  `aria-pressed` everywhere else.

---

## `createBranch` start point must be a branch *shorthand*, not a full ref

**Rule.** To create a local branch that auto-tracks a remote (the `git checkout
-b foo origin/foo` flow), pass `createBranch(localName, "origin/foo", true)` —
the **shorthand** `origin/foo` (`RemoteBranch.name`), never the full ref
`refs/remotes/origin/foo` (`RemoteBranch.full_name`).

**Why.** `Repo::create_branch` (`crates/strand-core/src/branch.rs`) resolves the
start point with `revparse_single` (which accepts *either* form, so the branch is
still created + checked out) but only wires the upstream when
`repo.find_branch(rev, BranchType::Remote)` succeeds — and git2's `find_branch`
with `BranchType::Remote` accepts **only the shorthand**. Pass the full ref and
you silently get an untracked local branch (push/pull defaults break), with no
error. Every correct call site (Topbar, Sidebar) uses `rb.name`; the command
palette regressed by passing `rb.full_name` and a review caught it.

---

## Commit-graph search highlights, never filters — lanes depend on it

**Rule.** Search in the All Commits view (`ui/src/views/Commits.tsx`) **must not
remove rows from the list.** It highlights matches in place (a `.match` wash +
accent-bolded substring) and steps through them with ‹/›. Do not "filter the
graph to matches."

**Why.** `lib/graph.ts` assigns lanes in a single top-down pass that assumes the
list is a complete, topologically-sorted history — every commit's parent is still
somewhere below it. Drop the non-matching rows and a parent can vanish from under
its child, so lanes connect to nothing and the SVG is garbage. This is *the*
reason the search box shipped `disabled` for months; highlighting sidesteps it
because the row set never changes.

**How to apply.**
- Message/Author/Hash matching is **client-side over the loaded log**
  (`commitMatches`) — instant, no backend, but only the loaded window (~500), and
  no content search.
- The current match is **derived from `focusedCommit`** (`matches.indexOf`), not a
  separate counter — keeps the N/M readout and ‹/› in sync for free. Stepping
  `setFocusedCommit`s the row (the existing effect scrolls it in) while DOM focus
  stays in the input.
- Reachable from the keyboard: `/` focuses the field, ⌘K "Search commits…" via a
  one-shot `commitSearchFocus` store signal (modeled on `revealCommit`).
- **Future `-G`/`-S` content search or full-history search** needs a `git
  log`-backed `Repo` command (can't be client-side). If you add it, prefer a
  *flat results mode* (no lanes drawn) over filtering the graph — same conclusion,
  arrived at differently: when you're showing a subset, don't pretend it's a graph.

---

## Interactive rebase drives `git rebase -i` with no editor; rebase resumes via `--continue`, never a commit

**Rule.** `Repo::interactive_rebase` (`history.rs`) runs real `git rebase -i` but
never lets an editor open — the plan is precomputed in the UI
(`views/RebaseEditor.tsx`) and fed in non-interactively:

- **Sequence editor:** git launches the configured editor through *its own shell*
  as `sh -c '<editor> "<todofile>"'` (on every platform — Git-for-Windows uses its
  bundled sh). So set `GIT_SEQUENCE_EDITOR=cat "$STRAND_REBASE_PLAN" >`: the trailing
  `>` plus git's appended `"<todofile>"` becomes a redirect that overwrites the todo
  with our plan. The plan path travels in the `STRAND_REBASE_PLAN` env var (sh
  expands it), so there's **no helper script and no path quoting** — and pass the
  path forward-slashed (`sh_path`) so Windows backslashes don't break inside sh.
- **Message editor:** force `GIT_EDITOR=true` for the whole run. `squash` then keeps
  git's default combined message (all subjects concatenated) — no message UI needed.
- **Reword:** don't use a `reword` todo line (it would invoke the editor and you'd
  have to sequence which message goes where). Emit `pick <oid>` + `exec git <safe>
  commit --amend --no-edit -F <msgfile>` instead — the new message maps to the right
  commit by construction, still editor-free. (`<safe>` = `GIT_SAFE_CONFIG` joined,
  because the `exec`'d git is a fresh process that could otherwise re-trigger
  fsmonitor.)
- **Drop** = omit the line. Reject an all-drop plan (git aborts on an empty todo).

**Why `continue` had to come along.** There was only `--abort`; the `OpBanner` told
users to "resolve conflicts and commit." That's wrong for rebase — a paused rebase
**only advances via `git rebase --continue`**, not a commit (committing mid-rebase
just adds a stray commit). So `Repo::continue_operation` detects the live op from the
same `.git/` markers as `abort_operation` and runs the matching `--continue` with
`GIT_EDITOR=true`; the banner gained a **Continue** button gated until no
`CONFLICTED` files remain. This fixed the latent gap for plain rebase too.

**How to apply.** Reuse the conflict-aware mapping (`run_sequencer_env` → `Ok(true)`
when the index has unmerged entries, so conflicts route to Local Changes like every
other history op — see the conflict-is-an-outcome learning). The editable range comes
from `Repo::rebase_todo(base)` (a `git log --reverse base..HEAD`, base validated as a
HEAD ancestor) — **not** the loaded graph, which spans all refs and isn't linear.
Out of v1 and tracked in TASKS: `edit` (pause-to-amend, needs an amend-during-rebase
state machine on top of continue) and `--rebase-merges` (v1 flattens merges; the
editor warns when the range has any).

---

## Watcher events filter on .git internals, not just the workdir

**Rule.** The working-tree watcher (`strand-core/src/watch.rs`) must treat a
small allowlist of `.git` entries as refresh-worthy — `HEAD`, `index`,
`packed-refs`, `refs/`, and the in-progress-op markers — and ignore everything
else under `.git` (objects, logs, `*.lock`, `FETCH_HEAD`, `COMMIT_EDITMSG`).
Watch the whole workdir recursively; debounce trailing (fire only after a
quiet period), never leading.

**Why.** An agent's `git add`/`git commit` from a terminal changes the index
and refs *without* touching tracked files, so a workdir-only filter misses
exactly the events the review workflow exists for. Conversely, git's atomic
writes churn `*.lock` and `.git/objects` constantly — refresh on those and
every commit double- or triple-fires. The trailing debounce is what collapses
an agent's multi-file write burst into one ~90ms snapshot refresh.

**How to apply.** New repo-state files (e.g. `MERGE_MSG`-driven features)
that should trigger a repaint must be added to `relevant_path` explicitly —
and tested in `watch.rs`'s table tests. The watch is `.gitignore`-blind by
design (documented tradeoff); revisit only if build storms show up in perf.

---

## Keep palette/parse logic in lib/ — view modules can't be unit-tested

**Rule.** Pure logic (scoring, parsing, slicing) lives in `ui/src/lib/`, not
in view modules. Views may import lib, never the reverse. Tests import lib
modules only.

**Why.** Importing any `views/*.tsx` into a Vitest node run drags in
`stores/settings`, which touches `window` at module-init
(`detectPlatform`) — the suite dies on `ReferenceError: window is not
defined` before a single test runs. The palette's fuzzy scorer had to move to
`lib/fuzzy.ts` for exactly this. A jsdom environment would paper over it at
the cost of slower tests and a false sense that view modules are import-safe.

**How to apply.** When a view grows a testable pure function, extract it to
`lib/` immediately (the function, not the component). Vitest is pinned to a
major that supports the workspace's Vite (vitest 2.x ↔ vite 5 — the latest
vitest requires vite 6+ and will not run here).

---

## Virtualized rows: the row-height constant must track the CSS

**Rule.** The commit graph table renders only a viewport slice with spacer
rows; the math reads `ROW_PX` in `views/Commits.tsx`, which **must** equal
`.graph-table tbody tr { height: var(--row-h) }` in `features.css` (compact 22 /
default 26 / relaxed 32). `CommitGraphCell` takes the same `rowH` for its
viewBox so lane geometry does not distort.
Change one → change both. Blame's virtual list has the same coupling (18px).

**Why.** A drifted constant doesn't crash — it makes the scrollbar lie and
rows land under the wrong mouse position, which reads as "selection is
flaky" and is miserable to bisect. Focus/reveal jumps also fall back to
index × rowH math when the target row isn't mounted (`scrollIntoView` can't
reach an unmounted row), so the constant is correctness, not just layout.

---

## Dialogs go through `Dialog`; empties and pane heads share one shell

**Rule.** New modals use `components/Dialog.tsx` (shared Tab trap including
`select`/`textarea`, Esc blocked while busy unless `blockEscapeWhileBusy` is
false, focus restore). New empty/loading copy uses `EmptyState` (`compact` in
tree panes). New main-pane toolbars use `PaneHeader` or the `.pane-head`
height token. Diff stacked/split maps through `toPierreLayout` /
`DiffLayoutToggle` — do not reimplement the toggle in a file header.
Transient success/error toasts go through `onToast` → `ToastViewport`; only
in-place arm-to-confirm gestures (double-tap discard) may render a local
`.toast`. PierreTree row height is `--trees-row-height: var(--row-h)`.

**Why.** The 2026-09-01 UI audit found 26 hand-rolled traps, five header
heights, and two toast looks. The primitives exist so the next surface does
not invent a sixth.

---

## Diff appearance settings flow through one helper — and never into MergeResolver

**Rule.** User-facing diff appearance (change indicators, line numbers,
word-level highlight) is computed by `diffAppearanceOptions()` in
`components/Diff.tsx` and consumed by exactly two call sites: the `Diff`
wrapper and LocalChanges' `fileDiffOptions` memo (where the three settings
must stay **inside the existing `useMemo` deps** — an unstable options object
forces Pierre re-virtualization and the documented scroll-snap bug).
`MergeResolver` keeps its own pinned options and must NOT adopt them.

**Why.** MergeResolver's `HighlightLayer` measures gutter rows inside
Pierre's shadow root; `disableLineNumbers` removes the gutter and silently
breaks conflict-range highlighting. The single helper exists so the real
panes and the Settings → Diff live preview can't drift apart.

**How to apply.** A new diff appearance setting = one field in
`stores/settings.ts`, one line in `diffAppearanceOptions()`, a control in
`views/settings/DiffSection.tsx`, and the field added to LocalChanges' memo
deps. The diff *font* is different: Pierre reads the `--diffs-font-family`
CSS custom property (custom properties pierce shadow DOM), set on `<html>`
in App's font effect — no Pierre option involved.

---

## External app launches: tokenize the template before substituting

**Rule.** Editor/terminal command templates (`code -g {file}:{line}`) are
launched by `strand-core::external::build_argv`, which splits the template
into argv tokens **first** and substitutes `{file}`/`{line}`/`{dir}` inside
tokens **afterwards**, then spawns directly (never via a shell). File paths
additionally pass the `workdir_path` traversal/symlink guard.

**Why.** The template is the user's own setting (same trust as git's
`merge.tool`), but `{file}` is repo content — a path like
`a'; rm -rf /;'b.txt` must stay a single argv element. Substituting before
tokenizing (or going through a shell) turns a hostile filename into command
injection.

**How to apply.** New placeholders or launch surfaces go through
`build_argv` + `spawn_detached`; never `format!` a command string. Presets
live in `ui/src/lib/integrations.ts` per OS — macOS editor presets use CLI
shims (`code`, `zed`…) because `open -a` can't pass file:line; Windows names
`code.cmd` explicitly (std `Command` doesn't apply PATHEXT). The Windows VS
Code and Windows Terminal presets were verified from the exact built app on
2026-07-18. Linux presets still require real GNOME/KDE candidates (tracked ☐
in TASKS).

---

## Native-menu accelerator ownership is platform-specific

**Rule.** Install the shared native menu on every desktop target, but skip a
menu-owned global shortcut in App's window keydown handler only when
`nativeMenuPreemptsKeydown()` is true. That is macOS/AppKit. Windows/Linux must
keep the webview keydown path even though their native window menu displays the
same accelerator and invokes the same callback when selected.

**Why.** AppKit dispatches menu key equivalents through
`performKeyEquivalent` *before* the webview receives the keydown — the menu
action fires and the JS handler usually never sees the key. "Usually" is the
trap: relying on that ordering invites double-fire bugs if dispatch changes
(or the menu fails to install), and a dead shortcut if you remove the JS
path entirely. The explicit `nativeMenuPreemptsKeydown()` gate makes handling
single-fire deterministically. A 2026-07-18 Computer pass proved why the gate
cannot mean merely "menu installed": Windows rendered the menu and its Ctrl
labels but needed the webview path for Ctrl+K/Ctrl+, to fire.

**How to apply.** Menu accelerators use muda syntax (`Cmd+Comma`, `Cmd+1`,
`CmdOrControl+Shift+S` — `Comma` and digits also parse). Menu permissions need no
capability change: `core:default` already includes `core:menu:default`,
which allows all menu commands including `set-as-app-menu`. Repo-scoped
items take `enabled: hasRepo`; App reinstalls the menu when that flips
(menu handlers read the latest callbacks through a ref, so no rebuild per
render). Keep macOS-only predefined items (Services/Hide/Hide Others/Show All)
conditional; the same `Menu` becomes a global menubar on macOS and a window
menu on Windows/Linux.

**Update (2026-06-15): accelerators come from the keybinding registry, not
literals.** Global shortcuts now live in a single registry — `lib/keys.ts`,
`COMMANDS` — resolved against the user's overrides (`settings.keybindings`) by
`resolveBindings`. `lib/menu.ts` no longer hardcodes `accelerator:` strings; its
`item()` helper takes a `cmd: CommandId` and looks the accelerator up through an
`accel` resolver App passes in (`toMudaAccelerator(resolved)`), so a shortcut the
user remaps in Settings → Keyboard updates the menu too — App's menu effect now
deps on `keyMap` and reinstalls on change. The window keydown handler is also
registry-driven: it computes `eventToBinding(e)`, looks up the command, and still
defers to the native menu for menu-owned, representable combos
(`nativeMenuPreemptsKeydown() && MENU_COMMANDS.has(cmd) && toMudaAccelerator(binding)`).
See the keybinding-registry learning below.

---

## Pierre tree rows only repaint on data pushes — decoration changes need a key bump

**Rule.** `PierreTree`'s `rowDecoration` callback (the per-row badge lane,
e.g. the Review view's reviewed ✓) is read through a ref, so the *values* are
always fresh — but Pierre only re-renders rows when data is pushed into the
model. Any state that feeds `rowDecoration` must also be fingerprinted into
`rowDecorationKey`, or the badges go stale on screen.

**Why.** `@pierre/trees` renders into a shadow root outside React; props
changing on our wrapper doesn't reach it. The wrapper repaints rows by
calling `model.setGitStatus(...)` (which unconditionally re-renders the row
tree) when `pathsKey` / `statusKey` / `rowDecorationKey` change. A decoration
callback whose inputs aren't in the key silently skips that path.

**How to apply.** Build `rowDecorationKey` from exactly the state the
callback reads (e.g. `pool.map(d => `${d.path}:${verdict}`).join('|')`).
Same pattern applies to any future per-row state we surface through the
decoration lane.

---

## Pierre diffs highlight on the main thread unless the worker pool is mounted

**Rule.** Every diff surface must run under `DiffWorkerPool`
(`components/DiffWorkerPool.tsx`, mounted at the root in `main.tsx`), and any
parsed patch handed to Pierre must carry a `cacheKey` — use
`parseCacheablePatch` (`components/Diff.tsx`), never raw `getSingularPatch`,
and never `PatchDiff` with a patch string when the diff can be large.

**Why.** Without a `WorkerPoolContextProvider`, `@pierre/diffs` tokenizes
with Shiki synchronously on the main thread at mount — fine for hunk-sized
patches, a per-keystroke stall for the Review view's whole-file patches.
Without a `cacheKey`, the pool's highlight LRU never hits (it keys solely on
`diff.cacheKey`, which Pierre's own patch parsing leaves unset), so every
remount re-tokenizes.

**How to apply.** Pool render options (theme, `lineDiffType`,
`tokenizeMaxLineLength`) are *global* while a pool is active — per-instance
options are ignored for tokenization. Theme is registered dual
(pierre-dark + pierre-light), so theme flips don't re-highlight. Every mounted
Pierre diff must still pass the resolved app theme as `themeType` (use
`pierreThemeOptions()`); passing only `theme` is ignored by the active pool and
falls back to Pierre's OS color-scheme, which is wrong when Strand explicitly
overrides the OS theme. Settings
that affect tokenization must be pushed via `pool.setRenderOptions(...)`
(see `RenderOptionsSync`). The pool self-heals after `terminate()` (Strict
Mode's dev double-mount), re-initializing on the next task. Vite needs
`worker: { format: 'es' }` because the worker code-splits a lazy wasm chunk.

---

## Pierre's VirtualizedFileDiff pins its first fileDiff — key it to swap content

**Rule.** Any Pierre diff component rendered inside a `<Virtualizer>` must
get a React `key` derived from the content it shows (we use
`path:contentHash`). Swapping the `patch`/`fileDiff` prop on a mounted
instance silently renders the old file.

**Why.** `VirtualizedFileDiff.render` assigns `this.fileDiff ??= fileDiff` —
nullish-assign — so the first diff wins for the life of the instance. The
non-virtualized `FileDiff` path re-reads the prop, which masks the bug until
virtualization is enabled (Review's diff pane, and Local Changes since
2026-07-06). Also reset the scroll container to the top on swap: the
virtualizer keeps the previous file's offset, and a deep offset into a short
file shows an empty window.

**How to apply.** A single `<Virtualizer>` can host a *stack* of files, not
just one — every `<PierreFileDiff>` under it auto-registers through context
(`useFileDiffInstance` → `useVirtualizer`) and windows its own rows. That's
how Local Changes' stacked `DiffPane` virtualizes: wrap the map in one
`<Virtualizer className="lc-diff-scroll">`, key each file's diff by
`hashFileDiff(diff)` (the pinning rule above — staging a block changes the
patch, and the instance must remount to show it), and keep any per-file
viewport-lazy mount gate you already have (it bounds *instances* while the
virtualizer bounds *rows* per instance). One more consequence: a ⌘F / jump to
an off-screen line can't `findRow` it (virtualized rows past the window aren't
in the DOM), so `scrollToDiffLine` needs `{patch, layout}` to seek
proportionally first — but only when the pane shows a single file (selecting
the match narrows Local Changes to one file, so its scroll maps 1:1). The
per-block action *overlay* markers are **not** virtualized — they live in
Pierre's light DOM, so all of them render regardless; that's cheap next to
highlighted code rows but worth knowing if a file has thousands of blocks.

---

## A palette-triggered surface that focuses an input must re-claim focus itself

**Rule.** When a one-shot store signal (the `commitSearchFocus` /
`diffSearchSignal` pattern) is fired from a palette action and the consumer
mounts something with an `autoFocus` input, the consumer must *re-claim* focus
after the palette unmounts — e.g. via a `requestAnimationFrame` call to an
exported focus helper (`focusDiffSearchInput()` in
`components/DiffSearchBar.tsx`). `autoFocus` alone is not enough.

**Why.** The palette restores focus to its opener on unmount (a deliberate
a11y behavior — see the palette learning above). The order is: action runs →
signal consumer mounts and autofocuses → palette unmounts → focus snaps back
to the opener, silently stealing it from the input you just focused. The bug
is invisible if you only test the direct-shortcut path (⌘F), which never goes
through the palette.

**How to apply.** Export a `focusX()` helper from the component that owns the
input; in the signal-consuming effect, clear the signal and call the helper
inside `requestAnimationFrame` so it lands after the palette's unmount
refocus. Any new `requestX()` one-shot signal whose consumer wants focus needs
the same treatment.

---

## Palette actions over big store slices: gate on counts, read content at run time

**Rule.** A `PaletteAction` whose availability depends on a large store array
(diffs, review notes, the log) must subscribe `App.tsx` only to a cheap
derived value — a length/count selector like `s.unstagedDiffs.length` — and
have its `run` read the live data via `useRepo.getState()` at invocation time.
Never subscribe App to the array itself just to build a palette entry.

**Why.** `App.tsx` is the app's root; subscribing it to diff *content* means a
whole-app re-render on every watcher-driven refresh (which, with the file
watcher, is every agent write burst). Length-only selectors keep the gating
reactive while content churn stays free, and `getState()` at run time
guarantees the action still operates on fresh data. The copy-diff and
review-feedback palette actions are the canonical sites.

**How to apply.** New action: add a count-only selector for the gate
(`useRepo(s => s.xs.length)`), spread the action conditionally, and inside
`run` call `useRepo.getState().xs`. If the action needs multiple slices,
read them all at run time rather than widening the subscription.

---

## Global shortcuts live in one registry; context shortcuts stay with their views

**Rule.** Every *global* app shortcut is declared once in `ui/src/lib/keys.ts`
(`COMMANDS`: id, label, category, `defaultBinding`, `menu`, `needsRepo`). Bindings
use a canonical `Mod+Alt+Shift+<key>` string where `Mod` = ⌘/Ctrl. Three consumers
resolve through the same module so they can never drift:

- **Window keydown** (`App.tsx`): `eventToBinding(e)` → `resolveBindings(overrides)
  .byBinding` → command id → a handler from the per-render `commandHandlers` map
  (read via ref so settings changes don't re-subscribe the listener).
- **Native menu** (`lib/menu.ts`): accelerators via `toMudaAccelerator` (see the
  menu-ownership learning's 2026-06-15 update).
- **Palette + Settings chips**: `formatBinding(binding, platform)` (⌘⇧P on mac,
  Ctrl+Shift+P elsewhere).

User overrides persist in `settings.keybindings` (`KeyOverrides`: id → binding, or
`null` to unbind, or **absent** = default). `setKeybinding(id, undefined)` resets one
row; `resetKeybindings()` clears all. Settings → Keyboard (`KeyboardSection.tsx`)
records a combo by listening in the **capture** phase (fires before App's handler;
`stopPropagation` keeps the in-progress chord from triggering an app command or the
dialog's Esc), and flags clashes via `conflictingCommands`.

**Why.** The push/pull request (⌘P / ⌘⇧P) plus "make shortcuts configurable" forced
a single source of truth — the old hardcoded keydown chain + literal menu
accelerators couldn't be remapped or kept in sync. Keeping the pure logic in `lib/`
(not the view) follows the testable-logic learning; `keys.test.ts` covers
event→binding folding, override resolution, conflict detection, and formatting.

**Scope / how to apply.** Only *global* commands are in the registry. Surface-local
keys that depend on what's focused — commit `Mod+Enter` (LocalChanges), in-diff
search `Mod+F` (LocalChanges), commit search `/` (Commits), Review `j`/`k` — stay in
their own components and are documented (not rebindable) in the Keyboard section's
"Context shortcuts" card. To add a global command: add a `COMMANDS` row, a handler in
App's `commandHandlers`, and (if it should sit on the native menu) a `cmd:` on the
menu item + `menu: true`. Plain (modifier-less) bindings are suppressed while a text
field/combobox is focused (`isPlainKey`); repo-scoped commands no-op without a repo
(`REPO_COMMANDS`). `Mod+R` refresh calls `preventDefault`, so it doesn't reload the
webview in dev.

---

## Tree keyboard nav must use Pierre's display order, not flat path order

**Rule.** When walking a `@pierre/trees` file list by keyboard (the Review
queue's `j`/`k`), step through the paths in the tree's **visible display order**,
not the diff list's flat full-path sort. Use `treeFileOrder(paths)` /
`compareTreePaths` (`ui/src/lib/treeOrder.ts`).

**Why.** Pierre sorts **directories before files at each path level**, then by a
**case-insensitive natural** comparison (`a2` < `a10`). A flat string sort of
full paths interleaves nested files with their siblings differently — e.g.
`[src/app.ts, src/lib/keys.ts, src/lib/menu.ts, src/zebra.ts]` flat vs.
`[src/lib/keys.ts, src/lib/menu.ts, src/app.ts, src/zebra.ts]` in the tree. `j`
over the flat order looked like it was "diving into folders" because the next
flat entry was a nested file the user hadn't visually reached. The arrows were
always correct because Pierre's own keydown (`focusNextItem` in
`render/FileTreeView.js`) moves through the rendered rows.

**Why we re-implement the comparator.** The public `model` from `useFileTree` is
the render `FileTree` handle, which exposes `focusPath`/`getFocusedPath` but
**not** `focusNextItem`/`getVisibleRows` (those are on the internal
`FileTreeController`). And the tree renders into an **open shadow root with its
own React root**, so synthesizing arrow keydowns to drive Pierre's handler is
fragile. `treeOrder.ts` is a faithful port of Pierre's
`path-store/src/sort.js` `comparePreparedPaths`, unit-tested
(`treeOrder.test.ts`) so the two stay in agreement. It orders *files* only —
folder flattening and collapsed-folder visibility don't change the relative
order of files, so they're ignored (consistent with the old behavior, which
also ignored collapse).

**How to apply.** Any new tree keyboard walk sorts its candidate paths through
`treeFileOrder` first, then indexes by the active path. Both the Review queue
(`Review.tsx` `navOrder`) and Local Changes' `j`/`k` (`LocalChanges.tsx` `nav`,
each of the unstaged + staged groups sorted independently) route through it.

---

## Worktree UI names the repo first, branch second

**Rule.** A linked worktree is not a different workspace/repo in the UI. Chrome,
navigation, recents, and worktree dashboards must show the stable repo-family
name first and the worktree branch/session as secondary context.

**Why.** AI-agent workflows commonly run one branch per worktree. If the app
lets a linked worktree's folder or branch replace the repo name, switching tabs
feels like switching projects and recents can get polluted with branch slugs.

**How to apply.** Use `repoFamilyName`, `repoTabLabel`, and `worktreeName` from
`ui/src/lib/repoIdentity.ts`. `RepoMeta.name` is only the active workdir's
basename; it is not stable across linked worktrees. The stable family label is
derived from `RepoMeta.common_dir` (usually the main repo's `.git` directory).
When opening Review from the Worktrees dashboard, leave the dashboard before
switching active worktrees so the current-row sort does not visibly jump under
the cursor.

---

## Worktrees should distinguish checkout identity, state, and selection

**Rule.** Keep the single shared `PaneHeader` and repository-family breadcrumb.
Show each branch once, with its directory below; give working changes and the
latest commit their own columns. Use existing font, color, and density tokens.
Mark the current checkout independently of the selected row: selecting another
checkout must visibly move selection without implying that HEAD switched.
Keep Open worktree and Review vs base discoverable for the selected checkout,
and retain keyboard navigation and focus outlines. On narrow panes, prioritize
identity and changes over commit metadata.

**Why.** The owner rejected PR 113's September 3 persist-cut presentation on
2026-09-04. Its duplicate branch columns, clipped names, hidden actions, and
current-row selection styling obscured the worktrees' actual state. This rule
supersedes that branch's exact 26px table/no-controls constraint.

**How to apply.** Key selection by checkout path and keep asynchronous stats
from reordering the list under the pointer. Failed status reads are unknown,
never clean. Cleanup must exclude current, main, locked, and missing checkouts.

---

## AI commit messages use vendor CLIs, not raw OAuth

**Rule.** Subscription-backed AI features delegate auth and billing to the
official vendor CLIs — **Codex** (`codex login` / `codex exec`) for ChatGPT,
**Claude Code** (`claude auth login` / `claude -p`) for Anthropic. Strand
orchestrates subprocess calls and parses JSON; it does not store API keys or
implement Anthropic subscription OAuth.

**Why.** ChatGPT Plus billing for third-party tools flows through Codex OAuth;
Anthropic restricts subscription OAuth to first-party surfaces. Shelling out
to `claude` is the supported path for Claude Code users.

**How to apply.**

- New AI providers implement the minimal `AiProviderAdapter` boundary in
  `crates/strand-tauri/src/ai/` — don't add direct HTTP + key storage without
  an explicit product decision.
- Spawn argv directly (no shell), same safety model as `external.rs`.
- Disable tool use in headless CLI invocations (`--tools ""`, read-only Codex
  sandbox) so suggestion runs can't mutate the repo.
- Don't gate Suggest on upfront sign-in — run the vendor CLI first; on failure,
  check `auth status` / `login status` on the bin and only then open the login
  flow (`AI_AUTH_REQUIRED` prefix from Rust → UI calls `ai_provider_login`). A
  failed status command is **not** automatically a logged-out result: a launcher
  can exist while its packaged executable is missing or corrupt. Preserve that
  health error, and preflight detached login flows with `--version`, so the UI
  never claims sign-in started when the vendor CLI could not run.
- Settings → AI shows per-CLI status (Codex + Claude Code) via an explicit
  status button — no auto auth probe on open. Its last explicitly checked
  installed/logged-in result may be persisted for immediate UI continuity, but
  never credentials or provider account identifiers; label it as CLI-saved and
  keep the status button as the explicit refresh. Changing the custom CLI path
  invalidates that cached result. Optional manual sign-in/out per CLI remains.

---

## AI writing treats repository data as untrusted and generation as cancellable

**Rule.** AI writing may send only Strand's explicitly bounded prompt. Codex
runs in a fresh empty temporary directory with its ephemeral/no-repo-check,
ignore-user-config/rules, read-only, no-web flags; provider executable paths are
canonicalized before any cwd change. Both providers receive the same
untrusted-data preamble and delimited branch, path, profile, example, manifest,
and patch sections. Never log or persist prompts, output, or matched secret
values.

Every generation is an operation, not a fire-and-forget promise. Register its
`AiCancelHandle` in `AppState.ops`, give it a unique `opId`, kill and reap its
whole Unix process group or Windows Job Object on timeout/cancel/output overflow,
and apply results only while repository, provider, and PR target identity still
match. Repository/provider/target changes and dialog teardown cancel in flight;
the UI keeps cancellation quiet and exposes a visible Cancel action.

Before launch, scan only conservative sensitive path/content signals. Return
path plus classification, never a matched value. Confirmation is two-pass and
fingerprinted: exclusion removes the whole flagged file, inclusion is explicit,
and any diff change requires confirmation again. Context stays deterministic and
bounded: a compact manifest, ranked textual patches with per-file/global caps,
and additive `AiInputCoverage`. Repository writing profiles are keyed by
canonical `RepoMeta.common_dir`, so linked worktrees share one policy.

---

## Vendor-CLI subprocesses on Windows (paid for by DAN-11)

**Rule.** Every vendor-CLI spawn from `crates/strand-tauri/src/ai/bin.rs`
must: resolve only `.exe`/`.cmd`/`.bat` on Windows (never extensionless
PATH entries), run batch shims via `cmd /C`, pass prompts over **stdin**
(not argv), null stdin otherwise, enforce a timeout (30s status /
120s suggest), and set `CREATE_NO_WINDOW`.

**Why.** npm installs an extensionless POSIX-shell shim *next to* every
`.cmd`; the old bare-name probe resolved it first, `CreateProcess` can't run
it, and `provider_status` then reported "installed but not signed in" on a
fully signed-in machine while suggest failed every time. Prompts as argv hit
the 32K command-line ceiling and get re-parsed (newlines = command
separators) when routed through `cmd /C`. A CLI that stops to ask a question
on inherited stdin spins the UI forever without a timeout, and the release
build is GUI-subsystem, so unflagged children flash a console per call (same
lesson as `strand_core::git_command`).

**How to apply.** Route new CLI calls through `bin::run_capture` /
`bin::spawn_detached` — never `Command::new` directly in provider modules.
Exception mirror: `spawn_detached` (login flows) keeps a visible console on
purpose, because sign-in may need an interactive picker.

---

## Dialog `mountedRef` must re-arm in the effect body (StrictMode)

**Rule.** The dialog pattern `const mountedRef = useRef(true)` guarding
`setError`/`setBusy` after an await must set the ref back to `true` in the
mount effect's *body*, not rely on the initializer:
`useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, [])`.
A cleanup-only effect (`useEffect(() => () => { ... }, [])`) is wrong.

**Why.** The app runs in `<StrictMode>`, which in dev mounts → unmounts →
remounts every component. The ref *object* survives that remount, so the
simulated unmount's cleanup leaves `mountedRef.current === false` on a fully
mounted dialog. Every guarded state update is then silently skipped — in
practice the `finally { if (mountedRef.current) setBusy(false) }` never runs
and the dialog freezes on its busy label the first time its submit errors
(found 2026-07-07: "Merging…" frozen in `WorktreeMergeDialog` when the base
worktree refused the merge; the same latent bug sat in eleven other dialogs).
Production builds don't double-mount, so the bug is dev-only and invisible on
the happy path.

**How to apply.** Copying an existing dialog is how the bug spread — all
dialogs were fixed in one pass (2026-07-07), so copy from any of them now, but
check for the re-arm line whenever you see `mountedRef`. Same trap for any
`useRef` flag that a cleanup mutates: initializers run once per fiber, not per
mount.

---

## Resolve provider CLIs before entering an untrusted repository

**Rule.** A provider integration must resolve its executable from `PATH` to an
absolute path *before* setting a repository as the child process's working
directory. Reuse `crates/strand-tauri/src/ai/bin.rs` (`resolve_cli` +
`base_command`) for spawnability and Windows console behavior. Null stdin,
drain stdout and stderr concurrently, and enforce a bounded timeout.

**Why.** `Command::new("gh")` / `Command::new("az")` with an untrusted repo as
cwd can execute a repository-owned same-name program on Windows because the
CreateProcess search includes the current directory. A relative `PATH` entry
has the same problem after `current_dir` changes. Independently, a 100-PR JSON
response can fill an OS pipe and deadlock if the parent waits for exit before
reading, while an invisible auth prompt can otherwise wait forever.

**How to apply.** Resolve and canonicalize first; then build the command with
the shared wrapper. Spawn with piped stdout/stderr readers running in parallel,
`stdin(null)`, and a product-appropriate timeout. Provider auth remains in the
official CLI unless OS-keychain storage is explicitly part of the change.

---

## Provider list queries stay shallow; nested data loads per activation

**Rule.** Never request nested comments, commits, reviews, files, or checks for
an entire hosted-PR list. The index query carries only row fields; load rich
metadata only after explicit PR activation (or current-branch auto-open).

**Why.** `gh pr list --limit 100` with comments + commits + latest reviews +
check rollups asked GitHub GraphQL to traverse up to 1,000,000 possible nodes,
over its 500,000 maximum. The user was authenticated; the UI incorrectly
described the provider query-shape error as a login problem. Eager per-row
detail calls would avoid that cap but turn j/k key-repeat into a subprocess
storm.

**How to apply.** GitHub uses shallow `gh pr list` plus one `gh pr view` for the
opened row. Other providers follow the same boundary even if their present API
would tolerate a large response. List focus may move freely; Enter/click opens
details, while only an active source-branch match may auto-open. Generation-gate
responses so a slow previous activation cannot replace the active detail, and
append login guidance only when stderr actually indicates authentication
failure.

---

## Hosted PR content stays safe and heavy changes stay tab-lazy

**Rule.** Render provider descriptions and comments through the shared
React-element Markdown renderer: no raw HTML and no automatic remote image
requests. A remote image may render only after an explicit user reveal. Fetch
and parse a hosted patch only after the Changes tab opens, and mount only the
selected file through Strand's Pierre wrapper.

Provider identity avatars are the narrow exception: they are trusted metadata,
not author-controlled Markdown. Load only a sanitized `http(s)` URL, lazily and
with `referrerPolicy="no-referrer"`; keep initials behind the image so a missing,
blocked, or expired avatar never leaves an empty marker. GitHub's `gh pr view`
comment shape exposes only `author.login`, so derive its standard profile
image route (`https://github.com/<login>.png?size=80`) after validating the login
instead of spawning one `gh api users/...` subprocess per commenter. Azure
thread identities may supply `author.imageUrl` directly.

**Why.** Pull-request content is untrusted input inside an IPC-privileged
webview. Remote images also leak that the PR was viewed. Separately, eager patch
downloads and one Pierre mount per changed file turn list navigation into a
network/render hot path and repeat the large-diff freezes already solved in
Local Changes and Review.

**How to apply.** Reuse `renderMarkdown` with a provider URL resolver and the
click-to-load `ProviderImage` handler. The comment composer may insert standard
image Markdown for an already-hosted `http(s)` URL; do not claim local binary
upload or call an undocumented provider upload endpoint. GitHub and Azure's
supported CLI paths do not currently share a stable attachment-upload contract.
Keep provider list/detail, discussion, and diff calls separate; mount the
changes component conditionally by tab. Parse the aggregate
patch once, give Pierre a stable cache key, and hand `ParsedDiff` only the
active `FileDiffMetadata`. Reuse `PierreTree` and the Local Changes file-header
strip for hosted changed-file navigation instead of maintaining a second flat
list or letting Pierre render a padded, provider-specific diff card. Keep the
changes workspace inside the tab panel's actual content width: a negative
margin into the detail padding is still clipped by the tab's `overflow: hidden`
and cuts off right-aligned diff totals with more than one digit.

---

## Hosted PR writes carry the exact reviewed head

**Rule.** Every hosted pull-request action that can integrate code must send
the provider the exact source commit loaded in the detail view. Do not expose
policy or administrator bypasses by default, and do not infer mergeability from
the checks currently visible in Strand.

**Why.** A source branch can advance after a reviewer opens the PR. Merging by
PR number alone can then integrate code the user never saw. Provider policies
also contain information Strand may not have loaded (especially in Azure
DevOps), so client-side green checks are not sufficient authorization.

**How to apply.** GitHub immediate merges use REST `sha`; queue/auto-merge mutations use
`expectedHeadOid`. Azure
completion requests include `lastMergeSourceCommit`. Keep required checks,
reviews, queues, and branch policies provider-authoritative, preserve their
failure text next to the initiating control, and refresh the PR after a
successful request because queued completion may leave it active temporarily.

---

## Hosted PR worktrees start from immutable provider heads

**Rule.** Prepare a PR worktree from the exact source OID returned by the
provider, never from a same-named local branch or a mutable remote-tracking ref.
Fetch the object without creating refs or updating `FETCH_HEAD`, and reuse an
existing local branch only when it already resolves to that exact OID. Hosted
branch-update requests must carry the same expected-head guard.

**Why.** A local branch can lag, diverge, or belong to another fork while the
PR branch advances independently. Opening it silently gives a reviewer code
that does not match the hosted diff. Temporary PR refs and `FETCH_HEAD` also
pollute repository state for a read-oriented preparation step.

**How to apply.** GitHub preparation fetches the documented
`refs/pull/<number>/head`; Azure fetches the provider source ref, including the
fork remote when supplied. Pass the resulting commit directly to the shared
worktree dialog and suffix a conflicting branch name. Detect the hosted
provider from the raw configured remote URL before Git's `url.*.insteadOf`
transport rewrite so corporate mirrors remain recognizable, while the actual
fetch still uses Git's effective rewritten transport.

---

## Hosted PR lifecycle controls fail closed on viewer capability

**Rule.** A provider lifecycle action appears only when activated PR detail can
establish that the signed-in provider account may perform it. GitHub draft
handoff uses `PullRequest.viewerCanUpdate`; Azure's PR response has no equivalent
viewer field, so Strand exposes Ready for review only to the signed-in PR author
and still lets the PATCH enforce current permissions. Missing identity or
capability data hides the transition rather than guessing from local Git config.

**Why.** Draft state says what the PR is, not what the current user may change.
Showing an enabled lifecycle button from state alone creates predictable
permission failures and confuses a provider account with local commit identity.

**How to apply.** Keep permission data on rich activated detail, never the
shallow 100-row query. Refresh the same detail after a successful lifecycle
write so the action, readiness strip, and state badge change together without
reloading the hosted patch.

---

## Background PR refreshes use activity snapshots, never patches

**Rule.** A followed pull request is monitored with its provider-neutral
activity snapshot only: identity/state/head SHA, stable comment and review IDs,
and normalized check or policy states. Background work must never request or
parse the hosted patch, and a shallow-list refresh must not invalidate the
currently mounted detail.

**Why.** Pull-request patches are the largest provider response and the most
expensive UI resource. Polling them would waste provider/CLI work, repeatedly
parse large diffs, and destroy the reviewer's focus, scroll, file selection, and
unsent drafts. Provider failures also must not turn a previously known failure
green or erase a successful activity baseline.

**How to apply.** Poll immediately after hydration, at a modest interval, and
on focus without overlapping cycles. Share in-flight activity calls with the
visible PR. Revalidate rich detail only when the activity fingerprint changes;
reload the patch only when the head SHA changes. Keep the old patch visible
while that replacement loads or fails, label it stale, and disable writes that
depend on exact patch coordinates. Treat incomplete policy/check reads as
unknown and retain the last complete baseline.

---

## Pull-request creation publishes a missing source branch deliberately

**Rule.** Creating a hosted pull request may publish the checked-out source
branch when that exact branch is absent from the detected repository remote.
Push only current `HEAD`, never force, and invoke the provider only after the
push succeeds. Set the detected remote as upstream only when no upstream exists;
preserve an existing upstream on another remote.

**Why.** PR creation cannot succeed without a hosted source branch. Making the
publish step part of the explicit Create action removes a predictable dead end,
while checking the active branch and using a non-force push bounds the write to
the branch and commit named by the dialog.

**How to apply.** The creation UI names the checked-out source branch and
explains that Strand will push it if missing. Before provider creation, verify
that the requested source still equals the checked-out branch, inspect the
local remote-tracking refs, and explicitly push `HEAD` to the detected remote
only when its branch is absent. Surface push and authentication failures inline.
After success, query the new PR by branch, open it, and enroll it in the existing
follow monitor.

AI-assisted PR writing follows the same separation. Build its prompt from the
committed merge-base-to-`HEAD` diff only, keep Codex in its read-only sandbox
and Claude Code tools disabled, and return editable text without invoking the
host provider. Never describe staged/unstaged work as though it were already in
the pull request.

---

## Hosted thread writes use node IDs and provider capabilities, not head guards

**Rule.** New inline comments remain coordinate writes and must carry the exact
reviewed head SHA. Replies and Resolve/Reopen target an existing provider thread
by its stable node ID instead: gate those controls on the provider's
`viewerCanReply` / `viewerCanResolve` / `viewerCanUnresolve` fields and let the
provider reject stale permissions. Missing capability fields fail closed.

**Why.** Applying the coordinate-write head guard to thread writes would block
valid replies on outdated threads and valid resolution after a push. GitHub's
thread mutation already names the unambiguous object, while the capability
fields express the signed-in viewer's current authority.

**How to apply.** Send GraphQL mutations and variables through stdin to the
resolved provider CLI, never interpolate user text into argv. Return the small
comment/thread outcome and patch the active PR locally so a reply does not
reload the rich detail or hosted patch, remount Pierre, or discard scroll,
focus, file selection, and per-thread drafts. Background monitoring can then
seed its activity baseline through the existing post-write path.

---

## Network variants are typed, and destructive pushes are lease-guarded

**Rule.** Pull and push variants cross the IPC boundary as explicit `PullMode`
and `PushMode` values. The default mode preserves the user's Git configuration;
explicit modes add only the requested flag. Strand exposes force-push only as
`--force-with-lease` and never offers plain `--force`.

**Why.** Boolean flags stop scaling once the client offers merge, rebase,
fast-forward-only, tag-following, and guarded rewrite behavior. Typed modes keep
the Rust command, TypeScript wrapper, store, progress copy, and UI action in
agreement. A lease prevents silently overwriting remote work that arrived
after the user's last fetch.

**How to apply.** Add new strategies to the shared mode union instead of
creating one-off IPC commands. Route UI entry points through the App-owned
network callbacks so busy guards, cancellation, progress, refresh, and errors
remain consistent. Any history-rewriting network action must name its target,
explain the safety check, and require explicit confirmation.

---

## Explicit branch network operations use qualified refs and never switch HEAD

**Rule.** Branch-scoped fetch, pull, and push operations validate Git ref names,
build fully qualified `refs/heads/...` and `refs/remotes/...` refspecs, and pass
the remote/refspec after `--`. Pushing a non-current branch must name that local
ref directly; never check it out as an implementation shortcut. A selected
branch pull refreshes its remote-tracking ref as part of the same refspec.

**Why.** Letting Git guess a namespace makes branch/tag collisions ambiguous,
while checkout-before-push mutates the user's active worktree and fails when a
branch belongs to another worktree. Updating the tracking ref prevents the
sidebar from showing stale state after a successful selected-branch pull.

**How to apply.** Keep explicit ref operations in `network.rs`, reuse typed
`PullMode` / `PushMode`, the streaming cancellation path, and App-owned busy
state. Per-repository network preferences belong in the settings database;
asynchronous loads must re-check the active repository path before applying a
saved value so rapid tab switches cannot leak one repository's policy into
another.

---

## Network action policy and remote identity have different sources of truth

**Rule.** Persist per-repository operation defaults such as fetch pruning,
pull strategy, and pull autostash in Strand's settings database, and pass an
explicit positive or negative flag for every invocation. Read and write remote
fetch/push URLs through native Git configuration; never mirror remote identity
in app storage.

**Why.** Explicit flags make a one-operation override deterministic regardless
of the user's global Git config, while keeping URLs in `.git/config` ensures
the command line and every other Git client immediately see the same remotes.

**How to apply.** Route network preferences through the active-repository
loader and App-owned callbacks. Extend the remote model and native Git config
mutation together when adding remote identity fields. Repository-wide remote
choices use native keys such as `remote.pushDefault`; rename and remove must
update or clear those keys in the same operation.

---

## Row context actions use their target, not ambient selection

**Rule.** A row context-menu action must receive the row's repository and item
identity explicitly. Do not implement it by reading the globally selected file,
branch, commit, or repository when the action runs.

**Why.** Right-click does not necessarily change selection, and multi-repository
views intentionally keep one active repository while exposing rows from several.
Reading ambient state can therefore open or mutate a different item than the one
whose menu the user invoked.

**How to apply.** Build menu callbacks from the targets passed by the tree or
row component, then route that explicit identity through the App-owned action.
If an operation only makes sense for one target, omit it for multi-selection.
For historical file trees, hide working-tree-only actions instead of applying
them to a same-named current file.

---

## A merged branch mark means containment by the primary branch

**Rule.** `refs::Branch.merged` is true only when the local branch tip is
reachable from the repository's primary branch tip; the primary and checked-out
branches themselves are always false. Resolve the primary branch from symbolic
remote HEAD (preferring `origin`), then local `main`, local `master`, and finally
the checked-out branch. Sidebar and commit-graph indicators must use this field
instead of guessing from ahead/behind counts or the loaded log window.

**Why.** Upstream drift answers a remote-sync question, not whether deleting a
local branch would orphan its commits. Using the checked-out feature as the
containment target also mislabels its base (`main`) as an already-merged branch.
The graph view is intentionally bounded, so client-side ancestry checks would
also produce false negatives for older merged branches.

**How to apply.** Compute the flag while collecting refs with libgit2 commit
ancestry (`graph_descendant_of`, including equal tips), and refresh it through
the existing snapshot path after history or checkout operations. Squash and
rebase merges do not preserve ancestry and therefore do not change this core
field; provider-aware UI may add the exact-tip overlay described below.

**Bulk cleanup extension (2026-07-17).** `RemoteBranch.merged` applies the same
containment test to remote-tracking tips, but does not suppress the primary ref
(`origin/main` is contained and therefore true). `mergedBranchCleanupPlan`
pairs remote deletion only with an already-merged local candidate, requires
the remote tip to be contained too, and explicitly rejects any remote whose
branch portion is the primary branch. This matters because a remote can advance
after its local branch was merged. Local cleanup calls
`Repo::delete_branch(force=false)`, which re-checks containment and linked-
worktree occupancy at deletion time; never rely on a frozen dialog snapshot as
the final destructive-operation guard.

**Provider exact-tip extension (2026-08-07, DAN-41; revised 2026-09-01, DAN-63).**
The sidebar, commit graph, and bulk cleanup may additionally mark a non-current
local branch when a completed GitHub/Azure PR targets the primary branch and the
PR source name matches the local branch. Tip equality is not required: Azure
DevOps completed PRs often omit or rewrite `lastMergeSourceCommit` after squash,
so exact-tip matching left squash-merged locals unmarked and out of cleanup.
Never infer merges from tree equality, subjects, PR numbers, or ahead/behind.
An open or active PR from the same source into the primary branch means the
name was reused for new work — leave those unmarked. Keep discovery async,
delayed, deduplicated, and session-cached off repo-open/ref-snapshot hot paths;
explicit cleanup refreshes once and freezes its display plan. Remote deletion
remains ancestry-only. Local provider-confirmed deletion must call
`Repo::delete_branch_at`, which rejects a tip that moved after the plan froze
and any current/worktree-held branch at execution time.

---

## Windows CLI launch uses persisted PATH and cmd-compatible canonical paths

**Rule.** Build the Windows CLI environment by retaining inherited PATH order
and appending current machine/user PATH entries from the registry. Resolve
executables before changing cwd. Route `.cmd`/`.bat` through an absolute system
`cmd.exe /D /C`, and remove only the canonical `\\?\` or `\\?\UNC\` prefix from
the batch-file argument; native executables keep their canonical path.

**Why.** Explorer and already-running desktop launchers can retain a PATH from
before npm, WinGet, or another installer changed the persisted environment.
Separately, `std::fs::canonicalize` returns verbatim Windows paths, which work
with `CreateProcess` but make `cmd.exe` report that it cannot find an existing
npm launcher. Resolving a bare command processor after entering a repository
would also reopen the current-directory executable-search hazard.

**How to apply.** Reuse `path_env::effective_path`, `ai::bin::resolve_cli`, and
`ai::bin::base_command` for provider-style subprocesses. Regression tests must
execute a canonicalized batch launcher, not merely assert that lookup found a
file. For packaged-app verification, start Strand with a deliberately stripped
process PATH and confirm a user-installed CLI plus its runtime still executes.

---

## Windows notification permission comes from the native plugin backend

**Rule.** Until Tauri's notification shim changes, do not use its exported
`isPermissionGranted()` as the source of truth on Windows. Invoke the native
notification plugin permission command directly; keep the normal plugin flow
on other platforms.

**Why.** Tauri notification 2.3.3 replaces `window.Notification`, initializes
its Windows permission value as `default`, and immediately converts that value
to `denied` without asking the desktop backend. The backend itself reports
desktop permission as granted, so Strand otherwise displays a persistent false
"blocked" warning even when Windows notifications are enabled.

**How to apply.** Keep the workaround isolated in `ui/src/lib/notifications.ts`
and retain a platform-routing test. Re-evaluate it when upgrading the Tauri
notification plugin; remove it only after a running Windows webview reports the
same state through both paths.

---

## Optional provider helpers are exact-release, short-lived trust boundaries

**Rule.** An app-managed provider helper is never resolved from PATH or a
repository. Download it only from its dedicated rolling GitHub release, verify
a signed version/protocol/target manifest plus archive and extracted-binary
hashes, reject incompatible protocol versions, and execute one bounded JSON-RPC
process per operation from its absolute app-config path. Keep list payloads
shallow and detail/diff/activity lazy exactly as for the in-process
provider-neutral workspace.

**Why.** A repository-local or unsigned helper would turn opening an untrusted
checkout into executable-code discovery. Protocol gating lets helper fixes ship
independently without weakening the signed trust boundary. A daemon adds lifecycle and credential
surface without helping the current provider-operation granularity. Reusing the
PR normalization layer also prevents Azure Server from drifting into a second
UI model or weakening the one-mounted-diff performance boundary.

**How to apply.** Share only the strict serde protocol crate. Cap stdin,
stdout, stderr, and runtime; reject unknown fields and mismatched versions.
Credentials enter over stdin and live only in the native vault. Authenticated
HTTP never redirects and stays under the configured HTTPS collection origin;
custom roots apply only to PAT transport, while Windows integrated auth uses
WinHTTP and the Windows trusted-root store. A helper failure disables only its
provider adapter, never local Git or another host.

**Azure DevOps Server coordinate resolution (2026-07-17).** Treat the profile's
HTTPS collection URL as its default remote boundary and compare host/path
identity across HTTPS and SSH clone transports. The standard Azure remote shape
already carries the project immediately before `_git` and the repository after
it, so do not add per-repository project settings. Additional prefixes are only
for genuine server aliases. A blank Settings field may derive this boundary
from the active repository, but persist the inferred HTTPS origin before an
authenticated helper request; never let a guessed origin become an implicit
runtime redirect. Hosting readiness is deliberately configuration-level:
verified helper plus stored PAT or Windows-auth profile, while **Test** remains
the explicit network/authentication probe. Keep the helper's strict `version`
response schema in sync with every emitted field, including `capabilities`.

**Helper manifest signature format (2026-07-17).** Tauri's `signer sign`
command writes a base64 envelope around the Minisign text. Decode that envelope
before publishing `strand-azdo-manifest.json.minisig`; the desktop passes the
downloaded text directly to `minisign_verify::Signature::decode`. Rolling
promotion reuses the signed workflow artifact after exact-tag upload. The
post-promotion Linux smoke checks the public archive, binary, hashes, version,
and protocol; the desktop verifier remains the runtime enforcement point for
the cryptographic signature on every platform.

**Helper versions and protocol channels are independent (2026-07-29).** Never
copy the desktop version or handwrite the helper protocol into release
metadata. `strand-azdo` owns its explicit Cargo version and
`strand-azdo-vX.Y.Z` tag. Every platform runner executes the built binary's
strict `version --json`; manifest assembly accepts only one reported helper
version and one protocol across all targets. Promote the signed artifacts to
`strand-azdo-protocol-N`, not a global latest that a future incompatible
protocol can overwrite. Keep protocol 5 mirrored to `strand-azdo-latest` only
for already-shipped clients. Upload archives before the signature and manifest
so an interrupted promotion never advertises a missing binary; a transient
manifest/signature mismatch remains fail-closed. After promotion, download
through the protocol channel and compare the running native binary plus both
hashes to the public manifest. Schema 1's misleading `strand_version` field is
the helper version and must remain until old clients no longer consume it.
Assemble an exact helper release as a draft and publish only after every asset
is present; never overwrite an already-published helper version.

**Peel commit-ish inputs before commit lookup (2026-07-18).** A revparse result
can be an annotated-tag object rather than a commit even when the user-visible
input names a commit. Any history/diff operation that accepts branches, tags,
or arbitrary revision expressions must call `peel_to_commit()` before reading
the commit/tree; passing `revparse_single(...).id()` to `find_commit` rejects
valid annotated tags. Keep a focused annotated-tag test on every shared
commit-ish boundary.

**Merge-preserving rebase owns the generated topology (2026-07-18).** With
`git rebase --rebase-merges`, never replace Git's generated todo with a flat
list: its `label`, `reset`, and `merge` commands are the topology. Transform
only matching pick/merge actions, reject reorder/squash/fixup and merge-drop
plans that would cross those boundaries, and keep the generated plan/message
artifacts inside the worktree git dir until the operation completes or aborts.
An `edit`/`break` stop can exit successfully while rebase markers remain, so
paused state is determined from those markers, not the process exit code alone.

**Cross-view reveal effects own post-mount selection (2026-07-18).** A sidebar
action that switches views cannot rely on selecting detail before the target
view mounts: that view's initial-focus effect may clear it. Carry the requested
object through the store's reveal signal, then focus, scroll, and open any
detail from the target view's reveal effect after its first render. Keep the
source-side action declarative so there is one navigation path and no race.

**Repository housekeeping retains bounded transcripts outside Git
(2026-07-18).** Long `maintenance`, `gc`, and `fsck` runs use the shared
cancellable system-Git runner, but a non-zero exit is returned as a transcript
outcome rather than collapsed into an error so the UI can retain the diagnostic
output. Record the exact safety-prefixed command, result, duration, and combined
output in Strand's per-repository app storage—never in the checkout. Cap both
entry count and transcript size; integrity failures can otherwise make the
settings database a new hot-path liability.

**Working-tree actions keep exact row identity and Git-shaped enumeration
(2026-07-18).** Pierre resolves a folder selection to its descendant files for
batch actions, but row-specific operations must also receive the exact invoked
path and whether it is a file or directory; otherwise Open/Rename/Delete can
silently target the first descendant. Keep the Files tree index-plus-untracked
rather than adding a filesystem walk merely to display empty directories—an
empty folder can open directly and appears once populated. Every file mutation
must pass through `safe_workdir_path`, reject traversal and `.git` components,
validate the whole target set before its first deletion, avoid following
directory symlinks, and emit native separators at OS integration boundaries.

**Signature verification is lazy; patch export is staged outside `.git`
(2026-07-18).** Git's `%G?` placeholders can invoke GPG/SSH verification for
every formatted row, so they never belong in `Repo::log` or another paged hot
path. Detect whether the opened immutable commit carries a signature, verify
only that commit through system Git, and keep a bounded UI cache keyed by
repository path plus OID. Exact multi-commit export uses resolved full OIDs and
`format-patch --no-walk=unsorted`; Git consumes those revision arguments in
reverse insertion order, so reverse the argv to preserve the UI's oldest-to-
newest selection. Stream into a create-new sibling temporary file first, reject
symlink and `.git` destinations, and copy to the user-selected file only after
Git succeeds so a formatting failure cannot truncate an existing export.

**Hosted writes derive from lifecycle state at every surface (2026-07-18).**
Do not merely disable the merge button for a terminal pull request: Summary and
Timeline composers, inline comment selection, thread reply/resolution, and
lifecycle menus must all use the same open-state predicate. Closed/abandoned
requests may expose only Reopen; merged/completed requests are immutable
history. When adding a new Azure DevOps Server write operation, bump the helper
protocol so an already-installed older helper is upgraded rather than selected
by a matching but incomplete capability contract.

Azure thread IDs are scoped to a pull request rather than globally unique, and
a reply also needs the thread's root comment ID. Normalize all three as one
provider-prefixed ID in shared UI state, and decode it only at the provider
boundary; the visible thread ID alone cannot build either Azure write route.

**Hosted viewed marks fingerprint the rendered file, not the provider patch
(2026-07-18).** A provider/Pierre cache key can identify the whole PR patch, so
using it for one file makes every unrelated push invalidate all review
progress. Persist the exact head SHA plus a hash of only that file's rendered
metadata/content. When a filtered file queue becomes empty, reconcile selection
against the filtered paths—not the unfiltered file map—or the hidden previous
diff remains mounted and violates both the filter and one-diff review model.

**Hosted review submission validates the exact head with a lean read
(2026-07-18).** Recheck the provider head immediately before any review write;
do not refresh rich detail or the patch merely to guard submission. GitHub can
send the decision, summary, and inline comments atomically in one review pinned
to that commit. Azure vote, inline-thread, and summary APIs are separate writes:
submit the vote first, then tracked inline comments, then the summary; report
partial success explicitly at every boundary and preserve the local draft so
the user can reconcile unsent or already-posted text. Never clear a draft on a
provider failure; clear it only after the provider confirms every review write.

**Existing-review actions are capability-driven and identity-bound
(2026-07-18).** Keep submitted reviews out of the shallow GitHub list and load
them with rich detail, including provider viewer capabilities. A GitHub review
body is editable only when `viewerCanUpdate` says so; dismissal requires a
reason and remains subject to the provider's final authorization. Azure votes
have no editable body: expose reset only when the exact reviewer ID and signed-
in identity match a current nonzero vote, then re-read the pull request before
writing. After either provider accepts a write, refresh rich detail instead of
guessing the next capability state locally.

**Azure inline comments resolve provider coordinates at write time
(2026-07-18).** A displayed patch path and line number are not sufficient for
an Azure DevOps review thread. Match the latest iteration's source commit to the
exact reviewed head, page its cumulative changes against the common commit,
map both current and `originalPath` names to the provider `changeTrackingId`,
and recheck the PR head immediately before posting. For that cumulative diff,
send the same latest iteration as both comparing iterations so Azure interprets
the left version as the common commit; populate only the left positions for
deletions or right positions for additions. Keep paging bounded and report
partial batched-review writes explicitly because Azure has no atomic review
payload.

**Release security policy is an exact, fail-closed allowlist (2026-07-18).**
Keep production CSP, main-window capabilities, signed updater artifacts, the
HTTPS stable endpoint, and updater key ID mirrored in
`scripts/check-release-security.mjs`; PR and release CI must reject silent
broadening or disabling. Tauri production assets need its IPC and asset
protocols, self-hosted scripts/fonts, inline styles for React/Pierre, and HTTPS
images for provider avatars/Markdown attachments. The desktop frontend uses no
OS-info commands even though the OS plugin injects platform internals, so do
not restore `os:default`. Verify changes against an exact workspace executable
path: launching by app identity on Windows may resolve to the installed
`C:\Program Files\Strand\strand.exe` and produce false release evidence.

**English is a typed catalog, not an excuse for fixed formatting (2026-07-18).**
Put new Strand-owned UI copy in `ui/src/lib/i18n.ts`; unknown keys should remain
a TypeScript error and missing interpolation values should fail loudly. Use its
plural and browser-locale formatting helpers for counts, dates, numbers, and
percentages. Keep Git/provider diagnostics verbatim and translate only Strand's
context around them. Do not expose a locale picker until another catalog is
complete enough to avoid a partially translated application.

**Window-state verification must cross a real process boundary (2026-07-18).**
Keep the main Tauri window hidden in config so `tauri-plugin-window-state` can
restore geometry before the frame appears; the existing setup may then apply
Windows decorations/shadow and show it. Verify persistence by changing state,
closing the process through the UI, and launching the exact workspace binary.
A same-process hide/show or app-identity launch does not prove disk restore.

**A Windows executable icon is not a retained taskbar icon (2026-08-07,
DAN-40).** Extracting a valid `icon.ico` from `strand.exe` proves the resource,
not the visible HWND state. After an in-place update, Windows' executable-path
cache can fall back to a generic document icon when `WM_GETICON` returns no big
or small handle. At `RunEvent::Ready`, enumerate the current process's visible
top-level window, load shared big/small handles from winres resource `32512`,
and send both `WM_SETICON` messages. Verify the real visible HWND in a fresh
process: `ICON_BIG` and `ICON_SMALL` must be non-zero and extract to the Strand
artwork. Keep this contract in `scripts/check-release-security.mjs`.

**Animated notifications need one stable accessibility channel (2026-07-18).**
Keep visible success/error/network pills `aria-hidden` and mirror the active
message through the always-mounted assertive live region in `ToastViewport`;
screen readers can miss announcements on nodes that enter/leave with
`Presence`. Interactive progress (Cancel) remains reachable on the visual pill.

**Composite rows must not hide pointer-only controls inside buttons
(2026-07-18).** A recent/workspace row with secondary Remove, Rename, or Delete
actions is a focusable menu-item container with real child buttons, never a
button containing clickable spans. Stop child key events from activating the
row. Repository tabs keep a single tab stop and expose Close on Delete/
Backspace; arrow keys plus Home/End implement the tablist focus model. Any
pointer double-click action needs an explicit keyboard equivalent.

**Authentication ownership follows the system-Git boundary (2026-07-18).**
Network operations inherit the user's credential helper, SSH agent, and
`GIT_ASKPASS`/`SSH_ASKPASS`; signed commits inherit gpg-agent/pinentry. Do not
add duplicate in-app passphrase storage or prompts while that delegation is in
place. A secret Strand itself owns must use the native platform vault—the Azure
Server helper PAT uses `keyring` for Keychain, Windows Credential Manager, and
Linux Secret Service. Stable 1.0 has no product telemetry and only the
user-reviewed crash-report flow; adding telemetry or another updater channel is
a new post-1.0 trust decision, not release polish.

**Tauri's updater key-mismatch warning is a release failure (2026-07-18).**
The bundler can successfully emit installers and updater `.sig` files even
when `TAURI_SIGNING_PRIVATE_KEY` does not match the public key embedded in the
app. Always run `scripts/check-updater-signatures.mjs` on generated desktop and
helper signatures and compare packet key IDs, including helpers-only release
paths. Do not rotate the embedded key to accommodate an unexpected machine or
CI secret: select the established release key, keep the draft unpromoted, and
then run the end-to-end updater rehearsal.

**A trademark knock-out search is evidence, not clearance (2026-07-18).**
Record exact queries, jurisdictions, classes, status, owners, and primary
register links, but leave the gate open when live identical or related marks
exist. `STRAND` has active class-9 registrations in the US and EU for Signify's
lighting-control software/equipment and other related software marks exist.
Only the owner with qualified counsel can decide coexistence, territory scope,
or renaming; an agent must not convert a database result into legal approval.

**Configure Git tag signing before release promotion (2026-07-18).** An
annotated tag is not a signed tag, and a pushed tag cannot gain a cryptographic
signature later without replacing the tag object and force-updating the remote
reference. Check `user.signingKey`, signing format/program, and a noninteractive
test signature before the promotion window. If an owner explicitly overrides
the gate, record the exact peeled commit and the unsigned status rather than
describing the tag as signed.

**Ignored-file enumeration is Files-tab-only, never part of the snapshot hot
path (2026-07-19).** Recursing Git-ignored directories can mean walking generated
trees such as `node_modules` and `target`; on a real development checkout the
equivalent enumeration exceeded 20 seconds. Keep `status_options` and
`Repo::snapshot` limited to index-plus-untracked data. The Files view may call
`Repo::work_tree_with_ignored(true)` automatically only after the user opens
that tab, through the blocking IPC path. That initial call must walk only
non-ignored directories and return each ignored directory as one explicit
trailing-slash boundary; it must never enter generated trees. Fetch one native
filesystem level through `Repo::ignored_directory_children` only when that
muted folder is expanded, and cache loaded levels for the session. Stop Git
ignore checks at the first ignored ancestor so deep Windows paths never reach
libgit2, do not follow symlinks, and never expose any `.git` directory. While
the first local enumeration is pending, show a loading state; do not temporarily
render the snapshot-backed tree, because Files would misleadingly swap from
Git-visible paths to local paths. Use the cheap snapshot only as the current
Git-status overlay, never as the Files path source. Ignored entries carry
explicit identity for muted Pierre rows, stay badge-free, and remain out of
Local Changes. Pierre's stock status model counts every status entry toward
ancestor change dots, including `ignored`; keep the pinned package patch that
excludes ignored statuses from `directoriesWithChanges` while retaining
`ignoredDirectoryPaths` for inherited muted styling. Its transition logic must
increment when ignored becomes a real status, decrement when real becomes
ignored, and leave counters alone when an ignored status is removed. Never set
libgit2's `recurse_ignored_dirs`: its Windows filesystem layer can abort the
entire status walk when a generated descendant exceeds its path limit.

**Refresh the ignored Files cache from path mutations, not status changes
(2026-07-19).** The ignored-inclusive listing is the sole Files path source, so
refreshing only the snapshot leaves created, deleted, or moved paths stale.
Advance a dedicated mutation signal after a successful create/delete/move,
apply that mutation immediately to the loaded local cache, clear loaded ignored
directory levels, and re-fetch the cheap boundary listing in the background.
Ordinary boundary refreshes may retain cached lazy descendants. Never key that
fetch to general status; instead, overlay the cheap current snapshot metadata
onto the cached local paths. Git
does not represent empty directories, so retain
folders created in Strand as explicit trailing-slash Pierre paths for the
session, and transform/remove those markers on move/delete. Explicit directory
paths must stay out of PierreTree's file set so selection and context menus keep
classifying them as folders.

**In-app text writes are optimistic and encoding-preserving (2026-07-19,
updated 2026-08-06).** A file editor must send the exact content it last read
and the core must reject a write when the disk copy no longer matches; agents
and external editors share the working tree, so last-writer-wins would silently
destroy work. Mutate only complete UTF-8 regular files behind
`safe_workdir_path`, reject symlinks and oversized/binary content, and preserve
a consistently-CRLF file's line endings after editor normalization.
Commit/revision content remains immutable. Pierre's lazy-loaded `<File edit>`
surface owns live tokenization and editor behavior; do not restore the parallel
textarea/highlight overlay. Focus/watcher refetches keep the loaded editor
mounted while the read is in flight, and a completed refresh must never replace
an unsaved draft. Reserve the empty loading surface for the initial file/source
load. Pierre's editable document exposes LF line boundaries even when a Windows
checkout is CRLF. Normalize the session buffer to LF and keep the raw last-read
text separately for optimistic writes so the core can restore the original
line-ending convention on save. Discarding editor changes is a session-buffer
operation: clear the stored draft, rebuild Pierre from the last-read text, then
refresh from disk; never implement it through a working-tree write.
Expose undo/redo through Pierre's public `Editor` instance and its `canUndo` /
`canRedo` flags; never maintain a parallel history over the session draft. The
toolbar and Pierre's keymap must walk the same stack, and an intentional editor
rebuild (clean external refresh or Discard) must clear the exposed handle until
the replacement document attaches.

**Windows discard keeps libgit2 fast and falls back only for its path ceiling
(2026-07-20).** `git2::Repository::checkout_index` may inspect an unrelated
ignored directory during its default refresh and fail with class `Filesystem`
and `path too long` before applying a narrow checkout pathspec. Build discard's
`CheckoutBuilder` with `refresh(false)`: every IPC discard opens a fresh
repository and index, so the scan is redundant. Keep libgit2 as the normal
batched path; on Windows only, retry that exact error through system Git's
`checkout-index --force -- <paths>` with `-c core.longpaths=true`. Do not treat
other checkout or filesystem errors as fallback candidates, and keep the
pathspec after `--` so a repository filename cannot become an option.

**Embedded terminals are process-owned; only their descriptors persist
(2026-07-20).** Keep PTY runtimes in process-wide native state and xterm
renderers mounted across view, repository, and workspace switches. Persist
descriptors, never processes or scrollback; restore them dormant and unselected,
then launch only after explicit activation. Resolve the executable and recovered
PATH before applying the repository cwd, pass custom commands as direct argv,
and terminate the full process group/job on tab close or app exit. Removing one
workspace owner or hiding a workspace must not stop a repository terminal; a
final repository close must confirm first. While xterm owns focus, preserve
shell controls, keep Command shortcuts app-owned on macOS and only numbered
view navigation plus the fixed Work `Ctrl+PageUp`/`Ctrl+PageDown` peer cycle
app-owned on Windows/Linux, with `F6` returning focus to the peer Work tab
strip. Fit xterm before creating the PTY and explicitly synchronize the native
grid again once its runtime ID exists; an observer can fire during async startup
and otherwise leave a full-screen alternate-screen app on the default 80x24
grid. Claude Code deliberately replaces its complete welcome dashboard with a
mini logo after setup warnings and release notes have been consumed; this is
application state, not an xterm rendering failure. Strand's agent-first terminal
sets `CLAUDE_CODE_FORCE_FULL_LOGO=1` and the supported
`CLAUDE_CODE_NO_FLICKER=1` alternate-screen switch in
`configure_terminal_environment`; keep such compatibility variables inert for
other shells and cover them as a single tested environment contract. Mount only
the active file document so terminal continuity does not turn inactive file tabs
into a background rendering cost.

**Terminal defaults and explicit shell choices have different lifetimes
(2026-07-20).** The primary New Terminal action follows the repository/global
default at process start; a shell chosen from its split menu is stored in that
tab's descriptor and must survive relaunch/restore independently of later
default changes. Discover installed WSL distributions lazily, decode redirected
`wsl.exe --list --quiet` output as UTF-16LE on Windows, and pass distro plus
Windows repository path through direct `--distribution`/`--cd` argv. Typography
changes update existing xterm options and then refit/resynchronize only visible
PTYs so a font preference cannot collapse a hidden terminal's native grid.

**Legacy Windows shells cannot receive canonical verbatim executable paths
(2026-07-20).** `std::fs::canonicalize` returns `\\?\C:\…` on Windows, which is
useful for identity and safety but must be converted back to a normal drive/UNC
path at the embedded-terminal process boundary. Windows PowerShell 5.1 passes
its executable path into .NET Framework during interactive ConPTY startup; the
verbatim form can abort initialization in `System.Net.ServicePointManager` even
though non-interactive launches work. Keep canonical paths elsewhere, normalize
only shell executable argv, and retain a PTY regression test that answers the
shell's cursor-position query before asserting startup output.

**Native dropdown chrome is an app-level primitive (2026-07-20).** Render
selects through `components/Select.tsx`, not one-off `<select>` wrappers. The
shared component keeps the platform-native keyboard/form/accessibility model
while owning Strand's chevron, right-side text clearance, and disabled icon
state. Surface CSS may size or skin the underlying select, but must size the
`.select-control` wrapper too whenever the old select was itself a flex or grid
item; otherwise the wrapper, rather than the select, becomes the layout child.

**Linux shares Ctrl shortcuts, not Windows window chrome (2026-07-20).** Keep
Linux as a distinct `Platform` even when shortcut formatting branches only on
macOS versus non-macOS. Collapsing Linux into `win11` makes key labels correct
but incorrectly opts it into Strand's custom Windows caption controls;
collapsing it into `mac` preserves native chrome but emits Command glyphs and
macOS toolbar spacing. Platform detection must identify all three targets, and
individual surfaces may deliberately group Windows and Linux with a non-macOS
predicate.

**Embedding a file document must not change its editing contract (2026-07-20).**
Work's tab chrome is presentation context, not an access-control boundary.
Existing complete UTF-8 working-tree files remain editable whether the shared
file document is standalone or embedded; revision, binary, size, encoding, and
backend safety checks are the only read-only gates. An embedded clean document
may follow watcher refreshes, but a watcher tick must never replace an unsaved
draft; rely on the optimistic stale-write check to protect newer disk content.

**Completed Azure PR diffs must use provider-recorded merge history
(2026-07-24).** Azure commonly deletes a completed PR's source branch, so never
reconstruct its Code view by fetching that ref. Fetch the durable target ref
without updating local refs or `FETCH_HEAD`, then compare
`lastMergeTargetCommit` to `lastMergeCommit`. Keep a real remote-deletion
integration test because a fixture with both refs cannot reproduce this
provider lifecycle.

**Raw AI CLI stderr is untrusted content, not a user-facing diagnostic
(2026-07-24).** The general rule to preserve provider diagnostics verbatim
still applies to Git and hosting operations, but AI vendor CLIs may emit session
metadata plus echoed stdin containing repository paths, prompts, and patches.
Preserve only bounded single-line diagnostics; classify known failures from the
diagnostic prefix before any prompt boundary, and replace every unclassified
transcript with a stable Strand-authored recovery hint.

**The Microsoft Store MSI is a separate, fail-closed release flavor
(2026-07-24).** Tauri's supported Store path links Partner Center to an
unpackaged MSI; do not improvise an unverified MSIX conversion. Keep the normal
GitHub MSI lean and merge `tauri.microsoftstore.conf.json` only for the Store
candidate so WebView2 is embedded and installed silently. The submitted URL is
immutable and version-bearing. Require both trust layers before upload:
timestamped Authenticode on `strand.exe` plus the MSI, and Tauri updater
signatures matching embedded key `84FCBFD2A981CE5D`. Store metadata must
explicitly disclose the optional live-generative-AI drafts, link the public
privacy notice, and keep a keyboard-reachable in-product route for reporting
inappropriate provider, user-generated, or generated content; keyboard support
alone is not evidence for claiming an audited accessibility standard.
When Strand displays or sends Git-hosted user content, Store policy 11.12 also
requires public user-content guidelines. Keep
`website/docs/content-guidelines.md` linked from the documentation manifest and
public site alongside the privacy notice, and keep reporting/removal guidance
aligned with the actual in-product reporting path.

**The verified packaged-classic MSIX is the preferred Microsoft Store route
(2026-07-25), superseding the earlier prohibition on an unverified conversion.**
Tauri still does not generate MSIX, but Microsoft's documented manual
packaging path is now proven for Strand: MakeAppx completed semantic validation,
a temporary test-signed package registered, and Windows launched the real
WindowsApps executable through its AUMID. Keep the manifest identity fully
parameterized and require the exact Partner Center `Name`, `Publisher`, and
`PublisherDisplayName`; never submit the development `.test` identity. Build
MSIX with `VITE_DISTRIBUTION=msix` so Microsoft Store owns updates and the
direct GitHub updater is neither checked nor offered. The Store candidate
workflow must emit an unsigned `.msixupload` for Partner Center to sign—do not
reintroduce a CA certificate requirement into this route. Retain the signed,
offline-WebView2 MSI workflow only as a fallback.

**Microsoft Store CD starts from a published GitHub release and ends at
Partner Center acceptance (2026-07-28).** Pin the public Store product and
manifest identity in the repository, but keep the Entra client ID/secret,
tenant ID, and seller ID in the protected `microsoft-store-production`
environment. Use Microsoft's Store Developer CLI action for managed MSIX; the
older `store-submission` action targets unmanaged MSI/EXE. A successful
workflow submission does not mean certification is complete, and the unsigned
`.msixupload` remains a private Actions artifact. Preserve manual build-only
dispatch so packaging can be diagnosed without mutating Partner Center.

**The Store-signed MSIX fulfills Strand's Windows signed-installer requirement
(2026-07-29).** Partner Center signing of the production `Danielss.strand`
package is the trusted Windows distribution boundary. Do not keep a purchased
EV/Authenticode certificate as a release gate for that route, and do not imply
that Store signing also signs the standalone GitHub MSI. The unmanaged
MSI/EXE fallback still needs its own certificate if it is ever promoted.

**Pierre action targets must expand every selected directory (2026-07-29).**
Pierre's raw multi-selection contains both file and directory paths. Never
filter it to exact file rows before resolving an action: doing so silently
drops every selected folder from a mixed selection. Expand each selected
directory against the wrapper's known file set, deduplicate overlaps by
iterating that set once, and keep an action on an unselected context row scoped
to that row. `expandTreeSelection` / `resolveTreeActionTargets` own this
boundary; preserve the single batched IPC call after expansion.

**A persistent terminal host must stay compositable (2026-07-29).** A stable
xterm runtime layer can preserve PTYs, DOM nodes, and input while still making
every renderer invisible if an ancestor uses `visibility: hidden`. Keep the
runtime ancestor visible and hide only inactive terminal panes; test both
halves of that CSS contract.

**Nested modal launchers can race focus restoration (2026-07-29).** When a
command palette launches a modal, its unmount cleanup may restore the palette
opener after the modal's native `autoFocus` runs. Reclaim modal focus on the
next animation frame, remember any control restored behind it, and return focus
to that real opener when the modal closes.

**Equal-tip branches are peers unless provenance says otherwise
(2026-07-29).** Git may record a new branch as merely “Created from HEAD,” so
base detection needs an equal-tip fallback. Prefer the primary branch at the
same tip; do not treat arbitrary equal-tip siblings as parents because they may
have been created from the target later. An explicitly named reflog parent
still wins.

**Store-owned MSIX updates still need in-product discovery (2026-07-30).**
Keep the direct GitHub updater disabled for `VITE_DISTRIBUTION=msix`, but query
`Windows.Services.Store.StoreContext.GetAppAndOptionalStorePackageUpdatesAsync`
after launch and on an explicit check. Microsoft throttles that API to one
fresh check per 30 minutes and ten per 24 hours, so one delayed launch check is
enough; repeated calls may return cached status. Strand may notify and open the
Store product page, but Microsoft Store remains responsible for downloading,
signing, and installing the package. The API requires package identity, so
browser and unpackaged development runs can verify the UI/state contract but
not a real availability response.

**MSIX shell icons need the complete target-size unplated matrix
(2026-07-30, corrected 2026-08-11).** A lone
`Square44x44Logo.targetsize-44_altform-unplated.png`
does not cover Windows display scales. The shell then shrinks the plated
manifest logo, producing blur and an accent-color backplate. Generate exact
16/20/24/30/32/36/40/44/48/60/64/72/80/96/256 px default, `unplated`, and
`lightunplated` variants directly from canonical `strand.png`, copy every
variant into the MSIX, then generate `resources.pri` with MakePri before
MakeAppx. Qualified files copied without a package resource index are present
on disk but invisible to shell resource resolution; Strand 1.3.0 exposed this
failure. Keep the cross-platform policy check aligned with the full matrix and
the MakePri step.

**Pierre worker themes are global light/dark pairs (2026-08-07).** Use the
official palette names already registered by `@pierre/diffs`, initialize the
pool with both the light and dark member, and change families through
`pool.setRenderOptions`. A mounted diff's `themeType` should only select which
already-highlighted palette to display, so ordinary Strand light/dark toggles
do not discard and recompute highlighted ASTs. Do not register those official
names again: duplicate registration logs errors and makes Vite emit a second
copy of every palette chunk.

**AI review results must stay bound to the submitted diff (2026-08-07).** Key
each request by the review baseline plus per-file patch hashes and cancel or
ignore it when that key changes. Normalize model paths against the submitted
`FileDiff`s on the Rust side, drop unknown files, and retain a line anchor only
when the patch proves that line exists on the reported old/new side; a valid
finding with a bad line becomes a file note. Keep provider findings transient:
AI review must not edit files or persist notes until the reviewer explicitly
accepts an individual finding or the pending set. Append accepted findings in
one write without replacing human or previously accepted AI feedback. This
keeps hallucinated or stale coordinates out of the diff and avoids N IndexedDB
writes for N findings.

## Vite optimizer cache must follow pnpm dependency upgrades (2026-08-07)

Vite's generated `ui/node_modules/.vite/deps/_metadata.json` can survive a
`pnpm install` while still pointing at a package-version directory pnpm has
removed. The failure is an ENOENT during dependency optimization, before Vite
can reliably invalidate its own cache. The pre-dev/build
`ui/scripts/clean-stale-js.mjs` check therefore validates every recorded
optimizer `src` path and removes only `ui/node_modules/.vite` when one is
missing. Keep this check generic; do not special-case a package or delete the
whole dependency installation.

## Composed views need one owner per live surface (2026-08-27)

A configurable workspace cannot safely render a second copy of a feature whose
store, window listeners, focus loop, or renderer assumes it is unique. Assign a
feature to at most one pane and move it when reassigned. Only the active pane
may own surface-level window shortcuts, and DOM queries must start from that
surface's own root so two different diff surfaces cannot steer each other.
Keep expensive persistent renderers such as Work's xterm/editor layer at one
stable React position and measure a reserved pane for placement; do not remount
them as the layout tree changes. This preserves terminal processes, scrollback,
selection, and the ordinary non-composed-view hot path.

## Workspace layouts need scope on every persistence channel (2026-08-27)

A layout is not workspace-specific merely because its topology uses a
workspace-keyed SQLite row. Scope the complete persistence surface: cached
models, in-flight restores, serialized write queues, and
`react-resizable-panels` auto-save identities. On a workspace switch, hide the
previous tree synchronously and ignore a stale async restore unless its scope
is still active; otherwise a slow read can flash or overwrite another
workspace's view. Keep per-workspace write queues independent so one slow disk
write does not stall edits elsewhere. When migrating a former app-wide value,
attach it only to the reserved Default workspace—copying it into every named
workspace defeats the user's expectation that each starts independently.

## Pierre controlled selections echo through `onLineSelected` (2026-08-28)

Pierre's React wrapper calls `setSelectedLines` when Strand changes the
controlled `selectedLines` prop, and that programmatic update can invoke
`onLineSelected`. Do not use that callback to persist a selection when the same
prop also drives transient hover tint: the first hovered range otherwise
becomes persistent and the blue tint stops following later hovers. Use
`onLineSelectionEnd` for pointer-only drag commits; programmatic hover updates
do not emit that lifecycle event.

## Extensible layouts must preserve identity before resolving code (2026-08-28)

Persisted workbench layouts store namespaced surface identity, instance
identity, and context binding; they must validate bounded structure without
requiring the contribution to be installed. Unknown or disabled IDs survive
as stable placeholders, so one missing plugin can never reset an otherwise
valid workspace. Contribution metadata, pickers, command generation, and
render hosts must consume one registry instead of growing parallel feature
lists. Community code must stay outside Strand's privileged React/Tauri
webview and reach app data only through versioned, permission-checked,
quota-bounded capabilities.

## Workbench configuration is an overlay on the default Work surface (2026-08-28)

Work and composition are one product destination, but remain separate runtime
responsibilities: Work owns editor/terminal panes and the Workbench owns outer
surface placement. Absence of a saved Workbench layout must take the direct,
full-size Work path with no loading gate or configuration chrome. Entering
customization may compose that same stable Work renderer; Done hides editing
controls, and Reset removes the workspace layout so the direct default returns.
Legacy Custom layout keys and settings are one-way migration inputs, not a second
route; remove the legacy global layout only after its per-workspace write succeeds
so Reset cannot resurrect it. Normal composed layouts retain an outer keyboard loop:
`F6` and `Mod+[` / `Mod+]` focus each surface's entry point without editor chrome.
Work needs an explicit bridge because its persistent renderer is visually positioned in
the layout but remains a DOM sibling of the Workbench placeholder.

## Heroi is an active-repository-only chat surface (2026-08-30)

**Rule.** The Strand-hosted Heroi plugin (`daniels.heroi`) contributes only a
coding-agent chat. Render and persist conversations by repository, and display
only conversations whose canonical project path matches Strand's active
repository. Do not duplicate workspaces, Files, git changes, diffs, kanban, or
terminal chrome inside Heroi; those belong to independently composable
Workbench panes. Heroi launches authenticated Claude, Codex, and Cursor Agent
CLIs off the UI thread, consumes their streaming JSONL, retains provider session
IDs for resume, and cancels the complete child process tree. Model and
reasoning pickers are provider-owned: Claude uses the version-gated catalog
with per-model effort levels, Codex is probed via `app-server` `model/list`,
and Cursor Agent is probed via ACP `cursor/list_available_models`. Bound captured
output and never expose raw vendor stderr or transcript paths.

**Why.** Heroi is embedded in Strand's Workbench rather than acting as a second
IDE. Duplicating surrounding tools wastes pane space, creates competing state,
and obscures the repository boundary that must isolate chat history.

**Visual contract.** Heroi uses a compact Threads rail, a one-line repository
context/action bar, flat left-aligned turns, and a bottom-anchored command deck.
Avoid conventional chat bubbles and large centered cards. Render message bodies
with Strand's first-party `renderMarkdown` (React elements only — no HTML
execution). Keep tool calls for a turn in **one** collapsible group at the
**start** of the assistant turn (before the markdown body); do not stack a
growing list of activity rows as the primary transcript chrome, and do not put
the group under the files list or at the bottom of the bubble. Show
added/changed/deleted paths after the prose, attributed to the turn's mutating
tool payloads, and open a clicked path through Workbench navigation (Work
Changes) rather than an inline diff viewer. **Open review** routes to Strand's
existing Review surface; it must never grow an inline diff viewer. Derive the
near-black/amber treatment from Strand theme tokens so repository accenting,
focus rings, and contrast remain coherent.

**Composer and concurrency contract.** A running conversation must only lock
its own composer and settings; it must not prevent creating, opening, sending,
or stopping other repository conversations. Track runs by conversation id and
keep cancellation keyed by each unique operation id. `@` references canonical
repository-relative paths. The `/` picker discovers the selected provider's
user and project skill roots but inserts `$skill-name`, matching the native CLI
prompt syntax. Files-tree drops must become mentions and must not also trigger
the tree's move/open behavior. Report drag-hover entry/exit separately from the
drop so the composer can acknowledge a valid target before release. Tool calls for a turn belong in one grouped disclosure; individual rows expand
when provider detail exists. Retain bounded command/tool arguments and output,
never unbounded vendor transcripts or stderr.

---

## Perf hook exposes plugins for CDP (2026-08-30)

**Rule.** When driving Strand over CDP in Vite DEV, use `window.__strand.*`
stores only. Dynamic `import('/src/...')` from `Runtime.evaluate` can resolve a
**second** module graph, so installs and layout writes look successful but the
React tree never updates. `window.__strand.plugins` is part of the perf hook
(`strand:perf=1`) for the same reason as `repo` / `customView`. Workbench
workspace id must be `__default__`, never `"default"`.

**Why.** A Heroi install against the duplicate registry left the App surface
registry empty and the main pane blank until the real store was used.

## Microsoft Store uploads require an explicit timeout (2026-08-30)

**Rule.** Every `msstore publish` invocation must pass `--uploadTimeout 300`,
and `scripts/check-msix.mjs` must enforce it. Do not rely on the CLI default.

**Why.** Microsoft Store CLI v0.4.0 and v0.4.1 map an omitted timeout to zero,
so valid Partner Center submissions fail consistently at the Azure blob upload
after package preparation. The upstream fix was merged after v0.4.1 but was not
yet released when Strand 1.5.0 was submitted.

---

## The website demo is the production UI behind a mocked IPC layer (2026-09-02)

**Rule.** `strandgit.com/demo/` is `ui/` built with `--mode demo`
(`VITE_DEMO=1`), not a replica. Every Tauri command the UI invokes must have a
handler in `ui/src/demo/dispatch.ts` (or a plugin stub in `boot.ts`), and the
demo's event payloads must match the desktop wire format exactly — e.g. PTY
output is base64, progress events carry the same `kind`/`phase` shape. When you
add or reshape an IPC command, add the demo handler in the same change; an
unhandled command surfaces as an error toast in the live demo. Do not add
`if (demo)` branches to app code beyond the single bootstrap hook in
`ui/src/main.tsx` — the demo runs the same React tree on purpose so chrome
changes reach the site for free. Presentation-only differences (no OS window
controls to clear) go in CSS under `html[data-demo]` in `chrome.css`; `boot.ts`
sets that attribute.

**Why.** The hand-coded HTML mock drifted from the app on every release and
was replaced because it felt fake. Keeping the demo honest costs one handler
per command; a special-cased UI would drift the same way the mock did.

**Rule.** Railway service `strand` (project `landings`) must build from the
repo root, not `website/`. `website/demo/` is gitignored, so a
`website/`-only root never sees the Vite bundle and `strandgit.com/demo/`
404s. Railpack otherwise detects the root `Cargo.toml` as Rust and has no
pnpm; keep `railpack.json` (`"provider": "node"`) and the service vars
`RAILPACK_PACKAGES=node@22 pnpm@9.0.0`,
`RAILPACK_INSTALL_CMD=true`, `RAILPACK_NO_SPA=1`. The build command is
`pnpm install --frozen-lockfile && pnpm --filter strand-ui build:demo &&
pnpm --filter strand-website build` (one step — Railpack's Rust provider
races a separate install layer). Start with
`npx --yes serve website/dist -l ${PORT:-4321}` plus
`RAILPACK_DEPLOY_APT_PACKAGES=nodejs npm` until `railpack.json` is on
`main` and the Node provider owns the runtime. Watch `/website/**` and
`/ui/**`. `website/build.mjs` must fail on Railway/CI when the bundle is
missing.

**Why.** The 2026-09-02 DAN-58 landing shipped the iframe chrome without
the demo artifact because Railway only pulled `website/` and
`build.mjs` warned instead of failing.

---

## Optional helpers use protocol compatibility, not app versions

**Rule.** `strand-azdo` compatibility is determined only by
`PROTOCOL_VERSION` and its signed `strand-azdo-protocol-N` release channel.
Background startup may keep an installed helper that matches the channel
manifest, but a user-triggered install or Retry is a repair action and must
download, verify, and replace the binary even when its reported helper version
matches. Removing helper state must not require executing that helper.

**Why.** Helper releases advance independently of Strand releases, and a
binary can be corrupt or otherwise broken while still reporting expected
metadata. Sharing an updater fast path with explicit Retry made recovery a
no-op; requiring a protocol-compatible helper to remove its own state trapped
users after a breaking IPC change.

## Performance evidence must separate status, patches, and paint (2026-09-06)

A fast `repo_snapshot` does not establish a fast refresh: the frontend can
concurrently generate all staged/unstaged and full-context Review patches, then
parse and render them. Measure these costs independently and capture actual
visible paint before claiming a PRD interaction target. Diff virtualization
bounds mounted rows, not native patch generation or IPC payload size.

When reducing refresh work, identical status metadata is not a content revision:
an already-modified file can change again while retaining the same status row.
Use explicit invalidation/generations and preserve equal diff objects only after
comparing their content and metadata. Coalescing must retain a trailing refresh
for writes during an in-flight read, and reject superseded responses for the
same repository as well as responses belonging to another active tab.

Patch consumers include Work's Changes document, composed Review/Local Changes
panes, clipboard exports, and reviewed-file staging. Status-only controls
(stash checklists, fixup availability, navigation badges) must use status;
rename-aware staging targets come from index-to-workdir deltas, never from a
pinned historical review baseline. Files inventories have per-repository
versions that survive tab activation; file contents alone do not invalidate
ignored-boundary listings.

Pierre's theme/language resolvers reject worker contexts. Resolve their
registrations on the window side, then pass them to a worker-owned Shiki core
for tokenization. Test actual colored tokens, not only worker creation or
plain-text fallback: silent fallback hid this integration error during the
September pass.

Browser dependencies in Node tests need explicit globals **before import**.
Pierre reads `navigator.userAgent` during module evaluation; Node 22's built-in
`navigator` hid a failure on CI's Node 20. Stub browser globals and restore them
after the test, while retaining real integration assertions. Reproduce this
class of failure locally with `--no-experimental-global-navigator`.

## Hosted connection pages carry completeness and reviewed heads (2026-09-06)

GitHub connection continuations carry their opaque cursor and the activated
head SHA. Reject missing/repeated cursors and head mismatches; deduplicate by
provider ID when appending, and keep already loaded data on failures. A thread
page fetches only its root comment; replies have independent cursors. Counts
remain explicitly partial until their connections are exhausted. Background
check snapshots traverse check pages without patch or comment-body reads.

## Deferred completion retains provider semantics (2026-09-06)

GitHub queue membership, GitHub auto-merge and Azure auto-complete are separate
states. Enabling carries the loaded head; cancellation targets the existing
provider intent and remains possible after source changes. Do not call
`gh pr merge` for immediate completion because it may silently enqueue. Azure
auto-complete follows subsequent source pushes under server policies; its
waiting state is not a queue position. Helper operations advance the protocol
channel and need a corresponding signed helper release.


## Hosted evolution uses immutable boundaries and exact local files (2026-09-06)

A saved reviewed head is a commit ID scoped to the provider PR URL; never replace
it with a branch name or a new merge base after force pushes. Compare the two
explicit trees, retain failed/unavailable boundaries, and label an old result
when the displayed provider head changes. GitHub review commits and Azure
iteration source commits are provider boundaries, not proof that the viewer
reviewed every file. The local **Mark head reviewed** is an explicit action.

Suggestion application re-reads the provider discussion and head and checks the
exact comment body, current full-line source range, local HEAD, index and file
contents. Revalidate the complete preview before writing through the existing
file compare-and-swap operation. Unknown/old Azure iterations, column ranges,
mixed sides, outdated lines and offset-form fences fail closed. Empty and
blank-line suggestions differ; keep the parsed trailing newline to preserve
that distinction. No staging, commits, pushes or provider writes are implicit.

Unresolved export is an explicit discussion traversal with cancellation, stable
ID deduplication and source context. Include file-level threads without inventing
line zero annotations; they render above the file diff. Keep this traversal out
of inbox and background monitoring. A read error must not produce a supposedly
complete export or overwrite a review draft.

**Hosted provider writes preserve host and commit scope (2026-09-06).**
Custom GitHub remotes need an explicit adapter and host-scoped CLI calls; keep
GitHub.com's existing owner/repo identity so saved follows and drafts survive.
GitLab inline coordinates use the diff version's base/start/head and both
paths across a rename. A preflight head read is not an atomic merge guard:
Bitbucket Cloud merge stays unavailable until its API accepts an expected
head. Cloud comment/review races must report that a write may have happened,
and partial batches must retain drafts with reconciliation guidance. Never
reuse another provider's credentials; Cloud API tokens are scoped to
api.bitbucket.org through the system Git credential helper.

**Repository creation must be resumable before any network write (2026-09-06).**
Persist the concrete destination and reviewed commit locally before creation,
record uncertain state before POST, and recover by GET instead of blindly
reposting. Creation, remote attachment and initial push are separate user
actions. Initial push sends only the reviewed SHA to the reviewed branch,
rejects URL rewrites/alternate push URLs, disables implicit tag/submodule
pushes and preserves an existing upstream. Recovery records contain no tokens.


### Advanced refs preserve reviewed identities (2026-09-06)

Git notes must use a locked namespace tip and publish the prepared notes tree
atomically; a stale note editor must retain its draft when another worktree
changes that namespace. Replacement inspection uses raw object IDs because
libgit2/gix readers do not apply Git's replace refs. Tag retargeting and
re-annotation are separate operations with compare-and-swap of the raw tag ref,
not its peeled commit. Never drop an existing tag signature during an edit.


### Git-flow finish is a resumable sequence, not a transaction (2026-09-06)

Git-flow AVH can finish its production merge and tag before a develop merge
conflicts. Abort must be described as aborting only that current merge; it must
never reset earlier completed stages. Retain workflow branches and use exact
names so a later finish can resume. AVH flags can default from Git config:
explicitly negate every publication flag (including release pushproduction,
pushdevelop and pushtag), not just push. AVH builds its tag command with shell
`eval`; use reviewed generated annotation text from validated names rather
than interpolating arbitrary editor text. Keep tool detection and all of this
metadata off repository-open and graph/diff hot paths.

## Personal actions preserve argv and captured targets (2026-09-06)

User actions are personal executable/argv definitions, separate from Workbench
registries and community plugins. Establish argument boundaries before
single-pass placeholder substitution; never interpolate repository-controlled
values into an implicit shell or recursively expand substituted text. Resolve
the executable before adopting the repository cwd. Windows actions require a
native executable, with script paths passed to their interpreter as arguments;
batch shims introduce another command parser.

Menus capture the invoked repository/ref/file, including inactive repository
tabs. Palette actions require an exact active target, and every run revalidates
the resolved preview and captured ref ID. A sidebar ref click only reveals its
graph row; Enter selects the tip's commit for ref palette actions. Do not infer
a ref from HEAD or a commit shared by several branches/tags.

Bound stdout and stderr independently. Cancel the whole process tree on close,
timeout, output overflow, or selection changes. Stop descendants even after a
natural parent exit **before** joining pipe readers: inherited stdout/stderr can
otherwise keep the reader joins blocked indefinitely. Replay early cancellation
after native operation registration to cover a closed dialog during IPC startup.


## Repository identity must use the commit resolver

Effective author/committer reads use system Git, including conditional includes,
worktree config and environment overrides. Keep these reads on the explicit
settings surface; do not add subprocesses to snapshot/status paths. Local
identity edits target the direct common repository config, never a file reached
through an include. Show both the saved local values and the effective values:
a later conditional include or a worktree/environment override can still win.
Linked worktrees share local config; `--worktree` writes must never silently
fall back to `--local` when `extensions.worktreeConfig` is disabled.

## Signing policy must remain Git-compatible (2026-09-06)

Signing settings store only key references and existing-agent configuration.
Operation-level inherit/sign/unsigned choices never rewrite config, and signing
or hook failures retain the draft. Tag creation runs system Git too: `--file`
already creates an annotated tag, while explicit `--annotate` suppresses
`tag.forceSignAnnotated`. Use that override only for an explicitly unsigned
annotation, alongside `--no-sign`. With verbatim cleanup, ensure a final newline
before Git appends the signature or the result cannot be verified.

Verify tags lazily against their immutable object ID. Display Git's verification
output and distinguish unsigned, valid and failed results; do not turn signature
validity into an unconditional claim of signer trust. Keep config reads and
signature verification out of status/snapshot and graph-wide refresh paths.
In `git config --null --get-regexp` output, a valueless boolean has no newline
separator and means true; a newline followed by an empty value means false.
Preserve that distinction in settings displays and scoped editing.

LFS guards must run before sparse-index mutation dispatch. Refresh an attached
memory-only sparse index through `sparse_read_index`, never `Index::read` from
disk; keep one process-tree cancellation helper when composing Git workflows.
