# Worktrees

Git worktrees let you check out several branches of one repository into separate directories at the same time — which makes them the natural unit for parallel AI-agent work: one task, one branch, one worktree. Strand treats worktrees as first-class, with a dedicated dashboard (`Mod+6`) for creating, monitoring, reviewing, comparing, merging, and cleaning them up.

## The Worktrees dashboard

Open it with `Mod+6`, the palette entry "Show: Worktrees", or by clicking a worktree in the sidebar's Worktrees section. The header shows the repository's fleet at a glance — total, dirty, and merged counts — alongside the primary actions: **New worktree**, **Compare (N)** (appears once two or more rows are ticked), **Clean up (N)** (appears when clean, already-merged worktrees exist), and **Prune stale** (appears when the worktree registry points at directories that no longer exist).

Each worktree is a row, ordered current first, then the main checkout, then the rest. A row tells you:

- **Branch and location** — branch name, whether it's the main checkout, the directory name, and the full path.
- **Drift vs base** — ahead/behind counts (`N↑ N↓`) against its detected base branch.
- **Working-tree state** — dirty-file count (or "clean"), `+added −deleted` line counts, "touched N ago" activity based on the newest file change, and the working directory's disk size.
- **Last commit** — the subject of the worktree's own HEAD commit.
- **Badges** — `current`, `main`, `merged`, `unpushed` / `unmerged` (work exists only here), `locked` (with the lock reason as a tooltip), `detached`, and `stale` (prunable). Worktrees created by agent tooling (for example under `.claude/worktrees/`, or on `vk/` branches) get a creator badge, so you can tell your own checkouts from agent sessions.
- **Overlap warnings** — when two dirty worktrees have uncommitted changes touching the same files, each shows an `overlaps <name>: N` warning badge, with the file list in the tooltip. Use it to spot parallel attempts that are about to collide before you merge anything.

