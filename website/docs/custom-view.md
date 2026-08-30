# Customize the Workbench

Workbench (`Mod+1`) is Strand's primary workspace. With no saved
configuration it is exactly the familiar full-size Work surface: file and
terminal tabs, internal Work splits, and no outer layout controls.

Use `Mod+8`, **View → Customize Workbench…**, or **Customize Workbench…** in
Quick Launch (`Mod+K`) to arrange more Strand features around Work. Existing
layouts from the former experimental Custom view migrate automatically.

## Build a layout

Customization starts from the current Workbench. Choose surfaces, split the
active pane right or down, drag or keyboard-resize dividers, or apply a
template. Divider rules stay visually thin but expose a wider highlighted
mouse target when hovered, so every split can be resized without pixel-perfect
aim. The available built-in surfaces are:

- Work
- Files
- Local Changes
- Changes explorer
- Review
- All Commits
- Pull Requests
- Reflog
- Worktrees
- Workspace Review

Open a pane's surface selector to change its contents. A stateful Strand
surface can appear only once; choosing one that is already open moves it by
swapping the two panes. This prevents duplicate focus loops, listeners, or
background work.

The **Changes explorer** is Local Changes reduced to its Unstaged and Staged
trees. Clicking a file there opens its whole-file Changes tab in Work. With
both **All Commits** and **Review** in the layout, “Review changes since this”
on a commit routes to the Workbench Review pane.

Choose **Done** to hide surface selectors and other layout-editing controls.
The configured surfaces remain live, and dividers remain resizable. Use
**Reset to default** to remove the workspace's saved composition and return to
the direct full-size Work surface.

## Templates

The **Templates** menu provides four starting points:

- **VS Code workbench** — Files on the left, Work in the center, and Local
  Changes above All Commits in an inspector column.
- **Review station** — Review beside All Commits.
- **Focus** — one full-size Work pane.
- **Blank layout** — one empty pane.

Applying a template replaces the current outer layout. Work's own file and
terminal tabs—and its internal editor splits—are independent and stay intact.

## Saving and repository behavior

Assignments, splits, closes, templates, and divider proportions auto-save per
Strand workspace. Switching between Default and named workspaces restores each
workspace's independent layout. Panes follow the active repository;
Workspace Review is the cross-repository surface.

Saved layouts use namespaced surface and instance identities. If a referenced
surface is unavailable, Workbench keeps the rest of the layout and shows a
stable placeholder instead of resetting the workspace.

Files uses the same live repository tree as the sidebar. When a Workbench pane
owns Files, the repository sidebar hides its Files tab instead of mounting a
second tree. Work also remains one live renderer when its outer pane moves or
resizes, so open editors, terminal processes, output, scrollback, and selection
survive.

## Keyboard access

- `Mod+1` opens Workbench in normal mode.
- `Mod+8` enters Workbench customization. Both bindings are rebindable in
  Settings → Keyboard.
- `F6` focuses the active surface's entry point in normal mode (Work's active
  tab when Work is selected) and its surface selector while customizing.
- `Mod+Z` undoes the last layout change while customization is open.
- `Mod+[` / `Mod+]` cycle panes in both normal and customization modes.
- Arrow keys navigate the surface grid and resize focused dividers.
- Quick Launch exposes surface assignment, split, close, and template actions
  while customization is open.

Workbench currently supports built-in Strand surfaces, installed plugin
surfaces from Settings → Plugins (including the Heroi dogfood plugin, which
provides chats scoped to the active repository and runs Claude, Codex, or
Cursor Agent in the background, and Quick Notes, which saves a separate
scratchpad for each repository in Strand's app data), and a 32-pane defensive
limit. Heroi does not
duplicate Files, git changes, or diffs; add those as separate Workbench panes.
Declarative plugins render from
validated manifests; third-party JavaScript does not run inside the privileged
webview. See `docs/plugin-creation.md` for authoring.

Heroi reuses the authenticated CLIs already installed on your machine. Sign in
with `claude`, `codex`, or `cursor-agent` before starting a chat. Custom Claude
and Codex executable paths come from Settings → AI; Cursor Agent must be on
`PATH`.

Heroi's Threads rail lists only conversations for the active repository. The
header shows the current agent, model, and branch; execution activity appears
inside the transcript while an agent works. Model and reasoning menus come from
the selected provider — Claude's catalog, Codex's live model list, or Cursor
Agent's available models — including that model's advertised reasoning levels.
Threads run independently, so starting a new conversation does not stop or
block an agent already working. Type `@` to attach a repository path, type `/`
to choose an installed or project skill, or drag one or more entries from a
Files pane into the composer. A chosen skill is sent using the provider-native
`$skill-name` prompt form. The composer glows while a Files-tree drag is over a
valid target. Command and tool activity rows with available details can be
expanded to inspect the command, arguments, changes, and bounded output.
Use **Open review** to activate a
Review pane in the current Workbench layout, or to open Strand's Review view
when the layout has none.
