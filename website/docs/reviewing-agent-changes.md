# Reviewing Agent Changes

The Review view (`Mod+5`) is Strand's core workflow: a dedicated surface for reading everything an AI coding agent did to your repository — whether it left the changes unstaged, staged them, or already committed them — and turning your reading into verdicts and feedback. It is deliberately separate from Local Changes: staging lives there, reviewing lives here.

Open it from the sidebar **Review** row, with `Mod+5`, or via the palette action "Show: Review".

## Two modes

Review works in one of two modes, decided by whether a baseline is pinned:

- **Inbox mode** (no baseline) — the review set is every uncommitted change, staged and unstaged together. Staging a file never removes it from Review. Files with only unstaged work carry inline Stage / Discard buttons; a file with staged content renders read-only at hunk level so a combined patch cannot be applied to the index incorrectly.
- **Session mode** (baseline pinned) — the review set is *everything since the baseline commit*: the agent's commits, plus whatever is staged and unstaged on top. Diffs are read-only in this mode; you act at the file level (mark reviewed, add notes) rather than staging hunks.

If the view is empty, the placeholder tells you which mode you are in — in session mode it reads "No changes since `<short>`. Let the agent work — this view follows along live."

## Whole-file context diffs

Every file in the review set renders in its entirety, with the edits inline — not as isolated hunks with a few context lines. You always see the code around a change, which is exactly what reviewing agent output needs: agents edit in many places at once, and hunk-sized windows hide the shape of the file. Large files stay fast; the diff pane is virtualized, so a 5,000-line file mounts only the rows on screen.

`Mod+F` opens in-diff search across the whole review set, with wrap-around stepping (`Enter` / `Shift+Enter`) and path + line previews; jumps land centered on the matched line.

## Pinning a baseline

A baseline says "review everything since this commit." Use the branch-start action to include every commit made on the current branch, plus its staged and unstaged work, in one combined diff.

- **From the Review toolbar** — "Review from branch start" detects the branch you forked from and pins the baseline at their merge base. Once pinned, "Move baseline to HEAD" starts a fresh session at the current HEAD, while "Clear baseline" returns to inbox mode. The toolbar shows "Session since `<short>`" while pinned.
- **From the commit graph** — right-click any commit and choose "Review changes since this" to pin the baseline at that exact commit. See [Commits and history](commits-and-history.md).
- **From the palette** — the baseline actions (pin, move, clear) are all available under `Mod+K`.

The baseline persists per repository, so a session survives restarting Strand. While a baseline is pinned, the graph toolbar also offers "Select since `<short>`" (palette: "Review: select commits since baseline"), which multi-selects the agent session's commits in the graph. Commits with `Co-Authored-By` trailers or bot authors get an `ai` chip there, so agent sessions are easy to spot.

## The review queue

The left side of the view is a file tree of everything in the review set — your queue. It tracks your progress:

- A check decoration marks files you have reviewed.
- If a file changes again after you reviewed it, its mark flips automatically and the row shows **changed** ("Changed since reviewed — review again"). Reviewed marks are tied to the exact content you saw, so a stale approval can never hide a newer edit.
- Files with notes carry a `✎N` badge.

Double-click or press `Enter` on a row to toggle its reviewed state; doing this on a folder marks its whole subtree. Right-click a row for Mark reviewed, Stage, Discard, and Copy path. Reviewed marks persist per repository across restarts, and they drive the progress bar in the Review toolbar.

## Change map

Beside the diff's scrollbar sits an overview ruler marking where every change block lives in the file — green for additions, red for deletions, split for mixed blocks — plus a translucent thumb tracking the visible region. Click or drag it to jump anywhere in the file. It is the fastest way to see how much of a long file the agent actually touched.

## Notes and feedback for the agent

While reading, attach notes to what you want changed:

- Press `m` (or use the file-header **Note** button) to add a note on the current file; in inbox mode, per-change-block Note buttons attach a note anchored to a specific line.
- Notes appear as chips above the diff (line-anchored ones show an `L<line>` chip) and can be removed with their × button.
- Notes are scoped to the current baseline and branch (or exact detached
  commit). Switching comparisons shows that comparison's own notes; returning
  restores the notes you left there.

When you are done, click **Copy feedback (N)** in the toolbar (palette: "Review: copy feedback as prompt"). Strand assembles every note into one Markdown prompt — branch and baseline header, per-file sections, each line note with a fenced diff excerpt of the surrounding lines, and a closing instruction — ready to paste straight back into the agent. "Review: clear notes" wipes the slate for the next round.

