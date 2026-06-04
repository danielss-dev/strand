# Strand

> A fast, friendly, cross-platform Git client.

Tauri 2 + Rust + React. See [`PRD.md`](./PRD.md) for the product spec.

Keyboard-first: almost every action is operable from the keyboard alone —
never keyboard-only, the mouse stays first-class.

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
- Staging: diff view + stage/unstage + commit loop with resizable panes;
  per-change-block Stage / Discard (and Unstage on the staged side)
  inline in the diff via Pierre annotations; stacked / split diff layout
  toggle remembered per repo
- Commit graph: SVG lanes + branch/tag chips inline; click a commit to
  open a resizable detail panel with the commit's metadata, file list,
  and per-file diff; keyboard focus starts on the current commit, ↑/↓ moves
  through commits, Enter opens details, and Esc closes them
- Network: fetch / pull / push with ahead/behind counts
- Refs: branches (with upstream + ahead/behind), remotes, remote-tracking
  branches, and tags — feeds the topbar branch picker
- Branch writes: checkout a local branch, create a branch via an inline
  field with prefix autocomplete (auto-tracks when started from a
  remote), delete a branch via the sidebar — wired into the topbar
  picker and sidebar Git tab
- Stashes: list / apply / pop / drop in the sidebar Stashes section, plus
  create from the topbar stash menu or a Save-snapshot dialog (message +
  include-untracked + keep-changes-in-working-dir), reachable via the
  sidebar `+`, the topbar menu, and ⌘K
- Tags: create (lightweight or annotated) from the sidebar Tags `+`, ⌘K, or a
  commit's detail panel; click a tag to check out its commit; right-click for
  push to the default remote, delete on the remote (grayed out for tags the
  remote doesn't have), or delete locally (each delete behind a confirm step);
  ⌘K "Push all tags"
- Sidebar row actions live in a right-click menu (branches, remotes, tags,
  stashes) — keyboard-openable via the Menu key / Shift+F10; the primary
  action also runs on click
- Tauri IPC: `repo_open`, `repo_meta`, `repo_status`, `repo_log`,
  `repo_refs`, `repo_diff_commit`, plus the staging, network, branch,
  and tag commands above
- SQLite plugin (recent repos + settings schema)
- Updater plugin (endpoint stub)

## What's still stubbed

- File tree — `@pierre/trees` integration pending
- Commit graph: multi-select, search, and Files-tab re-rooting to the
  selected commit
- Rebase, cherry-pick, merge, revert — mutating commands wrap
  `git2` and shell out as PRD §4 describes. Branch checkout/create/delete
  and stashes are wired; stash branch-from and checkout from an arbitrary
  commit (detached HEAD) still pending.

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
