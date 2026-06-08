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
