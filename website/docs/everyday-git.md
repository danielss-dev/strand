# Everyday Git

Strand is a complete daily-driver Git client alongside its review features. This page covers staging and committing in Local Changes, syncing with remotes, the sidebar's branch/tag/stash/remote/submodule sections, history operations like cherry-pick and interactive rebase, and conflict resolution.

## Local Changes (`Mod+1`)

Local Changes is a pure staging workspace: an Unstaged pane and a Staged pane (hierarchical file trees with status badges), a diff pane, and the commit form.

Right-click a single file in Local Changes or Review and choose **Open in editor** to open that exact working-tree path with the editor selected in Settings → Integrations. The same action is available in the sidebar Files tree and in each repository inside Workspace Review. Multi-file selections keep their batch actions and omit this single-file command.

- The view opens with a "show all" stacked diff of every changed file. Clicking the Unstaged or Staged column title re-selects that side's full changeset, and selecting a folder row aggregates the diffs beneath it.
- Stage or unstage a whole file from its row, or use **Stage all** / **Unstage all** for the whole side.
- **Block and line staging**: each change block in the diff has inline **Stage** and **Discard** buttons (**Unstage** on the staged side). Drag across changed line numbers to act on a contiguous range, or choose **Lines…** for a keyboard-operable checklist that can select any combination of deleted and added lines. The action labels show the selected-line count.
- **Discarding a change block or selected lines is recoverable**: it shows an Undo toast for a few seconds. Whole-file and bulk discards are immediate and permanent — there is no Undo toast and no automatic safety stash — so stash first if you might want the changes back.
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

Inside **Lines…**, `Tab` moves through each changed-line checkbox and action,
`Space` toggles the focused line, and `Escape` closes the picker. **All** and
**Clear** make large blocks quick to adjust before Stage, Unstage, or Discard.

## Working-tree files

Switch the sidebar from **Git** to **Files** to browse tracked and untracked
working-tree entries. Open the **+** menu beside search to create an empty file
or folder at the repository root; **New file…** and **New folder…** are also
searchable in Quick Launch. A file path may include existing parent folders.
Existing entries are never overwritten, and Strand rejects paths that escape
the checkout or enter `.git`.

Open a row's context menu with right-click, the Menu key, or `Shift+F10`:

- **Open** previews a file or opens a folder's contents in Strand.
- **Open in editor** and **Reveal in file manager** target the exact file or
  folder row.
- A file can jump directly to **Open file history** or **Open blame**.
- **New file here…**, **New folder here…**, and **Rename / move…** act relative
  to the selected row.
- Copy one or several relative paths, or native absolute paths suitable for
  the current operating system.
- **Delete file/folder** requires a second confirmation click. Tracked entries
  become ordinary working-tree deletions; the index is not changed.

The Files tree uses the repository's ignored-inclusive local listing directly;
it does not first substitute the Git snapshot while that listing loads. Current
Git state is overlaid on those local paths, so added, modified, and deleted
entries keep their status colors. Ignored files and fully ignored folders are
muted gray, have no internal change dots, and stay out of Local Changes. Strand
loads the local listing only after you open Files. It lists ignored folder
boundaries immediately, then fetches one directory level when you expand a
muted folder; generated trees such as `node_modules` therefore do not block the
view or the normal status/snapshot path. An
empty folder created in Strand appears in the tree immediately and remains
visible for the session; Git itself cannot persist an empty directory across a
restart until it contains a file. Successful creates, deletes, renames, and
moves update the open Files tree without a reload or tab switch.

## Committing

The commit form takes a subject and an optional description body. The body grows
with short or wrapped text, then scrolls once a long message reaches its bounded
height so it does not crowd the diff. `Mod+Enter` in the message box commits
(the Commit button shows the same chip). An **amend** checkbox rewrites the
previous commit instead.

**Commit signing honors your existing setup**: if `commit.gpgSign=true` is configured, Strand runs your real `git commit`, so GPG or SSH signing happens automatically and pre-commit/commit-msg hooks fire as they would on the command line. With signing off, commits are made by Strand's own engine and hooks are not run.

### AI commit message suggestions

The sparkle button next to the subject field (or `Mod+Shift+M`, or the palette action "Suggest commit message") generates a commit message from your **staged** changes. If nothing is staged, it uses all unstaged changes instead, so it is available as soon as there is work to describe. Suggestions use your own subscription CLIs — the Codex CLI (ChatGPT) or the Claude Code CLI — with no Strand-side API key. Pick the provider and sign in under Settings → AI; see [Settings](settings.md) for setup.

