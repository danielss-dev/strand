# Pull-request workspace: competitive review and improvement proposal

> Research date: 2026-07-13. This is a product/UX proposal, not an implementation
> record. It compares current documented behavior with Strand's existing
> `PullRequests.tsx` workspace and keeps Strand's performance, keyboard, provider-
> neutral, and resizable-pane rules as hard constraints.

> Implementation status (2026-07-14): the readiness ledger, in-context
> stacked/split controls, Pierre line-range selection, and stale-head-guarded
> GitHub inline publishing are present. Followed PRs now persist across relaunch,
> the checked-out branch auto-follows independently of this view, native
> notifications report review activity, and list/detail/patch refreshes use
> stale-while-revalidate resource boundaries. Inline comments still publish
> immediately; the pending **Add to review** queue described below remains the
> intended batched-review workflow.

## Outcome

Strand already has a good *PR reader*: a fast list, lazy detail and patch
queries, provider-neutral GitHub/Azure support, safe Markdown, comments, a
single-mounted-file diff, and guarded merge actions. The next step should not be
more metadata. It should turn the view into a *review workspace* that keeps a
reviewer's place and makes the next blocker or action obvious.

The proposed signature is a **review ledger**: one compact, persistent status
line shared by the PR header and changed-file tree:

`14 / 22 viewed · 3 unresolved · 1 failing check · updated 8m ago`

Each file carries the same small state vocabulary (unviewed, viewed, changed
since viewed, unresolved thread). This is specific to Strand's job—reviewing
large human- and agent-authored changes without losing one's place—and is more
useful than adding a generic dashboard or decorative status cards.

## What comparable products do

| Product | Integration model | Useful interaction pattern | Lesson for Strand |
| --- | --- | --- | --- |
| **Codex app** | When the checked-out branch has a GitHub PR, the sidebar loads PR context and reviewer feedback through authenticated `gh`; comments appear alongside the diff. The user can ask Codex to address selected feedback, inspect the resulting local diff, then stage, commit, and push in the same task. | Review feedback is not a destination; it becomes actionable context for a fix-and-verify loop. | Keep hosted threads attached to their code, and offer a lightweight handoff such as **Copy unresolved feedback** before considering a built-in agent. |
| **Cursor 3** | A PR workspace spans Reviews, Commits, and Changes. Reviews combines inline threads and top-level comments; Changes uses a file tree and changes picker. Reviewer status, pending-review banners, and quick-action pills stay prominent. | The interface surfaces the current review state and likely next action instead of making the user infer them from raw metadata. | Add a commits view, thread-aware review state, and contextual actions; do not turn every action into a permanent toolbar button. |
| **Conductor** | The PR is attached to the same worktree/workspace as the agent, terminal, diff, and branch. Its Checks tab aggregates git status, PR metadata, CI, deployments, review comments, and todos. Line comments can be sent back to the agent; resolved GitHub threads can be cleared in the diff. | “Ready to merge?” is a cross-signal question, not merely a CI state. | Build one provider-neutral readiness model and let it drive both the summary and merge affordance. |
| **GitHub** | Conversation, Commits, Checks, and Files changed separate distinct review jobs. Files changed supports single- or multi-line comments, file comments, suggestions, batched reviews, and a navigator for unresolved, resolved, and outdated conversations. | Threads have lifecycle and location; reviews have draft state and a deliberate submit step. | Replies, resolution, outdated state, and review submission are core data-model work, not conversation-tab polish. |
| **Graphite** | A filtered PR inbox groups work into needs-review, returned, approved, drafts, and merging states. The review page supports inline threads/suggestions, keyboard review actions, version comparison, and “hide reviewed changes.” | Reviewers need an attention queue and a way to isolate what changed since their last pass. | First add local viewed-state and list filters; later add provider-backed “since last review” comparison if the provider exposes a reliable boundary. |
| **GitKraken** | Desktop exposes PR metadata, checkout, build status, suggestions, and merge, but its newest full review experience is linked to a richer web surface. | A desktop client can be excellent without reproducing every host feature, provided deep links preserve context. | Keep **Open on host** and add targeted links for a check or thread when provider support is incomplete. |

Sources:

