# Everyday Git

Strand is a complete daily-driver Git client alongside its review features. This page covers staging and committing in Local Changes, syncing with remotes, the sidebar's branch/tag/stash/remote/submodule sections, history operations like cherry-pick and interactive rebase, and conflict resolution.

## Local Changes (`Mod+1`)

Local Changes is a pure staging workspace: an Unstaged pane and a Staged pane (hierarchical file trees with status badges), a diff pane, and the commit form.

- The view opens with a "show all" stacked diff of every changed file. Clicking the Unstaged or Staged column title re-selects that side's full changeset, and selecting a folder row aggregates the diffs beneath it.
- Stage or unstage a whole file from its row, or use **Stage all** / **Unstage all** for the whole side.
- **Change-block staging**: each change block in the diff has inline **Stage** and **Discard** buttons (**Unstage** on the staged side), so you can commit part of a file. The change block is the smallest unit — there is no single-line staging.
- **Discarding a change block is recoverable**: it shows an Undo toast for a few seconds. Whole-file and bulk discards are immediate and permanent — there is no Undo toast and no automatic safety stash — so stash first if you might want the changes back.
- Toggle between stacked and split diff layout with the header buttons; the choice is remembered per repository. `Mod+F` opens in-diff text search.

The staging loop is fully keyboard-driven:

| Key | Action |
|---|---|
| `j` / `k` | Next / previous file |
| `n` / `p` | Next / previous change block |
| `s` | Stage or unstage the selected file |
| `d` `d` | Discard (press twice to confirm) |
| `c` | Jump to the commit subject field |
| `Shift+J` / `Shift+K` | Scroll the diff pane |
| `Mod+F` | Search within the diff |

## Committing

The commit form takes a subject and an optional description body. `Mod+Enter` in the message box commits (the Commit button shows the same chip). An **amend** checkbox rewrites the previous commit instead.

**Commit signing honors your existing setup**: if `commit.gpgSign=true` is configured, Strand runs your real `git commit`, so GPG or SSH signing happens automatically and pre-commit/commit-msg hooks fire as they would on the command line. With signing off, commits are made by Strand's own engine and hooks are not run.

### AI commit message suggestions

The sparkle button next to the subject field (or `Mod+Shift+M`, or the palette action "Suggest commit message") generates a commit message from your **staged** changes. If nothing is staged, it uses all unstaged changes instead, so it is available as soon as there is work to describe. Suggestions use your own subscription CLIs — the Codex CLI (ChatGPT) or the Claude Code CLI — with no Strand-side API key. Pick the provider and sign in under Settings → AI; see [Settings](settings.md) for setup.

Generation is explicit and cancellable. Strand sends a bounded manifest plus
the highest-signal patches and shows the resulting coverage beside the draft.
If conservative path or content checks flag potentially sensitive files, choose
to exclude them, explicitly include them, or cancel; changed input requires a
new confirmation. **Undo AI replacement** restores the subject and body that
were present immediately before generation. A non-authentication failure can
be retried with the other provider without changing the default in Settings.

## Fetch, pull, push

The topbar Fetch / Pull / Push buttons show real ahead/behind counts. Network operations stream progress (phase and percent) into a live topbar toast, are cancellable, and surface git's own stderr in a toast on failure.

The first push of a new local branch creates the same-named branch on `origin` and sets it as the upstream, so later Push and Pull actions work normally. If the branch already has an upstream or an explicit push destination, Strand leaves that routing to Git.

| Shortcut | Action |
|---|---|
| `Mod+P` | Push |
| `Mod+Shift+P` | Pull |
| `Mod+Shift+Y` | Fetch |
| `Mod+Shift+S` | Sync (fetch + pull + push) |

Network operations shell out to your system git, so **credential helpers, SSH keys and agents, and proxy settings just work** — Strand never asks for credentials of its own. Content filters configured in your git (such as Git LFS) run as they do on the command line, though Strand has no dedicated LFS UI yet.

## The sidebar Git tab

The sidebar's Git tab holds collapsible **Worktrees, Branches, Remotes, Tags, Stashes, Submodules** sections, all filtered by the box at the top. Per-row actions live in right-click context menus (also keyboard-openable via the Menu key or `Shift+F10`); destructive items require a "Confirm" second click. Worktrees have their own page — see [Worktrees](worktrees.md).

### Branches

Branches render as a folder tree (`feature/foo` nests under `feature/`). Clicking a branch reveals its tip commit in the graph; double-click (or `Enter`) checks it out. The context menu offers: Checkout, New branch from here…, New worktree from here…, Rename branch…, Merge into the current branch, Rebase the current branch onto this, Interactive rebase (on the current branch), and Delete branch.

The topbar branch dropdown also checks out local branches, tracks remote ones, and has an inline "Create branch…" field with prefix autocomplete. A detached HEAD shows a "detached" chip.