Generation is explicit and cancellable. Strand sends a bounded manifest plus
the highest-signal patches. If conservative path or content checks flag
potentially sensitive files, choose to exclude them, explicitly include them,
or cancel; changed input requires a new confirmation. The generated subject and
body remain directly editable. A non-authentication failure can be retried with
the other provider without changing the default in Settings.

## Fetch, pull, push

The topbar Fetch / Pull / Push buttons show real ahead/behind counts. The adjacent chevron opens the full network menu: fetch with or without pruning stale remote-tracking branches; pull using Git's configured behavior, an explicit merge, rebase, or fast-forward-only, with or without autostash; and push the current branch, follow annotated tags, push every tag, or force-push with a lease. Fetch-prune, pull-strategy, and pull-autostash choices can each be saved as this repository's default. Network operations stream progress (phase and percent) into a live topbar toast, are cancellable, and surface git's own stderr in a toast on failure. Sync runs fetch, then the repository's default pull, then push, and stops at the first failed stage.

Force-push is deliberately guarded: Strand only exposes `--force-with-lease`, names the branch and upstream in a confirmation dialog, and refuses the update if the remote branch moved since the last fetch. Plain `--force` is not available. The same strategy actions are keyboard-reachable from the command palette; the current branch's context menu also exposes the pull and push variants.

The first push of a new local branch creates the same-named branch on `origin` and sets it as the upstream, so later Push and Pull actions work normally. A branch's context menu can also set, change, or remove its upstream, or push that branch to a chosen remote and destination without checking it out. The explicit push dialog can set the new destination as upstream and offers the same safe push strategies.

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

Branches render as a flat list with their full names visible. A green check over the branch icon means that branch's tip is already contained in the repository's primary branch, so deleting it will not discard its commits; the primary and checked-out branches are never marked. Strand resolves the primary branch from the remote's default branch, then falls back to local `main`, `master`, or the checked-out branch. The same check appears on the branch's commit-graph chip. Clicking a branch reveals its tip commit in the graph; double-click (or `Enter`) checks it out. The context menu offers: Checkout, Push to remote…, Set/Change upstream…, New branch from here…, New worktree from here…, Rename branch…, Merge into the current branch, Rebase the current branch onto this, Interactive rebase (on the current branch), and Delete branch. It can also copy the branch name, full ref, or tip SHA; the current branch adds pull and push strategy submenus.

Run **Clear merged branches…** from the command palette to remove several checked branches at once. Every removable local branch starts selected; its matching upstream remote branch (or the same-named branch on `origin` when no upstream is configured) is shown separately and stays opt-in when that remote tip is also contained by the primary branch. Primary-branch refs are never offered. You can change either selection per row. Branches checked out in another worktree are listed as excluded and are never deleted. Remote deletion uses `git push --delete`; if it fails, Strand keeps the local branch as a recovery anchor and continues with the other selected refs.

The topbar branch dropdown also checks out local branches, tracks remote ones, and has an inline "Create branch…" field with prefix autocomplete. A detached HEAD shows a "detached" chip.

### Remotes

