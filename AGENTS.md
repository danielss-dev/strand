# AGENTS.md

Notes for AI coding agents working on Strand. Read this first.

## Prime directive

Strand must be **stable, fast, and performance-first.** This is the lens
for every change: prefer correctness and predictable behavior over clever
shortcuts, and never regress a hot path. Performance is a feature, not an
afterthought — if a change trades responsiveness for convenience, it's the
wrong change. See PRD §8 for the concrete targets.

## Start here

- [`PRD.md`](./PRD.md) — what we're building and why.
- [`ROADMAP.md`](./ROADMAP.md) — milestones (0.1 alpha → 0.5 beta → 1.0).
- [`TASKS.md`](./TASKS.md) — granular work list with priorities.
- [`docs/learnings.md`](./docs/learnings.md) — **durable rules** distilled
  from earlier sessions. These override defaults. Read before changing the
  UI or making cross-cutting decisions, and append to it when you discover
  something future work needs to respect.

If a request conflicts with a learning, surface the conflict instead of
silently picking one — the learnings exist because we already paid for the
mistake once.

## Behavioral guidelines

Guidelines to reduce common LLM coding mistakes. Merge with the
project-specific instructions above as needed.

**Tradeoff:** these bias toward caution over speed. For trivial tasks, use
judgment.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs. Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If
yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess. When editing
existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-driven execution

Define success criteria. Loop until verified. Transform tasks into
verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make
it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.

## Project shape

- `crates/strand-core` — Rust git engine. Reads via `gix`, writes via
  `git2`. UI-agnostic.
- `crates/strand-tauri` — Tauri 2 shell. `commands.rs` exposes Rust ops to
  the webview; new ops get a wrapper there and a typed wrapper in
  `ui/src/lib/tauri.ts`.
- `ui/` — React + TypeScript front end. Zustand stores under
  `ui/src/stores/`, design tokens in `ui/src/styles/tokens.css`.

## Conventions worth knowing

- Cross-platform from day one: keyboard shortcuts use ⌘ on macOS, Ctrl
  elsewhere. Don't hardcode either.
- Keyboard-operable, almost everywhere: Strand is "keyboard-first, but
  never keyboard-only" (PRD §2). Almost every action must be doable from
  the keyboard alone — give each new surface a focus model, list/grid
  navigation, and a command-palette entry. Only inherently pointer-driven
  affordances (drag-and-drop) may stay mouse-only, and even then the
  action should be reachable another way. See `docs/learnings.md`.
- Pierre libraries (`@pierre/diffs`, `@pierre/trees`) are the rendering
  layer for code and trees. Wrap them in our own components so version
  bumps stay isolated.
- Strand is dark-only at the moment; theme management lands in 0.5 (see
  ROADMAP). Use CSS tokens from `tokens.css` — no hardcoded colors.
- Performance targets in PRD §8 are not aspirational. If a change makes a
  hot path slower, fix it before merging.

## Post-task ritual

After finishing any non-trivial task, before declaring "done":

1. **Update `TASKS.md`.** Flip the relevant rows:
   - `☐` → `◐` when you start partial work on a multi-step item.
   - `☐`/`◐` → `☑` when the row is genuinely complete.
   - When marking a row done, append a short parenthetical naming the
     concrete artifact (function, IPC command, UI surface) so a future
     reader can verify without diffing.
   - If you uncovered new work, add it as a `☐` under the right section
     instead of leaving it implicit in chat.
2. **Update `ROADMAP.md`.** If the task moved a milestone bullet from
   `☐`/`◐` to `☑` (or partially completed a multi-part item), reflect
   it. Add a dated "kick" / "shipped" paragraph at the bottom of the
   active phase when something substantial lands — it's the changelog
   for the milestone view.
3. **Update `README.md`** when user-visible behavior changed. The
   "Features" / "Status" sections should reflect reality. New top-level
   files/folders → update the layout block. Keep the README scannable —
   it isn't a changelog.
4. **Memory.** Save durable things (conventions, "why we did it this
   way", policy decisions) to the agent memory system. Don't write
   transient task state there.

Skip the ritual only when the change has no behavioral or planning
impact (typo fixes, comment tweaks, formatter passes).

## Workflow rules

- **One commit per logical change.** Don't bundle unrelated work.
- **Never** `--no-verify` or `--no-gpg-sign` without the user asking.
  Commit signing is configured intentionally.
- **Don't push without being asked.** Commits are local-by-default; the
  user decides when to publish.
- **Run the relevant checks before claiming green.** Rust:
  `cargo check -p strand-core -p strand-tauri`. Frontend:
  `pnpm --filter ./ui exec tsc --noEmit` (two pre-existing
  `waitForPaint`/`requestAnimationFrame` errors in `App.tsx` are noise —
  ignore them unless explicitly asked).
- **No drive-by refactors.** One-line fix stays one line. Open a
  follow-up `☐` in `TASKS.md` instead of expanding scope.
