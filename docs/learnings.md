# Learnings

Things we've learned while building Strand that aren't otherwise obvious from
the PRD / ROADMAP / TASKS files. Append here when you discover something
that future work (yours or another agent's) needs to respect.

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
