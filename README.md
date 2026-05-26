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
├── pnpm-workspace.yaml
└── AGENTS.md               # working agreement for AI/dev agents (CLAUDE.md → here)
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
- Open-repo flow with multi-repo tabs, recent repos, and palette nav
- Staging: diff view + stage/unstage + commit loop with resizable panes
- Network: fetch / pull / push with ahead/behind counts
- Refs: branches (with upstream + ahead/behind), remotes, remote-tracking
  branches, and tags — feeds the topbar branch picker
- Tauri IPC: `repo_open`, `repo_meta`, `repo_status`, `repo_log`,
  `repo_refs`, plus the staging and network commands above
- SQLite plugin (recent repos + settings schema)
- Updater plugin (endpoint stub)

## What's still stubbed

- File tree — `@pierre/trees` integration pending
- Commit graph SVG (currently table-only)
- Branch ops, stash, rebase — mutating commands wrap `git2` and shell out as
  PRD §4 describes (refs are read-only today; checkout/create branch from
  the picker still toast-stubbed)

## Design source

The visual design originated as an HTML/CSS/JS prototype from Claude Design
(see `Strand.zip`). Tokens and component-level CSS in `ui/src/styles/`
are ported verbatim — when you tweak the visual identity, tweak it there.

## License

Strand is dual-licensed:

- **AGPL-3.0** for the public distribution. Anyone can read, build, modify,
  and use the source under the standard AGPL terms.
- **Commercial license** (one-time purchase) for companies that prefer not to
  take on AGPL obligations or want to support development.

The app is fully functional for everyone — no feature gating, no nag dialogs,
no trial period. The commercial license is honor-system: free for individuals,
appreciated for company use. See `COMMERCIAL.md` for details.
