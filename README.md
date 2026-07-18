# Strand

> A fast, keyboard-first Git client — built for reviewing what AI coding
> agents do to your code.

[![CI](https://github.com/danielss-dev/strand/actions/workflows/ci.yml/badge.svg)](https://github.com/danielss-dev/strand/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)

**[Website](https://strand.danielss.dev)** ·
**[Docs](https://strand.danielss.dev/docs/)** ·
**[Download](https://github.com/danielss-dev/strand/releases/latest)** ·
**[Roadmap](./ROADMAP.md)** ·
**[Commercial license](./COMMERCIAL.md)**

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
| `Mod+1…5` | Local Changes · All Commits · Reflog · Review · Worktrees |
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
diff · palette `↑↓`/`↵`/`⇥`/`Esc`.

Strand is a native, cross-platform Git client (Tauri 2 + Rust + React) with
a dedicated surface for reviewing an agent's changes: whole-file-context
diffs, a review queue, and worktree-aware baselines that include what the
agent already staged or committed. It's also a complete everyday Git client
— staging, commit graph, interactive rebase, stashes, tags — and it's
keyboard-first, but never keyboard-only: almost every action works from the
keyboard alone, and the mouse stays first-class.

## Features

- **Review view (⌘4)** — read an agent's changes as whole files with the
  edits inline, not isolated hunks. A file-tree queue tracks what you've
  reviewed, a pinnable baseline captures everything since a commit —
  including work the agent already staged or committed — and a change map
  beside the scrollbar shows where every edit sits in the file (click to
  jump).
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
  follow commits/comments/lifecycle events on one chronology rail, compose
  top-level comments from Summary or Timeline with one preserved draft, and inspect
  lazily loaded code in the Local Changes-style Pierre file tree with aggregate
  and selected-file addition/deletion totals,
  switch stacked/split layout in place, jump from timeline comments to their
  file/thread, read GitHub review threads with replies directly beneath their code,
  reply to them, resolve or reopen them, and add stale-head-guarded comments to
  selected line ranges. A compact readiness ledger combines review,
  checks, conflicts, merge state, and provider freshness. Permission-backed
  drafts expose **Ready for review** in place of Merge; active PRs merge with
  merge-commit, squash, or rebase through a GitHub-style split control.
  GitHub and Azure DevOps Services authentication stays in the signed-in `gh` /
  `az` CLI. Azure DevOps Server 2020+ is available through an optional,
  independently updated, signed `strand-azdo` REST helper configured in Settings → Hosting;
  installation shows an explicit download and verification indicator;
  PATs live only in the native credential vault, and Windows can use integrated
  Negotiate/NTLM authentication. Its collection URL automatically matches HTTPS
  repository remotes and supplies the project/repository coordinates used by the
  PR view across HTTPS and SSH clones; extra prefixes are only needed for server
  aliases. New profiles can leave the collection URL blank to derive and save it
  from the active repository. Hosting settings also show connection readiness
  and the signed-in `gh` / `az` accounts. Provider policies
  remain enforced. Windows notification monitoring reads the native desktop
  permission instead of WebView2's browser permission shim. Packaged desktop
  builds recover the user's CLI `PATH` from the Unix login shell or persisted
  Windows environment, so package-manager and version-manager installs work
  without a custom path. Azure
  inline comments need iteration tracking and
  submit-review and other lifecycle actions are still in progress.
- **Worktrees (⌘5)** — an AI-agent dashboard for every worktree with stable
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
  box.
- **Everyday Git** — stage, unstage, or recoverably discard whole change
  blocks or individually selected lines inline in the diff; initialize a
  repository with an initial branch, optional
  `.gitignore`, and optional first commit; inspect a stash from the sidebar
  without applying it, or create and check out a branch from it; fetch / pull /
  push with streaming progress and explicit
  pull modes (merge, rebase, fast-forward only) plus a per-repo default; normal,
  annotated-tag, all-tag, and guarded force-with-lease pushes; explicit push of
  any local branch to a chosen remote destination; upstream set/change/unset;
  selected-remote-branch fetch/pull; richer ref menus copy names, refs, and SHAs;
  local branches merged into the primary branch are marked in the sidebar and
  commit graph and can be cleared in bulk with independent local/remote
  selection; branches, tags, stashes, remotes, ordered multi-commit
  cherry-pick, merge-mainline cherry-pick/revert, branch/tag/commit comparison,
  merge, and a fully keyboard-operable interactive rebase (reorder, reword,
  edit/pause-to-amend, squash, fixup, drop, and merge preservation) with
  pause/conflict Continue / Abort.
- **Commit graph** — SVG lanes with branch/tag chips, revealable inline stash
  nodes with non-mutating diff inspection, a
  resizable commit detail panel, in-graph search by message / author / hash, a
  multi-selection toolbar for ordered cherry-pick and two-commit comparison, a
  vertical activity-timeline rail (commit-density histogram you can scrub to
  seek by date), and a reflog browser for recovering commits orphaned by a
  reset or rebase.
- **Command palette (⌘K)** — fuzzy search across commands, branches, tags,
  files, commits, and recent repos, with scope filtering and full keyboard +
  screen-reader operability.
- **File view** — highlighted source, `--follow` history, compare any two
  revisions, blame, and rendered previews for markdown and SVG; the Files tree
  uses recognizable language and tool logos, and selecting a commit re-roots it
  while pinning opened content to that revision. Selecting a folder opens its
  immediate contents with the same file-type icons, file/change counts, and
  keyboard navigation.
  Right-click any working-tree file to open that exact path in your configured
  external editor.
- **Comfortable to live in** — multiple repositories open at once (as a
  vertical icon rail or horizontal toolbar tabs, your pick in Appearance)
  persisted across launches, saveable as named **workspaces** (the repos behind
  one product — open a workspace to focus the rail on just those repos, close it
  to return to your default set; a manage dialog curates each; creating,
  switching, and managing are all in ⌘K, including importing a VS Code
  `.code-workspace`), native macOS
  menubar, open the repository or a chosen file in your editor, open a terminal,
  settings (⌘,) for appearance / diff /
  git / hosting / integrations / AI, in-app updates.
- **AI commit messages** — suggest subject + body from staged changes (or all
  unstaged changes when nothing is staged) via
  your ChatGPT subscription (Codex CLI, `gpt-5.6-luna`) or Claude Code CLI
  (`claude-sonnet-5` by default); Settings → AI for focused provider sign-in,
  per-provider model selection used by commit and PR generation, and CLI health
  checks with a remembered connected indicator. Packaged builds resolve these
  tools and their runtimes through
  the user's recovered Unix or Windows `PATH`; custom paths remain available.
  Generation is cancellable, scans conservative sensitive-file
  signals before provider launch, keeps the generated description content-sized,
  and can retry explicitly with the other provider without changing your
  default. Repository-family writing profiles keep terminology and style
  consistent across worktrees.
- **Fast by design** — reads go through [gix](https://github.com/GitoxideLabs/gitoxide),
  writes through git2 and your system `git`. Performance targets live in
  [`PRD.md`](./PRD.md) §8 and are measured in
  [`docs/perf-baseline.md`](./docs/perf-baseline.md).

## Status

Strand is in **alpha** and actively closing its 1.0 milestone. It opens and
works on large real-world repositories daily, but expect rough edges. The main
remaining gaps are hosted-review completion, localization, Windows/Linux
release signing and validation, remote-management/maintenance close-out, and
the remaining file/commit-metadata daily-driver actions. See the
[`1.0 parity audit`](./docs/git-client-1.0-audit.md), [`ROADMAP.md`](./ROADMAP.md),
and [`TASKS.md`](./TASKS.md).

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
├── ui/                 # Vite + React + TypeScript frontend
├── website/            # strand.danielss.dev: landing page + user guide (website/docs/, no build step)
├── docs/               # design notes, perf baseline, packaging
├── PRD.md              # product spec
├── ROADMAP.md          # milestones and status
├── TASKS.md            # granular work list
└── AGENTS.md           # working agreement for AI/dev agents
```

## Contributing

Issues and pull requests are welcome. Before diving in:

- [`PRD.md`](./PRD.md) explains what Strand is and the bar it has to clear —
  performance targets in §8 are not aspirational.
- [`AGENTS.md`](./AGENTS.md) is the working agreement. It's written for AI
  agents but applies to humans too: surgical diffs, simplicity first, and
  every new surface keyboard-operable.
- The visual identity lives in `ui/src/styles/` as design tokens — no
  hardcoded colors.

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
