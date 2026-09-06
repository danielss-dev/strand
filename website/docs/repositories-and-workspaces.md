# Repositories & Workspaces

Strand keeps as many repositories open as you like, restores them on every launch, and lets you group them into named workspaces — the set of repos behind one product. This page covers opening and cloning repos, switching between them, and managing workspaces.

## Opening a repository

There are several equivalent ways to open a repo:

- `Mod+O`, or the `+` button in the repository rail/tab strip, or the palette action "Open repository". All of them show a native folder picker.
- The picker is **multi-select** — choose several folders and each opens as its own tab.
- **Drag and drop** one or more folders onto the Strand window.
- Pick a repo from the **Recent** list (in the empty-state sidebar, the `+` dropdown, or the command palette).

While a repository opens, an indeterminate progress popup with elapsed time appears after a short delay, so large repos never look hung and small ones never flash a dialog.

## Cloning a repository

Clone from the `+` menu, the command palette, or the native File menu. The clone dialog takes a URL and a destination chosen with a native picker; the folder name is derived from the URL.

The dialog warns before URL entry that cloning can run hooks installed by your
Git template or system configuration. Clone only repositories and URLs you
trust.

- Cloning shows a persistent bottom-center progress popup with a determinate bar and per-phase ETA. On success it switches to "Opening" and opens the clone as a new tab.
- Clones are **cancellable** from the progress popup.
- Failures become a persistent, dismissible error state with the reason — they never silently vanish.

Network operations shell out to your system git, so SSH keys, credential helpers, and proxies work exactly as they do on the command line.

### Clone options

Expand **Advanced options** before starting:

- **Branch** chooses the initial branch; blank uses the remote default.
- **Number of recent commits (optional)** limits ancestry. Blank downloads all history. Older history,
  blame and merge bases may be unavailable in a shallow clone.
- **Download only this branch** also limits future fetches. Depth and
  single-branch fetching are independent choices.
- **Download file contents when needed** keeps historical file contents out of
  the initial transfer when the server supports filtering. Checkout still
  downloads current files; older content, diffs and blame can require a network
  connection. A server that ignores filtering may send all objects.
- **Also clone submodules** clones nested modules too. Their
  downloads and credentials are separate; the parent's depth and filter do not
  apply to them.

Use **Fetch → Download more history…** in the topbar network menu, or
**Repository history and downloads…** in the command palette to inspect shallow state, remote filters and fetch refspecs. In a shallow
repository, choose a remote and **Download more history** or **Download full
history**. These fetch ancestry without switching branches or altering local
edits. They preserve the current branch refspecs and partial-clone filter; a
shallow source may not have the entire history. The dialog shows progress and
offers **Cancel download**. This also works for repositories cloned outside Strand.

### Sparse checkout

Open **File actions** beside the Files search field and choose **Choose checked-out
folders…**, also available in the command palette.
Filter the tracked directories, tick those to keep, and choose **Enable sparse
checkout** or **Apply selection**. Selection uses directories in HEAD. Root files
and files beside a selected directory or its ancestors remain included; an empty
selection keeps root files only. Nested selections label their ancestors as partly
included. Sparse checkout changes populated files, independently of clone depth
and object filtering.

Sparse-excluded paths remain tracked in Git. The Files pane omits those absent
paths and shows a compact **Sparse checkout** link; they do not appear as deleted in Local
Changes. Actual deletions inside included directories retain their normal status.
Historical commit trees still show every file at that revision.

**Use sparse index** retains Git's compressed index format. Strand can read an
externally created sparse index without rewriting it, and stages, commits and
switches branches through Git when sparse checkout is active. Older external
tools may require turning this option off.

Selection changes and **Disable sparse checkout** refuse tracked edits or
untracked files. Commit or stash edits and move untracked files first. Strand also
refuses a selection that could remove ignored files: include their directory or
move those files yourself. Disabling restores all tracked files and may download
missing contents in a partial clone. Settings apply to the current worktree.
External non-cone patterns can be inspected and disabled; disable them before
selecting cone directories. Submodule lifecycle controls are separate.

### Default clone & open folder

In [Settings](settings.md) → Git, **Default clone & open folder** sets where the clone dialog and the open-repository picker start. Use Choose… to set it and Clear to remove it.

## Initializing a repository

Choose **Initialize repository…** from the repository `+` menu or the command palette. The dialog accepts a local folder and initial branch plus optional `.gitignore` patterns and an optional first commit. The first commit contains only the new `.gitignore`, or is empty when no patterns are entered. Strand refuses to overwrite an existing `.gitignore` and opens the initialized repository as a tab when complete.

## Rail or tabs

Open repositories show in one of two layouts, chosen in [Settings](settings.md) → Appearance → **Open repositories**:

- **Sidebar** — a vertical icon rail along the edge of the window.
- **Tabs** — a horizontal strip of pills in the toolbar (the default).

Both layouts share the same behavior:

- Color-dot pills / icon tiles, with a close action on hover.
- Middle-click a tab or rail tile to close it.
- A `+` menu for open, initialize, clone, SSH, and recent repositories.
- Right-click a repo to customize its icon and color, or close it.
- When the tab strip overflows it scrolls, and a ▾ jump menu lists every open repo.
- Linked [worktrees](worktrees.md) group with their parent repository (shared color, worktree glyph) rather than appearing as unrelated tabs.

