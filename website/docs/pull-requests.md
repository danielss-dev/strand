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
Closed and merged PRs never auto-open. Otherwise, click a row to inspect it, or
use `Up`/`Down` or `j`/`k` and press `Enter`. **Pull Requests** in the detail
toolbar returns to the list and restores its keyboard focus. **Open on host**
hands the active PR to the provider website.

The list loads only compact row data; Strand loads rich metadata only after a
PR is opened. This keeps large repositories below provider query limits and
means moving through the list does not start provider calls. The opened PR uses
the full content width and has three tabs. Use `Left`/`Right`, `Home`, and `End`
while the tab bar is focused.

### Overview

Overview shows title, state, author, source and target branches, dates, labels,
reviewers, review and merge state, file/addition/deletion/comment/commit counts,
and CI checks when available. Descriptions render as Markdown without executing
raw HTML or silently loading remote images. Checks are green when successful,
yellow while running or queued, red when failed, and neutral when the provider
does not report a recognized state.

### Conversation

Conversation displays GitHub comments and Azure DevOps thread comments as safe
Markdown. Azure inline comments include their file path. Write a top-level
Markdown comment in the composer and choose **Add comment**, or press
`Mod+Enter`. The comment is submitted through the signed-in provider CLI; Strand
does not receive or store the provider token.

### Changes

Changes loads only when its tab opens. A narrow left rail groups changed files
in the same Pierre folder tree used by Local Changes. Use the folder chevrons
to expand or collapse paths; use `Up`/`Down`, `j`/`k`, `Home`, or `End` to
select a file. The rest of the full-width workspace renders the selected patch
edge to edge beneath the same compact, collapsible file header used by Local
Changes and follows the configured stacked/split diff appearance. Only one
file diff is mounted at a time to keep large PRs responsive. Provider patches
larger than 16 MB are not rendered.

Azure does not expose every check or policy field through the same provider
command, so absent data is shown honestly rather than inferred. Replies, new
inline comments, suggestions, approve/request-changes actions, Azure policies,
branch updates, and merge controls are planned but are not presented as
available yet. GitLab and Bitbucket adapters will use the same workspace in a
later slice.
