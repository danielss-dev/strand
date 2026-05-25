# Strand

> A fast, friendly, cross-platform Git client.

Tauri 2 + Rust + React. See [`PRD.md`](./PRD.md) for the product spec.

## Layout

```
strand/
├── crates/
│   ├── strand-core/        # Git engine (gix for reads, git2 for writes)
│   └── strand-tauri/       # Tauri 2 app shell + IPC commands
├── ui/                     # Vite + React + TypeScript frontend
│   ├── src/
│   │   ├── components/     # Topbar, Sidebar, StatusBar, Icon
│   │   ├── views/          # LocalChanges, Commits, FileView, Palette
│   │   ├── stores/         # Zustand: settings, repo
│   │   ├── lib/            # Tauri command wrappers, shared types
│   │   └── styles/         # tokens, base, chrome, features
│   └── index.html
├── Cargo.toml              # workspace
├── package.json            # pnpm workspace root
└── pnpm-workspace.yaml
```

## Prerequisites

- **Rust** stable (`rustup default stable`)
- **Node** ≥ 20 and **pnpm** ≥ 9
- Platform deps for Tauri 2: see <https://v2.tauri.app/start/prerequisites/>

## First-time setup

```sh
pnpm install
```

Generate the icon set once (any 1024×1024 PNG works for now):

```sh
pnpm tauri icon path/to/source.png
```

## Develop

```sh
pnpm tauri:dev     # full app: Vite + Rust + native shell
pnpm dev           # frontend only, in a regular browser
```

The frontend detects when it isn't running inside Tauri and disables IPC
calls, so `pnpm dev` is useful for UI work without a Rust build.

## Build

```sh
pnpm tauri:build   # signed installers in target/release/bundle
```

## What's wired up

- Window chrome, sidebar, status bar, command palette (⌘K)
- Theme + density + platform + font tweaks (persisted via Zustand)
- Tauri IPC: `repo_open`, `repo_meta`, `repo_status`, `repo_log`
- SQLite plugin (recent repos + settings schema)
- Updater plugin (endpoint stub)

## What's still stubbed

- Diff rendering — waiting on `@pierre/diffs` license confirmation (PRD Q1)
- File tree — waiting on `@pierre/trees`
- Commit graph SVG (currently table-only)
- Fetch / pull / push, branch ops, stash, rebase — `strand-core` only exposes
  read paths today; mutating commands wrap `git2` and shell out as PRD §4
  describes
- Recent repos UI, multi-repo tabs

## Design source

The visual design originated as an HTML/CSS/JS prototype from Claude Design
(see `Strand.zip`). Tokens and component-level CSS in `ui/src/styles/`
are ported verbatim — when you tweak the visual identity, tweak it there.