Per-row actions: **Review** (any non-main worktree — see below), **Open** (the main checkout), **Merge…** (shown while the branch isn't merged into its detected base), **Open tab**, and remove. If git refuses a removal (dirty or locked worktree), the row offers a **Force remove / Cancel** fallback — safe either way, because a snapshot is archived first. A stale row, whose directory is already gone, offers **Prune** instead of remove and clears the obsolete registry entry immediately.

The list is a keyboard listbox:

| Key | Action |
|---|---|
| `↑` / `↓` | Move focus between worktrees |
| `Enter` | Review the focused worktree against its base |
| `Space` | Tick / untick the row for comparison |

## Creating a worktree

Click **New worktree** on the dashboard, use the `+` on the sidebar's Worktrees section, or run "New worktree…" from the palette. You can also start from a specific point: **New worktree from here…** appears in the sidebar branch menus and the commit graph's right-click menu, seeding the dialog with that branch or commit.

The dialog:

- **Create a new task branch** — name the branch (spaces are auto-dashed) and pick where it starts: HEAD, any local branch, a remote branch, or a tag. When you pick a remote base, a **Fetch first** checkbox (checked by default) fetches before creating, so the worktree starts from the remote's actual tip; remote bases are set up to track automatically. Uncheck "create a new task branch" to check out an existing local branch instead.
- **Location** — defaults to a sibling directory, `<repo>.worktrees/<branch>`, and is editable.
- **Copy setup files from `.worktreeinclude`** — shown when the repository has a `.worktreeinclude` file at its root whose patterns match gitignored files. Git worktrees start without your ignored local setup (`.env` files, local configs), which breaks fresh checkouts; list those files in `.worktreeinclude` and Strand copies them from the source worktree into the new one so it runs out of the box. Checked by default when the file matches something; a toast reports how many files were copied.
- **Open in a new tab when created** — jump straight into the new worktree.

## Reviewing a worktree against its base

The **Review** button on a row (also `Enter` on the focused row, "Review vs base" in the sidebar and tab context menus) answers "what did this attempt actually change?" in one motion: Strand detects the worktree's base branch, pins the [review baseline](reviewing-agent-changes.md) at the fork point (the merge-base of the worktree branch and the base), opens the worktree's tab, and lands you in the Review view in session mode.

That means you see everything since the branch forked — the agent's commits, whatever it staged, and whatever is still uncommitted — as whole-file diffs in a single queue, regardless of how the agent left the working tree. The full review toolkit applies: reviewed marks, notes, and feedback export. See [Reviewing agent changes](reviewing-agent-changes.md).

If several agent worktrees belong to repositories in one workspace, [Workspace Review](repositories-and-workspaces.md) (`Mod+7`) aggregates them: every open worktree tab of a member repository reviews as its own section.

## Comparing attempts

When you've fanned the same task out to multiple agents, tick two or more rows (checkbox or `Space`) and click **Compare (N)**. The compare dialog shows one column per attempt, each diffed against its own fork point, as side-by-side changed-file lists. Files touched by two or more attempts are highlighted — those are where the attempts genuinely diverge and deserve a closer look.

Per column you can jump to a full **Review** of that attempt, or click **Pick winner…**, which hands the chosen worktree off to Merge & clean up; the losers can then be cleaned up from the dashboard.

## Merge & clean up

**Merge…** on a row (or "Merge & clean up…" in the sidebar and tab context menus) lands the worktree's branch on its base and retires the worktree in one dialog:

- **Into** — the target base branch. Strand detects it and marks the detected one, but you can pick another.
- **Mode** — **Squash into one commit** (agent WIP history stays out of the base branch), **Merge commit** (keeps every commit and records the merge), or **Fast-forward only** (available only when the base hasn't moved since the fork; it's the only option when the base branch isn't checked out anywhere).
- **Preview** — the dialog shows the exact git commands it will run, so there are no surprises.
- **Remove the worktree and delete the branch** — optional final step. A full snapshot is archived first, restorable from the dashboard. (Unavailable for the worktree you're currently in.)

The dialog warns when the worktree still has uncommitted changes, and when its files overlap with another dirty worktree's uncommitted changes — merge order matters in that case.

For bulk retirement, **Clean up (N)** removes every worktree that is both clean and already merged into its base, deleting the branches too, behind a confirmation that lists exactly what goes. **Prune stale** clears registry entries whose directories have vanished. Both are also in the palette: "Clean up merged worktrees…" and "Prune stale worktrees".

## Removal snapshots

Every worktree removal — including force removals and the bulk clean-up — first archives the worktree's full state: HEAD, staged changes, unstaged changes, and untracked files. Deleting a worktree in Strand is therefore never destructive.

The collapsible **Archived snapshots** panel at the bottom of the dashboard lists them. **Restore** recreates a worktree with the snapshot's exact state, uncommitted changes included; **Delete snapshot** (confirm-gated) discards one for good. Snapshots are auto-pruned — the newest 10 per worktree are kept, with a 60-day cap — so the archive doesn't grow forever.

## Worktrees in the sidebar and tabs

- **Sidebar → Git tab → Worktrees** is the first section: the current worktree is check-marked, single-click shows the dashboard, and double-click (or `Enter`) opens the worktree as its own tab. The right-click menu carries Open, Show, Copy path, **Review vs base**, **Merge & clean up…**, Lock / Unlock, Remove / Force remove, and Prune; the section's `+` creates a new worktree.
- **Grouped tabs** — in the repository rail or tab strip, a repository's worktrees cluster with their parent: shared color dot, repository name first with the branch as context, and a worktree glyph. Right-clicking a worktree tab offers **Review vs base**, **Merge & clean up…**, and Close worktree, so the whole review-and-land loop works without visiting the dashboard.

## Shortcut summary

| Shortcut | Action |
|---|---|
| `Mod+6` | Go to Worktrees |
| `↑` / `↓` | Move focus in the dashboard list |
| `Enter` | Review the focused worktree vs its base |
| `Space` | Tick the row for Compare |
| `Mod+7` | Workspace Review (includes open worktree tabs) |

`Mod+6` and `Mod+7` are rebindable in [Settings](settings.md) → Keyboard; the full shortcut reference lives in [Keyboard and palette](keyboard-and-palette.md).
