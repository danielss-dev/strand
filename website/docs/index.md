# Strand User Guide

Strand is a fast, keyboard-first Git client built for reviewing what AI coding agents do to your code — and a complete everyday Git client at the same time. This guide covers everything the app can do today and how to drive it from the keyboard.

## What Strand is

Strand is a native desktop app that treats agent-driven development as a first-class workflow:

- A dedicated **Review** view shows an agent's changes as whole files with edits inline, backed by a review queue, pinnable baselines ("everything since this commit" — including work the agent already staged or committed), inline notes, and a one-click feedback export you can paste back into the agent.
- A **Worktrees** dashboard treats parallel agent attempts as first-class: per-worktree activity, dirty, and ahead/behind stats, side-by-side comparison of attempts, and a single "Merge & clean up" motion with full snapshot archiving so removals are always recoverable.
- **Workspaces** group the repositories behind one product and let you review changes across all of them in a single merged queue.

It is also a full everyday client: staging down to individually selected lines, a commit graph with inline stashes and full-history search, interactive rebase without an editor ever popping up, branches, remotes, tags, stashes, submodules, a three-way merge editor, and a command palette (`Mod+K`) that reaches nearly everything.

Strand is keyboard-first but never keyboard-only — the mouse stays first-class throughout. Network operations (fetch, pull, push, clone) and commit signing shell out to your system git, so SSH keys, credential helpers, hooks, and GPG/SSH signing work exactly as they do on the command line.

## Status

This guide describes **Strand 1.0**. Releases are published on [GitHub Releases](https://github.com/danielss-dev/strand/releases/latest); the in-app updater keeps installs current on macOS, Windows, and the Linux AppImage (`.deb`/`.rpm` installs update through your package manager). Stable publication is fail-closed on platform signing and release-candidate validation, so a source checkout can reach `1.0.0` before the public release appears.

Strand is open source under AGPL-3.0, free for individuals forever, with an honor-system commercial license for companies — no license keys, feature gating, or telemetry.

## Platforms

| Platform | Installer |
| --- | --- |
| macOS | Universal `.dmg` (Apple Silicon + Intel), signed and notarized |
| Windows | `.msi` |
| Linux | `.deb`, `.rpm`, `.AppImage` |

Installers are small — roughly 15 MB for the Windows MSI and Linux `.deb`/`.rpm`, about 31 MB for the universal macOS DMG. The auto-updater covers the macOS app bundle, the Windows MSI, and the Linux AppImage; `.deb`/`.rpm` installs update through your package manager.

## Guide contents

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Installing Strand, opening your first repository, the app layout, and the `Mod` key notation used throughout this guide. |
| [Repositories and workspaces](repositories-and-workspaces.md) | Opening, cloning, and switching between repositories; tabs and the icon rail; workspaces for multi-repo products. |
| [Reviewing agent changes](reviewing-agent-changes.md) | The Review view: baselines, the review queue, notes, feedback export, and cross-repo Workspace Review. |
| [Pull requests](pull-requests.md) | Browse, review, and manage GitHub and Azure DevOps pull requests for the active repository. |
| [Worktrees](worktrees.md) | The worktrees dashboard: creating isolated checkouts per agent task, comparing attempts, Merge & clean up, and archived snapshots. |
| [Everyday Git](everyday-git.md) | Staging and committing, branches, merging, fetch/pull/push, stashes, tags, submodules, and conflict resolution. |
| [Commits and history](commits-and-history.md) | The commit graph, commit search, the detail panel, interactive rebase, reset, reflog, and file history/blame. |
| [Keyboard and palette](keyboard-and-palette.md) | The command palette, global shortcuts, and the per-view keyboard loops. |
| [Settings](settings.md) | Appearance and theming, diff rendering, keyboard rebinding, git identity, editor/terminal integrations, AI providers, updates, and privacy. |
