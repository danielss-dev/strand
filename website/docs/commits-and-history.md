# Commits & History

Strand gives you three lenses on history: the All Commits graph for reachable history, the Reflog for everywhere `HEAD` has been (including orphaned commits), and a per-file view with follow-renames history, revision compare, and blame.

## All Commits (`Mod+2`)

The All Commits view renders the full commit graph as a virtualized table: an SVG lane graph on the left, then message, author, date, and short hash columns. Each branch gets its own colored lane; merge commits are marked with a ⊕ next to the message. Row height follows the density setting (compact / default / relaxed) from [Settings](settings.md).

Rows are decorated with chips:

- **Branch, remote, and tag chips** — every ref pointing at a commit shows inline, with the current `HEAD` branch styled distinctly.
- **Stash nodes** — stashes appear as synthetic rows in the graph, right above their base commit, labeled `stash@{n}`. Clicking one shows its changes in the detail panel; right-click offers Apply, Pop, Drop, and Copy SHA (stashes are also managed from the sidebar's Stashes section — see [Everyday Git](everyday-git.md)).
- **`ai` chip** — commits co-authored by an AI coding agent (detected from `Co-Authored-By:` trailers left by Claude Code, Copilot, Cursor, Aider, and similar, or bot-flavored authors) get an `ai` chip. Useful for spotting an agent's session at a glance; to review one, see [Reviewing agent changes](reviewing-agent-changes.md).

### Commit detail panel

Selecting a commit (click or `Enter`) opens a detail panel on the right with the full message, a metadata grid, the list of changed files, and the diff of the focused file. It also re-roots the sidebar's **Files** tab to that commit; the short hash above the tree makes the historical context explicit. Historical trees are read-only, and opening a file keeps Content and Preview pinned to that revision. Image changes render as before/after previews. Drag the divider to resize the panel; the split is remembered. Press `Escape` to close it and return Files to the working tree.

### Keyboard

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move focus through the graph |
| `Shift+↑` / `Shift+↓` | Extend the multi-selection |
| `Mod+A` | Select all loaded commits |
| `Enter` | Open the focused commit in the detail panel |
| `Escape` | Close the detail panel, then clear the multi-selection |
| `Shift+F10` / Menu key | Open the context menu for the focused row |
| `/` | Focus the search field |

### Context menu

Right-click a commit (or use `Shift+F10`) for:

- **Checkout** — detached checkout of the commit.
- **Tag…** — create a tag here.
- **Cherry-pick** / **Revert** — conflicts land in Local Changes for resolution.
- **Create fixup! commit** — commits the currently staged changes as `fixup!` of this commit (enabled only when something is staged); fold it in later with an interactive rebase.
- **Rebase from here…** — open the interactive rebase editor over this commit and everything newer.
- **Reset \<branch\> to here…** — opens the Reset dialog.
- **New worktree from here…** — cut a task branch at this exact commit; see [Worktrees](worktrees.md).
- **Review changes since this** — pin the review baseline here and jump to the Review view.
- **Copy SHA**

### Searching the graph (`/`)

Press `/` (or run "Search commits…" from the command palette) to focus the search field in the toolbar. A mode button in front of the field picks what you search:

- **Message** — commit subjects.
- **Author** — author name or email.
- **Hash** — commit hash prefix.
- **Content** — the diffs themselves (what changed), searched by the backend.

Message, author, and hash matches highlight in place over the loaded graph; a counter shows your position and `Enter` / `Shift+Enter` step through matches. The graph loads a window of recent history — in Message and Author mode, press `Mod+Enter` (or the history button) to run a full-history search on the backend; results open in a dropdown you can navigate with the arrow keys. Hash search stays within the loaded window. Content mode always searches the backend, so a plain `Enter` runs it there. `Escape` clears the search.

### Activity timeline

A vertical rail on the right edge of the graph is a commit-density histogram over **time**: each bar is an equal time bucket, and bar length encodes how many commits landed in that span — bursts read as long bars, quiet stretches as gaps. Date gridlines label the axis (newest at the top), a translucent band marks the currently visible window, and hovering shows the bucket's date range and commit count. Click or drag the rail to scrub the graph to that point in time. A toolbar button toggles the rail; it's a pointer affordance like a minimap — everything it reaches is also reachable by arrow keys and search.

## Reflog (`Mod+3`)

The Reflog view is the local, chronological record of where `HEAD` has pointed — every commit, checkout, reset, rebase, merge, and pull. A segmented **Graph | Reflog** toggle in the toolbar flips between the two history lenses.

Unlike the graph, the reflog includes commits orphaned by a reset, rebase, or amend, so it's your recovery path back to "lost" work. Each row shows the `HEAD@{n}` selector, the operation (destructive ops like reset and rebase are color-flagged), the message, time, and target hash.

- **Click a row or press `Enter`** to jump to that commit in the graph.
- **Right-click** (or `Shift+F10`) for recovery actions: **Jump to in graph**, **Checkout (detached)**, **Create branch here…**, and **Reset HEAD here…**.

To recover a commit you lost to a bad reset: open the Reflog, find the entry from before the reset, and either **Create branch here…** to keep it or **Reset HEAD here…** to move your branch back. If the commit is orphaned it won't appear in the graph, but the context menu actions work on it directly.

## File view

Open any file from the sidebar's **Files** tab or the command palette to get a dedicated file view with up to five tabs:

| Tab | What it shows |
| --- | --- |
| Content | The working-tree file, or the selected commit's version, syntax-highlighted; images get a checkerboard preview |
| Preview | Rendered form of the working-tree or selected-commit file (only for previewable files) |
| History | The file's commit history, following renames (`git log --follow`) |
| Compare | This file diffed between any two of its revisions |
| Blame | Per-line authorship |

Press `Mod+F` anywhere in the file view to switch to Content and search the
file's source. `Enter` / `Shift+Enter` (or `Down` / `Up`) move through matches
with wrapping; `Esc` closes the search.

### Preview

Markdown renders as a document — including repo-relative images and Mermaid diagrams — and SVG files render as an image. The tab only appears for files Strand can preview.

### History

Every commit that touched the file, with per-commit `+`/`−` line stats, following the file across renames. If the file has uncommitted changes, a "Working tree" entry sits at the top and is selected by default. Click a revision to see the file's change in that commit; double-click to jump to the commit in the All Commits graph.

### Compare

Two pickers — **Base** and **Compare** — list the file's revisions; the diff between them renders below (defaulting to previous vs. latest). For image files the comparison is a side-by-side before/after preview on a checkerboard, with a side absent when the file didn't exist at that revision.

### Blame

Per-line authorship for the whole file. Click a line to jump to the commit that last touched it; a back bar returns you to the file view on the same tab.

Diffs in the detail panel, file history, and compare respect your default diff layout (Stacked or Split) — see [Settings](settings.md). For shortcuts across the whole app, see [Keyboard & palette](keyboard-and-palette.md).
