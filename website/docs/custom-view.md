# Custom view (experimental)

Custom (`Mod+8`) lets you assemble an app-wide workspace from Strand's existing
features. It is intended for layouts such as a VS Code-style workbench: a broad
Work pane beside narrower Local Changes and All Commits inspectors. This is a
Strand layout template, not an embedded copy of VS Code.

Open **Custom** from the sidebar's Labs row, the native View menu, or Quick
Launch (`Mod+K`). You can also choose **Custom (experimental)** under Settings
→ Appearance → Start in.

## Build a layout

The first visit starts with one empty pane. Choose any of these live surfaces:

- Work
- Local Changes
- Review
- All Commits
- Pull Requests
- Reflog
- Worktrees
- Workspace Review

Use the two split buttons in a pane header to add a pane to the right or below.
Splits can nest in either direction. Drag a divider to resize it, or focus the
divider with `Tab` and use the arrow keys. The × button closes a pane and
expands its neighbor; with only one pane left, it clears that pane instead.

Open the feature selector in any pane to change its contents. A Strand feature
can appear only once in the layout. Choosing one that is already open moves it
to the active pane and leaves its previous pane empty. This prevents two copies
of a stateful surface from competing over selection and keyboard commands.

## Templates

The **Templates** menu provides four starting points:

- **VS Code workbench** — Work on the left, with Local Changes above All
  Commits in an inspector column.
- **Review station** — Review beside All Commits.
- **Focus** — one full-size Work pane.
- **Blank layout** — one empty pane.

Applying a template replaces the current pane layout. Blank asks for
confirmation when the current layout contains features.

## Saving and repository behavior

Changes auto-save as you assign, split, close, resize, or apply a template.
The pane tree, feature choices, and divider proportions return after the next
launch. Custom currently stores one layout for the whole app rather than one
per repository; every pane follows whichever repository or workspace is
active.

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
- Arrow keys move through the feature cards in an empty pane.
- The feature selector, templates, split controls, close control, and resize
  dividers are keyboard-operable.
- While Custom is open, Quick Launch includes actions to assign every feature,
  split or close the active pane, and apply every template.

Custom is experimental. It currently supports the eight built-in Strand
surfaces, at most eight panes, one app-wide saved layout, and no arbitrary web
views or third-party extensions. Those boundaries keep the feature predictable
while the composition model is tested across platforms.
