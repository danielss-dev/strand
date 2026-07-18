# Keyboard & Command Palette

Strand is keyboard-first: nearly every action has a command-palette entry, a global shortcut, or a surface-local key. This page covers the command palette, the full list of global (rebindable) shortcuts, and the fixed per-view keys.

## The command palette

Open the palette with `Mod+K`. It is a single fuzzy-matched search over commands and repository data — the placeholder says it all: "Type a command, branch, file, or commit…".

Results are grouped, in this order:

- **Actions** — every command Strand exposes: initialize/open/clone/switch repository, show any view, fetch/pull/push/sync, stash and snapshot, create branch/tag/remote, clear merged local and matching remote branches, interactive rebase, review actions (pin/move/clear baseline, copy feedback as prompt), worktree cleanup, settings and theme, and "Abort <operation>" while a merge or rebase is paused.
- **Branches** — checkout a local branch. Remote branches without a local counterpart appear too; running one creates a local tracking branch. The current branch reveals its tip in the graph instead.
- **Tags** — reveal the tagged commit in the graph (non-destructive).
- **Stashes** — "Apply stash: …", "Pop stash: …", and "Create branch from stash: …" rows per stash.
- **Files** — working-tree files; opens the file in the file view.
- **Commits** — reveal the commit in the graph and open its detail panel.
- **Workspaces** — one row per workspace (shown once a named workspace exists); running one switches to it. See [Repositories and workspaces](repositories-and-workspaces.md).
- **Recent** — recently opened repositories; running one opens it by path.

With an empty query only Actions, Workspaces, and Recent show; type something or pick a scope to surface branches, files, and commits. Repo-scoped groups disappear when no repository is open, and repository data is indexed lazily only while the palette is open, so it costs nothing on large repos when closed.

### Scope filtering

Below the input sit scope pills: **All** plus one pill per group present. Press `Tab` / `Shift+Tab` to cycle scopes, or click a pill. Under **All**, each group shows up to 6 results; under a single scope, up to 50.

### Palette keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move through results |
| `Enter` | Run the selected item |
| `Tab` / `Shift+Tab` | Cycle scope pills |
| `Mod+K` | Toggle the palette |
| `Escape` | Close |

For jumping between *repositories* specifically, the quick-switcher `Mod+E` is faster: a fuzzy overlay over open repos and recents that switches or opens directly.

## Global shortcuts

All of these are rebindable in **Settings → Keyboard** (see [Settings](settings.md)): click a binding chip to record a new combination, unassign it, or reset it to the default. Conflicting bindings are flagged "Shared with another command". "Clone repository…" ships with no default binding — assign one there if you clone often.

| Shortcut | Command | Category |
| --- | --- | --- |
| `Mod+K` | Command palette | General |
| `Mod+O` | Open repository… | General |
| — | Clone repository… | General |
| `Mod+,` | Settings | General |
| `Mod+1` | Go to Local Changes | Navigation |
| `Mod+2` | Go to All Commits | Navigation |
| `Mod+3` | Go to Reflog | Navigation |
| `Mod+4` | Go to Review | Navigation |
| `Mod+5` | Go to Worktrees | Navigation |
| `Mod+6` | Go to Workspace Review | Navigation |
| `Mod+Tab` | Next repository | Navigation |
| `Mod+Shift+Tab` | Previous repository | Navigation |
| `Mod+E` | Switch repository… | Navigation |
| `Mod+Shift+Y` | Fetch | Git |
| `Mod+Shift+P` | Pull | Git |
| `Mod+P` | Push | Git |
| `Mod+Shift+S` | Sync (fetch + pull + push) | Git |
| `Mod+Shift+M` | Suggest commit message | Git |
| `Mod+Shift+E` | Open in editor | Repository |
| `Mod+Shift+C` | Open in terminal | Repository |
| `Mod+R` | Refresh | Repository |
| `Mod+Shift+T` | Toggle light/dark theme | Appearance |

Push is deliberately on `Mod+P` and pull on `Mod+Shift+P`. The Git shortcuts act only on the currently open repository, and most Navigation/Git/Repository commands need a repository open — `Mod+E` is the exception and lists recents even with nothing open.

Alternative network strategies are palette actions rather than fixed shortcuts: fetch with or without pruning; pull with merge, rebase, or fast-forward-only, with or without autostash; push annotated tags; push every tag; and force-push with a lease. The current branch also contributes “Manage current branch upstream…” and “Push current branch to…” actions. Force-push always opens a branch-specific confirmation dialog, and plain `--force` is not exposed. Any branch or remote-branch row can open its richer context menu from the keyboard with the Menu key or `Shift+F10`.

Each configured remote contributes palette actions to prune only that remote,
inspect its fetch/push refspecs, and make it the repository's default push
remote. The same actions are in the keyboard-openable remote-folder menu.

**Repository maintenance…** opens a keyboard-operable activity dialog for an
integrity check, incremental Git maintenance, or guarded garbage collection.
Use `Tab` to move between actions and activity entries, `Enter` to run or
expand one, and `Escape` to close when no operation is running.

