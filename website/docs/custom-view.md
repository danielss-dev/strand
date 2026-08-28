# Custom view (experimental)

Custom (`Mod+8`) lets you assemble a personal layout for each Strand workspace
from the app's existing features. It is intended for arrangements such as a
VS Code-style workbench: Files beside a broad Work pane and narrower Local
Changes and All Commits inspectors. This is a Strand layout template, not an
embedded copy of VS Code.

Open **Custom** from the sidebar's Labs row, the native View menu, or Quick
Launch (`Mod+K`). You can also choose **Custom (experimental)** under Settings
→ Appearance → Start in.

## Build a layout

The first visit starts with one empty pane. Choose any of these live surfaces:

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

The feature grid in an empty pane fills the available pane width.

The **Changes explorer** is Local Changes reduced to its Unstaged and Staged
trees. Clicking a file there opens it in the Work pane's **Changes** tab — the
whole file rendered as a Review-style full-file diff.

With both **All Commits** and **Review** in the layout, "Review changes since
this" on a commit routes to the embedded Review pane instead of leaving Custom.

Use the two split buttons in a pane header to add a pane to the right or below.
Splits can nest in either direction. Drag a divider to resize it, or focus the
divider with `Tab` and use the arrow keys. The × button closes a pane and
expands its neighbor; with only one pane left, it clears that pane instead.

Open the feature selector in any pane to change its contents. A Strand feature
can appear only once in the layout. Choosing one that is already open swaps the
two panes' features. This prevents two copies of a stateful surface from
competing over selection and keyboard commands.

## Templates

The **Templates** menu provides four starting points:

- **VS Code workbench** — Files on the left, Work in the center, and Local
  Changes above All Commits in an inspector column.
- **Review station** — Review beside All Commits.
- **Focus** — one full-size Work pane.
- **Blank layout** — one empty pane.

Applying a template replaces the current pane layout. Blank asks for
confirmation when the current layout contains features.

## Saving and repository behavior

Changes auto-save as you assign, split, close, resize, or apply a template.
The save indicator flashes after each layout change.
The pane tree, feature choices, and divider proportions belong to the active
Strand workspace and return after the next launch. Switch to another named
workspace—or Default—and Custom restores that workspace's independent layout.
Existing app-wide layouts from the first experimental version migrate to
Default. Every feature pane still follows the active repository inside the
workspace; Workspace Review is the cross-repository surface.

Saved layouts use namespaced surface and instance identities. If a referenced
surface is unavailable, Custom keeps the rest of the layout and shows a stable
placeholder for that pane instead of resetting the workspace.

Files uses the same live repository tree as the sidebar. While Files owns a
Custom pane, the sidebar points back to that pane instead of mounting a second
tree. Opening a file stays in Custom when the layout also contains Work;
otherwise it opens the normal Work view.

Work remains one live surface even when Custom moves or resizes its pane, so
open file editors and embedded terminals keep their process, output,
scrollback, and selection. Other features use their normal Strand state and
actions. An action that intentionally opens a dedicated view can leave Custom;
your saved layout is unchanged when you return.

## Keyboard access

- `Mod+8` opens Custom; all global bindings remain rebindable in Settings →
  Keyboard.
- `F6` focuses the active pane's feature selector from a complex embedded
  surface.
- `Mod+Z` (`Cmd+Z` on macOS) undoes the last layout change while Custom is
  open.
- `Mod+[` / `Mod+]` cycle to the previous / next pane, wrapping at the ends.
- Arrow keys move through the feature cards in an empty pane.
- The feature selector, templates, split controls, close control, and resize
  dividers are keyboard-operable.
- While Custom is open, Quick Launch includes actions to assign every feature,
  split or close the active pane, and apply every template.

Custom is experimental. It currently supports ten built-in Strand surfaces, a
32-pane defensive limit, one saved layout per Strand workspace, and no
arbitrary web views or third-party extensions. The namespaced registry and
shared host are internal foundations for future extensions, not a community
plugin runtime. Those boundaries keep the feature predictable while the
composition model is tested across platforms.
