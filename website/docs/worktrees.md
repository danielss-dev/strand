# Worktrees

Git worktrees let you check out several branches of one repository into separate directories at the same time — one task, one branch, one working tree. Strand treats them as first-class, with a dedicated compact table (`Mod+6`) for creating and monitoring parallel checkouts. Review, merge, removal, and cleanup remain available from the sidebar, tab menus, and command palette.

## The Worktrees pane

Open it with `Mod+6`, the palette entry "Show: Worktrees", or by clicking a worktree in the sidebar's Worktrees section. The header is deliberately spare: repository / Worktrees and **New worktree**.

Each worktree is a row, ordered current first, then the main checkout, then the rest. A row tells you:

- **Worktree** — the checkout name; the current checkout is amber on the selected background.
- **Branch** — its checked-out branch, followed by a quiet `merged` word when applicable.
- **Changes** — either `clean · <last commit subject>` or added/deleted line counts and changed-file count.
- **Touched** — relative time for the newest working-directory activity.

The focused row's full path appears in the status bar instead of consuming table space. Double-click a row or press `Enter` to open that checkout. Management actions live in the sidebar worktree context menu, where there is room to name them clearly.

The table is keyboard-operable:

| Key | Action |
|---|---|
| `↑` / `↓` | Move focus between worktrees |
| `Enter` | Open the focused worktree |

## Creating a worktree

Click **New worktree** on the dashboard, use the `+` on the sidebar's Worktrees section, or run "New worktree…" from the palette. You can also start from a specific point: **New worktree from here…** appears in the sidebar branch menus and the commit graph's right-click menu, seeding the dialog with that branch or commit.

The dialog:

- **Create a new task branch** — name the branch (spaces are auto-dashed) and pick where it starts: HEAD, any local branch, a remote branch, or a tag. When you pick a remote base, a **Fetch first** checkbox (checked by default) fetches before creating, so the worktree starts from the remote's actual tip; remote bases are set up to track automatically. Uncheck "create a new task branch" to check out an existing local branch instead.
- **Location** — defaults to a sibling directory, `<repo>.worktrees/<branch>`, and is editable.
- **Copy setup files from `.worktreeinclude`** — shown when the repository has a `.worktreeinclude` file at its root whose patterns match gitignored files. Git worktrees start without your ignored local setup (`.env` files, local configs), which breaks fresh checkouts; list those files in `.worktreeinclude` and Strand copies them from the source worktree into the new one so it runs out of the box. Checked by default when the file matches something; a toast reports how many files were copied.
- **Open in a new tab when created** — jump straight into the new worktree.

## Reviewing a worktree against its base

**Review vs base** in the sidebar and tab context menus answers "what did this attempt actually change?" in one motion: Strand detects the worktree's base branch, pins the [review baseline](reviewing-agent-changes.md) at the fork point (the merge-base of the worktree branch and the base), opens the worktree's tab, and lands you in the Review view in session mode.

That means you see everything since the branch forked — the agent's commits, whatever it staged, and whatever is still uncommitted — as whole-file diffs in a single queue, regardless of how the agent left the working tree. The full review toolkit applies: reviewed marks, notes, and feedback export. See [Reviewing agent changes](reviewing-agent-changes.md).

If several agent worktrees belong to repositories in one workspace, [Workspace Review](repositories-and-workspaces.md) (`Mod+7`) aggregates them: every open worktree tab of a member repository reviews as its own section.

## Merge & clean up

**Merge & clean up…** in the sidebar and tab context menus lands the worktree's branch on its base and retires the worktree in one dialog:

- **Into** — the target base branch. Strand detects it and marks the detected one, but you can pick another.
- **Mode** — **Squash into one commit** (agent WIP history stays out of the base branch), **Merge commit** (keeps every commit and records the merge), or **Fast-forward only** (available only when the base hasn't moved since the fork; it's the only option when the base branch isn't checked out anywhere).
- **Preview** — the dialog shows the exact git commands it will run, so there are no surprises.
- **Remove the worktree and delete the branch** — optional final step. A full snapshot is archived first, restorable from the dashboard. (Unavailable for the worktree you're currently in.)

The dialog warns when the worktree still has uncommitted changes, and when its files overlap with another dirty worktree's uncommitted changes — merge order matters in that case.

For bulk retirement, the palette action **Clean up merged worktrees…** removes every worktree that is both clean and already merged into its base, deleting the branches too, behind a confirmation that lists exactly what goes. **Prune stale worktrees** clears registry entries whose directories have vanished.

## Removal snapshots

Every worktree removal — including force removals and the bulk clean-up — first archives the worktree's full state: HEAD, staged changes, unstaged changes, and untracked files. Deleting a worktree in Strand is therefore never destructive.

Snapshots are retained behind the scenes and auto-pruned — the newest 10 per worktree are kept, with a 60-day cap — so the archive doesn't grow forever. They are intentionally not shown in the compact Worktrees pane.

## Worktrees in the sidebar and tabs

- **Sidebar → Git tab → Worktrees** is the first section: the current worktree is check-marked, single-click shows the Worktrees pane, and double-click (or `Enter`) opens the worktree as its own tab. The right-click menu carries Open, Show, Copy path, **Review vs base**, **Merge & clean up…**, Lock / Unlock, Remove / Force remove, and Prune; the section's `+` creates a new worktree.
- **Grouped tabs** — in the repository rail or tab strip, a repository's worktrees cluster with their parent: shared color dot, repository name first with the branch as context, and a worktree glyph. Right-clicking a worktree tab offers **Review vs base**, **Merge & clean up…**, and Close worktree, so the whole review-and-land loop works without visiting the dashboard.

## Shortcut summary

| Shortcut | Action |
|---|---|
| `Mod+6` | Go to Worktrees |
| `↑` / `↓` | Move focus in the dashboard list |
| `Enter` | Open the focused worktree |
| `Mod+7` | Workspace Review (includes open worktree tabs) |

`Mod+6` and `Mod+7` are rebindable in [Settings](settings.md) → Keyboard; the full shortcut reference lives in [Keyboard and palette](keyboard-and-palette.md).
