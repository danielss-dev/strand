# Getting Started

Strand is a fast, keyboard-first Git client for macOS, Windows, and Linux, built for reviewing what AI coding agents do to your code — and for everyday Git work. This page covers installing Strand, opening your first repository, and finding your way around the main window.

## A note on `Mod`

Throughout this guide, `Mod` means **⌘ on macOS** and **Ctrl on Windows and Linux**. So `Mod+K` is ⌘K on a Mac and Ctrl+K everywhere else. Every global shortcut shown here is rebindable in [Settings](settings.md) → Keyboard.

## Install

Download the latest release from [GitHub Releases](https://github.com/danielss-dev/strand/releases/latest). Installers range from roughly 15 MB (Windows MSI, Linux `.deb`/`.rpm`) to about 31 MB (macOS universal DMG); the Linux AppImage is larger, at around 90 MB.

| Platform | Artifact | Notes |
|---|---|---|
| macOS | `.dmg` | Universal binary (Apple Silicon + Intel), Developer ID–signed and notarized |
| Windows | `.msi` | Windows 11; the installer is not yet code-signed |
| Linux | `.deb`, `.rpm`, `.AppImage` | Built on Ubuntu 22.04; AppImage includes a keyless Sigstore verification bundle |

You can also build from source with Rust stable, Node.js 20+, pnpm 9+, and the Tauri 2 platform dependencies.

Strand is open source (AGPL-3.0) and free for individuals. Companies can buy a one-time commercial license as an alternative to the AGPL; nothing in the app checks or enforces it — the same build works for everyone, with no license keys or feature gating.

## First launch

Strand is a local-first desktop app: there are no accounts to create and no product telemetry. Crash details stay in a local log; the optional report flow only opens a pre-filled GitHub issue for you to review and submit. On first launch you land in an empty window with an open-repository prompt; once you have opened repositories, the same empty state lists your recent ones.

Strand talks to your repositories directly. Network operations (fetch, pull, push, clone) shell out to your system `git`, so your existing SSH keys, credential helpers, commit signing, and hooks just work — no separate credential setup.

## Opening a repository

There are several ways to get a repository open:

- **`Mod+O`** — opens the native folder picker. The picker is multi-select: pick several folders and each opens as its own tab.
- **Drag and drop** — drop one or more repository folders onto the Strand window.
- **Topbar `+` menu** — Initialize, Open, Clone, and a list of recent repositories.
- **Command palette (`Mod+K`)** — "Initialize repository…", "Open repository…", "Clone repository…", and a Recent group of previously opened repositories.
- **Repo quick-switcher (`Mod+E`)** — a fuzzy overlay over your open repositories and recents; works even with no repository open.

To clone, use the Clone dialog (topbar `+` menu, palette, or the native File menu): paste a URL, pick a destination, and Strand shows streamed clone progress and opens the result when done. Where the pickers start is configurable via Settings → Git → "Default clone & open folder".

To start locally, choose **Initialize repository…** from the `+` menu or palette. Pick or type the folder, choose the initial branch, optionally enter `.gitignore` patterns, and decide whether Strand should create the first commit. Strand never overwrites an existing `.gitignore`.

Open repositories become tabs that are restored the next time you launch Strand. Cycle between them with `Mod+Tab` and `Mod+Shift+Tab`. For grouping several repositories into one working set, see [Repositories and workspaces](repositories-and-workspaces.md).

## A quick tour of the main window

### Topbar

The topbar carries the current view's title and the repository-level controls:

- **Branch dropdown** — check out local branches, track remote ones, or create a branch inline.
- **Fetch / Pull / Push buttons** — with live ahead/behind counts and streaming progress. The adjacent chevron opens explicit pull strategies (including a saved per-repository default) and push/tag/guarded-force variants. Shortcuts: `Mod+Shift+Y` fetch, `Mod+Shift+P` pull, `Mod+P` push, `Mod+Shift+S` sync (fetch + the saved pull strategy + push).
- **Stash split button** — stash everything in one click, or open the chevron menu for snapshot and untracked-file variants.
- **Refresh** (`Mod+R`), plus buttons to open the repository in your configured external editor (`Mod+Shift+E`) or terminal (`Mod+Shift+C`).

Strand also refreshes automatically: on window focus and via a file watcher that live-updates the active tab while files change on disk — useful when an agent is editing underneath you.

### Repository rail or tabs

Open repositories appear either as a vertical icon rail or a horizontal tab strip — choose under Settings → Appearance → "Open repositories". Linked worktrees group with their parent repository and carry a worktree icon.

### Sidebar

The sidebar has five primary rows — **Work**, **Local Changes** (with an
unstaged-count badge), **Review**, **Pull Requests**, and **All Commits** — and
two tabs below them. Entering Work selects Files immediately.

- **Git** — collapsible sections for Worktrees, Branches, Remotes, Tags, Stashes, and Submodules, with a filter box. Per-row right-click menus include upstream management, explicit branch-to-remote push, selected-branch fetch/pull, and copy actions.
- **Files** — the working-tree file tree; when a commit is selected in All
  Commits, it re-roots to that commit and shows its short hash. Recognizable
  logos identify common source types, including C#, F#, Visual Basic, JVM and
  scripting languages, CMake, Razor, and XML. Clicking a folder opens an index
  of its immediate child folders and files using the same file-type icons; use
  Arrow keys, Home/End, and Enter/Space to navigate it. Clicking a file opens
  a replaceable preview in Work; double-click or Enter pins it. Right-click a
  working-tree file and choose **Open in editor** to open that exact path with
  the editor selected in Settings → Integrations. The external action is
  intentionally hidden while browsing a historical commit.

### Main views

Switch views with `Mod+1` through `Mod+7`:

| Shortcut | View | What it's for |
|---|---|---|
| `Mod+1` | Work | Lightweight file editing, inspection, and embedded terminals — see [Work](work.md) |
| `Mod+2` | Local Changes | Staging, diffs, and committing — see [Everyday Git](everyday-git.md) |
| `Mod+3` | All Commits | The commit graph and history — see [Commits and history](commits-and-history.md) |
| `Mod+4` | Reflog | HEAD reflog browser, the recovery path after resets and rebases |
| `Mod+5` | Review | Reviewing changes as whole files with a queue and baselines — see [Reviewing agent changes](reviewing-agent-changes.md) |
| `Mod+6` | Worktrees | Dashboard for parallel worktrees and agent attempts — see [Worktrees](worktrees.md) |
| `Mod+7` | Workspace Review | Aggregated review across every repository in the active workspace |

**Pull Requests** currently has no dedicated number shortcut; open it from the
sidebar or the palette action "Show: Pull Requests". See [Pull Requests](pull-requests.md).

### Status bar

The bottom status bar shows the current branch with ahead/behind counts and a
derived sync state — up to date, ahead, behind, diverged, or conflicts needing
resolution — on the left. Modified/staged counts and the Settings gear are on
the right.

### Command palette

`Mod+K` opens the command palette from anywhere — a fuzzy-searchable list of actions, branches, tags, stashes, files, commits, workspaces, and recent repositories. Nearly everything in Strand is reachable from it. See [Keyboard and palette](keyboard-and-palette.md) for the full reference.

## In-app updates

Direct Strand installations check for updates on launch by default and manage
them under Settings → Updates: check for updates, download and install, and
restart to apply. Automatic download-and-install is off by default, and updates
always apply on the next restart — Strand never restarts itself. Update
packages are cryptographically signed.

The in-app updater covers the macOS app, direct Windows MSI installs, and the
Linux AppImage. Microsoft Store MSIX installs check Store availability on
launch, notify you when an update exists, and open the Strand Store page for
installation. Linux `.deb` and `.rpm` installs update through their package
manager.

## Settings

Open Settings with `Mod+,`, the status-bar gear, or the palette. The dialog has nine sections — Appearance, Diff, Keyboard, Git, Hosting, Integrations, AI, Updates, and Privacy. Most changes apply live; global Git identity and Azure DevOps Server profiles use explicit save actions. See [Settings](settings.md) for the full walkthrough.

## Where to go next

- [Everyday Git](everyday-git.md) — staging, committing, branching, stashing, and syncing.
- [Work](work.md) — editable working-tree file tabs and repository-scoped embedded terminals.
- [Commits and history](commits-and-history.md) — the commit graph, search, interactive rebase, and the reflog.
- [Reviewing agent changes](reviewing-agent-changes.md) — the Review view, baselines, notes, and feedback export.
- [Worktrees](worktrees.md) — one worktree per agent task, comparison, and merge-and-clean-up.
- [Repositories and workspaces](repositories-and-workspaces.md) — multi-repo tabs and workspace groups.
- [Keyboard and palette](keyboard-and-palette.md) — every shortcut and the command palette.
- [Settings](settings.md) — every option, explained.
