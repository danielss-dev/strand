# AGENTS.md

Notes for AI coding agents working on Strand. Read this first.

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
- Pierre libraries (`@pierre/diffs`, `@pierre/trees`) are the rendering
  layer for code and trees. Wrap them in our own components so version
  bumps stay isolated.
- Strand is dark-only at the moment; theme management lands in 0.5 (see
  ROADMAP). Use CSS tokens from `tokens.css` — no hardcoded colors.
- Performance targets in PRD §8 are not aspirational. If a change makes a
  hot path slower, fix it before merging.
