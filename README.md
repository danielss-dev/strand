# Strand

> A fast, keyboard-first Git client for Windows, macOS, and Linux — with
> first-class workflows for reviewing what AI coding agents do to your code.

[![CI](https://github.com/danielss-dev/strand/actions/workflows/ci.yml/badge.svg)](https://github.com/danielss-dev/strand/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

**[Website](https://strandgit.com)** ·
**[Docs](https://strandgit.com/docs/)** ·
**[Download](https://github.com/danielss-dev/strand/releases/latest)** ·
**[Roadmap](./ROADMAP.md)** ·
**[Commercial license](./COMMERCIAL.md)**

The website includes a keyboard-operable, resizable demo of Strand's current
Work, Local Changes, Review, Pull Requests, and All Commits surfaces.

Keyboard-first: almost every action is operable from the keyboard alone —
never keyboard-only, the mouse stays first-class. Shortcuts are listed below
and **every global one is rebindable** in Settings → Keyboard.

### Keyboard shortcuts

`Mod` is ⌘ on macOS, Ctrl elsewhere. All of the following are configurable in
Settings → Keyboard (also reachable via the palette: "Settings: Keyboard
shortcuts").

| Shortcut | Action |
| --- | --- |
| `Mod+K` | Command palette |
| `Mod+O` | Open repository |
| `Mod+,` | Settings |
| `Mod+1…7` | Work · Local Changes · All Commits · Reflog · Review · Worktrees · Workspace Review |
| `Mod+Tab` / `Mod+Shift+Tab` | Next / previous repository |
| `Mod+E` | Switch repository (quick-switcher) |
| `Mod+P` | Push |
| `Mod+Shift+P` | Pull |
| `Mod+Shift+Y` | Fetch |
| `Mod+Shift+S` | Sync (fetch + pull + push) |
| `Mod+Shift+E` | Open in editor |
| `Mod+Shift+C` | Open in terminal |
| `Mod+R` | Refresh |
| `Mod+Shift+T` | Toggle light/dark theme |

Surface-local keys (not rebindable, documented in Settings → Keyboard):
`Mod+Enter` commit · `Mod+F` search in file or diff · `/` search commits · `j`/`k`
walk the file list · `n`/`p` step change blocks · `Shift+J`/`Shift+K` scroll the
diff · tabs in the active Work pane `Ctrl/⌘+PageUp`/`PageDown` or
`←→`/`Home`/`End`/`Delete`, with `F6` to leave a terminal ·
palette `↑↓`/`↵`/`⇥`/`Esc`.

Strand is a native, cross-platform Git client (Tauri 2 + Rust + React) with
a dedicated surface for reviewing an agent's changes: whole-file-context
diffs, a review queue, and worktree-aware baselines that include what the
agent already staged or committed. It's also a complete everyday Git client
— staging, commit graph, interactive rebase, stashes, tags — and it's
keyboard-first, but never keyboard-only: almost every action works from the
keyboard alone, and the mouse stays first-class. Repository and Work tabs close
from their close control, with Delete/Backspace while focused, or by middle-click.
Light, dark, and system appearance apply consistently to the shell, code diffs,
and the live Diff settings preview. Diff syntax colors offer five paired Pierre
palettes—including red–green and blue–yellow accessible variants—that follow
the resolved app appearance automatically.

## Features

- **Work view (⌘1)** — Strand's default startup workspace combines editable
  working-tree file documents and embedded shells in VS Code-style resizable
  panes. Drag tabs to reorder them, move them between panes, or drop on a pane
  edge to create a left/right/top/bottom split; each pane keeps its own tabs
  and replaceable preview. New splits match the 50/50 hover preview, while
  later resizing is remembered for that split. Files retain
  Content, rendered Preview, History, Compare, Blame, image, and directory
  modes. Content uses Pierre's lightweight edit mode; unsaved drafts survive
  navigation during the app session and reach disk only through Save or `Mod+S`;
  toolbar Undo/Redo controls share Pierre's structure-aware keyboard history,
  and Discard changes resets the current buffer without writing it.
  Multiple terminals run at the repository
  root and keep output, scrollback, and selection across view, repository, and
  workspace switches, pane splits, and resizes, and full-screen terminal apps receive the fitted PTY
  grid. Claude Code starts with its complete dashboard and alternate-screen
  renderer in a configurable terminal font and size. Work tabs keep their width in a wheel-scrollable strip with an overflow
  selector and tree-matched file icons, and middle-click closes a tab. Only descriptors restore after
  relaunch; selecting one starts a fresh process. The New Terminal split button
  can launch a one-off native or WSL shell, while Settings → Terminal provides
  a global default, paired repository and shell selectors for per-repository
  overrides, and typography without changing the separate external
  **Open in terminal** action. Linked worktrees share one override.

- **Review view (⌘5)** — read an agent's changes as whole files with the
  edits inline, not isolated hunks. A file-tree queue tracks what you've
  reviewed; staged files remain visible, and the branch-start baseline
  captures every commit since the detected fork point —
  including work the agent already staged or committed — and a change map
  beside the scrollbar shows where every edit sits in the file (click to
  jump). Inline feedback notes persist with their baseline/branch comparison,
  so switching review targets never mixes two agents' feedback. The selected
  Codex or Claude Code subscription can inspect that exact review set for
  possible defects. Findings stay pending until you explicitly add selected
  ones as severity-labelled notes; AI review never edits repository files.
- **Hosted pull requests** — browse the latest 100 GitHub or Azure DevOps PRs
  for the active repository, with the active PR for your checked-out branch
  opening and being followed automatically even before the PR view is opened.
  Create a PR or draft for the checked-out branch from the toolbar or command
  palette, choosing its title, description, and target branch; Strand publishes
  the checked-out branch first when it is not on the repository remote yet.
  Optionally draft the editable title and description from the
  committed branch delta using the configured Codex or Claude Code subscription.
  Persistent Follow controls and native desktop notifications surface new
  comments, review decisions, failed checks, pushes, and merged/closed state.
  Refreshes keep existing content, focus, tabs, drafts, and diffs in place
  while lightweight activity is revalidated in the background. The searchable
  inbox filters All, Authored, and Completed PRs using the signed-in provider
  identity while keeping the latest-100 query shallow. Each PR gets compact,
  toolbar-centered Summary, Timeline, and Code tabs: read rendered Markdown descriptions,
  follow commits/comments/lifecycle events newest-first on one chronology rail, compose
  top-level comments from Summary or Timeline with one preserved draft, and inspect
  lazily loaded code in the Local Changes-style Pierre file tree with aggregate
  and selected-file addition/deletion totals,
  track exact-head viewed/changed progress, filter unviewed files or unresolved
  threads, switch stacked/split layout in place, jump from timeline comments to their
  file/thread, read GitHub or Azure review threads with replies directly beneath
  their code, reply to them, resolve or reopen them, and add stale-head-guarded GitHub or
  Azure comments to selected line ranges. Selected ranges can instead be queued in one preserved,
  exact-head review draft with Markdown preview and submitted as Comment,
  Approve, or Request changes; GitHub batches the pending comments atomically,
  while Azure Services/Server resolve provider iteration/change-tracking
  coordinates, submit the provider vote, publish pending inline comments, and
  add the optional summary with explicit partial-success errors.
  A compact readiness ledger combines review,
  checks, conflicts, merge state, and provider freshness. Permission-backed
  drafts expose **Ready for review** in place of Merge; active PRs merge with
  merge-commit, squash, or rebase through a GitHub-style split control and can
  update their source from the target on GitHub with an expected-head guard.
  Every GitHub or Azure PR can open its exact provider head in a new worktree
  without changing local refs or `FETCH_HEAD`. Active PRs can be closed from a
  confirmed overflow action. Closed PRs can be reopened;
  merged PRs and every terminal discussion/thread surface remain read-only.
  Completed Azure PR Code views remain available after the provider deletes
  the source branch by using its recorded target and merge commits.
  GitHub and Azure DevOps Services authentication stays in the signed-in `gh` /
  `az` CLI. Azure DevOps Server 2020+ is available through an optional,
  independently versioned and updated, signed `strand-azdo` REST helper from
  a protocol-specific release channel, configured in Settings → Hosting;
  installation shows an explicit download and verification indicator;
  PATs live only in the native credential vault, and Windows can use integrated
  Negotiate/NTLM authentication. Its collection URL automatically matches HTTPS
  repository remotes and supplies the project/repository coordinates used by the
  PR view across HTTPS and SSH clones; extra prefixes are only needed for server
  aliases. New profiles can leave the collection URL blank to derive and save it
  from the active repository. Hosting settings also show connection readiness
  and the signed-in `gh` / `az` accounts. Provider policies
  remain enforced. Submitted reviews appear in Summary; GitHub exposes
  provider-authorized summary editing and reasoned dismissal, while Azure lets
  only the signed-in reviewer reset their current vote. Windows notification
  monitoring reads the native desktop permission instead of WebView2's browser
  permission shim. Packaged desktop
  builds recover the user's CLI `PATH` from the Unix login shell or persisted
  Windows environment, so package-manager and version-manager installs work
  without a custom path. Azure inline comments still need iteration tracking.
- **Worktrees (⌘6)** — an AI-agent dashboard for every worktree with stable
  repo naming, branch/session labels, dirty count, ±lines, "touched 3m ago"
  activity, disk size, ahead/behind, and one-click Review pinned where the
  branch diverged from main. Worktree tabs of one repo group together instead
  of looking like separate repos. Rows badge merged / unpushed work against
  the detected base and warn when parallel worktrees touch the same files;
  **Merge & clean up** lands a worktree's branch (squash / merge /
  fast-forward, exact commands previewed) and retires the worktree + branch
  in one motion, and every removal first archives a full snapshot —
  uncommitted and untracked files included — restorable later as a new
  worktree. Select two or more attempts and **Compare** them side by side —
  shared files highlighted — then pick the winner and land it. Creating a
  worktree can start from any branch, remote branch, tag, or commit
  (fetch-first for remote bases) and copies gitignored setup files listed in
  `.worktreeinclude` (`.env`, local settings) so agents can run out of the
  box. Stale entries whose directories are already gone prune immediately.
- **Everyday Git** — stage, unstage, or recoverably discard whole change
  blocks or individually selected lines inline in the diff; bulk tree actions
  include every selected file and every changed file beneath selected folders;
  initialize a repository with an initial branch, optional
  `.gitignore`, and optional first commit; inspect a stash from the sidebar
  without applying it, or create and check out a branch from it; fetch / pull /
  push with streaming progress and explicit
  pull modes (merge, rebase, fast-forward only) plus a per-repo default; normal,
  annotated-tag, all-tag, and guarded force-with-lease pushes; explicit push of
  any local branch to a chosen remote destination; upstream set/change/unset;
  selected-remote-branch fetch/pull; richer ref menus copy names, refs, and SHAs;
  local branches merged into the primary branch by ancestry or by an exact-tip
  completed GitHub/Azure PR are marked in the sidebar and commit graph and can
  be cleared in bulk with independent, guarded local/remote selection; branches,
  tags, stashes, remotes, ordered multi-commit
  cherry-pick, merge-mainline cherry-pick/revert, branch/tag/commit comparison,
  merge, and a fully keyboard-operable interactive rebase (reorder, reword,
  edit/pause-to-amend, squash, fixup, drop, and merge preservation) with
  pause/conflict Continue / Abort.
- **Commit graph** — SVG lanes with branch/tag chips, revealable inline stash
  nodes with non-mutating diff inspection, a
  resizable commit detail panel with lazy GPG/SSH/X.509 verification,
  subject/body copy, and exact patch export; in-graph search by message /
  author / hash; a multi-selection toolbar/menu for ordered cherry-pick,
  two-commit comparison, metadata copy, and patch-series export; a
  vertical activity-timeline rail (commit-density histogram you can scrub to
  seek by date), and a reflog browser for recovering commits orphaned by a
  reset or rebase.
- **Command palette (⌘K)** — fuzzy search across commands, branches, tags,
  files, commits, and recent repos, with scope filtering and full keyboard +
  screen-reader operability.
- **Work file documents** — edit syntax-highlighted working-tree files or
  inspect historical source read-only; `--follow` history,
  compare any two revisions, blame, and rendered previews for markdown and SVG; the Files tree
  uses the local filesystem listing directly, including muted Git-ignored
  paths, while overlaying current Git-state colors and recognizable language
  and tool logos. Ignored folders load one level at a time when expanded, so
  generated trees do not block the initial view. Selecting a commit
  re-roots it while pinning opened content to that revision. Selecting a folder
  opens its immediate contents with the same file-type icons, file/change
  counts, and keyboard navigation. A compact **+** menu beside search creates a
  file or folder at the repository root; fully ignored folders and their
  descendants stay muted without creating change dots on mixed parent folders.
  Creates, deletes, and
  renames update the tree in place, including newly created empty folders.
  Right-click any working-tree file to open that exact path in your configured
  external editor.
- **Comfortable to live in** — multiple repositories open at once (as a
  vertical icon rail or horizontal toolbar tabs, your pick in Appearance)
  persisted across launches, saveable as named **workspaces** (the repos behind
  one product — open a workspace to focus the rail on just those repos, close it
  to return to your default set; a manage dialog curates each; creating,
  switching, and managing are all in ⌘K, including importing a VS Code
  `.code-workspace`), native desktop menus (global on macOS, in-window on
  Windows/Linux), open the repository or a chosen file in your editor, open a
  terminal, a configurable startup space, settings (⌘,) for appearance /
  terminal / diff / git / hosting / integrations / AI, consistent
  keyboard-native dropdowns, and update checks for both direct and Microsoft
  Store installations.
- **AI writing and code review** — suggest subject + body from staged changes (or all
  unstaged changes when nothing is staged) via
  your ChatGPT subscription (Codex CLI, `gpt-5.6-luna`) or Claude Code CLI
  (`claude-sonnet-5` by default); Settings → AI for focused provider sign-in,
  per-provider model selection used by commit, PR, and Review generation, and CLI health
  checks with a remembered connected indicator. Packaged builds resolve these
  tools and their runtimes through
  the user's recovered Unix or Windows `PATH`; custom paths remain available.
  Generation is cancellable, scans conservative sensitive-file
  signals before provider launch, keeps the generated description content-sized,
  and can retry explicitly with the other provider without changing your
  default. Provider failures are reduced to concise, actionable hints; raw CLI
  session, prompt, and patch transcripts are never displayed. Repository-family
  writing profiles keep terminology and style consistent across worktrees.
  Review findings are structured, path/line-validated, stale-diff guarded, and
  require explicit acceptance before they become notes; repository files are
  never changed by an AI review.
- **Fast by design** — reads go through [gix](https://github.com/GitoxideLabs/gitoxide),
  writes through git2 and your system `git`. Performance targets live in
  [`PRD.md`](./PRD.md) §8 and are measured in
  [`docs/perf-baseline.md`](./docs/perf-baseline.md).

## Status

Strand **1.2.1 is the current stable release**, with **1.3.0 preparing for
release**, and works on large real-world repositories daily. Release CI
produces updater-signed desktop artifacts,
notarizes macOS, and keyless-signs Linux AppImages with Sigstore. Microsoft
Store engineering has a verified packaged-classic MSIX
with production identity `Danielss.strand`. Publishing a GitHub release builds
the exact tag and submits its unsigned `.msixupload` to Store product
`9N0JG96LRC4W` through Microsoft's Store Developer CLI; Partner Center signs
the accepted package, and production Store signing is complete. Store installs
check Microsoft's native package-update API on launch, notify when an update is
available, and hand installation back to the Store. PRI-indexed, DPI-tailored
icon assets keep the Store taskbar and Start icon as sharp and background-free
as the direct MSI, while explicit native Windows icon handles keep the taskbar
identity intact across in-place updates. The standalone GitHub MSI remains unsigned; the
certificate-backed offline-WebView2 MSI workflow is only a fallback.
Listing copy, privacy and user-content policies, in-product inappropriate-
content reporting, and release credentials are configured. The first automated
submission was accepted by Partner Center on 2026-07-28; Store signing was
confirmed complete on 2026-07-29. Trademark approval and clean-machine
validation remain external gates. See the
[`1.0 parity audit`](./docs/git-client-1.0-audit.md), [`ROADMAP.md`](./ROADMAP.md),
[`release checklist`](./docs/release-checklist.md), and [`TASKS.md`](./TASKS.md).

## Install

Download the latest release for macOS (universal), Windows, or Linux
(`.deb` / `.rpm` / `.AppImage`) from
[GitHub Releases](https://github.com/danielss-dev/strand/releases/latest).

## Building from source

Prerequisites:

- **Rust** stable (`rustup default stable`)
- **Node** ≥ 20 and **pnpm** ≥ 9
- Platform deps for Tauri 2: see <https://v2.tauri.app/start/prerequisites/>

```sh
pnpm install
pnpm tauri:dev     # full app: Vite + Rust + native shell
pnpm dev           # frontend only, in a regular browser
pnpm tauri:build   # installers in target/release/bundle
```

The frontend detects when it isn't running inside Tauri and disables IPC
calls, so `pnpm dev` is useful for UI work without a Rust build.

## Project layout

```
strand/
├── crates/
│   ├── strand-core/           # Git engine (gix for reads, git2 for writes)
│   ├── strand-azdo-protocol/  # Shared optional-helper JSON contract
│   ├── strand-azdo/           # Azure DevOps Server REST helper CLI
│   └── strand-tauri/          # Tauri 2 app shell + IPC commands
├── packaging/          # Store/distribution manifests assembled around release binaries
├── ui/                 # Vite + React + TypeScript frontend
├── website/            # strandgit.com: landing page + pre-rendered user guide
├── docs/               # design notes, perf baseline, packaging
├── PRD.md              # product spec
├── ROADMAP.md          # milestones and status
├── TASKS.md            # granular work list
└── AGENTS.md           # working agreement for AI/dev agents
```

## Contributing

Issues are welcome. Outside code contributions are temporarily paused while
the contributor-assignment terms and signing workflow required by Strand's
AGPL/commercial dual-license model are reviewed. Please open an issue before
writing a patch; do not open a pull request until this notice is replaced by
the approved CLA process.

When preparing an issue or discussing a future change:

- [`PRD.md`](./PRD.md) explains what Strand is and the bar it has to clear —
  performance targets in §8 are not aspirational.
- [`AGENTS.md`](./AGENTS.md) is the working agreement. It's written for AI
  agents but applies to humans too: surgical diffs, simplicity first, and
  every new surface keyboard-operable.
- The visual identity lives in `ui/src/styles/` as design tokens — no
  hardcoded colors. The Refined Circuit S mark lives in `strand.svg`, with
  the rounded white-tile platform icon source in `strand.png`.

## License

Strand is dual-licensed:

- **AGPL-3.0** for the public distribution. Anyone can read, build, modify,
  and use the source under the standard AGPL terms.
- **Commercial license** (one-time purchase) for companies that prefer not to
  take on AGPL obligations or want to support development.

The app is fully functional for everyone — no feature gating, no nag dialogs,
no trial period. The commercial license is honor-system: free for individuals,
appreciated for company use. See [`COMMERCIAL.md`](./COMMERCIAL.md) for
details.
