# Improvement proposals

> Suggestions from a full-repo review (2026-06-09), organized around Strand's three
> stated pillars — **fast, reliable, efficient** — plus the emerging primary use
> case: **reviewing changes made by AI coding agents**. Each item cites the code it
> refers to. Nothing here is started; this is a menu, not a commitment.

Priority key: **P0** = directly serves the AI-review focus or fixes a real
reliability hole · **P1** = strong improvement, schedule soon · **P2** = nice to have.

> **Implementation status (2026-06-09):** everything below landed in one pass
> except the items that can't be done from this machine or were judged not
> worth their weight:
>
> - ✅ 1.1 watcher · 1.2 baseline diff · 1.3 review state · 1.4 bulk verdicts +
>   snapshot net · 1.5 word-level diffs (pinned explicitly; was Pierre's
>   default) · 1.6 AI commit chips
> - ✅ 2.1 Vitest suite · 2.2 PR CI (incl. clippy `-D warnings`; the "two
>   pre-existing tsc errors" turned out to no longer exist) · 2.3 cancellation
> - ✅ 3.1 `repo_snapshot` · 3.2 graph virtualization · 3.3 diff single-pass ·
>   3.5 webview perf marks (`lib/perf.ts`; numbers still to be recorded)
> - ✅ 4.1 keyboard review loop · 4.3 palette coverage (stashes, submodules,
>   review actions) · 4.4 external mergetool
> - ✅ 5: local crash log (panic hook → `crash.log`); clippy is the Rust lint
>   gate
> - ⬜ 4.2 tree keyboard nav — **already native**: `@pierre/trees` handles
>   arrow-key navigation in its focus model; the gap report was stale.
> - ⬜ 2.4 backend call cancellation tokens, 3.4 on-demand diff payloads —
>   deliberately deferred (P2; no measured need yet).
> - ⬜ Frontend lint config (Biome/ESLint) — deferred; tsc strict + Vitest +
>   clippy gate CI for now.
> - ⬜ Auto-update endpoint hosting and Pierre license verification — external
>   actions, not codebase changes.
>
> Details per item below are the original proposals, kept for rationale.

## Second pass (2026-06-11)

A ten-item implementation pass over the next ring of gaps — mostly "real git
client" table stakes plus two review-loop features. Everything landed in the
working tree in one batch:

- **git reset** (soft/mixed/hard, safety snapshot before a dirty hard reset) +
  reflog recovery menu + "Undo last commit" — `crates/strand-core/src/reset.rs`,
  `ui/src/views/ResetDialog.tsx`, `ui/src/views/Reflog.tsx`
- **Remote management** (add/rename/set-url/remove) + **branch rename** —
  `crates/strand-core/src/remote.rs`, `branch.rs`, `ui/src/views/RemoteDialog.tsx`,
  `RenameBranchDialog.tsx`, `ui/src/components/Sidebar.tsx`
- **Commit signing** via shell-out when `commit.gpgSign=true` —
  `crates/strand-core/src/commit.rs` (default unsigned path stays git2)
- **Gitignore quick-add** for untracked files (root-anchored + `*.<ext>`) —
  `crates/strand-core/src/ignore.rs`, `ui/src/lib/ignore.ts`
- **fixup! commit creation + autosquash** in the rebase editor —
  `ui/src/lib/rebase.ts`, `ui/src/views/RebaseEditor.tsx`, `Commits.tsx`
- **Copy diff as patch / Markdown** (tree menus + palette) —
  `ui/src/lib/patchExport.ts`
- **In-diff text search** (⌘F over the whole diff pool in Local Changes +
  Review) — `ui/src/lib/diffSearch.ts`, `ui/src/components/DiffSearchBar.tsx`
- **Image diff preview** (side-by-side Before/After in Local Changes, Review,
  CommitDetail) — `crates/strand-core/src/file.rs` (`file_blob`),
  `ui/src/components/ImageDiff.tsx`
- **Review annotations + feedback export** (notes on files/hunks → one
  markdown prompt for the agent) — `ui/src/lib/reviewExport.ts`,
  `ui/src/views/Review.tsx`, `ui/src/stores/repo.ts`

Still deliberately open (assessed as on-radar, pulled-forward priorities — not
part of this pass): line-level staging, the rebase `edit` action, the
multi-repo-tab architecture work, full-history / `-G` content search, and a
GitHub/GitLab PR review surface.

---

## 1. AI-change review as a first-class surface

The PRD (§12 Q3) defers "AI features" to 1.1+, but those were *generative* features
(commit message suggestions, conflict hints). Reviewing an agent's edits is a
different thing — it's a **review workflow**, and today Strand has the primitives
(hunk staging, discard+undo, snapshots) but not the workflow. These are the gaps:

### 1.1 File watcher — auto-refresh while the agent works (P0)

Today the UI refreshes only on window focus/visibility (400ms debounce,
`ui/src/App.tsx:359-381`) or a manual button. The defining scenario — Strand open
on one monitor while Claude Code edits files in a terminal on the other — shows a
**stale view until you click into the window**.

- Add a working-tree watcher in `strand-tauri` (the `notify` crate; watch the
  workdir, ignore `.git/` internals except `HEAD`, `index`, and refs so commits and
  branch switches are also caught).
- Debounce aggressively (agents write in bursts — 300–500ms after last event) and
  emit a single `repo://changed` Tauri event; the frontend reuses the existing
  `refreshLocalChanges()` path (`ui/src/stores/repo.ts:687`).
- Status on the 10k-file fixture is ~85ms (`docs/perf-baseline.md`), so a
  refresh-on-event model is well within budget. Keep the focus-refresh as fallback.
- Make it per-tab and suspendable (pause while a modal/conflict resolver is open).

This is the highest-leverage single change for the AI-review use case.

### 1.2 Baseline ("review since…") diffing (P0)

Reviewing an agent session means "show me everything since I let it loose", which
is not always `HEAD..worktree` — the agent may have made commits. Today the diff
pane only knows unstaged/staged (`repo.ts` `refreshDiffs`).

- Add a **session baseline marker**: one click (or automatic on first change burst)
  records the current `HEAD` OID + a workdir snapshot (the `stash.rs` snapshot
  infrastructure already creates a stash without touching the tree — reuse it).
- New backend op `diff_since(baseline_oid)` — `git2::diff_tree_to_workdir_with_index`
  against the baseline tree. Mostly plumbing; `diff.rs` already has the collect path.
- UI: a baseline chip in Local Changes ("Reviewing 23 files since 04aa634 · 2:14 PM")
  with a one-click reset.

### 1.3 Review-state tracking (P0)

There is no way to mark "I've looked at this file" — with a 40-file agent diff you
lose your place after every refresh (and 1.1 will make refreshes constant).

- Session-scoped `reviewed: Set<path+contentHash>` in the repo store; keyed on a
  hash of the file's diff so a file flips back to *unreviewed* if the agent touches
  it again after you marked it.
- Badge rows in the Unstaged tree (`ui/src/views/LocalChanges.tsx`); show
  "12/23 reviewed" progress in the commit bar; `Space` toggles reviewed on the
  focused row, `j`/`k` to walk files (see 4.1).
- Persist in SQLite keyed by repo+baseline so an app restart mid-review doesn't
  lose state (`ui/src/lib/db.ts` already has the migration pattern).

### 1.4 Bulk accept / reject with a safety net (P1)

Per-file and per-hunk operations exist; verdict-level operations don't. Reviewing
an agent change usually ends with "accept all of this" or "throw it all away".

- "Stage all reviewed" / "Discard all unreviewed" actions on top of the existing
  batched IPC (`repo_stage_many` etc. — learnings.md rule 3).
- **Before any multi-file discard, take an automatic snapshot stash** (the
  `stash.rs` snapshot op) and extend the undo toast to restore it. The current undo
  is a single hunk with a 6-second window (`App.tsx:736-766`) — too small a net for
  "discard 30 files" actions. Suggest: keep last N snapshots in a "Safety" section
  under Stashes, auto-pruned after a few days.

### 1.5 Word-level (intra-line) diff emphasis (P1)

Agents often change one identifier or argument on a long line. `@pierre/diffs`
supports inline word/character highlights (PRD §6.3 lists it as P0) but Strand
doesn't enable it in the staging diff. Verify the prop wiring in
`ui/src/components/Diff.tsx` and the hunk overlay path (`LocalChanges.tsx:485-767`).

### 1.6 AI-commit awareness in the graph (P2)

Agent-made commits are identifiable (`Co-Authored-By: Claude …` trailers, distinct
author/committer). Parse trailers in `log.rs` (the `-z` shell-out already carries
the body) and render a subtle robot chip next to branch/tag chips in
`Commits.tsx`. Combined with 1.2, "select all commits since baseline" gives a
one-click review of an agent's whole session including its commits.

---

## 2. Reliability

### 2.1 Zero frontend tests (P0)

`ui/` has no test runner at all. The riskiest pure-logic modules are exactly the
ones an LLM (or human) will quietly break:

- `ui/src/lib/patch.ts` — `sliceChangeBlock()` carves synthetic single-hunk patches
  for stage/discard. A bug here **corrupts the user's working tree**. This needs
  property-style tests (slice + reverse round-trips, no-newline markers, CRLF).
- `ui/src/lib/graph.ts` — lane assignment assumes a complete topologically-ordered
  list (learnings rule 18); regressions render a garbled graph.
- `ui/src/lib/conflictParse.ts` — marker parsing feeds the resolver that *writes
  files back*.
- Palette fuzzy scoring (`ui/src/views/Palette.tsx`).

Add Vitest (no DOM needed for these four — they're pure functions), wire into the
pre-claim checklist in AGENTS.md alongside `cargo check`/`tsc`.

### 2.2 PR-level CI (P0)

`.github/workflows/release.yml` exists but only runs on tags. There is no gate
that runs `cargo test -p strand-core`, `cargo clippy`, `tsc --noEmit`, or (once
added) Vitest on pushes/PRs. For a repo where AI agents author most changes, CI is
the review backstop — it should exist before more feature work. Cheap matrix:
ubuntu only for checks; the release workflow stays as is.

Also: fix the two pre-existing `tsc` errors in `App.tsx`
(`waitForPaint`/`requestAnimationFrame` noise) so "tsc clean" is a meaningful
signal again — a check that's known-red gets ignored.

### 2.3 Cancellation for long operations (P1)

Clone/fetch/pull/push spawn `git` with no way to interrupt (`network.rs:213-274`).
A hung clone (bad SSH agent, network drop) leaves a spinner forever. Store the
child handle keyed by an operation id in Tauri `AppState`, expose `repo_cancel(id)`
that kills the child, surface a Cancel button on the progress popup. Likewise add
a timeout for non-interactive fetches.

### 2.4 In-flight Rust call cancellation in the UI (P2)

Frontend `cancelled` flags (e.g. `FileView.tsx`) prevent stale `setState` but the
backend call keeps running. Fine for cheap reads; once `diff_since` (1.2) and big
blames exist, consider a generation-token convention so the backend can early-exit.

---

## 3. Performance / efficiency

The engine targets already pass with margin; these are the known remaining items,
roughly ordered by user-perceived impact for the AI-review workflow:

### 3.1 `repo_snapshot` batched refresh (P1)

Every refresh fires five parallel IPC calls (`status`, `log`, `meta`, `refs`,
`submodules` — `App.tsx:325-328`), each re-discovering the repo and `work_tree` +
`status` each doing a **separate full `git2::statuses()` walk** (~42ms × 2,
`status.rs:28-70`, `tree.rs:25-57`). One `repo_snapshot` command that opens once,
walks statuses once, and returns the bundle halves the refresh cost and removes
IPC chatter. This matters more once the watcher (1.1) makes refreshes frequent.
(Both already tracked in TASKS.md → Performance; raising priority because of 1.1.)

### 3.2 Commit graph virtualization (P1)

`Commits.tsx` renders every loaded commit into one `<tbody>`. Fine at the 500
first page; at "load more" × N or full-history it will jank. Blame already has a
hand-rolled fixed-height virtual list (`FileView.tsx:192-291`) — extract and reuse
the same pattern (rows are fixed-height already).

### 3.3 Diff `collect()` single-pass rewrite (P1)

`diff.rs:136-207`: the foreach+print double walk with an O(files×lines) linear
`delta_index` search is the dominant cost of `diff_unstaged` (~150ms on the
501-file fixture). Hash deltas by path and merge counting into the print pass.
Already on TASKS.md; it's the hot path the watcher will hit on every burst.

### 3.4 Large-diff payload strategy (P2)

A 500-file agent changeset serializes as one JSON blob over IPC. Works today;
won't scale to pathological agent runs. Two cheap mitigations before real
streaming: (a) return file list + stats first, fetch patch text per file on demand
(the viewport-lazy mounting in `LocalChanges.tsx:401-417` already only *renders*
on demand — make it *fetch* on demand too); (b) cap patch text per file with an
explicit "load full diff" escape hatch.

### 3.5 Webview-side measurements (P1)

Four PRD §8 targets are still unmeasured (cold start, 5k-line diff render,
perceived hunk stage, idle memory — `docs/perf-baseline.md`). Add a simple
`performance.mark` harness behind a dev flag so numbers come from the running app,
and record them in the baseline doc before 0.5 ships. You can't defend "fast" as
a feature without the headline numbers.

---

## 4. UX / keyboard gaps

### 4.1 Review-loop keyboard model (P0, pairs with §1)

The staging workspace has no keyboard path through a big diff: no next/previous
file, no next/previous hunk, stage/discard are mouse-overlay buttons
(`LocalChanges.tsx` hunk overlays). For reviewing an agent's 40-file change, the
loop should be: `j`/`k` next/prev file · `n`/`p` next/prev hunk · `s` stage hunk ·
`d` discard (with confirm) · `Space` mark reviewed · `c` focus commit message.
This is the single biggest "keyboard-first" promise gap (PRD §2, learnings rule 2).

### 4.2 File tree keyboard navigation (P1)

`@pierre/trees` rows activate via Enter but arrow-key tree navigation
(expand/collapse, move) isn't wired (`ui/src/components/PierreTree.tsx`). Same
rule-2 gap.

### 4.3 Palette coverage (P2)

Stashes, submodules, and sidebar section jumps aren't in the command palette;
actions like "apply stash…" should be. The `PaletteAction` pattern
(learnings rule 16) makes this additive work in `App.tsx:424-512`.

### 4.4 External mergetool fallback (P2)

The pick-sides-only conflict modal is a deliberate constraint (learnings rule 5),
but some conflicts genuinely need editing. Honoring `git config merge.tool` as an
escape hatch (PRD §6.4 P1) keeps the modal simple while unblocking the hard cases.

---

## 5. Housekeeping

- **Lint config (P1).** No clippy config, no ESLint/Prettier/Biome. Pick one
  frontend toolchain (Biome is the low-overhead choice), add `cargo clippy -- -D
  warnings` to CI (2.2), and codify both in AGENTS.md's pre-claim checklist. For an
  agent-authored codebase, linters catch the classes of mistakes agents make most.
- **Crash reporting & opt-in telemetry (P2).** PRD lists both as P0 for launch;
  nothing exists yet. At minimum wire a panic hook + Tauri webview error listener
  to a local log file now, so alpha bug reports come with evidence — the opt-in
  remote part can come later.
- **Auto-update endpoint (P1).** Signing is done; `strandgit.com` manifest
  hosting is the last blocker (ROADMAP 0.5). Cheap to finish, unblocks the beta
  loop.
- **License clarity for Pierre libs (P0-before-launch).** PRD open question 1 is
  still open; everything renders through `@pierre/diffs`/`@pierre/trees`. Resolve
  before any public release.

---

## Suggested sequencing

1. **CI + patch.ts tests** (2.1, 2.2) — backstop everything that follows.
2. **File watcher** (1.1) → **`repo_snapshot` + diff collect** (3.1, 3.3) — the
   watcher makes these hot.
3. **Review keyboard loop + review state** (4.1, 1.3) — turns Strand from "a git
   client that can show agent diffs" into "the tool you review agents with".
4. **Baseline diffing + bulk accept/reject with snapshots** (1.2, 1.4).
5. The P1 tail: cancellation, graph virtualization, webview measurements, lint.

Items 2–4 together are a coherent 0.6 theme: **"watch the agent work, review it
fast, accept or reject it safely."** That's a positioning no mainstream git client
(Tower, Fork, GitKraken) currently owns.

---

# Worktrees pass (2026-07-07) — proposals

> From a research sweep across (a) Strand's current worktree code, (b) how other
> tools expose worktrees (Fork, Tower, GitKraken Agent Mode, SmartGit, lazygit,
> Zed, JetBrains 2026.1, Conductor, Vibe Kanban, Claude Squad, Cursor, Claude
> Code's own `--worktree`), and (c) how developers actually run parallel AI
> agents on worktrees. Menu, not commitment.

> **Implementation status (2026-07-07):** W1 + W2 + W3 landed the same day —
> `Repo::worktree_health` / `integrate_worktree_branch` /
> `archive_worktree_state` + restore/list/delete in `worktree.rs`, six new IPC
> commands, merged/unpushed badges + Clean up + Prune on the overview,
> `WorktreeMergeDialog` with exact-command preview, archive-before-every-remove
> in the store, and a restorable "Archived snapshots" strip. The
> `run_blocking` fix from W9 rode along.
>
> **Second worktrees pass (2026-07-08):** everything else landed — W4
> (`.worktreeinclude` copy on create + agent-tool badges; the optional
> post-create command stays deferred as launcher territory), W5
> (`worktree_stats`: disk size, last-activity, ±lines; recent-first sort), W6
> v1 (row selection + `WorktreeCompareDialog` with shared-file highlighting
> and Pick winner → merge), W7 (pairwise dirty-file overlap badges + merge
> dialog warning), W8 (start-point picker with track/fetch-first, "New
> worktree from here…" in branch/commit menus, `lock`/`unlock`; `move`/`repair`
> still open), and the follow-ups: archive auto-prune (10 per slug / 60 days),
> sidebar Review-vs-base + Merge-&-clean-up, palette Clean up / Prune, ⌘4→⌘5
> copy drift. Remaining `☐`s live in TASKS.md → Worktrees.

**Where the market landed (2025–2026).** Every agent orchestrator (Conductor,
Vibe Kanban, Cursor, GitKraken Agent Mode, Claude Code itself) rebuilt the same
Git-client subset: worktree list → diff review → merge+cleanup. The pure
worktree multiplexers died or pivoted (Crystal deprecated, Vibe Kanban shut
down, Terragon shut down, Sculptor pivoted); the survivors are the
**review-centric** ones. Strand approaches from the other side — it already has
the review surface — so the play is to own the worktree *lifecycle around
review*, not to become an agent launcher.

**What Strand already has** (all shipped): worktrees dashboard (Mod+5) with
per-row Review at the detected merge-base (DAN-14), create dialog with sibling
`<family>.worktrees/<slug>` default, family grouping by `common_dir` everywhere
(rail, tabs, workspaces), branch-held-elsewhere → navigate-to-worktree instead
of erroring (the Fork/SmartGit pattern), per-worktree workspace review members.
That's already ahead of Fork/Tower. The gaps are lifecycle (setup, cleanup,
merge-back) and fleet legibility.

## W1. Close the review loop: merge-and-clean-up as one action (P0)

The canonical agent-worktree session ends with "this is good — land it and make
the worktree go away". Today that's N manual steps across two tabs. Every tool
studied converged on one command (Worktrunk `wt merge`, Crystal's
"Squash and rebase to main", Vibe Kanban's one-click merge, Cursor
`/apply-worktree`).

- After a worktree review, offer **"Merge into <parent> & remove worktree"**:
  squash or merge the worktree branch onto its detected base branch
  (`refs.rs::detect_base_branch` already knows the parent), fast-forward the
  parent's worktree if clean, then `worktree remove` + `branch -d`.
- Crystal's touch worth copying: the confirm dialog **previews the exact git
  commands** it will run. Trust through legibility.
- Guard rails: refuse (or downgrade to "merge only") when the worktree has
  uncommitted changes; take a snapshot ref first (W3).
- Surface it in three places: the Worktrees overview row, the review header
  when reviewing a worktree session, and the sidebar worktree context menu.

## W2. Dirty-aware cleanup + merged detection (P0)

Stale worktrees pile up because deletion is scary — some hold unpushed agent
work. The safety pattern that separates "trustworthy" from "scary"
(Claude Code's exit policy, GitKraken's merged-PR pill):

- Classify each worktree: **clean+merged** (branch fully merged into its base —
  cheap `merge_base == branch tip` check), **clean+unmerged**,
  **dirty**, **has unpushed commits**. Show it as a badge; GitKraken's
  "merged" pill is the cleanup cue users act on.
- Dashboard-level **"Clean up" action**: one click removes all clean+merged
  worktrees and their branches; dirty/unpushed ones are listed but require
  explicit per-row confirmation. Never blind-sweep.
- Surface `prunable <reason>` from `worktree list --porcelain` (already parsed
  into `is_prunable`, reason is dropped — `worktree.rs` keeps only the flag) and
  add a dashboard **Prune** button; today prune hides in a sidebar context menu
  that only appears on prunable rows (`Sidebar.tsx:705-707`).
- Display `lock_reason` — parsed, typed, carried to the frontend
  (`types.ts:270`) and never rendered anywhere. Dead data today.

## W3. Archive-before-remove: snapshot ref safety net (P1)

Conductor's best idea: before removing a worktree, snapshot **committed +
uncommitted + untracked** state into a git ref, restorable later. Removes all
fear from cleanup, which is the root cause of stale pile-up.

- Strand already has the no-touch snapshot-stash infrastructure (`stash.rs`,
  used by the discard safety net). Extend: on any worktree remove, create a
  snapshot (e.g. `refs/strand/worktree-archive/<name>@<date>`), keep last N,
  auto-prune after a few weeks.
- A small "Archive" section (or filter on the Worktrees overview) lists
  snapshots with one-click **Restore as new worktree**.
- This also unlocks Claude Squad's cheap **pause/resume**: "Shelve worktree" =
  snapshot + remove directory + keep branch; "Resume" = re-add worktree from
  branch. Reclaims disk (the #3 complaint: 9.8 GB for two worktrees of a 2 GB
  repo) without losing anything.

## W4. Setup: copy-list + honor agent-tool conventions (P1)

The single most-cited worktree pain everywhere: gitignored files (`.env`,
`settings.local`, `.venv`) don't exist in a fresh worktree, so agents can't
even run tests. The field converged on a declarative copy-list + post-create
script:

- On worktree create, **copy gitignored files matching a pattern list** from
  the source worktree. Honor existing config the user already has —
  `.worktreeinclude` (Claude Code), `git.worktreeIncludeFiles`-style globs —
  before inventing a Strand-only format; fall back to a per-repo setting with
  a sane default offer ("Copy .env* into the new worktree?").
- Optional **post-create command** (per-repo setting, e.g. `pnpm i`), run with
  `STRAND_WORKTREE_PATH` / `STRAND_ROOT_PATH` env vars, output streamed into
  the progress toast. Explicitly opt-in — Strand is a client, not a launcher.
- Recognize the naming conventions agents generate so the dashboard reads
  well: `worktree-<name>` / `.claude/worktrees/` (Claude Code), `vk/<id>-slug`
  (Vibe Kanban), `<user>/` prefixes — strip the noise in `worktreeName` labels
  and badge the tool that created it when detectable.

## W5. Fleet dashboard: status at a glance (P1)

The wishlist item users state most often: "which worktree has which task, and
is anything happening in it?" The overview (`views/Worktrees.tsx`) already has
per-row dirty/ahead-behind/drift; missing:

- **Last-activity time** (mtime of index / newest workdir change) — "touched
  3 min ago" is a decent proxy for "agent is working" without process
  spying; sort recent-first.
- **Merged / unpushed / prunable-reason / lock-reason badges** (from W2).
- **Per-worktree disk size** (background `du`, cached) — makes the cost of
  stale trees visible and motivates cleanup.
- **Uncommitted-summary line** ("+412 −38 across 23 files") so triage doesn't
  require opening each tab. The existing lazy `repoStatus` per-row fetch
  already has the data.
- Optional later: detect a running agent by lock holder or heuristics
  (Claude Code holds `git worktree lock` while a session runs — read the
  reason string).

## W6. Best-of-N: compare sibling attempts (P1, review differentiator)

Running the same task in 2–4 worktrees and picking the winner is now a
first-class pattern (Cursor `/best-of-n` productized it). Nobody offers a good
*comparison* UI — that's a review problem, i.e. Strand's home turf.

- Let the user **select 2+ worktrees of one family** in the overview and open
  a compare view: same baseline (shared merge-base), side-by-side or tabbed
  per-attempt diffs, file-list intersection highlighted ("both touched
  `auth.ts`, only attempt B touched migrations").
- Verdict: **pick winner** → offer W1 merge for it and W2/W3 cleanup for the
  losers in one flow.
- Cheap v1: even just "open N worktree review sessions as adjacent tabs with
  synchronized file focus" beats everything on the market.

## W7. Cross-worktree overlap warning (P2, nobody does this)

Parallel agents silently diverge and conflicts only surface at merge time
(GitButler's core critique of worktrees). Strand sees all worktrees of a
family and their diffs-vs-base:

- Compute pairwise **file-set overlap** between dirty worktrees of a family;
  badge the dashboard rows ("overlaps fix-auth: 3 files") and warn in the W1
  merge dialog when a sibling worktree touches the same files.
- Full conflict prediction (merge simulation) is overkill; path-set
  intersection catches most of it for free from data already fetched.

## W8. Create-from-anything (P2)

The create dialog is HEAD-only (`WorktreeDialog.tsx:142`; `add_worktree`
hard-codes `-b <branch> <dest>`). Lazygit puts "new worktree" in seven panels;
GitKraken creates from a PR. For Strand:

- **Start-point picker** in the dialog: any local/remote branch, tag, or
  commit; remote branches create with `--track`.
- **"New worktree from here"** in the branch and commit context menus (the
  branch menu already grew "Review <current> vs this" — same pattern).
- **Fetch-first option**: "base on origin/HEAD (fetch first)" checkbox — the
  Conductor/Claude Code default that avoids building on a stale local main.
- Engine: extend `add_worktree` with start-point + track flags; add
  `worktree lock/unlock` (reason string), `move`, `repair` while in there —
  all missing, all trivial shell-outs (`worktree.rs`).

## W9. Small fixes surfaced by the audit (P2, quick)

- `repo_worktree_add/remove/prune` are `#[tauri::command(async)]` but call the
  blocking git shell-out directly (`commands.rs:549-567`) — route through
  `run_blocking` like `repo_worktrees`; a slow post-checkout hook currently
  blocks an executor thread.
- "Review vs base" is only reachable from the overview; add it to the sidebar
  worktree context menu (`Sidebar.tsx:690-709`) and rail/tab menus.
- Keybinding copy drift: Worktrees is Mod+5 (`keys.ts:81`) but ROADMAP/prose
  still say ⌘4.

## Suggested sequencing (worktrees)

1. **W9 + W2** — safety and legibility first; small engine surface
   (merged-check, prunable reason, lock reason) with immediate dashboard value.
2. **W1 merge-and-cleanup** riding on W2's classification, with W3's snapshot
   as its guard rail (build W3's snapshot op first, UI later).
3. **W4 setup copy-list** — table stakes for the agent audience; honor
   `.worktreeinclude` for free adoption.
4. **W5 fleet dashboard** polish, then **W6 best-of-N** as the flagship
   review differentiator, with **W7 overlap warnings** feeding both.
5. **W8** whenever the dialog is next touched.

W1–W3 together make the pitch: **"the only Git client where cleaning up after
an agent is one safe click."** W6+W7 make the second pitch: **"the only place
to compare N agent attempts and land the winner."**
