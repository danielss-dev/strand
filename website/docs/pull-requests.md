# Pull Requests

The **Pull Requests** sidebar destination shows hosted pull requests for the
active repository. Strand currently supports GitHub and Azure DevOps, detected
from the repository's remotes; `origin` wins when more than one supported remote
exists. Open the same view from the command palette with "Show: Pull Requests".

## Sign in

GitHub and Azure DevOps Services delegate authentication to the provider's
official CLI, and Strand never reads or stores those access tokens:

- GitHub requires [GitHub CLI](https://cli.github.com/) and `gh auth login`.
- Azure DevOps requires Azure CLI, the `azure-devops` extension, and `az login`.

Settings → Hosting summarizes both CLI connections and displays the signed-in
account reported by each provider.

Azure DevOps Server 2020+ uses the optional `strand-azdo` REST helper instead
of `az`. Enable it and add an HTTPS collection profile under **Settings →
Hosting**. PAT profiles work on every supported desktop and keep the token only
in the native credential vault; Windows profiles can use the current Windows
identity with Negotiate/NTLM. Private-CA PEM import is available for PAT
profiles. The collection URL automatically matches standard HTTPS and SSH clone URLs,
so Strand derives the project and repository from each Git remote. Leave the
collection field blank to derive and save it from the active repository. Additional
prefixes are needed only for server aliases; the longest match wins, with
`origin` preferred. Azure DevOps Services URLs are never routed through the
helper.

Packaged desktop builds import the interactive login-shell `PATH`, including
Homebrew, local-bin, and version-manager locations that GUI launchers normally
omit. Restart Strand after changing shell startup files or installing a CLI.

If the CLI is missing, signed out, or cannot access the repository, the view
shows the provider error and the setup command. Provider calls time out after
30 seconds instead of blocking the app indefinitely.

## Create a PR

Choose **Create PR** in the Pull Requests toolbar, or run “Pull Requests:
create for current branch…” from the command palette. The dialog creates a
GitHub or Azure DevOps pull request from the checked-out branch with a title,
Markdown description, target branch, and optional draft state. After creation,
Strand opens the new PR and follows it automatically.

If the checked-out branch does not exist on the detected repository remote,
Strand pushes it before asking the provider to create the PR. A branch without
an upstream starts tracking that remote branch; an existing upstream on another
remote is preserved. A failed push leaves the dialog open and the PR is not
created. Authentication continues to use the signed-in `gh` or `az` CLI for
cloud providers, or the matched helper profile for Azure DevOps Server.

“Draft pull request with AI…” in the command palette opens the same dialog,
resolves its default target, and then starts generation. AI generation itself
does not push or create anything automatically.

Choose **Fill with Codex** or **Fill with Claude Code** to draft both editable
fields using the AI provider selected in **Settings → AI**. Strand compares the
selected target branch's merge base with local `HEAD` and sends that bounded,
committed diff to the configured vendor CLI. Staged and unstaged changes are not
included. If the fields already contain text, the button changes to **Replace**
so overwriting the current draft is explicit. AI generation does not push the
branch, contact GitHub/Azure DevOps, or create the PR; review and edit the result
before choosing **Create pull request**.

The dialog shows which AI provider produced the text and how much bounded diff
context was included. Generation has a visible **Cancel** action, conservative
sensitive-file include/exclude confirmation, **Undo AI replacement**, and an
explicit retry with the other provider after non-authentication failures. The
alternate retry does not change the provider selected in Settings.

## Browse PRs

The list contains up to the latest 100 open, closed, and merged pull requests.
Use the local search field to match a PR number, title, author, source branch,
or target branch without starting another provider request. The filter tabs are:

- **All** — every returned status.
- **Authored** — every status authored by the account signed into `gh` or `az`.
- **Completed** — merged and closed-without-merge PRs, with distinct badges.

If Strand cannot identify the signed-in provider account, All and Completed
remain available and Authored shows a sign-in/refresh explanation. Search and
filter state survive detail navigation and reset when the active repository
changes. Run “Pull Requests: search…” from the command palette to return to the
inbox and focus its search field.

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

Strand checks desktop-notification permission when monitoring starts; a first
manual follow requests it when the platform requires a prompt. On Windows,
Strand reads Tauri's native desktop permission directly instead of WebView2's
unrelated browser permission. Denying permission does not stop following:
Strand keeps a persistent warning and a later manual Follow attempt can ask
again. Explicitly choosing **Following** to unfollow mutes automatic following
for that PR until you manually follow it again. Automatic removal after merge
or close does not create that mute.

Provider or network failures keep the last successful snapshot and retry later,
so a temporary outage cannot create false activity or turn an unknown check
state green. Monitoring uses small provider activity queries and never fetches
or parses patches.

For a draft PR, the detail header replaces Merge with **Ready for review** when
the signed-in provider account can change that PR's stage. GitHub uses its
viewer update capability; Azure DevOps presents the action conservatively for
the signed-in PR author, and the provider remains authoritative if permissions
changed. A successful transition refreshes the current detail in place and the
normal Merge control appears. The command-palette action “Pull Requests: merge
or mark ready…” follows the same rule.

For an active, non-draft PR, choose **Merge** in the detail header or run that
command-palette action. The
split merge control works like GitHub: its primary button immediately runs the
selected strategy, while the adjacent chevron opens a keyboard-operable menu
for merge-commit, squash, and rebase. Required checks, reviews, branch policies,
and merge queues remain enforced by GitHub or Azure DevOps. Strand includes the
exact source commit currently displayed in the merge request; if the branch
changes before the action reaches the provider, the stale merge is refused and
Strand asks you to refresh. The source branch is not deleted automatically.

The adjacent **Pull request actions** menu closes an active PR behind a second
confirmation. A closed GitHub or abandoned Azure DevOps PR shows **Reopen pull
request** there instead. Merged/completed PRs have no lifecycle or merge action.
Summary and Timeline replace their composers with an explicit read-only state,
and Code keeps inline threads visible without reply, resolve, or comment
controls. These rules are shared by GitHub, Azure DevOps Services, and the
optional Azure DevOps Server helper.

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
opened PR uses the full content width, starts directly beneath the compact PR
toolbar, and keeps its three tabs centered there. Use `Left`/`Right`, `Home`,
and `End` while the tab bar is focused.

### Summary

Summary shows the source → target branch, reviewers, comment and commit counts,
and aggregate file/addition/deletion totals as compact fact rows. Description
and checks are collapsible. Descriptions render as Markdown without executing
raw HTML or silently loading remote images. Checks are green when successful,
yellow while running or queued, red when failed, and neutral when the provider
does not report a recognized state. The compact comment composer is shared with
Timeline, so an unsent draft survives tab switches and refreshes.

### Timeline

Timeline orders commits, GitHub issue/review-thread comments, Azure DevOps
thread comments, and opened/merged/closed lifecycle markers oldest-first on one
chronology rail. Commit events show the author, subject, short hash, timestamp,
and a provider link when available. Comments render as safe Markdown with author
markers, timestamps, and inline file paths. Commit metadata is fetched only for
the opened PR; newly detected pushes refresh this chronology without making the
inbox query heavy or loading Code. GitHub and Azure profile images appear when
the provider supplies a usable identity; initials remain visible if an avatar
is absent or cannot load. Select a comment timestamp to open that comment
directly on the provider host. File-backed comments also show **View in Code**.
It switches to Code, selects the referenced file, and focuses the inline GitHub
thread when the provider supplied its line coordinates.

Use **Write** to compose a top-level comment and **Preview** to inspect the
rendered result before sending. The formatting toolbar supports bold, italic,
inline or fenced code, quotes, bulleted/numbered/task lists, links, and images.
Select existing text before choosing a format to wrap or prefix it. Choose
**Comment** or press `Mod+Enter` to send through the selected provider
connection. Cloud credentials remain in `gh`/`az`; Azure Server PATs remain in
the native credential vault.

The image action inserts standard Markdown for a screenshot or image that
already has an `http(s)` URL. This also works with image Markdown copied from
the provider website. Direct local-file upload is not currently available
because the supported GitHub and Azure provider paths do not share a stable
binary attachment API. Images in descriptions, previews, and comments stay unloaded
until you explicitly choose **Show image**, preventing a PR from silently
making a remote tracking request when opened.

### Code

Code loads only when its tab opens. Its aggregate strip shows source → target,
commit count, changed-file count, and total additions/deletions. A narrow left
rail groups changed files in the same Pierre folder tree used by Local Changes;
addition/deletion totals stay in the selected-file header instead of every
tree row. Use the folder chevrons
to expand or collapse paths; use `Up`/`Down`, `j`/`k`, `Home`, or `End` to
select a file. The rest of the full-width workspace renders the selected patch
edge to edge beneath the same compact, collapsible file header used by Local
Changes. Use the two layout buttons in that header to switch between stacked
and split diffs; the choice is saved per repository. Only one file diff is
mounted at a time to keep large PRs responsive. Provider patches larger than
16 MB are not rendered.

Code also tracks review progress locally for the exact pull-request head and
each file's rendered patch. Choose **Mark viewed** or press `v`; if that file or
the PR head later changes, its check becomes **changed** instead of silently
remaining reviewed. The header shows viewed-file and unresolved-thread totals.
Use **All**, **Unviewed**, or **Threads** to focus the file tree, `[` / `]` or
`j` / `k` to move between files, and `n` / `Shift+n` to jump between unresolved
threads. These filters preserve the one-mounted-diff performance boundary.

On an open GitHub pull request, hover a line number and choose the `+` in its
gutter. Drag the `+` across adjacent lines to comment on a range, or drag across
line numbers and then use the `+` at the end of the selection. Strand
highlights the range and opens a compact composer directly beneath that code,
inside the diff. **Add comment** publishes a GitHub review thread
on that exact old- or new-file range; `Mod+Enter` sends from the composer.
Before publishing, Strand verifies that
the pull request head is still the commit used by the displayed patch; if it
changed, the draft stays in place and Code asks you to refresh and reselect.
Closed and merged pull requests stay read-only.

Choose **Add to review** in that inline composer to queue the selected range
instead of publishing it immediately. **Review** in the Code header opens the
exact-head review draft, where pending comments can be removed and a Markdown
summary can be written or previewed. Submit the whole draft as **Comment**,
**Approve**, or **Request changes**; requesting changes requires a summary. The
same composer is reachable from the command palette with “Pull Requests:
submit review…”. Drafts survive leaving the tab and provider failures, but a
new source commit makes the old draft visibly stale and blocks submission until
it is discarded or rewritten against the refreshed patch. GitHub sends the
summary and pending inline comments as one review pinned to that commit. Azure
DevOps Services and Server support the decision plus optional summary; pending
inline comments stay unavailable there until Strand has provider iteration and
change-tracking coordinates.

When a new head commit is detected, Strand keeps the existing patch visible
while the replacement loads and labels it stale. Inline-comment submission is
disabled until the new patch succeeds, so comments cannot be anchored to old
coordinates. Background monitoring never reloads a patch when the head SHA is
unchanged.

Fetched GitHub review threads remain visible directly beneath their anchored
line or range. Replies stay grouped in the same card, and resolved or outdated
threads are labeled. The same review comments also appear in Timeline, so
comments added on GitHub are visible after refreshing the pull request.

When GitHub reports that your account can write to a thread, its card exposes
**Reply** and **Resolve** or **Reopen**. Replies publish immediately; use
`Mod+Enter` to send or `Esc` to close the reply editor without losing its draft.
Successful writes update both the inline card and Timeline without
reloading the patch or moving your current file and scroll position. These
actions target the existing provider thread rather than a line coordinate, so
they remain valid when GitHub permits them on a resolved or outdated thread.

Submitted reviews appear in the Summary tab. When GitHub reports that your
account may update a review, **Edit summary** changes its Markdown body. When
the pull request and review are eligible for dismissal, **Dismiss review…**
requires a reason before the provider write is enabled. Azure DevOps votes do
not have an editable review body; Strand instead offers **Reset my vote** only
on the signed-in reviewer's current nonzero vote. Every successful action
refreshes rich detail so revoked capabilities and provider state take effect
immediately. These controls are absent on terminal pull requests.

Azure policy evaluations participate in readiness when their dedicated query
succeeds. A failed or incomplete policy query remains unknown instead of being
treated as green. Azure inline
comments also require provider iteration/change-tracking coordinates that the
current patch fetch does not include, so Strand disables that action and
directs you to the host instead of creating a wrongly anchored thread.
Open pull requests can be closed after confirmation, and closed/abandoned pull
requests can be reopened when the provider grants permission. The PR overflow
menu also exposes **Open branch in worktree…** for GitHub and Azure. Strand
verifies the provider's current source commit, fetches that exact object without
creating a PR ref or writing `FETCH_HEAD`, and opens the normal New worktree
dialog with a derived `pr-<number>-<source>` task branch. An existing local
branch is reused only when it already points to that exact commit; otherwise
Strand proposes a suffixed branch instead of opening stale code.

Open GitHub pull requests additionally expose **Update branch from target**.
The provider request includes the source commit displayed by Strand,
so a head change fails closed instead of updating code that was not reviewed.
Azure DevOps does not expose the same safe source-branch update operation;
use the exact-head local worktree action there. The worktree command is
available while any PR is active, and the update command appears only for an
open GitHub PR; both contextual commands disappear on the inbox.

Suggestions and richer Azure policy details are planned but are not presented
as available yet. GitLab and
Bitbucket adapters will use the same workspace in a later slice.