**New file…** and **New folder…** open a focus-trapped path dialog for the
active repository. The Files sidebar exposes the same actions in its toolbar.
Focus a file or folder row and press the Menu key or `Shift+F10` to reach its
editor/reveal, path-copy, history/blame, nested-create, rename, and confirmed
delete actions without a pointer.

A few fixed app-level keys are not rebindable:

| Key | Action |
| --- | --- |
| `Mod+Plus` (or `=`) | Zoom UI in |
| `Mod+Minus` | Zoom UI out |
| `Mod+0` | Reset zoom to 100% |
| `Escape` | Close the palette, quick-switcher, or dialogs |

Zoom works even while a text field is focused, shows a "Zoom N%" toast, and persists.

## Surface-local keys

Each view has its own small set of fixed (non-rebindable) keys. Settings → Keyboard lists the most common of them under "Context shortcuts" for reference; this page is the complete list.

### Repository tabs

When repository navigation uses the horizontal tab strip, focus a tab to use:

| Key | Action |
| --- | --- |
| `←` / `→` | Focus and open the previous / next repository tab |
| `Home` / `End` | Focus and open the first / last repository tab |
| `Delete` / `Backspace` | Close the focused repository or worktree tab |

Recent-repository and workspace menus expose their Open, Remove, Rename, and
Delete controls as separate tab stops. `Enter` / `Space` activates the focused
row or control.

### Local Changes (staging)

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file (unstaged tree order, then staged) |
| `n` / `p` | Next / previous change block in the diff |
| `Shift+J` / `Shift+K` | Scroll the diff pane down / up |
| `s` | Stage / unstage the selected file |
| `d` | Discard the selected file (press twice within 2.5 s to confirm) |
| `Delete` / `Backspace` | Discard immediately, no confirm |
| `c` | Focus the commit subject field |
| `Mod+Enter` | Commit (from the message box) |
| `Mod+F` | Search within the current file or diff |

Each inline change-block action includes **Lines…**. Its checklist is fully
keyboard-operable: `Tab` moves through changed lines and actions, `Space`
toggles a line, and `Escape` closes it. Pointer users can also drag across
changed line numbers directly in the diff.

### Review queue (Review and Workspace Review)

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file in the queue (crosses repo boundaries in Workspace Review) |
| `n` / `p` | Next / previous change block |
| `Shift+J` / `Shift+K` | Scroll the diff pane |
| `Space` | Mark the current file reviewed |
| `m` | Add a note on the current file |
| `s` | Stage the current file (if unstaged) |
| `d` | Discard the current file |
| `c` | Jump to Local Changes and focus the commit subject (Review only) |
| `o` | Open the file in its owning repository (Workspace Review only) |
| `Mod+F` | Search within the diff |

Arrow keys stay with the file tree. See [Reviewing agent changes](reviewing-agent-changes.md) for the full workflow.

### In-diff search bar

Opened with `Mod+F` in Local Changes, Review, or Workspace Review.

| Key | Action |
| --- | --- |
| `Enter` / `↓` | Next match (wraps) |
| `Shift+Enter` / `↑` | Previous match |
| `Escape` | Close |

### Commit graph (All Commits)

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move row focus (`Shift+↑`/`Shift+↓` extends the selection) |
| `Enter` | Open the commit detail panel |
| `Mod+A` | Select all loaded commits |
| Menu key / `Shift+F10` | Open the row context menu |
| `Escape` | Clear the selection |
| `/` | Focus the commit search field |

In the search field: `Enter` steps loaded matches (`Shift+Enter` backwards); `Mod+Enter` — or plain `Enter` in Content mode — runs the full-history search; `↑`/`↓` navigate the results dropdown and `Enter` opens a hit; `Escape` clears the query, then blurs. See [Commits and history](commits-and-history.md).

With several commits selected, the toolbar exposes ordered cherry-pick,
two-commit comparison, and patch-series export. Press the Menu key or
`Shift+F10` on any selected row for the same operations plus copy actions for
ordered full SHAs, subjects, and complete messages. A single commit's menu and
detail panel expose subject/body copy and native-dialog patch export.

In commit/ref comparison dialogs, `↑` / `↓`, `Home`, and `End` navigate
the changed-file list; `Escape` closes the dialog. Merge cherry-pick/revert
dialogs use the native radio-group arrow keys to choose the mainline parent.

In commit detail, each changed-file row is focusable; `Enter` / `Space` opens
its diff. In a file's History tab, `Space` selects a revision for comparison.
`Enter` selects an unselected revision, then opens that selected revision in
the commit graph when pressed again.

### Interactive rebase editor

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move focus between rows |
| `Alt+↑` / `Alt+↓` | Reorder the focused row (disabled while preserving merges) |
| `p` / `r` / `e` / `s` / `f` / `d` | Set the verb: Pick / Reword / Edit / Squash / Fixup / Drop |
| `Backspace` / `Delete` | Drop the row |
| `Escape` | Close the editor |

### Worktrees dashboard

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move focus in the list |
| `Enter` | Review the focused worktree |
| `Space` | Tick it for the best-of-N comparison |

See [Worktrees](worktrees.md).

On macOS, shortcut chips render as tight glyphs (`⌘⇧P`); on Windows and Linux they render as words (`Ctrl+Shift+P`). Either way the bindings are identical modulo `Mod`.