Tabs are deduplicated by canonical path — opening the same repo twice focuses the existing tab.

## Switching between repositories

| Shortcut | Action |
| --- | --- |
| `Mod+Tab` | Next repository |
| `Mod+Shift+Tab` | Previous repository |
| `Mod+E` | Switch repository… (quick switcher) |
| `Mod+K` | Command palette (includes repo and workspace actions) |

`Mod+E` opens a fuzzy quick switcher over your **open** repositories (switches to the tab) and **recent** repositories that aren't open (opens them). It works even with no repository open, where it lists recents. `Mod+K` remains the full command palette; the switcher is the faster path when all you want is another repo.

All of these are rebindable in Settings → Keyboard; "Next repository" and "Previous repository" also exist as palette actions. Both tab cycling and the quick switcher are **workspace-aware**: with a workspace active, they move within its members.

## Publish a hosted repository

With a local repository open, run **Publish repository…** from the command
palette, or use **Remote actions → Publish repository…** in the Git sidebar.
Repositories with no remotes also show **Publish repository** beneath Remotes.

1. Choose GitHub, GitLab or Bitbucket Cloud, enter the host, then **Load account
   and destinations**. GitHub Enterprise and custom GitLab hosts are supported.
   The active CLI/helper account is displayed; switch accounts in the provider
   CLI before loading again if needed.
2. Select the account, organization, namespace or workspace, a repository name,
   private/public visibility and a new remote name. Existing remotes are not
   overwritten. **Review destination** shows the exact hosted URL, account,
   visibility, remote URL, branch and commit to be published.
3. **Create repository** creates an empty destination. **Add remote** then
   configures it locally. These steps do not push files.
4. Optionally check **Push the reviewed commit and its history to this
   destination**, then **Push reviewed commit**. The checkbox starts unchecked.
   The push sends the reviewed commit even if newer local commits now exist,
   preserves an existing upstream and never force-pushes. With no commit at
   review time, create one and use the ordinary Push action later.

Close and reopen the dialog to resume. A failed or interrupted creation becomes
an uncertain result: **Check destination** inspects the exact repository without
issuing another create request. Remote setup and push failures retain their
stage for retry. A changed remote URL, Git URL rewrite or changed branch stops
the initial push. Dismissing a recovery record keeps the hosted repository and
local remote. Azure repository creation is not part of this flow.

## Persistence

Strand restores your session across launches: window size, position, and
maximized state; open tabs and the active repository; pane sizes; per-repo diff
layout; each workspace's Custom layout; and workspaces all come back as you left them. A recents list is kept
automatically and surfaces in the empty state, the `+` menu, the quick switcher,
and the palette.

The active repository also stays fresh on its own: Strand refreshes on window focus and a file watcher live-refreshes the open tab while files change — useful when an AI agent is editing in the background. `Mod+R` forces a refresh.

## Workspaces

A workspace is a **named set of repository paths** — typically the repos that make up one product. Activating a workspace filters the rail or tab strip to its members and opens them; non-member repos stay open but hidden until you switch back. A repo can belong to multiple workspaces.

There is always a reserved **Default** workspace: the view shown when no named workspace is active, which collects repos that belong to no group.

### Creating and switching

The **workspace switcher** button lives in the rail or tab strip. Its dropdown lists Default plus every named workspace, and offers create, rename, delete, and "Manage workspaces".

Creating a workspace seeds it with the repositories currently visible — "save what I'm looking at as a group" — so the quickest flow is: open the repos you want together, then create the workspace.

Everything is also reachable from the command palette (`Mod+K`):

- A **Workspaces** group appears once any named workspace exists — one row per workspace (including Default); the active one is check-marked and labeled "active", the others show repo counts. Running a row switches to it.
- **New workspace…**
- **Manage workspaces…**
- **Import .code-workspace…**

### The manage dialog

**Manage workspaces** opens a dialog listing all workspaces. From there you can:

- Create a workspace (created immediately with a placeholder name, then renamed inline).
- Rename or delete a workspace. Deleting a workspace does not close or delete any repository.
- Add repositories to a workspace — from recents, from currently open repos, or via a disk picker.
- Missing or moved entries are checked before the recent-repository choices
  appear, so deleted worktrees and stale paths are not offered as members.
- Remove a repository from a workspace. The repo stays on disk, but removing it from its **last** holding workspace also closes its open tabs (main plus linked worktrees) — otherwise it would be unreachable from every view.
- Import a `.code-workspace` file.

### Importing a VS Code workspace

**Import .code-workspace…** (palette or manager dialog) creates a Strand workspace from a VS Code multi-root workspace file. The parser tolerates JSONC (comments and trailing commas), and relative `folders[].path` entries resolve against the file's location. Only local paths are supported; folders that aren't Git repositories are reported rather than silently dropped. The imported workspace is selected afterwards so you can curate it.

### Workspace Review

With a workspace active, `Mod+7` opens **Workspace Review** — an aggregated review of changes across every member repo (and their open worktree tabs) in one queue. See [Reviewing agent changes](reviewing-agent-changes.md).

## See also

- [Getting started](getting-started.md) — first launch and the `Mod` notation.
- [Keyboard & palette](keyboard-and-palette.md) — the full shortcut reference and palette groups.
- [Worktrees](worktrees.md) — how worktree tabs group with their parent repo.
- [Settings](settings.md) — Appearance and Git settings referenced above.
