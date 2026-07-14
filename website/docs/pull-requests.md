# Pull Requests

The **Pull Requests** sidebar destination shows hosted pull requests for the
active repository. Strand currently supports GitHub and Azure DevOps, detected
from the repository's remotes; `origin` wins when more than one supported remote
exists. Open the same view from the command palette with "Show: Pull Requests".

## Sign in

Strand delegates authentication to the provider's official CLI and never reads
or stores its access token:

- GitHub requires [GitHub CLI](https://cli.github.com/) and `gh auth login`.
- Azure DevOps requires Azure CLI, the `azure-devops` extension, and `az login`.

If the CLI is missing, signed out, or cannot access the repository, the view
shows the provider error and the setup command. Provider calls time out after
30 seconds instead of blocking the app indefinitely.

## Browse PRs

The list contains up to the latest 100 open, closed, and merged pull requests.
If the checked-out branch has an active PR, Strand opens that PR automatically.
It also follows that PR in the background even if you never open Pull Requests.
Closed and merged PRs never auto-open. Otherwise, click a row to inspect it, or
use `Up`/`Down` or `j`/`k` and press `Enter`. **Pull Requests** in the detail
toolbar returns to the list and restores its keyboard focus. **Open on host**
hands the active PR to the provider website.

## Follow PR activity

Choose **Follow** in a PR header, or run “Pull Requests: follow open pull
request” from the command palette. Followed rows carry a bell badge. Strand
persists followed PRs, their last successful activity snapshot, and the most
recent worktree path for that hosted repository across relaunches. Switching
branches may add another automatically followed PR; it does not remove earlier
ones.

While Strand is running or minimized, it checks followed PRs after startup,
every 60 seconds, and when the window regains focus. A single desktop
notification per PR can summarize new non-system comments or thread replies,
approvals or requested changes, newly failing checks or Azure policies, a new
head commit, and merged or closed state. The first successful snapshot is only
a baseline and never notifies. Merged or closed PRs notify once and are then
removed from Following.

The first follow asks for desktop-notification permission. Denying permission
does not stop following; Strand keeps a persistent warning and a later manual
Follow attempt can ask again. Explicitly choosing **Following** to unfollow
mutes automatic following for that PR until you manually follow it again.
Automatic removal after merge or close does not create that mute.

Provider or network failures keep the last successful snapshot and retry later,
so a temporary outage cannot create false activity or turn an unknown check
state green. Monitoring uses small provider activity queries and never fetches
or parses patches.

For an active, non-draft PR, choose **Merge** in the detail header or run
"Pull Requests: merge open pull request…" from the command palette. The
split merge control works like GitHub: its primary button immediately runs the
selected strategy, while the adjacent chevron opens a keyboard-operable menu
for merge-commit, squash, and rebase. Required checks, reviews, branch policies,
and merge queues remain enforced by GitHub or Azure DevOps. Strand includes the
exact source commit currently displayed in the merge request; if the branch
changes before the action reaches the provider, the stale merge is refused and
Strand asks you to refresh. The source branch is not deleted automatically.

Directly below the PR title, the readiness strip combines the open/draft state,
review decision, provider checks, merge conflicts or policy state, and the last
reported update time. Select its **status details** disclosure to see the exact
blockers or pending signals. Strand only shows **Ready to merge** when every
reported signal is clear. Missing or unrecognized provider data is shown as
**Status incomplete**; Azure policy/check detail that the current CLI path does
not expose is never treated as success. The provider remains authoritative when
you choose Merge.

The list loads only compact row data; Strand loads rich metadata only after a
PR is opened. This keeps large repositories below provider query limits and
means moving through the list does not start provider calls. Refreshing keeps
the current list or detail mounted, including focus, scroll, active tab, file
selection, and unsent drafts. The toolbar shows **Updating…**, the last update
age, or a non-blocking failure with Retry instead of blanking the workspace.
Lightweight activity reloads rich detail only when something changed. The
opened PR uses the full content width and has three tabs. Use `Left`/`Right`,
`Home`, and `End` while the tab bar is focused.

### Overview

Overview shows title, state, author, source and target branches, dates, labels,
reviewers, review and merge state, file/addition/deletion/comment/commit counts,
and CI checks when available. Descriptions render as Markdown without executing
raw HTML or silently loading remote images. Checks are green when successful,
yellow while running or queued, red when failed, and neutral when the provider
does not report a recognized state.

### Conversation

Conversation displays GitHub issue and review-thread comments plus Azure
DevOps thread comments as safe Markdown in a timeline with author markers,
timestamps, and inline file paths for review comments. GitHub and Azure profile images appear when the provider
supplies a usable identity; initials remain visible if an avatar is absent or
cannot load. Select a comment timestamp to open that comment directly on the
provider host. File-backed comments also show **View in changes**. It switches
to Changes, selects the referenced file, and focuses the inline GitHub thread
when the provider supplied its line coordinates.

Use **Write** to compose a top-level comment and **Preview** to inspect the
rendered result before sending. The formatting toolbar supports bold, italic,
inline or fenced code, quotes, bulleted/numbered/task lists, links, and images.
Select existing text before choosing a format to wrap or prefix it. Choose
**Comment** or press `Mod+Enter` to send through the signed-in provider CLI;
Strand does not receive or store the provider token.

The image action inserts standard Markdown for a screenshot or image that
already has an `http(s)` URL. This also works with image Markdown copied from
the provider website. Direct local-file upload is not currently available
because the supported GitHub and Azure CLI paths do not share a stable binary
attachment API. Images in descriptions, previews, and comments stay unloaded
until you explicitly choose **Show image**, preventing a PR from silently
making a remote tracking request when opened.

### Changes

Changes loads only when its tab opens. A narrow left rail groups changed files
in the same Pierre folder tree used by Local Changes. Use the folder chevrons
to expand or collapse paths; use `Up`/`Down`, `j`/`k`, `Home`, or `End` to
select a file. The rest of the full-width workspace renders the selected patch
edge to edge beneath the same compact, collapsible file header used by Local
Changes. Use the two layout buttons in that header to switch between stacked
and split diffs; the choice is saved per repository. Only one file diff is
mounted at a time to keep large PRs responsive. Provider patches larger than
16 MB are not rendered.

On an open GitHub pull request, hover a line number and choose the `+` in its
gutter. Drag the `+` across adjacent lines to comment on a range, or drag across
line numbers and then use the `+` at the end of the selection. Strand
highlights the range and opens a compact composer directly beneath that code,
inside the diff. **Add comment** publishes a GitHub review thread
on that exact old- or new-file range; `Mod+Enter` sends from the composer.
Before publishing, Strand verifies that
the pull request head is still the commit used by the displayed patch; if it
changed, the draft stays in place and Changes asks you to refresh and reselect.
Closed and merged pull requests stay read-only.

When a new head commit is detected, Strand keeps the existing patch visible
while the replacement loads and labels it stale. Inline-comment submission is
disabled until the new patch succeeds, so comments cannot be anchored to old
coordinates. Background monitoring never reloads a patch when the head SHA is
unchanged.

Fetched GitHub review threads remain visible directly beneath their anchored
line or range. Replies stay grouped in the same card, and resolved or outdated
threads are labeled. The same review comments also appear in Conversation, so
comments added on GitHub are visible after refreshing the pull request.

Azure policy evaluations participate in readiness when their dedicated query
succeeds. A failed or incomplete policy query remains unknown instead of being
treated as green. Azure inline
comments also require provider iteration/change-tracking coordinates that the
current patch fetch does not include, so Strand disables that action and
directs you to the host instead of creating a wrongly anchored thread.
Creating replies, resolving threads, suggestions, approve/request-changes actions, richer Azure policy details,
branch updates, and close/reopen controls are planned but are not presented as
available yet. GitLab and Bitbucket adapters will use the same workspace in a
later slice.
