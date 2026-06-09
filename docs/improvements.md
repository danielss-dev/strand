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
- **Auto-update endpoint (P1).** Signing is done; `strand.danielss.dev` manifest
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