### Remotes

Each remote is a tree rooted at its name, showing all remote-tracking branches. Branch leaves offer checkout-or-track ("Create local branch & track"), New worktree from here…, and Delete branch on the remote. The remote folder menu has Edit URL…, Rename…, Copy URL, and Remove remote. The section `+` (or the palette's "Add remote…") adds a remote.

### Tags

Clicking a tag reveals the tagged commit in the graph; double-click (or `Enter`) checks it out (detached). The menu offers Checkout, Push to a remote, Delete on the remote (grayed out for tags the remote doesn't have), and Delete tag. The section `+` opens the tag dialog — adding a message creates an annotated tag. Tags can also be created from a commit's detail panel ("Tag…") and the palette ("Create tag…", "Push all tags").

### Stashes

Double-clicking a stash (or `Enter`) applies it; the menu offers Apply, Pop, and Drop. The section `+` opens the stash dialog: a message, a selectable file checklist for partial stashes, "Include untracked files", and "Keep changes in working directory" (which turns the stash into a snapshot). The topbar **Stash split button** opens the stash dialog, with a chevron menu for snapshot and untracked/keep-index variants plus "Pop latest". Stashes also appear inline on the commit graph as diamond nodes — see [Commits & History](commits-and-history.md).

### Submodules

Submodules list with status badges (uninitialized, out of date, modified). Double-click opens the submodule as its own repository tab; the menu offers Open, Update (or Init & update), and Copy path. The section header action runs "Update all" (`--init --recursive`) with streamed progress.

## Cherry-pick, revert, merge

- **Cherry-pick** and **Revert** act on a single commit, from the commit detail panel or the graph row's context menu.
- **Merge** ("Merge into <current>" on a branch) opens a dialog with three modes: fast-forward when possible, always create a merge commit (no-FF), or squash — a squash merge leaves the result staged so you write the commit yourself.
- A plain **rebase** ("Rebase <current> onto this") is available from the branch context menu, behind a confirm step.

If any of these operations hit conflicts, they pause rather than fail — see [Paused operations and conflicts](#paused-operations-and-conflicts) below.

## Interactive rebase

Strand drives interactive rebase entirely in-app — no `$EDITOR` ever pops up. Launch it from:

- the commit graph context menu or commit detail panel — **Rebase from here…**
- the current branch's sidebar context menu — **Interactive rebase**
- the palette — "Interactive rebase…"

The rebase editor is a keyboard-operable list of the commits in the plan:

| Key | Action |
|---|---|
| `↑` / `↓` | Move the focused row |
| `Alt+↑` / `Alt+↓` | Reorder the focused commit |
| `p` / `r` / `s` / `f` / `d` | Set the verb: Pick / Reword / Squash / Fixup / Drop |
| `Backspace` / `Delete` | Drop |
| `Escape` | Close the editor |

**Autosquash**: the graph context menu's "Create fixup! commit" commits your staged changes as `fixup! <subject>` of the chosen commit. When you next open the rebase editor, fixup! commits are automatically arranged next to their targets (like `git rebase --autosquash`), with a notice telling you how many moved — and the plan stays fully editable before you run it.

Interactive rebase shells out to your system git, so hooks and commit signing apply to rewritten commits.

## Paused operations and conflicts

Whenever a merge, rebase, cherry-pick, or revert pauses on conflicts, a banner appears above the main view naming the operation, with **Continue** (disabled until all conflicts are resolved) and **Abort** buttons. "Abort <operation>" is also in the palette.

Conflicted files show in a conflict bar in Local Changes. Selecting one opens a landing panel that explains the conflict and offers whole-file resolutions — take incoming, take current, or take both — plus **Open merge editor** and **External tool** (which runs your configured `git mergetool`).

The merge editor is a full-screen three-way view:

- Incoming and current versions side by side, scroll-synced, with the assembled result below.
- `‹` / `›` steps through conflicts with a counter that turns from red to green as you resolve them.
- Per conflict, take current, incoming, or both — or click a side's block directly. Per-side "take all" checkboxes resolve everything at once.
- **Resolve** writes the result and stages the file. The editor is pick-sides only; it does not support free-form text editing.

Once every conflicted file is resolved, the banner's Continue button resumes the operation.

## Where Strand uses your system git

Strand reads repositories with its own fast engine, but the operations where your environment matters shell out to the real `git` binary and therefore honor your global and per-repo configuration:

- **Committing when `commit.gpgSign` is on** — GPG/SSH signing keys and pre-commit/commit-msg hooks (with signing off, commits are in-process and hooks don't run).
- **Network operations** (clone, fetch, pull, push) — credential helpers, SSH agents and keys, remote-related hooks, and content filters such as Git LFS.
- **Interactive rebase** — hooks and signing on rewritten commits.
- **External merge tool** — your configured `git mergetool`.

If it works in your terminal, it works in Strand.