- [Codex code review and pull-request workflow](https://learn.chatgpt.com/docs/code-review.md)
- [Codex code review in GitHub](https://learn.chatgpt.com/docs/third-party/github.md)
- [Cursor 3 PR review announcement](https://cursor.com/changelog/05-07-26)
- [Conductor: review and merge a workspace](https://www.conductor.build/docs/guides/review-and-merge)
- [Conductor Checks reference](https://www.conductor.build/docs/reference/checks)
- [GitHub: commenting on a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request)
- [GitHub: about pull requests](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)
- [Graphite PR page](https://graphite.com/docs/pr-page-overview)
- [Graphite PR inbox](https://graphite.com/docs/use-pr-inbox)
- [Graphite PR versions](https://graphite.com/docs/pull-request-versions)
- [GitKraken pull requests](https://help.gitkraken.com/gitkraken-desktop/pull-requests/)

## Strand today

### What is already strong

- The list query is intentionally shallow and detail loads only after a PR is
  opened. That avoids the provider query-cap failure already recorded in
  `ROADMAP.md`.
- Changes load only when requested, parse once, and mount one Pierre diff at a
  time. This is the correct performance boundary for large PRs.
- List, tabs, file tree, merge menu, composer, and command-palette entry points
  already have credible keyboard models.
- Provider Markdown is sanitized and remote images require an explicit reveal.
- Merge carries the displayed head SHA, so a newly-pushed commit cannot be
  merged without review.
- The list-to-full-width-detail navigation gives the diff enough room instead
  of permanently shrinking it beside a PR list.

### Friction in the current information architecture

1. **The list is an archive, not an inbox.** Open, closed, and merged PRs share
   one latest-100 sequence with no search, state filter, “needs my review,” or
   “authored by me” grouping.
2. **Status is descriptive rather than diagnostic.** Raw review and merge-state
   pills do not explain whether the blocker is a failed check, missing approval,
   draft state, conflict, unresolved thread, or unknown provider data.
3. **Overview buries readiness.** Reviewers and checks appear after labels and
   description, even though they determine the next action.
4. **Conversation flattens review structure.** Top-level comments are readable,
   and Azure paths are shown, but replies, inline placement, resolved/outdated
   state, and pending review comments are absent.
5. **Changes does not preserve review progress.** There is no viewed state,
   changed-since-viewed state, unresolved-thread count, or next-thread command.
6. **No review decision can be completed in Strand.** Approve, request changes,
   review summary, and batched submission are still host-only.
7. **No commit/version lens.** A reviewer cannot understand how the PR evolved
   or isolate changes since an earlier pass.
8. **Refresh now follows activity signals.** Lightweight snapshots update on a
   60-second cadence and focus, while populated content stays mounted. Rich
   detail reloads only after activity changes and patches only after the head
   SHA changes; independent Checks and Commits tabs remain future work.

## Recommended UX and UI

### P0 — complete the review loop

#### 1. Add the review ledger and readiness summary

Replace the free-form status pills with a compact, semantic strip directly
under the title. It should report only facts Strand can support:

- **Ready to merge** when all provider-reported required signals are satisfied.
- **3 blockers** with an expandable ordered list: draft, conflicts, required
  reviews, failed/running required checks, unresolved required threads, stale
  branch, then provider-specific policy.
- **Status incomplete** when Azure or another provider does not expose a signal;
  unknown must never be rendered as success.
- Review progress: viewed files and unresolved threads.
- Freshness: “updated 2m ago” with a refresh action when stale.

Keep the merge control visible, but make its relationship to readiness explicit.
If the provider permits an override, the confirmation should name the blockers;
if Strand cannot determine readiness, say “Provider will verify on merge.”

#### 2. Make Changes the primary review workspace

Keep the current two-pane, single-mounted-file layout. Enrich it rather than
adding an always-visible third pane:

- File rows gain a small viewed toggle, unresolved-thread count, and
  changed-since-viewed indicator. Key viewed state by PR head SHA + file patch
  hash so a new push safely reopens changed files.
- The file-tree header becomes the ledger: `14 / 22 viewed · 3 unresolved`, plus
  filters for **All**, **Unviewed**, and **Threads**.
- `]` / `[` move to next/previous file; `n` / `Shift+n` move between unresolved
  threads; `v` toggles viewed. Expose all through the command palette and show
  the shortcuts in tooltips.
- Hovering or focusing a diff line reveals **Add comment**. Shift-selection
  creates a multi-line range. Existing threads render immediately after their
  anchor line and can collapse without unmounting the file diff.
- A compact conversation navigator popover lists unresolved, resolved, and
  outdated threads. Selecting an item switches file and scrolls to its anchor.

This is the visual signature: the changed-file tree becomes a quiet ledger of
what the reviewer has and has not cleared. Use existing `--text-*`, `--accent`,
`--warn`, `--add`, and `--del` tokens; do not introduce another status palette.

#### 3. Add a real review draft and submission flow

Line/file comments should default to **Add to review**, not notify immediately.
A sticky **Finish review (3)** action opens a focused sheet with:

- the pending comments grouped by file;
- an optional Markdown summary;
- **Comment**, **Approve**, and **Request changes** as mutually exclusive
  outcomes, limited by provider capability;
- the exact head SHA being reviewed and a stale-head refusal before submission.

After submission, keep the user on the same file and announce the result with an
ARIA live region. Replies and Resolve/Reopen belong inline in the thread. When a
provider cannot support a write, preserve the draft and offer a direct host link.

### P1 — make attention and evolution visible

#### 4. Turn the list into a repository-level PR inbox

The first iteration should stay local and cheap—filter the existing shallow
result rather than multiplying provider calls:

- segmented filters: **Open**, **Needs review**, **Mine**, **Draft**, **Closed**;
- fuzzy search over number, title, author, and branch;
- row-leading attention state: review requested, changes requested, failing CI,
  draft, or ready;
- updated age and comment/check summary at the trailing edge;
- sort open work by action required, then recency; keep closed/merged behind
  their filter rather than mixing them into the default view.

Do not copy Graphite's cross-repository inbox into this surface. Strand already
has a workspace-level aggregation pattern; cross-repo PR triage should be a
separate later decision.

#### 5. Split Summary, Commits, and Checks by job

Rename **Overview** to **Summary** and place description first, followed by a
short metadata block. Add:

- **Commits**: chronological commit rows with author, subject, time, and a
  compare/open action. Fetch only when the tab opens.
- **Checks**: grouped required, failed, running, and successful checks with
  duration and provider deep links. Fetch/refresh independently so a CI update
  does not re-download comments or the patch.

The persistent readiness strip means reviewers never need to visit Checks just
to learn whether merging is blocked.

#### 6. Add branch/worktree actions in context

For a PR not currently checked out, show **Open in worktree…** as the preferred
action and **Check out branch** in its menu. For the current branch, show
**Update branch** only when the provider reports it behind the base. These should
reuse Strand's existing worktree safety and overlap checks; a hosted PR must not
quietly take over a dirty checkout.

#### 7. Refresh by signal, not by whole-page polling

Implemented in the followed-PR slice: the global monitor shares in-flight
activity requests with the visible view, never downloads patches, and preserves
successful baselines through provider failures. The remaining work here is to
split Checks and Commits into their own lazy resources.

- Show the last successful provider refresh time.
- Refresh lightweight readiness data on window focus and on a modest interval
  only while the PR view is visible.
- Keep detail, threads, checks, commits, and patch caches separate.
- Invalidate the patch and file-viewed hashes only when the head SHA changes.
- Never poll the patch or mount additional Pierre diffs in the background.

### P2 — reduce repeat-review cost

#### 8. Add “changes since my last review”

When the provider exposes the viewer's last submitted review commit, add a
compare selector:

- **All changes**: merge base → current head;
- **Since my review**: last reviewed head → current head;
- **Commit…**: selected PR commit → current head.

If no reliable review boundary exists, omit the mode rather than infer it from
timestamps. Viewed-state remains local and clearly labeled as such.

#### 9. Add suggestions and a feedback handoff

- Let a line-range comment switch to **Suggest change**, producing provider-
  native suggestion syntax where supported.
- Add **Copy unresolved feedback** to export thread links, paths, ranges, and
  bodies as compact Markdown suitable for an external coding agent.
- If Strand later gains a first-class agent handoff, attach the exact PR head
  SHA and selected threads; do not begin with a vague “Fix PR” button.

#### 10. Support provider lifecycle features without polluting the common UI

Close/reopen, ready-for-review, reviewer management, auto-merge, merge queues,
and deployments should be capability-gated actions. Put uncommon provider-
specific operations in an overflow menu or readiness detail, not beside the
primary review/merge actions.

## Proposed layout

```text
┌ Pull Requests / #482                                      Refresh ··· ┐
│ Fix stale cache invalidation                         Open on host      │
│ #482 · daniel · feature/cache → main                                    │
│ [2 blockers] 14/22 viewed · 3 unresolved · CI 8/9 · updated 2m ago     │
├ Summary  Conversation  Changes  Commits  Checks                         ┤
│                                                                         │
│ ┌ Changed files ───────────────┐┆┌ src/cache.ts ─ +42 −18 ────────┐   │
│ │ 14 / 22 viewed · 3 threads   │┆│  81  const ttl = ...            │   │
│ │ [All] [Unviewed] [Threads]   │┆│ +82  cache.set(key, value)  [+] │   │
│ │ ○ src/api.ts               1 │┆│ ┌ unresolved · maya · 8m ────┐ │   │
│ │ ◐ src/cache.ts             2 │┆│ │ This races the eviction…   │ │   │
│ │ ✓ src/types.ts               │┆│ │ Reply  Resolve  Open host   │ │   │
│ │ ○ tests/cache.test.ts         │┆│ └────────────────────────────┘ │   │
│ └───────────────────────────────┘┆└─────────────────────────────────┘   │
├ [Previous thread] [Next thread]                 [Finish review (3)]    ┤
```

The divider remains `react-resizable-panels` with a stable `autoSaveId`. At
narrow desktop widths, collapse the file tree to a files popover; do not squeeze
the diff below the project's 30% minimum. Inline threads are part of the diff
flow, not a fixed-width third rail.

## Interaction and accessibility contract

- Preserve listbox semantics for the PR inbox and tab semantics for detail.
- Focus returns to the originating row, line, or thread after sheets/popovers
  close. New provider data must not steal focus.
- Every new action is in the command palette. Dedicated shortcuts are optional;
  when present, use the platform modifier helper rather than hardcoded Cmd/Ctrl.
- Thread anchors remain reachable after collapse and expose path + line range to
  screen readers.
- Status never relies on color alone: icon, label, and count travel together.
- Reduced motion means no animated progress shimmer or automatic scroll beyond
  the explicitly selected thread/file.

## Performance and data contract

The implementation should keep separate lazy resources:

```text
PR list (shallow)
  └─ selected PR summary/readiness
       ├─ conversation + review threads
       ├─ checks
       ├─ commits
       └─ patch → parsed file metadata → one mounted file diff
```

- Do not expand threads, checks, and commits across the 100-row list query.
- Cache each resource by provider/repository/PR/head SHA and cancel stale
  requests when selection changes.
- Fetch small readiness deltas separately from the patch.
- Keep comments paginated or incrementally loaded for very active PRs.
- Store viewed state as `{pr, headSha, path, patchHash}`; a changed hash becomes
  unviewed automatically.
- Thread anchors should use provider line/start-line/side fields, not deprecated
  diff-relative positions. Preserve enough original metadata to deep-link when
  a thread becomes outdated.
- Measure list-to-interactive, PR-open-to-summary, Changes-open-to-first-diff,
  and thread-jump latency against PRD §8 before shipping.

## Suggested delivery slices

1. **Review foundation:** provider-neutral thread/review types, readiness model,
   and the header ledger. Verify unknown provider fields never become green.
2. **Review workspace:** inline thread reading, thread navigator, and local
   viewed-state/filtering. Verify one Pierre file remains mounted.
3. **Review writes:** pending comments, replies, resolve/reopen, and submit
   comment/approve/request-changes with stale-head protection.
4. **Attention:** list filters/search/row states and independent Checks tab.
5. **Evolution:** Commits and “since my review” comparison where reliable.
6. **Local action:** safe worktree checkout/update and feedback export.

Each slice should land provider capability tests, keyboard tests, and one large-
PR performance check with the feature—not as a cleanup pass afterward.
