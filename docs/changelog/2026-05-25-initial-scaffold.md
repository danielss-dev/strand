# 2026-05-25 — Initial scaffold

Bootstrapped the project from scratch on top of the `PRD.md` spec and the
`Strand.zip` handoff bundle from Claude Design. Goal: stand up a working
Tauri 2 + Rust + React + TypeScript shell that boots, talks to git via
the Rust backend, and renders the prototype's visual identity.

## Created

### Cargo workspace

- `Cargo.toml` at root — workspace + shared dependency versions, release
  profile tuned for size (`lto = "thin"`, `codegen-units = 1`, `strip`).
- `crates/strand-core/` — UI-agnostic git engine
  - `Repo::discover()` (gix)
  - `Repo::meta()` — branch name, ahead/behind placeholders
  - `Repo::status()` — index + working tree, via git2
  - `Repo::log(limit)` — topological revwalk, via git2
  - `diff::{FileDiff, Hunk, DiffLine, LineKind}` types (no impl yet)
  - `Error` enum wrapping gix/git2/io
- `crates/strand-tauri/` — Tauri 2 app
  - `main.rs`, `commands.rs`, `state.rs`
  - 4 IPC commands: `repo_open`, `repo_meta`, `repo_status`, `repo_log`
  - Plugins: `sql`, `updater`, `dialog`, `shell`, `os`
  - SQLite migration: `recent_repos`, `settings`
  - `tauri.conf.json` + `capabilities/default.json`
  - Placeholder icons generated via `pnpm tauri icon`

### Frontend (`ui/`)

- Vite 5 + React 18 + TypeScript 5 (strict)
- `vite.config.ts` pinned to port 1420 with HMR on 1421 (Tauri convention)
- Zustand stores
  - `settings` (persisted): theme, platform, density, diffMode, graphStyle,
    fonts
  - `repo`: active path, meta, status, commits, view selection
- `lib/tauri.ts` — typed `invoke` wrappers (never use string literals)
- `lib/types.ts` — TS mirrors of the Rust Serde types
- Components: `Icon` (40 SVG glyphs ported), `Topbar`, `Sidebar`, `StatusBar`
- Views: `LocalChanges`, `Commits` (table only), `FileView` (4-tab shell),
  `CommandPalette`
- Global keybindings: ⌘K palette, ⌘1/⌘2 view switch, Escape close
- Styles split from prototype into 4 files (verbatim port):
  - `tokens.css` — design tokens, dark/light themes, densities, branch colors
  - `base.css` — reset, body, scrollbars, `.spin` keyframe
  - `chrome.css` — window, topbar, sidebar, statusbar, primitives
  - `features.css` — diff, local changes, graph, file view, palette, toast

### Project root

- `package.json` + `pnpm-workspace.yaml`
- `.gitignore` (Rust + Node + Tauri gen + the design bundle)
- `README.md` — layout, prereqs, dev/build commands

## Issues hit and fixed

| Symptom | Cause | Fix |
|---|---|---|
| `tauri dev` couldn't find `tauri.conf.json` | Ran via `pnpm --filter strand-ui`, but Tauri CLI walks subfolders of its cwd and the config lives in a sibling crate | Moved `@tauri-apps/cli` to root `package.json`; run `tauri dev` from workspace root |
| `gix::Repository` cascade — 65 compile errors, all rooted in `RefCell<…>: !Sync` | Stored `Repo` in `Tauri::State<AppState>`, which requires `T: Send + Sync` | Removed `Repo` from app state. Commands now call `Repo::discover(&path)` per invocation. State only tracks open path strings. |
| `tracing_subscriber::EnvFilter not found` | `env-filter` feature not enabled | Added `features = ["env-filter"]` to `tracing-subscriber` dep |
| `generate_context!()` failed: "failed to open icon" | `tauri.conf.json` referenced icon files that didn't exist | Generated placeholder icons with `magick` + `pnpm tauri icon` |
| Duplicate macOS traffic lights | Prototype rendered fake dots for browser preview; in Tauri the OS draws real ones | Hide `.traffic` div when `isTauri()` is true; added `:where(html.tauri)` style block to fill the OS window |
| Native traffic lights misaligned with topbar | Topbar was 44px tall; macOS centers controls at y≈14 | Added `.topbar[data-native-chrome="mac"]` rule: height 32px, left padding 78px to clear the dots, and 24px height for child controls |

## Verified working

- `pnpm install` → 4s, 121 packages
- `pnpm tauri:dev` → Vite on :1420, Cargo builds 606 deps + workspace,
  native macOS window opens
- Sidebar, topbar, command palette (⌘K), theme persistence, native chrome
  alignment

## Deliberately not done

- Pierre libraries (`@pierre/diffs`, `@pierre/trees`) — blocked on PRD Q1
  (licensing). Diff view, file tree, and commit graph SVG all wait on this.
- Any write operation: commit, stage/unstage, branch ops, merge, rebase, etc.
- Open-repo dialog — store has `openRepo(path)` but no UI calls it yet.
- Recent-repos persistence — SQLite tables exist, no readers/writers.
- Window controls for Win11 platform are styled but untested (built on macOS).