Each remote is a tree rooted at its name, showing all remote-tracking branches. Branch leaves can fetch only that branch, pull it into the current branch with a chosen strategy, set it as the current branch's upstream, checkout-or-track ("Create local branch & track"), create a worktree, delete the branch on the remote, and copy its short name, remote ref, or tip SHA. The remote folder menu can fetch, prune stale branches from only that remote, inspect its fetch/push refspecs, set Git's repository-local default remote, edit URLs, rename, copy URLs, or remove it. Adding or editing a remote accepts a required fetch URL and an optional push URL; remote URLs, refspecs, and `remote.pushDefault` stay in native Git configuration so command-line Git sees the same setup. Scoped prune, refspec inspection, and default selection are also searchable per remote in the command palette. The section `+` (or the palette's "Add remote…") adds a remote.

### Tags

Clicking a tag reveals the tagged commit in the graph; double-click (or `Enter`) checks it out (detached). The menu offers Checkout, create a branch or worktree from the tag, Push to a remote, Delete on the remote (grayed out for tags the remote doesn't have), copy the tag name or target SHA, and Delete tag. The section `+` opens the tag dialog — adding a message creates an annotated tag. Tags can also be created from a commit's detail panel ("Tag…") and the palette ("Create tag…", "Push all tags").

### Stashes

Single-clicking a stash switches to All Commits, reveals its graph node, and opens the stash diff without applying anything. Double-clicking it (or pressing `Enter`) applies it; the menu offers **Inspect changes**, Apply, Pop, **Create branch from stash…**, Drop, and copy actions for its `stash@{n}` reference or SHA. Branch-from-stash creates and checks out the branch at the stash base, applies the changes, and removes the stash only after a clean apply; the same action is searchable in the command palette. The section `+` opens the stash dialog: a message, a selectable file checklist for partial stashes, "Include untracked files", and "Keep changes in working directory" (which turns the stash into a snapshot). The topbar **Stash split button** opens the stash dialog, with a chevron menu for snapshot and untracked/keep-index variants plus "Pop latest". Stashes also appear inline on the commit graph as diamond nodes — see [Commits & History](commits-and-history.md).

### Submodules

Submodules list with status badges (uninitialized, out of date, modified). Double-click opens the submodule as its own repository tab; the menu offers Open, Update (or Init & update), and Copy path. The section header action runs "Update all" (`--init --recursive`) with streamed progress.

## Repository maintenance

Run **Repository maintenance…** from the command palette to use Git's own
housekeeping tools without leaving Strand:

- **Verify integrity** runs `git fsck --full` without changing the repository.
- **Run maintenance** runs the repository's configured `git maintenance run`
  tasks.
- **Garbage collect** runs `git gc` only after a second confirmation click and
  uses Git's normal grace periods.

Every run is cancellable. Strand records its exact safety-prefixed command,
success or failure, duration, and captured Git output in a per-repository
activity list outside the repository. The list survives relaunch, retains the
latest 50 runs, and bounds unusually large transcripts so maintenance history
cannot grow the app database indefinitely. Expand a row to inspect the command
and output; a successful integrity check may still report ordinary dangling
objects.

## Cherry-pick, revert, merge

- **Cherry-pick** and **Revert** act on a single commit from the commit detail
  panel or graph row menu. For a merge commit, choose the parent Git should
  treat as the mainline.
- Multi-select commits in All Commits to **Cherry-pick selected** in
  oldest-to-newest order. Exactly two selected commits can also be compared in
  a changed-file and full-diff dialog.
- **Merge** ("Merge into <current>" on a branch) opens a dialog with three modes: fast-forward when possible, always create a merge commit (no-FF), or squash — a squash merge leaves the result staged so you write the commit yourself.
- A plain **rebase** ("Rebase <current> onto this") is available from the branch context menu, behind a confirm step.

Local branches, remote branches, and tags also offer **Compare … with this…**
in their sidebar menus. The comparison dialog lets you swap or change either
ref, navigate the changed-file list with the arrow keys, and inspect text and
image diffs without checking anything out.

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
| `Alt+↑` / `Alt+↓` | Reorder the focused commit (disabled while preserving merges) |
| `p` / `r` / `e` / `s` / `f` / `d` | Set the verb: Pick / Reword / Edit / Squash / Fixup / Drop |
| `Backspace` / `Delete` | Drop |
| `Escape` | Close the editor |

**Autosquash**: the graph context menu's "Create fixup! commit" commits your staged changes as `fixup! <subject>` of the chosen commit. When you next open the rebase editor, fixup! commits are automatically arranged next to their targets (like `git rebase --autosquash`), with a notice telling you how many moved — and the plan stays fully editable before you run it.

**Edit** pauses the rebase immediately after the chosen commit. Strand opens
Local Changes: change and stage files, enable **Amend**, commit the amendment,
then use the operation banner's **Continue** button. You can also continue
without amending.

When the range contains a merge, **Preserve merge commits** is enabled by
default. Strand keeps Git's branch topology and disables reorder,
squash/fixup, and dropping a merge commit while that mode is active. Turn it
off explicitly if you intend to flatten the range into linear history.

Interactive rebase shells out to your system git, so hooks and commit signing apply to rewritten commits.

## Paused operations and conflicts

Whenever a merge, rebase, cherry-pick, or revert pauses, a banner appears above
the main view with **Continue** and **Abort**. Conflicts disable Continue until
they are resolved; an interactive-rebase Edit stop lets you amend the current
commit first. "Abort <operation>" is also in the palette.

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
- **Repository maintenance and integrity checks** — Git's configured
  maintenance tasks and object validation.
- **External merge tool** — your configured `git mergetool`.

If it works in your terminal, it works in Strand.
