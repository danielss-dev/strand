# Hosted provider contracts

Implemented September 6, 2026 in `pull_requests/hosted.rs` and
`pull_requests/transport.rs`. GitHub and Azure retain their existing adapters;
custom GitHub hosts pass through `GitHubContext` with an explicit hostname.

## API and authentication references

- GitHub: [CLI API hostname](https://cli.github.com/manual/gh_api),
  [host and token environment](https://cli.github.com/manual/gh_help_environment),
  [custom API host configuration](https://cli.github.com/manual/gh_config_set).
- GitLab: [CLI API](https://docs.gitlab.com/cli/api/),
  [merge requests](https://docs.gitlab.com/api/merge_requests/),
  [discussions and diff coordinates](https://docs.gitlab.com/api/discussions/),
  [approval SHA](https://docs.gitlab.com/api/merge_request_approvals/).
- Bitbucket Cloud: [pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/),
  [workspace repository permissions](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/),
  [workspaces](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-workspaces/),
  [API token permissions](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/).

GitLab uses the authenticated CLI host and nested project path. GitHub REST,
GraphQL, PR commands and viewer identity use the same explicit host; public
GitHub repository labels retain their earlier owner/repo form. Bitbucket uses
only Cloud's API origin and the system Git credential helper. The helper runs
from a neutral directory, with prompting disabled; credentials are never
included in provider error messages or saved application state.

## Capabilities and consistency

GitLab project/group access and Bitbucket's per-workspace repository permissions
inform controls. Permission-query failure is explicit. The provider remains
authoritative for protected branches and token scopes. Pipeline/status results
are not advertised as complete policy evaluations. Shallow list items carry
no optimistic write capabilities before detail loads.

GitLab merge and approval send the reviewed SHA. Inline discussions include
base/start/head coordinates, rename paths, both sides for context lines, and
versioned range line codes. Bitbucket merge stays disabled because its merge
contract has no atomic expected-head condition. Cloud comments and review
decisions check before/after writing and report races as possibly posted.
Neither adapter claims atomic batch reviews: errors preserve the local draft
and report confirmed writes for reconciliation before retry.

Bitbucket Server, Cloud merge/reopen/draft transitions/discussion resolution,
GitLab request-changes, and editing/resetting these providers' submitted reviews
remain provider-site actions. Same-repository Bitbucket checkout is supported;
fork checkout requires opening the source fork. These are capability limits,
not silent fallback to another provider.

Collections traverse GitLab pages and Bitbucket opaque `next` links, including
short intermediate pages, with duplicate and loop protection. Cross-origin or
cross-collection links are rejected. Cloud's documented PR-diff redirect is
allowed only to that repository's API diff route. Limits produce explicit
incomplete-result errors. Selected detail fetches commits/discussions; patches
load on Code; activity polling never fetches patches or commit history.

## Verification

The Rust fixtures exercise 101-entry pagination, opaque short pages, permission
denial, custom-host coordinates and identities, rename/context/range comments,
terminal and stale-head rejection, approval SHA, partial review failures and
provider draft markers. Existing GitHub/Azure fixture tests remain in the same
suite. Frontend tests cover provider labels and merge capabilities while
retaining existing GitHub/Azure behavior.

The isolated Windows Tauri/WebView2 pass exercised GitLab Code rendering,
retained review text after a stale-head rejection, disabled request-changes,
Bitbucket's provider-site merge control, keyboard palette access and real
per-remote settings persistence in a scratch repository. Hosted responses and
writes were injected fixtures; no authenticated live-provider mutation was
performed. The app used a separate identity/profile and temporary embedded
debug configuration; the normal binary was rebuilt after verification.

## Repository publishing

`pull_requests/publish.rs` uses GitHub
[repository creation](https://docs.github.com/en/rest/repos/repos), GitLab
[project creation](https://docs.gitlab.com/api/projects/) and
[namespaces](https://docs.gitlab.com/api/namespaces/), and Bitbucket's repository
and workspace APIs linked above. Azure creation is outside this flow.

The journal in repository-local `strand.publish-state` contains the reviewed
account/destination/visibility, branch and commit, plus recovery stage. It has no
credentials. Creation persists `uncertain` before POST; recovery only performs
GET. Attaching a remote and pushing require separate explicit actions. The
initial push pins the reviewed object, rejects changed or rewritten URLs,
disables implicit tag/submodule pushes and preserves an existing upstream.

Fixtures cover uncertain creation without duplicate POST, changed accounts,
visibility mismatch and remote conflicts. A real local bare-repository test
proves that only the reviewed object is pushed after a newer local commit and
that an existing upstream survives. The desktop pass exercised destination
review, remote-setup failure, close/resume/retry, an initially unchecked push
checkbox, and completion; it also caught and fixed initial keyboard focus.
