# Learnings

Things we've learned while building Strand that aren't otherwise obvious from
the PRD / ROADMAP / TASKS files. Append here when you discover something
that future work (yours or another agent's) needs to respect.

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
  handles so the hover/drag affordance is consistent everywhere.
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
driver. Index/commit ops still use git2. After any history op, the store refresh
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
rewritten to local `/fonts/*.woff2`. Files in `ui/public/` are copied to `dist`
verbatim by Vite and served at the root. To add/refresh a family: fetch the
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
`.graph-table tbody tr` heights in `features.css` per density (26 / 32 / 38).
Change one → change both. Blame's virtual list has the same coupling (18px).

**Why.** A drifted constant doesn't crash — it makes the scrollbar lie and
rows land under the wrong mouse position, which reads as "selection is
flaky" and is miserable to bisect. Focus/reveal jumps also fall back to
index × rowH math when the target row isn't mounted (`scrollIntoView` can't
reach an unmounted row), so the constant is correctness, not just layout.

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
`code.cmd` explicitly (std `Command` doesn't apply PATHEXT). Windows/Linux
presets are untested on real machines (tracked ☐ in TASKS).

---

## Keyboard shortcuts on macOS belong to the native menu, not the keydown handler

**Rule.** Any global shortcut that exists as a native-menu accelerator
(`ui/src/lib/menu.ts`) must be skipped by App's window keydown handler when
`appMenuInstalled()` is true. Adding a new global shortcut means deciding its
owner: put it in the menu (gets discoverability + the gate) or in the JS
handler (works on Win/Linux + browser dev), and if both, gate the JS side.

**Why.** AppKit dispatches menu key equivalents through
`performKeyEquivalent` *before* the webview receives the keydown — the menu
action fires and the JS handler usually never sees the key. "Usually" is the
trap: relying on that ordering invites double-fire bugs if dispatch changes
(or the menu fails to install), and a dead shortcut if you remove the JS
path entirely. The explicit `appMenuInstalled()` gate makes handling
single-fire deterministically, and shortcuts keep working in browser mode
and on Win/Linux where no native menu is installed.

**How to apply.** Menu accelerators use muda syntax (`Cmd+Comma`, `Cmd+1`,
`Cmd+Shift+S` — `,` and `1` aliases also parse). Menu permissions need no
capability change: `core:default` already includes `core:menu:default`,
which allows all menu commands including `set-as-app-menu`. Repo-scoped
items take `enabled: hasRepo`; App reinstalls the menu when that flips
(menu handlers read the latest callbacks through a ref, so no rebuild per
render).

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
(`appMenuInstalled() && MENU_COMMANDS.has(cmd) && toMudaAccelerator(binding)`).
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
(pierre-dark + pierre-light), so theme flips don't re-highlight; settings
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
App's `commandHandlers`, and (if it should sit on the macOS menu) a `cmd:` on the
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

**How to apply.** GitHub merge commands use `--match-head-commit`; Azure
completion requests include `lastMergeSourceCommit`. Keep required checks,
reviews, queues, and branch policies provider-authoritative, preserve their
failure text next to the initiating control, and refresh the PR after a
successful request because queued completion may leave it active temporarily.

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
the existing snapshot path after history or checkout operations. Squash merges
do not preserve ancestry and therefore do not receive this mark.

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
promotion reuses the signed workflow artifact after exact-tag upload; there is
no post-upload release smoke matrix, so the desktop verifier remains the runtime
enforcement point for signature and hash agreement.

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
