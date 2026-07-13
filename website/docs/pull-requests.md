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

The left pane contains up to the latest 100 open, closed, and merged pull
requests. Click a row to inspect it, use `Up`/`Down` or `j`/`k` while the list
is focused, and press `Enter` (or double-click) to open the PR on its host. Drag
the divider to resize the list; Strand remembers the size.

The detail pane shows the information reported by that provider: title, state,
author, source and target branches, description, dates, labels, reviewers,
review and merge state, file/addition/deletion/comment/commit counts, and CI
checks when available. Azure's list response does not expose every discussion
or check field, so absent data is shown honestly rather than inferred.

This first slice is read-only. Hosted diffs, comment threads, suggestions,
approve/request-changes actions, Azure policies, branch updates, and merge
controls are planned but are not presented as available yet. GitLab and
Bitbucket adapters will use the same workspace in a later slice.
