# Workbench: files and embedded terminals

Workbench (`Mod+1`) is Strand's default startup view. With no saved outer
layout it shows the full-size Work surface described here. You can instead
start in Local Changes, Review, Pull Requests, or All Commits from Settings →
Appearance. Work is a place to inspect and make lightweight edits to
repository files and run shells without replacing a full code editor.
Local Changes (`Mod+2`) remains the staging and commit workspace.

## File tabs

Open the sidebar's **Files** lens and select a file or folder:

The trailing **+** button beside Files search creates a file or folder at the
repository root; it remains aligned as the sidebar is resized.

- A single click or keyboard focus opens one italic preview tab. Selecting a
  different file replaces that preview in place.
- Double-click or press `Enter` to pin the file. **Open**, file selection from
  the command palette, History, and Blame also open pinned tabs.
- Opening an already pinned file activates it instead of creating a duplicate.
- A working-tree file that differs from HEAD gains a **Changes** tab: the whole
  file rendered as a full-file diff (unstaged first, staged otherwise), the
  same whole-file view the Review surface uses. The Changes explorer in Custom
  opens files directly on this tab.
- File and terminal tabs share the active pane's peer strip. Tabs keep their
  width instead of compressing; scroll the strip with the mouse wheel, or use
  its overflow selector to jump directly to any tab in that pane. File tabs use
  the same file-type icons as the Files tree.
- Drag a tab within its strip to reorder it. Drop it on another pane's strip or
  center to move it there, or hover the left, right, top, or bottom edge and
  release over the highlighted half-pane preview to create a split. Dragging
  an italic preview makes it pinned. A new split starts at the previewed 50/50
  boundary; later resizing is remembered for that split.
- Use `Ctrl/⌘+PageUp` and `Ctrl/⌘+PageDown` to cycle the active pane's tabs
  quickly, including while a terminal is focused. On a tab strip, Left/Right
  and Home/End move, Delete or Backspace closes the focused tab, and
  middle-click closes any tab.

Each file tab remembers its own Content, rendered Preview, History, Compare, or
Blame mode. Images and folders retain their dedicated presentations. Only the
active file document is mounted and fetched; working-tree content follows the
repository watcher, while selected-commit documents stay immutable. File tabs
survive repository and view switches during the current run but intentionally
start empty after relaunch.

For an existing UTF-8 working-tree file, type directly in **Content**. Strand
uses Pierre's lightweight edit mode for syntax highlighting, find and replace,
multiple cursors, smart indentation, bracket matching, and undo/redo. Unsaved
drafts remain available when you switch tabs, panes, views, workspaces, or
repositories during the current app session. Strand does not save on blur,
navigation, or idle time: use the save icon or `Mod+S` when you want to write
the file. Use the toolbar's **Undo** and **Redo** controls or `Mod+Z` and
`Mod+Shift+Z`; Windows and Linux also support `Ctrl+Y` for redo. The buttons
disable automatically at the ends of Pierre's structure-aware history. Use
**Discard changes** beside Save to reset the current unsaved
buffer and reload the file from disk without writing it. Historical revisions,
binaries, oversized files, and non-UTF-8 text
stay read-only. If another tool changes the file while you have unsaved edits,
Strand refuses the stale save instead of overwriting the newer disk content.

If a file moves through Strand, its tabs follow the new path. A removed preview
closes; a removed pinned file stays visible with a clear missing-file message.
History and Blame jumps remember the exact originating Work tab for **Back**.

## Split panes

Use the two pane buttons at the right of any Work tab strip to **Split pane
right** or **Split pane down**. You can nest the two directions to build the
same editor-group layouts used by VS Code, and drag every divider to resize it.
The same actions are available in Quick Launch.

You can also build and reorganize the layout directly from the tab strip:
dragging to another pane transfers the existing file or terminal, while
dropping on an edge creates a new pane in that direction. Moving a live
terminal preserves its process, transcript, scrollback, and selection. Quick
Launch provides keyboard equivalents for moving the active tab to the previous
or next pane and to a new pane on any of the four sides.

Splitting a file pins a second view of that file in the new pane. Splitting a
terminal starts a sibling terminal with the same shell choice. Each pane owns
its own active tab and replaceable preview; files opened from Files or Quick
Launch go to the pane you most recently focused. Closing the final tab in a pane
collapses that empty pane. Press `F6` from a document or terminal to focus the
active pane's tab strip.

Terminal renderers stay mounted while the layout changes, so splitting and
resizing do not reset live processes, scrollback, or selection. Pane proportions
are remembered for each nested split position. File tabs and the pane topology
remain session-only, matching the rest of the Work file session.

## Embedded terminals

Choose **New embedded terminal** in the empty state, the main `+` terminal
button, or the command palette to use the configured default. The adjacent
arrow opens a one-off shell picker; on Windows it includes installed WSL
distributions. Every shell starts at the active repository/worktree root.
Multiple terminal tabs are supported per repository.

Terminal processes and xterm scrollback, selection, and output continue while
you switch views, repositories, or workspaces. The scrollback limit is 5,000
lines. The PTY is created at the fitted xterm grid and resynchronized after
startup and host resizes, so alternate-screen CLI apps can use the full Work
pane. When a shell exits, its transcript stays visible with the exit code and a
**Relaunch** action. Closing the terminal tab stops its complete process tree
and removes its saved descriptor.

The global shell default and terminal font and size (10–32px) are configurable
in Settings → Terminal. Use the repository selector and adjacent shell selector
to edit per-repository defaults; linked worktrees share one override.
Strand keeps its complete bundled JetBrains Mono face as the glyph fallback for
full-screen CLI layouts, including native box drawing, and advertises xterm-256color
with true color. Claude Code launched from a Work terminal receives its
fullscreen-renderer and full-welcome compatibility hints, so it uses the
complete dashboard even after setup tips and release notes have already been
seen. This does not change Strand's repository-root working directory and the
hints are ignored by other CLI agents.

Terminal descriptors restore after restarting Strand, but processes never do.
Restored tabs are unselected and dormant; explicitly selecting one starts a
fresh shell using its saved one-off choice or the repository's current default.
A final repository
close asks before stopping live terminals. Removing the repository only from
one of several owning workspaces, hiding a workspace, or switching away does
not stop them. App exit drains every terminal without prompting.

While a terminal is focused, shell controls such as Ctrl+C, Ctrl+R, and Ctrl+P
remain shell-owned. On macOS, Command shortcuts remain app-owned. On Windows
and Linux, numbered view navigation and the fixed Work-tab
`Ctrl+PageUp`/`Ctrl+PageDown` shortcuts remain app-owned. Press `F6` to return
focus to the Work tab strip.

## Shell settings

Settings separates two concepts:

- **Settings → Terminal** controls Work terminals. Choose System default, a
  platform preset, a discovered WSL distribution on Windows, or a custom
  executable plus arguments. An active
  repository may override the global choice or use **Use global**. Linked
  worktrees share the override.
- **Settings → Integrations → Terminal** remains the external application used by **Open in
  terminal** (`Mod+Shift+C`). It is unchanged and launches a separate terminal
  window.

**Check availability** resolves the configured executable without starting a
shell. Custom commands are tokenized directly into argv; Strand does not insert
an intermediary shell or search the repository for executables.