## AI code review

Click **Review with Codex/Claude Code** in the Review toolbar, or run "Review changes with AI…" from the command palette. Strand sends the exact pool currently shown—staged and unstaged changes in inbox mode, or committed, staged, and unstaged changes since the pinned baseline in session mode—to the provider and model selected in Settings → AI.

Actionable findings first appear in a pending suggestions list. AI review never edits files, stages work, or adds notes automatically. Inspect each suggestion, then choose **Add note** or **Add all as notes** to keep the feedback, or dismiss it. Accepted findings become removable notes labelled **AI · critical/high/medium/low**. Strand validates every returned path against the submitted changes and keeps a line anchor only when that line exists on the reported diff side; an otherwise useful finding becomes a file note rather than pointing at invented code. If the diff or baseline changes while the provider is working or while suggestions are pending, Strand cancels or discards the stale answer.

The same privacy controls as commit and PR suggestions apply: conservative sensitive-file matches require an explicit exclude/include choice before provider launch, context and output are bounded, the operation is cancellable, and provider failures can retry with the other configured CLI. The coverage row reports how many patches were included or truncated. AI findings are possible issues to verify, not an approval verdict; Strand does not mark files reviewed automatically.

## Live following

Strand watches the working tree, so the review set updates while the agent is still working — no need to focus the window or hit refresh. New edits appear in the queue, and files edited after you reviewed them flip back to **changed** on their own. You can review an agent session as it happens rather than after the fact.

## Keyboard loop

Review is built to be driven entirely from the keyboard. These keys are fixed (the navigation ones also appear under Settings → Keyboard → Context shortcuts):

| Key | Action |
|---|---|
| `j` / `k` | Next / previous file in the queue |
| `n` / `p` | Next / previous change block in the diff |
| `Space` | Toggle reviewed on the current file (stays on the file) |
| `m` | Add a note to the current file |
| `s` | Stage the current file (when it is unstaged) |
| `d` `d` | Discard the current file (press twice to confirm) |
| `c` | Jump to Local Changes and focus the commit subject field |
| `Shift+J` / `Shift+K` | Scroll the diff pane down / up |
| `Mod+F` | Search within the review diff |
| `↑` / `↓` | Move through the file tree |

The typical rhythm: `j`, read, `Space`, `j`, read, `m` to leave a note, `Space` — and `c` to go commit once the queue is clear.

## Acting on your verdicts

Once files are marked, the toolbar offers bulk actions:

- **Stage reviewed (n)** — stages every reviewed file that is currently unstaged.
- **Discard unreviewed (n)** — throws away unstaged files you did not approve. It appears once two or more unreviewed unstaged files remain (for a single file, use the per-file discard). It is a two-step button: the first click arms it, a second click within a few seconds confirms.

Single-file discards (`d` `d`, or the context-menu Discard) also require the second press to confirm. In inbox mode, discarding an individual change block via its inline button surfaces an Undo toast for a few seconds — clicking Undo applies the discarded slice back to the working tree.

Discards permanently modify the working tree, so for anything larger than a block, prefer taking a snapshot first: the palette's "Save snapshot…" records the current state onto the stash stack while keeping your working tree untouched. See [Everyday Git](everyday-git.md) for stashes and snapshots.

## Review vs base for worktrees

Worktrees are the natural container for agent tasks — one attempt per worktree. **Review vs base** in the Worktrees action bar or a worktree's sidebar / rail / tab context menu pins the review baseline at the point where the worktree's branch forked from its detected base branch — the branch it was actually cut from, which is not necessarily the main branch — and opens that worktree's tab directly on Review in session mode (if the base branch cannot be detected, the tab opens on Local Changes instead). You see the attempt's committed, staged, and unstaged work since the fork point as one diff, with the full queue, notes, and feedback export.

See [Worktrees](worktrees.md) for creating worktrees, comparing multiple attempts, and merging the winner.

## Reviewing across repositories

If your product spans several repositories grouped into a workspace, Workspace Review (`Mod+7`) aggregates every member repository — and every open worktree tab of a member — into one merged review queue with the same keys, notes, and feedback export. Members whose folder was deleted or moved are skipped until the path is a repository again. See [Repositories and workspaces](repositories-and-workspaces.md).
