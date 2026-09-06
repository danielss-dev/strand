//! Pull-request host integration.
//!
//! CLI authentication stays with `gh`, `glab` and `az`; Bitbucket API credentials
//! come from the system Git helper. The list call stays shallow; a second command
//! loads nested metadata only for the selected pull request so provider query
//! limits and large repositories remain predictable.
mod hosted;
pub(crate) mod publish;
pub(crate) mod transport;
use transport::{github_command, github_command_input, GitHubContext};

use std::{
    collections::HashMap,
    io::{Read, Write},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use strand_azdo_protocol::{
    DiffSide as AzdoDiffSide, MergeStrategy as AzdoMergeStrategy, Operation as AzdoOperation,
    PullRequestStatus as AzdoPullRequestStatus, ReviewVote as AzdoReviewVote,
    ThreadStatus as AzdoThreadStatus,
};
use strand_core::Repo;
use uuid::Uuid;

use crate::ai::bin::{base_command, resolve_cli};
use crate::azdo_helper;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_COMMENT_BYTES: usize = 65_536;
const MAX_THREAD_ID_BYTES: usize = 512;
const MAX_PR_DESCRIPTION_BYTES: usize = 65_536;
const MAX_PR_TITLE_BYTES: usize = 512;
const MAX_DIFF_BYTES: usize = 16 * 1024 * 1024;
const MAX_PENDING_REVIEW_COMMENTS: usize = 100;
const AZURE_ITERATION_CHANGE_PAGE_SIZE: u32 = 2000;
const MAX_AZURE_ITERATION_CHANGE_PAGES: u32 = 32;
const GITHUB_BRANCH_STATE: &str = "open";
const AZURE_BRANCH_STATUS: &str = "active";
const GITHUB_LIST_FIELDS: &str = concat!(
    "number,title,state,isDraft,author,headRefName,headRefOid,baseRefName,createdAt,updatedAt,",
    "closedAt,mergedAt,url,reviewDecision,additions,deletions,changedFiles"
);
const GITHUB_DETAIL_FIELDS: &str = concat!(
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,",
    "closedAt,mergedAt,url,body,mergeStateStatus,reviewDecision,comments,commits,additions,deletions,",
    "changedFiles,reviewRequests,latestReviews,labels,statusCheckRollup,headRefOid"
);
const GITHUB_ACTIVITY_QUERY: &str = r#"query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title state url updatedAt headRefName headRefOid
      comments(last: 100) { nodes { id author { login } } }
      reviews(last: 100) { nodes { id state author { login } } }
      reviewThreads(last: 100) {
        nodes { comments(last: 100) { nodes { id author { login } } } }
      }
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun { databaseId name status conclusion }
            ... on StatusContext { id context state }
          }
        }
      }
    }
  }
}"#;
const GITHUB_REVIEW_THREADS_QUERY: &str = r#"query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      viewerCanUpdate
      reviews(last: 100) {
        nodes {
          id
          body
          state
          submittedAt
          url
          viewerCanUpdate
          viewerDidAuthor
          author { login avatarUrl }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          viewerCanReply
          viewerCanResolve
          viewerCanUnresolve
          path
          line
          startLine
          originalLine
          originalStartLine
          diffSide
          comments(first: 100) {
            nodes { id body createdAt url author { login avatarUrl } }
          }
        }
      }
    }
  }
}"#;
const GITHUB_REVIEW_UPDATE_MUTATION: &str = r#"mutation($reviewId: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $reviewId, body: $body }) {
    pullRequestReview { id }
  }
}"#;
const GITHUB_REVIEW_DISMISS_MUTATION: &str = r#"mutation($reviewId: ID!, $message: String!) {
  dismissPullRequestReview(input: { pullRequestReviewId: $reviewId, message: $message }) {
    pullRequestReview { id }
  }
}"#;
const GITHUB_THREAD_REPLY_MUTATION: &str = r#"mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId,
    body: $body
  }) {
    comment { id body createdAt url path author { login avatarUrl } }
  }
}"#;
const GITHUB_THREAD_RESOLVE_MUTATION: &str = r#"mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve }
  }
}"#;
const GITHUB_THREAD_UNRESOLVE_MUTATION: &str = r#"mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve }
  }
}"#;
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestProvider {
    GitLab,
    Bitbucket,
    GitHub,
    AzureDevOps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestMergeStrategy {
    MergeCommit,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestLifecycleAction {
    Close,
    Reopen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PullRequestPendingComment {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub side: PullRequestDiffSide,
    pub body: String,
}

#[derive(Debug)]
struct AzureReviewCoordinates {
    iteration_id: u32,
    change_tracking_ids: HashMap<String, u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestRepository {
    pub provider: PullRequestProvider,
    pub remote: String,
    pub label: String,
    pub viewer: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReviewer {
    pub name: String,
    pub status: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReview {
    pub id: String,
    pub author: String,
    pub avatar_url: Option<String>,
    pub state: String,
    pub body: String,
    pub submitted_at: String,
    pub url: String,
    pub can_update: bool,
    pub can_dismiss: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCheck {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCommit {
    pub id: String,
    pub title: String,
    pub author: String,
    pub avatar_url: Option<String>,
    pub committed_at: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestComment {
    pub id: String,
    pub author: String,
    pub avatar_url: Option<String>,
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub is_system: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReviewThread {
    pub id: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub side: PullRequestDiffSide,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub can_reply: bool,
    pub can_resolve: bool,
    pub can_unresolve: bool,
    pub comments: Vec<PullRequestComment>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReviewThreadUpdate {
    pub id: String,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub can_reply: bool,
    pub can_resolve: bool,
    pub can_unresolve: bool,
}

#[derive(Debug)]
struct AzureDiscussion {
    comments: Vec<PullRequestComment>,
    review_threads: Vec<PullRequestReviewThread>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PullRequestCapabilities {
    pub can_comment: bool,
    pub can_review: bool,
    pub can_request_changes: bool,
    pub can_close: bool,
    pub can_reopen: bool,
    pub merge_strategies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PullRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<PullRequestCapabilities>,
    pub id: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub can_mark_ready: bool,
    pub author: String,
    pub source_branch: String,
    pub source_commit: String,
    pub target_branch: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub url: String,
    pub description: String,
    pub merge_status: String,
    pub review_status: String,
    pub comment_count: usize,
    pub commit_count: usize,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    pub labels: Vec<String>,
    pub reviewers: Vec<PullRequestReviewer>,
    pub reviews: Vec<PullRequestReview>,
    pub checks: Vec<PullRequestCheck>,
    pub checks_complete: bool,
    pub comments: Vec<PullRequestComment>,
    pub review_threads: Vec<PullRequestReviewThread>,
    pub authored_by_viewer: bool,
    pub commits: Vec<PullRequestCommit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestList {
    pub repository: PullRequestRepository,
    pub pull_requests: Vec<PullRequest>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestBranchMatch {
    pub repository: PullRequestRepository,
    pub pull_request: PullRequest,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCreateOutcome {
    pub id: u64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCheckoutPreparation {
    pub branch: String,
    pub start_point: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestActivityComment {
    pub id: String,
    pub author: String,
    pub kind: String,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestActivityReview {
    pub id: String,
    pub author: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestActivityCheck {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestActivitySnapshot {
    pub repository: PullRequestRepository,
    pub id: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub source_branch: String,
    pub source_commit: String,
    pub updated_at: String,
    pub comments: Vec<PullRequestActivityComment>,
    pub reviews: Vec<PullRequestActivityReview>,
    pub checks: Vec<PullRequestActivityCheck>,
    pub checks_complete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestDiffSide {
    Deletions,
    Additions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostRepo {
    Hosted(hosted::HostedRepo),
    GitHub {
        host: String,
        owner: String,
        repo: String,
    },
    Azure {
        organization: String,
        project: String,
        repo: String,
    },
    AzureServer {
        profile_id: Uuid,
        collection_url: String,
        project: String,
        repo: String,
    },
}

pub fn list(path: &str) -> Result<PullRequestList> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.list(&host.client(path), remote, None),
        HostRepo::GitHub { host, owner, repo } => list_github(&GitHubContext { path, host: &host }, remote, owner, repo),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => list_azure(path, remote, organization, project, repo),
        HostRepo::AzureServer {
            profile_id,
            collection_url,
            project,
            repo,
        } => list_azure_server(remote, profile_id, collection_url, project, repo),
    }
}

pub fn for_branch(path: &str, branch: &str) -> Result<Option<PullRequestBranchMatch>> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.list(&host.client(path), remote, Some(branch)).map(|list| list.pull_requests.into_iter().next().map(|pull_request| PullRequestBranchMatch { repository: list.repository, pull_request })),
        HostRepo::GitHub { host, owner, repo } => for_branch_github(&GitHubContext { path, host: &host }, remote, owner, repo, branch),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => for_branch_azure(path, remote, organization, project, repo, branch),
        HostRepo::AzureServer {
            profile_id,
            collection_url,
            project,
            repo,
        } => for_branch_azure_server(remote, profile_id, collection_url, project, repo, branch),
    }
}

pub fn create(
    path: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
    is_draft: bool,
) -> Result<PullRequestCreateOutcome> {
    validate_create(source_branch, target_branch, title, description)?;
    let (remote, host) = host_for_path(path)?;
    ensure_source_branch_on_remote(path, &remote, source_branch)?;
    match host {
        HostRepo::Hosted(host) => host.create(&host.client(path), source_branch, target_branch, title, description, is_draft),
        HostRepo::GitHub { host, owner, repo } => create_github(&GitHubContext { path, host: &host },
            &owner,
            &repo,
            source_branch,
            target_branch,
            title,
            description,
            is_draft,
        ),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => create_azure(
            path,
            &organization,
            &project,
            &repo,
            source_branch,
            target_branch,
            title,
            description,
            is_draft,
        ),
        HostRepo::AzureServer {
            profile_id,
            collection_url,
            project,
            repo,
        } => create_azure_server(
            profile_id,
            &collection_url,
            &project,
            &repo,
            source_branch,
            target_branch,
            title,
            description,
            is_draft,
        ),
    }
}

fn ensure_source_branch_on_remote(path: &str, remote: &str, source_branch: &str) -> Result<()> {
    let repo = Repo::discover(path).map_err(|error| error.to_string())?;
    let meta = repo.meta().map_err(|error| error.to_string())?;
    if meta.detached || meta.branch != source_branch {
        return Err(format!(
            "Source branch `{source_branch}` is not the checked-out branch; switch to it before creating the pull request"
        ));
    }

    let refs = repo.refs().map_err(|error| error.to_string())?;
    if refs
        .remote_branches
        .iter()
        .any(|branch| branch.remote == remote && branch.branch == source_branch)
    {
        return Ok(());
    }

    let set_upstream = refs
        .branches
        .iter()
        .find(|branch| branch.is_head)
        .is_some_and(|branch| branch.upstream.is_none());
    repo.push_current_to_remote(remote, set_upstream, |_| {}, None)
        .map_err(|error| {
            format!(
                "Could not push source branch `{source_branch}` to `{remote}` before creating the pull request: {error}"
            )
        })?;
    Ok(())
}

pub fn activity(path: &str, id: u64) -> Result<PullRequestActivitySnapshot> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.activity(&host.client(path), remote, id),
        HostRepo::GitHub { host, owner, repo } => activity_github(&GitHubContext { path, host: &host }, remote, owner, repo, id),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => activity_azure(path, remote, organization, project, repo, id),
        HostRepo::AzureServer {
            profile_id,
            collection_url,
            project,
            repo,
        } => activity_azure_server(remote, profile_id, collection_url, project, repo, id),
    }
}

pub fn detail(path: &str, id: u64) -> Result<PullRequest> {
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.detail(&host.client(path), id),
        HostRepo::GitHub { host, owner, repo } => detail_github(&GitHubContext { path, host: &host }, owner, repo, id),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => detail_azure(path, organization, project, repo, id),
        HostRepo::AzureServer {
            profile_id,
            collection_url,
            project,
            repo,
        } => detail_azure_server(profile_id, collection_url, project, repo, id),
    }
}

pub fn diff(path: &str, id: u64) -> Result<String> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.diff(&host.client(path), id),
        HostRepo::GitHub { host, owner, repo } => diff_github(&GitHubContext { path, host: &host }, owner, repo, id),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => diff_azure(path, remote, organization, project, repo, id),
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => diff_azure_server(path, remote, profile_id, project, repo, id),
    }
}

pub fn add_comment(path: &str, id: u64, body: &str) -> Result<()> {
    validate_comment(body)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.add_comment(&host.client(path), id, body),
        HostRepo::GitHub { host, owner, repo } => add_comment_github(&GitHubContext { path, host: &host }, owner, repo, id, body),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => add_comment_azure(path, organization, project, repo, id, body),
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => add_comment_azure_server(profile_id, project, repo, id, body),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn add_inline_comment(
    path: &str,
    id: u64,
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    expected_head: &str,
) -> Result<()> {
    validate_comment(body)?;
    validate_commit(expected_head)?;
    if file_path.trim().is_empty() || file_path.contains(['\r', '\n', '\0']) {
        return Err("The inline comment file path is invalid".to_string());
    }
    if start_line == 0 || end_line < start_line {
        return Err("The inline comment line range is invalid".to_string());
    }
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.inline(&host.client(path), id, &PullRequestPendingComment { path: file_path.into(), start_line, end_line, side, body: body.into() }, expected_head),
        HostRepo::GitHub { host, owner, repo } => {
            let current = detail_github(&GitHubContext { path, host: &host }, owner.clone(), repo.clone(), id)?;
            if current.source_commit != expected_head {
                return Err("The pull request changed while this comment was being written. Refresh Changes and select the lines again.".to_string());
            }
            add_inline_comment_github(&GitHubContext { path, host: &host }, owner, repo, id, body, file_path, start_line, end_line, side,
                expected_head,
            )
        }
        HostRepo::Azure { organization, project, repo } => add_inline_comment_azure(
            path, &organization, &project, &repo, id, body, file_path, start_line, end_line,
            side, expected_head,
        ),
        HostRepo::AzureServer { profile_id, project, repo, .. } => {
            add_inline_comment_azure_server(
                profile_id, &project, &repo, id, body, file_path, start_line, end_line, side,
                expected_head,
            )
        }
    }
}

pub fn reply_to_thread(path: &str, thread_id: &str, body: &str) -> Result<PullRequestComment> {
    validate_comment(body)?;
    validate_thread_id(thread_id)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.reply(&host.client(path), thread_id, body),
        HostRepo::GitHub { host, .. } => reply_to_thread_github(&GitHubContext { path, host: &host }, thread_id, body),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => reply_to_thread_azure(path, &organization, &project, &repo, thread_id, body),
        HostRepo::AzureServer {
            profile_id,
            collection_url,
            project,
            repo,
        } => reply_to_thread_azure_server(
            profile_id,
            &collection_url,
            &project,
            &repo,
            thread_id,
            body,
        ),
    }
}

pub fn set_thread_resolved(
    path: &str,
    thread_id: &str,
    resolved: bool,
) -> Result<PullRequestReviewThreadUpdate> {
    validate_thread_id(thread_id)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.resolve(&host.client(path), thread_id, resolved),
        HostRepo::GitHub { host, .. } => set_thread_resolved_github(&GitHubContext { path, host: &host }, thread_id, resolved),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => set_thread_resolved_azure(
            path,
            &organization,
            &project,
            &repo,
            thread_id,
            resolved,
        ),
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => set_thread_resolved_azure_server(
            profile_id,
            &project,
            &repo,
            thread_id,
            resolved,
        ),
    }
}

pub fn submit_review(
    path: &str,
    id: u64,
    event: PullRequestReviewEvent,
    body: &str,
    comments: &[PullRequestPendingComment],
    expected_head: &str,
) -> Result<()> {
    validate_review(event, body, comments)?;
    validate_commit(expected_head)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.review(&host.client(path), id, event, body, comments, expected_head),
        HostRepo::GitHub { host, owner, repo } => submit_review_github(&GitHubContext { path, host: &host }, &owner, &repo, id, event, body, comments, expected_head,
        ),
        HostRepo::Azure { organization, project, repo } => submit_review_azure(
            path, &organization, &project, &repo, id, event, body, comments, expected_head,
        ),
        HostRepo::AzureServer { profile_id, project, repo, .. } => submit_review_azure_server(
            profile_id, &project, &repo, id, event, body, comments, expected_head,
        ),
    }
}

pub fn update_review(path: &str, _id: u64, review_id: &str, body: &str) -> Result<()> {
    validate_review_id(review_id)?;
    validate_comment(body)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(_) => Err("Edit review summaries on the provider website".into()),
        HostRepo::GitHub { host, .. } => update_review_github(&GitHubContext { path, host: &host }, review_id, body),
        HostRepo::Azure { .. } | HostRepo::AzureServer { .. } => Err(
            "Azure DevOps votes do not have an editable review summary. Submit a new summary comment or change the vote instead."
                .into(),
        ),
    }
}

pub fn dismiss_review(
    path: &str,
    id: u64,
    review_id: &str,
    message: &str,
) -> Result<()> {
    validate_review_id(review_id)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(_) => Err("Reset reviews on the provider website".into()),
        HostRepo::GitHub { host, .. } => {
            validate_comment(message)?;
            dismiss_review_github(&GitHubContext { path, host: &host }, review_id, message)
        }
        HostRepo::Azure { organization, .. } => {
            reset_review_azure(path, &organization, id, review_id)
        }
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => reset_review_azure_server(profile_id, &project, &repo, id, review_id),
    }
}

pub fn merge(
    path: &str,
    id: u64,
    strategy: PullRequestMergeStrategy,
    expected_head: &str,
) -> Result<()> {
    validate_commit(expected_head)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.merge(&host.client(path), id, strategy, expected_head),
        HostRepo::GitHub { host, owner, repo } => {
            merge_github(&GitHubContext { path, host: &host }, &owner, &repo, id, strategy, expected_head)
        }
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => merge_azure(
            path,
            &organization,
            &project,
            &repo,
            id,
            strategy,
            expected_head,
        ),
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => merge_azure_server(profile_id, project, repo, id, strategy, expected_head),
    }
}

pub fn mark_ready(path: &str, id: u64) -> Result<()> {
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.ready(&host.client(path), id),
        HostRepo::GitHub { host, owner, repo } => mark_ready_github(&GitHubContext { path, host: &host }, &owner, &repo, id),
        HostRepo::Azure { organization, .. } => mark_ready_azure(path, &organization, id),
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => mark_ready_azure_server(profile_id, project, repo, id),
    }
}

pub fn set_lifecycle(path: &str, id: u64, action: PullRequestLifecycleAction) -> Result<()> {
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.lifecycle(&host.client(path), id, action),
        HostRepo::GitHub { host, owner, repo } => {
            set_lifecycle_github(&GitHubContext { path, host: &host }, &owner, &repo, id, action)
        }
        HostRepo::Azure { organization, .. } => {
            set_lifecycle_azure(path, &organization, id, action)
        }
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => set_lifecycle_azure_server(profile_id, project, repo, id, action),
    }
}

pub fn update_branch(path: &str, id: u64, expected_head: &str) -> Result<()> {
    validate_commit(expected_head)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(_) => Err("Update this source branch in a local worktree".into()),
        HostRepo::GitHub { host, owner, repo } => {
            update_branch_github(&GitHubContext { path, host: &host }, &owner, &repo, id, expected_head)
        }
        HostRepo::Azure { .. } | HostRepo::AzureServer { .. } => Err(
            "Azure DevOps does not expose a safe update-source-branch pull-request operation. Open the branch in a worktree and update it locally."
                .into(),
        ),
    }
}

pub fn prepare_checkout(
    path: &str,
    id: u64,
    expected_head: &str,
) -> Result<PullRequestCheckoutPreparation> {
    validate_commit(expected_head)?;
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::Hosted(host) => host.checkout(&host.client(path), path, &remote, id, expected_head),
        HostRepo::GitHub { host, owner, repo } => {
            prepare_checkout_github(&GitHubContext { path, host: &host }, &remote, &owner, &repo, id, expected_head)
        }
        HostRepo::Azure { organization, .. } => {
            let value = azure_pr_value(path, &organization, id)?;
            prepare_checkout_azure_value(path, &remote, value, expected_head)
        }
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => {
            let value = server_show(profile_id, &project, &repo, id)?;
            prepare_checkout_azure_value(path, &remote, value, expected_head)
        }
    }
}

fn host_for_path(path: &str) -> Result<(String, HostRepo)> {
    let repo = Repo::discover(path).map_err(|error| error.to_string())?;
    let refs = repo.refs().map_err(|error| error.to_string())?;
    let remotes = refs
        .remotes
        .into_iter()
        .filter_map(|remote| {
            let effective_url = remote.url?;
            let url = repo
                .configured_remote_url(&remote.name)
                .ok()
                .flatten()
                .unwrap_or(effective_url);
            Some((remote.name, url))
        })
        .collect::<Vec<_>>();
    let mut supported = remotes
        .iter()
        .filter_map(|remote| {
            let coordinates = parse_remote(&remote.1).or_else(|| {
                let configured = run_command(path, "git", &["config", "--get", &format!("remote.{}.strand-provider", remote.0)], &[]).ok().and_then(|v| String::from_utf8(v).ok());
                parse_hosted_remote(&remote.1, configured.as_deref().map(str::trim))
            })?;
            Some((remote.0.clone(), coordinates))
        })
        .collect::<Vec<_>>();
    supported.sort_by_key(|(name, _)| (name != "origin", name.clone()));

    if supported.first().is_some_and(|(name, _)| name == "origin") {
        return Ok(supported.remove(0));
    }
    if let Some(coordinates) =
        azdo_helper::resolve_for_remotes(azdo_helper::handle()?, remotes.clone())?
    {
        let profile = azdo_helper::profile(azdo_helper::handle()?, coordinates.profile_id)?;
        return Ok((
            coordinates.remote,
            HostRepo::AzureServer {
                profile_id: coordinates.profile_id,
                collection_url: profile.collection_url,
                project: coordinates.project,
                repo: coordinates.repository,
            },
        ));
    }

    supported.into_iter().next().ok_or_else(|| {
        "No supported hosting remote was found. Configure a custom GitHub/GitLab remote provider in Hosting settings.".to_string()
    })
}

fn list_github(cwd: &GitHubContext<'_>, remote: String, owner: String, repo: String) -> Result<PullRequestList> {
    let slug = cwd.slug(&owner, &repo);
    // Keep the list query shallow. Asking GraphQL to expand nested comments,
    // commits, reviews, and checks across 100 PRs can exceed GitHub's 500k
    // possible-node cap even for a modest repository. Rich fields load only
    // for the selected PR via `detail_github`.
    let (output, viewer) = thread::scope(|scope| {
        let viewer = scope.spawn(|| github_viewer(cwd));
        let output = github_command(
            cwd,
            "gh",
            &[
                "pr",
                "list",
                "--repo",
                &slug,
                "--state",
                "all",
                "--limit",
                "100",
                "--json",
                GITHUB_LIST_FIELDS,
            ],
            &[("GH_PROMPT_DISABLED", "1")],
        );
        let viewer = viewer.join().ok().and_then(Result::ok);
        (output, viewer)
    });
    let output = output?;
    let values: Vec<Value> = serde_json::from_slice(&output)
        .map_err(|e| format!("GitHub CLI returned invalid JSON: {e}"))?;
    let pull_requests = values
        .iter()
        .filter_map(|value| parse_github_pr(value, viewer.as_deref()))
        .collect();
    Ok(PullRequestList {
        repository: PullRequestRepository {
            provider: PullRequestProvider::GitHub,
            remote,
            label: slug,
            viewer,
        },
        pull_requests,
    })
}

fn for_branch_github(
    cwd: &GitHubContext<'_>,
    remote: String,
    owner: String,
    repo: String,
    branch: &str,
) -> Result<Option<PullRequestBranchMatch>> {
    let slug = cwd.slug(&owner, &repo);
    let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
    let output = github_command(
        cwd,
        "gh",
        &[
            "pr",
            "list",
            "--repo",
            &slug,
            "--head",
            branch,
            "--state",
            GITHUB_BRANCH_STATE,
            "--limit",
            "1",
            "--json",
            GITHUB_LIST_FIELDS,
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let values: Vec<Value> = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid JSON: {error}"))?;
    Ok(values
        .first()
        .and_then(|value| parse_github_pr(value, None))
        .map(|pull_request| PullRequestBranchMatch {
            repository: PullRequestRepository {
                provider: PullRequestProvider::GitHub,
                remote,
                label: slug,
                viewer: None,
            },
            pull_request,
        }))
}

fn github_viewer(cwd: &GitHubContext<'_>) -> Result<String> {
    let output = github_command(
        cwd,
        "gh",
        &["api", "user", "--jq", ".login"],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    non_empty_text(&output, "GitHub CLI returned no signed-in account")
}

#[allow(clippy::too_many_arguments)]
fn create_github(
    cwd: &GitHubContext<'_>,
    owner: &str,
    repo: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
    is_draft: bool,
) -> Result<PullRequestCreateOutcome> {
    let slug = cwd.slug(&owner, &repo);
    let source_branch = branch_name(source_branch.to_string());
    let target_branch = branch_name(target_branch.to_string());
    let mut args = vec![
        "pr",
        "create",
        "--repo",
        &slug,
        "--head",
        &source_branch,
        "--base",
        &target_branch,
        "--title",
        title,
        "--body-file",
        "-",
    ];
    if is_draft {
        args.push("--draft");
    }
    let output = github_command_input(
        cwd,
        "gh",
        &args,
        &[("GH_PROMPT_DISABLED", "1")],
        Some(description.as_bytes()),
    )
    .map_err(|error| map_github_create_error(error, &source_branch, &target_branch))?;
    let url = String::from_utf8(output)
        .map_err(|error| format!("GitHub CLI returned invalid text: {error}"))?
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let id = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| {
            "GitHub created the pull request but returned no usable PR URL".to_string()
        })?;
    Ok(PullRequestCreateOutcome { id, url })
}

fn map_github_create_error(error: String, source_branch: &str, target_branch: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("head sha can't be blank") || lower.contains("head ref must be a branch") {
        return format!(
            "Source branch `{source_branch}` is not available on GitHub. Push this branch to the repository remote, then create the pull request again."
        );
    }
    if lower.contains("base sha can't be blank") || lower.contains("base ref must be a branch") {
        return format!(
            "Target branch `{target_branch}` is not available on GitHub. Choose an existing remote branch and try again."
        );
    }
    error
}

fn activity_github(
    cwd: &GitHubContext<'_>,
    remote: String,
    owner: String,
    repo: String,
    id: u64,
) -> Result<PullRequestActivitySnapshot> {
    let query = format!("query={GITHUB_ACTIVITY_QUERY}");
    let owner_arg = format!("owner={owner}");
    let repo_arg = format!("repo={repo}");
    let number = format!("number={id}");
    let output = github_command(
        cwd,
        "gh",
        &[
            "api", "graphql", "-f", &query, "-F", &owner_arg, "-F", &repo_arg, "-F", &number,
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid activity JSON: {error}"))?;
    let pull_request = value
        .pointer("/data/repository/pullRequest")
        .ok_or_else(|| format!("GitHub returned no activity data for PR #{id}"))?;
    parse_github_activity(
        pull_request,
        PullRequestRepository {
            provider: PullRequestProvider::GitHub,
            remote,
            label: cwd.slug(&owner, &repo),
            viewer: None,
        },
    )
}

fn detail_github(cwd: &GitHubContext<'_>, owner: String, repo: String, id: u64) -> Result<PullRequest> {
    let slug = cwd.slug(&owner, &repo);
    let id_string = id.to_string();
    let output = github_command(
        cwd,
        "gh",
        &[
            "pr",
            "view",
            &id_string,
            "--repo",
            &slug,
            "--json",
            GITHUB_DETAIL_FIELDS,
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid JSON: {error}"))?;
    let mut pull_request = parse_github_pr(&value, None)
        .ok_or_else(|| format!("GitHub CLI returned no data for PR #{id}"))?;
    for commit in &mut pull_request.commits {
        commit.url = Some(format!(
            "https://{}/{owner}/{repo}/commit/{}",
            cwd.host, commit.id
        ));
    }
    pull_request.checks_complete = true;
    let (review_threads, reviews, can_mark_ready) =
        github_review_threads(cwd, &owner, &repo, id)?;
    pull_request.can_mark_ready = pull_request.is_draft && can_mark_ready;
    pull_request.reviews = reviews;
    pull_request.comments.extend(
        review_threads
            .iter()
            .flat_map(|thread| thread.comments.iter().cloned()),
    );
    pull_request
        .comments
        .sort_by(|left, right| left.created_at.cmp(&right.created_at));
    pull_request.comment_count = pull_request.comments.len();
    pull_request.review_threads = review_threads;
    if cwd.host != "github.com" {
        let scope = |avatar: &mut Option<String>| cwd.scope_avatar(avatar);
        for comment in &mut pull_request.comments { scope(&mut comment.avatar_url); }
        for commit in &mut pull_request.commits { scope(&mut commit.avatar_url); }
        for review in &mut pull_request.reviews { scope(&mut review.avatar_url); }
        for thread in &mut pull_request.review_threads {
            for comment in &mut thread.comments { scope(&mut comment.avatar_url); }
        }
    }
    Ok(pull_request)
}

fn github_review_threads(
    cwd: &GitHubContext<'_>,
    owner: &str,
    repo: &str,
    id: u64,
) -> Result<(Vec<PullRequestReviewThread>, Vec<PullRequestReview>, bool)> {
    let query = format!("query={GITHUB_REVIEW_THREADS_QUERY}");
    let owner = format!("owner={owner}");
    let repo = format!("repo={repo}");
    let number = format!("number={id}");
    let output = github_command(
        cwd,
        "gh",
        &[
            "api", "graphql", "-f", &query, "-F", &owner, "-F", &repo, "-F", &number,
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid review-thread JSON: {error}"))?;
    Ok((
        parse_github_review_threads(&value),
        parse_github_reviews(&value),
        parse_github_can_mark_ready(&value),
    ))
}

fn diff_github(cwd: &GitHubContext<'_>, owner: String, repo: String, id: u64) -> Result<String> {
    let slug = cwd.slug(&owner, &repo);
    let id = id.to_string();
    let output = github_command(
        cwd,
        "gh",
        &["pr", "diff", &id, "--repo", &slug, "--color", "never"],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    if output.len() > MAX_DIFF_BYTES {
        return Err("Pull request diff exceeds Strand's 16 MB display limit".into());
    }
    String::from_utf8(output)
        .map_err(|error| format!("GitHub CLI returned a non-UTF-8 diff: {error}"))
}

fn add_comment_github(cwd: &GitHubContext<'_>, owner: String, repo: String, id: u64, body: &str) -> Result<()> {
    let slug = cwd.slug(&owner, &repo);
    let id = id.to_string();
    github_command_input(
        cwd,
        "gh",
        &["pr", "comment", &id, "--repo", &slug, "--body-file", "-"],
        &[("GH_PROMPT_DISABLED", "1")],
        Some(body.as_bytes()),
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_inline_comment_github(
    cwd: &GitHubContext<'_>,
    owner: String,
    repo: String,
    id: u64,
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    expected_head: &str,
) -> Result<()> {
    let endpoint = format!("repos/{owner}/{repo}/pulls/{id}/comments");
    let payload =
        github_inline_comment_payload(body, file_path, start_line, end_line, side, expected_head);
    let input = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not encode GitHub inline comment: {error}"))?;
    github_command_input(
        cwd,
        "gh",
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        &[("GH_PROMPT_DISABLED", "1")],
        Some(&input),
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn submit_review_github(
    cwd: &GitHubContext<'_>, owner: &str, repo: &str, id: u64, event: PullRequestReviewEvent,
    body: &str, comments: &[PullRequestPendingComment], expected_head: &str,
) -> Result<()> {
    let current = github_current_head(cwd, owner, repo, id)?;
    ensure_review_head(&current, expected_head)?;
    let endpoint = format!("repos/{owner}/{repo}/pulls/{id}/reviews");
    let input = serde_json::to_vec(&github_review_payload(event, body, comments, expected_head))
        .map_err(|error| format!("Could not encode GitHub review: {error}"))?;
    github_command_input(
        cwd, "gh", &["api", "--method", "POST", &endpoint, "--input", "-"],
        &[("GH_PROMPT_DISABLED", "1")], Some(&input),
    )?;
    Ok(())
}

fn github_current_head(cwd: &GitHubContext<'_>, owner: &str, repo: &str, id: u64) -> Result<String> {
    let slug = cwd.slug(&owner, &repo);
    let id = id.to_string();
    let output = github_command(
        cwd, "gh", &["pr", "view", &id, "--repo", &slug, "--json", "headRefOid"],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid head JSON: {error}"))?;
    text(value.get("headRefOid"))
        .ok_or_else(|| "GitHub did not return the pull request head commit".to_string())
}

fn update_branch_github(
    cwd: &GitHubContext<'_>,
    owner: &str,
    repo: &str,
    id: u64,
    expected_head: &str,
) -> Result<()> {
    let endpoint = format!("repos/{owner}/{repo}/pulls/{id}/update-branch");
    let input = serde_json::to_vec(&github_update_branch_payload(expected_head))
        .map_err(|error| format!("Could not encode GitHub branch update: {error}"))?;
    github_command_input(
        cwd,
        "gh",
        &["api", "--method", "PUT", &endpoint, "--input", "-"],
        &[("GH_PROMPT_DISABLED", "1")],
        Some(&input),
    )?;
    Ok(())
}

fn prepare_checkout_github(
    cwd: &GitHubContext<'_>,
    remote: &str,
    owner: &str,
    repo: &str,
    id: u64,
    expected_head: &str,
) -> Result<PullRequestCheckoutPreparation> {
    let slug = cwd.slug(&owner, &repo);
    let number = id.to_string();
    let output = github_command(
        cwd,
        "gh",
        &[
            "pr",
            "view",
            &number,
            "--repo",
            &slug,
            "--json",
            "headRefName,headRefOid",
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid checkout JSON: {error}"))?;
    let current_head = text(value.get("headRefOid"))
        .ok_or_else(|| "GitHub did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    let branch = text(value.get("headRefName"))
        .map(branch_name)
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| "GitHub did not return the pull request source branch".to_string())?;
    let pull_ref = github_pull_head_ref(id);
    Repo::discover(cwd.path)
        .map_err(|error| error.to_string())?
        .fetch_refs_for_read(remote, &[&pull_ref])
        .map_err(|error| format!("Could not fetch GitHub PR #{id} for a worktree: {error}"))?;
    Ok(PullRequestCheckoutPreparation {
        branch,
        start_point: expected_head.into(),
    })
}

fn github_update_branch_payload(expected_head: &str) -> Value {
    serde_json::json!({ "expected_head_sha": expected_head })
}

fn github_pull_head_ref(id: u64) -> String {
    format!("refs/pull/{id}/head")
}

fn reply_to_thread_github(cwd: &GitHubContext<'_>, thread_id: &str, body: &str) -> Result<PullRequestComment> {
    let value = run_github_graphql_mutation(
        cwd,
        GITHUB_THREAD_REPLY_MUTATION,
        serde_json::json!({ "threadId": thread_id, "body": body }),
    )?;
    let mut reply = parse_github_thread_reply(&value).ok_or_else(|| {
        "GitHub accepted the reply request but returned an incomplete comment".to_string()
    })?;
    cwd.scope_avatar(&mut reply.avatar_url);
    Ok(reply)
}

fn set_thread_resolved_github(
    cwd: &GitHubContext<'_>,
    thread_id: &str,
    resolved: bool,
) -> Result<PullRequestReviewThreadUpdate> {
    let mutation = if resolved {
        GITHUB_THREAD_RESOLVE_MUTATION
    } else {
        GITHUB_THREAD_UNRESOLVE_MUTATION
    };
    let value =
        run_github_graphql_mutation(cwd, mutation, serde_json::json!({ "threadId": thread_id }))?;
    parse_github_thread_update(&value, resolved).ok_or_else(|| {
        "GitHub accepted the thread update but returned incomplete thread state".to_string()
    })
}

fn update_review_github(cwd: &GitHubContext<'_>, review_id: &str, body: &str) -> Result<()> {
    run_github_graphql_mutation(
        cwd,
        GITHUB_REVIEW_UPDATE_MUTATION,
        serde_json::json!({ "reviewId": review_id, "body": body }),
    )?;
    Ok(())
}

fn dismiss_review_github(cwd: &GitHubContext<'_>, review_id: &str, message: &str) -> Result<()> {
    run_github_graphql_mutation(
        cwd,
        GITHUB_REVIEW_DISMISS_MUTATION,
        serde_json::json!({ "reviewId": review_id, "message": message }),
    )?;
    Ok(())
}

fn github_graphql_payload(query: &str, variables: Value) -> Value {
    serde_json::json!({ "query": query, "variables": variables })
}

fn run_github_graphql_mutation(cwd: &GitHubContext<'_>, query: &str, variables: Value) -> Result<Value> {
    let input = serde_json::to_vec(&github_graphql_payload(query, variables))
        .map_err(|error| format!("Could not encode GitHub review request: {error}"))?;
    let output = github_command_input(
        cwd,
        "gh",
        &["api", "graphql", "--method", "POST", "--input", "-"],
        &[("GH_PROMPT_DISABLED", "1")],
        Some(&input),
    )?;
    serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid review JSON: {error}"))
}

fn github_inline_comment_payload(
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    expected_head: &str,
) -> Value {
    let side = match side {
        PullRequestDiffSide::Deletions => "LEFT",
        PullRequestDiffSide::Additions => "RIGHT",
    };
    let mut payload = serde_json::json!({
        "body": body,
        "commit_id": expected_head,
        "path": file_path,
        "line": end_line,
        "side": side,
    });
    if start_line != end_line {
        payload["start_line"] = start_line.into();
        payload["start_side"] = side.into();
    }
    payload
}

fn github_review_payload(
    event: PullRequestReviewEvent,
    body: &str,
    comments: &[PullRequestPendingComment],
    expected_head: &str,
) -> Value {
    let event = match event {
        PullRequestReviewEvent::Comment => "COMMENT",
        PullRequestReviewEvent::Approve => "APPROVE",
        PullRequestReviewEvent::RequestChanges => "REQUEST_CHANGES",
    };
    serde_json::json!({
        "commit_id": expected_head,
        "body": body,
        "event": event,
        "comments": comments.iter().map(|comment| {
            let side = match comment.side {
                PullRequestDiffSide::Deletions => "LEFT",
                PullRequestDiffSide::Additions => "RIGHT",
            };
            let mut value = serde_json::json!({
                "path": comment.path,
                "line": comment.end_line,
                "side": side,
                "body": comment.body,
            });
            if comment.start_line != comment.end_line {
                value["start_line"] = comment.start_line.into();
                value["start_side"] = side.into();
            }
            value
        }).collect::<Vec<_>>(),
    })
}

fn merge_github(
    cwd: &GitHubContext<'_>,
    owner: &str,
    repo: &str,
    id: u64,
    strategy: PullRequestMergeStrategy,
    expected_head: &str,
) -> Result<()> {
    let slug = cwd.slug(&owner, &repo);
    let id = id.to_string();
    github_command(
        cwd,
        "gh",
        &[
            "pr",
            "merge",
            &id,
            "--repo",
            &slug,
            github_merge_flag(strategy),
            "--match-head-commit",
            expected_head,
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    Ok(())
}

fn mark_ready_github(cwd: &GitHubContext<'_>, owner: &str, repo: &str, id: u64) -> Result<()> {
    let slug = cwd.slug(&owner, &repo);
    let id = id.to_string();
    github_command(
        cwd,
        "gh",
        &["pr", "ready", &id, "--repo", &slug],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    Ok(())
}

fn set_lifecycle_github(
    cwd: &GitHubContext<'_>,
    owner: &str,
    repo: &str,
    id: u64,
    action: PullRequestLifecycleAction,
) -> Result<()> {
    let slug = cwd.slug(&owner, &repo);
    let id = id.to_string();
    let verb = github_lifecycle_verb(action);
    github_command(
        cwd,
        "gh",
        &["pr", verb, &id, "--repo", &slug],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    Ok(())
}

fn list_azure(
    cwd: &str,
    remote: String,
    organization: String,
    project: String,
    repo: String,
) -> Result<PullRequestList> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let (output, viewer) = thread::scope(|scope| {
        let viewer = scope.spawn(|| azure_viewer(cwd));
        let output = run_command(
            cwd,
            "az",
            &[
                "repos",
                "pr",
                "list",
                "--organization",
                &organization_url,
                "--project",
                &project,
                "--repository",
                &repo,
                "--status",
                "all",
                "--top",
                "100",
                "--output",
                "json",
                "--only-show-errors",
            ],
            &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
        );
        let viewer = viewer.join().ok().and_then(Result::ok);
        (output, viewer)
    });
    let output = output?;
    let values: Vec<Value> = serde_json::from_slice(&output)
        .map_err(|e| format!("Azure CLI returned invalid JSON: {e}"))?;
    let pull_requests = values
        .iter()
        .filter_map(|value| {
            parse_azure_pr(value, &organization, &project, &repo, viewer.as_deref())
        })
        .collect();
    Ok(PullRequestList {
        repository: PullRequestRepository {
            provider: PullRequestProvider::AzureDevOps,
            remote,
            label: format!("{organization}/{project}/{repo}"),
            viewer,
        },
        pull_requests,
    })
}

fn list_azure_server(
    remote: String,
    profile_id: Uuid,
    collection_url: String,
    project: String,
    repo: String,
) -> Result<PullRequestList> {
    let (values, viewer) = thread::scope(|scope| {
        let viewer = scope.spawn(|| azure_server_viewer(profile_id));
        let values = scope.spawn(|| {
            server_execute(
                profile_id,
                AzdoOperation::ListPullRequests {
                    project: project.clone(),
                    repository: repo.clone(),
                    source_branch: None,
                    status: Some("all".into()),
                    top: 100,
                },
            )
        });
        (values.join(), viewer.join())
    });
    let values = values.map_err(|_| "Azure DevOps Server list worker failed".to_string())??;
    let viewer = viewer.ok().and_then(Result::ok);
    let pull_requests = values
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|value| {
            parse_azure_pr(value, &collection_url, &project, &repo, viewer.as_deref())
        })
        .collect();
    Ok(PullRequestList {
        repository: PullRequestRepository {
            provider: PullRequestProvider::AzureDevOps,
            remote,
            label: azure_server_label(&collection_url, &project, &repo),
            viewer,
        },
        pull_requests,
    })
}

fn for_branch_azure_server(
    remote: String,
    profile_id: Uuid,
    collection_url: String,
    project: String,
    repo: String,
    branch: &str,
) -> Result<Option<PullRequestBranchMatch>> {
    let values = server_execute(
        profile_id,
        AzdoOperation::ListPullRequests {
            project: project.clone(),
            repository: repo.clone(),
            source_branch: Some(branch_name(branch.to_string())),
            status: Some(AZURE_BRANCH_STATUS.into()),
            top: 1,
        },
    )?;
    Ok(values
        .as_array()
        .and_then(|values| values.first())
        .and_then(|value| {
            parse_azure_pr(value, &collection_url, &project, &repo, None).map(|pull_request| {
                PullRequestBranchMatch {
                    repository: PullRequestRepository {
                        provider: PullRequestProvider::AzureDevOps,
                        remote,
                        label: azure_server_label(&collection_url, &project, &repo),
                        viewer: None,
                    },
                    pull_request,
                }
            })
        }))
}

#[allow(clippy::too_many_arguments)]
fn create_azure_server(
    profile_id: Uuid,
    collection_url: &str,
    project: &str,
    repo: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
    is_draft: bool,
) -> Result<PullRequestCreateOutcome> {
    let value = server_execute(
        profile_id,
        AzdoOperation::CreatePullRequest {
            project: project.into(),
            repository: repo.into(),
            source_branch: branch_name(source_branch.to_string()),
            target_branch: branch_name(target_branch.to_string()),
            title: title.into(),
            description: description.into(),
            is_draft,
        },
    )?;
    let id = value
        .get("pullRequestId")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            "Azure DevOps Server created the pull request but returned no PR id".to_string()
        })?;
    Ok(PullRequestCreateOutcome {
        id,
        url: azure_server_pr_url(collection_url, project, repo, id),
    })
}

fn detail_azure_server(
    profile_id: Uuid,
    collection_url: String,
    project: String,
    repo: String,
    id: u64,
) -> Result<PullRequest> {
    let (value, viewer) = thread::scope(|scope| {
        let value = scope.spawn(|| server_show(profile_id, &project, &repo, id));
        let viewer = scope.spawn(|| azure_server_viewer(profile_id));
        (value.join(), viewer.join())
    });
    let value =
        value.map_err(|_| "Azure DevOps Server pull-request worker failed".to_string())??;
    let viewer = viewer.ok().and_then(Result::ok);
    let mut pull_request =
        parse_azure_pr(&value, &collection_url, &project, &repo, viewer.as_deref())
            .ok_or_else(|| format!("Azure DevOps Server returned no data for PR #{id}"))?;
    let project_id =
        text(value.pointer("/repository/project/id")).unwrap_or_else(|| project.clone());
    let (comments, commits, checks) = thread::scope(|scope| {
        let comments =
            scope.spawn(|| azure_server_comments(profile_id, &collection_url, &project, &repo, id));
        let commits = scope.spawn(|| azure_server_commits(profile_id, &project, &repo, id));
        let checks = scope.spawn(|| azure_server_policies(profile_id, &project, &project_id, id));
        (comments.join(), commits.join(), checks.join())
    });
    let discussion =
        comments.map_err(|_| "Azure DevOps Server discussion worker failed".to_string())??;
    pull_request.comments = discussion.comments;
    pull_request.review_threads = discussion.review_threads;
    pull_request.comment_count = pull_request.comments.len();
    pull_request.commits =
        commits.map_err(|_| "Azure DevOps Server commit worker failed".to_string())??;
    pull_request.commit_count = pull_request.commits.len();
    if let Ok(Ok(checks)) = checks {
        pull_request.checks = checks
            .iter()
            .map(|check| PullRequestCheck {
                name: check.name.clone(),
                status: check.status.clone(),
            })
            .collect();
        pull_request.checks_complete = true;
    }
    Ok(pull_request)
}

fn activity_azure_server(
    remote: String,
    profile_id: Uuid,
    collection_url: String,
    project: String,
    repo: String,
    id: u64,
) -> Result<PullRequestActivitySnapshot> {
    let value = server_show(profile_id, &project, &repo, id)?;
    let pull_request = parse_azure_pr(&value, &collection_url, &project, &repo, None)
        .ok_or_else(|| format!("Azure DevOps Server returned no data for PR #{id}"))?;
    let comments = azure_server_comments(profile_id, &collection_url, &project, &repo, id)?
        .comments
        .into_iter()
        .map(|comment| PullRequestActivityComment {
            id: comment.id,
            author: comment.author,
            kind: if comment.path.is_some() {
                "thread"
            } else {
                "comment"
            }
            .into(),
            is_system: comment.is_system,
        })
        .collect();
    let reviews = array(&value, "reviewers")
        .iter()
        .filter_map(parse_azure_activity_review)
        .collect();
    let project_id =
        text(value.pointer("/repository/project/id")).unwrap_or_else(|| project.clone());
    let checks = azure_server_policies(profile_id, &project, &project_id, id)?;
    Ok(PullRequestActivitySnapshot {
        repository: PullRequestRepository {
            provider: PullRequestProvider::AzureDevOps,
            remote,
            label: azure_server_label(&collection_url, &project, &repo),
            viewer: None,
        },
        id: pull_request.id,
        title: pull_request.title,
        url: pull_request.url,
        state: pull_request.state,
        source_branch: pull_request.source_branch,
        source_commit: pull_request.source_commit,
        updated_at: pull_request.updated_at,
        comments,
        reviews,
        checks,
        checks_complete: true,
    })
}

fn server_show(profile_id: Uuid, project: &str, repo: &str, id: u64) -> Result<Value> {
    server_execute(
        profile_id,
        AzdoOperation::ShowPullRequest {
            project: project.into(),
            repository: repo.into(),
            id,
        },
    )
}

fn azure_server_comments(
    profile_id: Uuid,
    collection_url: &str,
    project: &str,
    repo: &str,
    id: u64,
) -> Result<AzureDiscussion> {
    let value = server_execute(
        profile_id,
        AzdoOperation::Threads {
            project: project.into(),
            repository: repo.into(),
            id,
        },
    )?;
    Ok(parse_azure_discussion(
        &value,
        &azure_server_pr_url(collection_url, project, repo, id),
        id,
    ))
}

fn reply_to_thread_azure_server(
    profile_id: Uuid,
    collection_url: &str,
    project: &str,
    repo: &str,
    thread_id: &str,
    body: &str,
) -> Result<PullRequestComment> {
    let (pull_request_id, azure_thread_id, parent_comment_id) =
        parse_azure_thread_id(thread_id)?;
    let value = server_execute(
        profile_id,
        AzdoOperation::ReplyToThread {
            project: project.into(),
            repository: repo.into(),
            id: pull_request_id,
            thread_id: azure_thread_id,
            parent_comment_id,
            body: body.into(),
        },
    )?;
    parse_azure_comment(
        &value,
        azure_thread_id,
        &azure_server_pr_url(collection_url, project, repo, pull_request_id),
        None,
    )
    .ok_or_else(|| "Azure DevOps Server returned no usable review-thread reply".into())
}

fn set_thread_resolved_azure_server(
    profile_id: Uuid,
    project: &str,
    repo: &str,
    thread_id: &str,
    resolved: bool,
) -> Result<PullRequestReviewThreadUpdate> {
    let (pull_request_id, azure_thread_id, parent_comment_id) =
        parse_azure_thread_id(thread_id)?;
    let value = server_execute(
        profile_id,
        AzdoOperation::SetThreadStatus {
            project: project.into(),
            repository: repo.into(),
            id: pull_request_id,
            thread_id: azure_thread_id,
            status: if resolved {
                AzdoThreadStatus::Fixed
            } else {
                AzdoThreadStatus::Active
            },
        },
    )?;
    Ok(parse_azure_thread_update(
        &value,
        pull_request_id,
        azure_thread_id,
        parent_comment_id,
        resolved,
    ))
}

fn azure_server_commits(
    profile_id: Uuid,
    project: &str,
    repo: &str,
    id: u64,
) -> Result<Vec<PullRequestCommit>> {
    let value = server_execute(
        profile_id,
        AzdoOperation::Commits {
            project: project.into(),
            repository: repo.into(),
            id,
        },
    )?;
    Ok(parse_azure_commits(&value))
}

fn azure_server_policies(
    profile_id: Uuid,
    project: &str,
    project_id: &str,
    id: u64,
) -> Result<Vec<PullRequestActivityCheck>> {
    let value = server_execute(
        profile_id,
        AzdoOperation::Policies {
            project: project.into(),
            project_id: project_id.into(),
            id,
        },
    )?;
    Ok(parse_azure_policies(&value))
}

fn azure_server_viewer(profile_id: Uuid) -> Result<String> {
    let value = server_execute(profile_id, AzdoOperation::Viewer)?;
    text(value.pointer("/authenticatedUser/properties/Account/$value"))
        .or_else(|| text(value.pointer("/authenticatedUser/providerDisplayName")))
        .or_else(|| text(value.pointer("/authenticatedUser/displayName")))
        .ok_or_else(|| "Azure DevOps Server returned no signed-in account".into())
}

fn add_comment_azure_server(
    profile_id: Uuid,
    project: String,
    repo: String,
    id: u64,
    body: &str,
) -> Result<()> {
    server_execute(
        profile_id,
        AzdoOperation::AddComment {
            project,
            repository: repo,
            id,
            body: body.into(),
        },
    )?;
    Ok(())
}

fn azure_server_review_coordinates(
    profile_id: Uuid,
    project: &str,
    repo: &str,
    id: u64,
    expected_head: &str,
) -> Result<AzureReviewCoordinates> {
    let iterations = server_execute(
        profile_id,
        AzdoOperation::PullRequestIterations {
            project: project.into(),
            repository: repo.into(),
            id,
        },
    )?;
    let iteration_id = azure_latest_iteration(&iterations, expected_head)?;
    let mut coordinates = AzureReviewCoordinates {
        iteration_id,
        change_tracking_ids: HashMap::new(),
    };
    let mut skip = 0;
    for _ in 0..MAX_AZURE_ITERATION_CHANGE_PAGES {
        let changes = server_execute(
            profile_id,
            AzdoOperation::PullRequestIterationChanges {
                project: project.into(),
                repository: repo.into(),
                id,
                iteration_id,
                top: AZURE_ITERATION_CHANGE_PAGE_SIZE,
                skip,
            },
        )?;
        add_azure_change_tracking_ids(&mut coordinates, &changes)?;
        let next_skip = changes.get("nextSkip").and_then(Value::as_u64).unwrap_or(0);
        if next_skip == 0 {
            return Ok(coordinates);
        }
        skip = u32::try_from(next_skip)
            .map_err(|_| "Azure DevOps returned an invalid iteration-change cursor".to_string())?;
    }
    Err("Azure DevOps pull request changes exceed Strand's 64,000-file review limit".into())
}

#[allow(clippy::too_many_arguments)]
fn add_inline_comment_azure_server_with_coordinates(
    profile_id: Uuid,
    project: &str,
    repo: &str,
    id: u64,
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    coordinates: &AzureReviewCoordinates,
) -> Result<()> {
    let change_tracking_id = azure_change_tracking_id(coordinates, file_path)?;
    server_execute(
        profile_id,
        AzdoOperation::AddInlineComment {
            project: project.into(),
            repository: repo.into(),
            id,
            body: body.into(),
            file_path: file_path.into(),
            start_line,
            end_line,
            side: match side {
                PullRequestDiffSide::Additions => AzdoDiffSide::Additions,
                PullRequestDiffSide::Deletions => AzdoDiffSide::Deletions,
            },
            iteration_id: coordinates.iteration_id,
            change_tracking_id,
        },
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_inline_comment_azure_server(
    profile_id: Uuid,
    project: &str,
    repo: &str,
    id: u64,
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    expected_head: &str,
) -> Result<()> {
    let current = server_show(profile_id, project, repo, id)?;
    let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure DevOps Server did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    let coordinates =
        azure_server_review_coordinates(profile_id, project, repo, id, expected_head)?;
    let current = server_show(profile_id, project, repo, id)?;
    let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure DevOps Server did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    add_inline_comment_azure_server_with_coordinates(
        profile_id,
        project,
        repo,
        id,
        body,
        file_path,
        start_line,
        end_line,
        side,
        &coordinates,
    )
}

#[allow(clippy::too_many_arguments)]
fn submit_review_azure_server(
    profile_id: Uuid, project: &str, repo: &str, id: u64,
    event: PullRequestReviewEvent, body: &str, comments: &[PullRequestPendingComment],
    expected_head: &str,
) -> Result<()> {
    let current = server_show(profile_id, project, repo, id)?;
    let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure DevOps Server did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    let coordinates = if comments.is_empty() {
        None
    } else {
        let coordinates =
            azure_server_review_coordinates(profile_id, project, repo, id, expected_head)?;
        let current = server_show(profile_id, project, repo, id)?;
        let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
            .ok_or_else(|| "Azure DevOps Server did not return the pull request head commit".to_string())?;
        ensure_review_head(&current_head, expected_head)?;
        Some(coordinates)
    };
    if let Some(vote) = azure_review_vote(event) {
        let reviewer_id = azure_server_viewer_id(profile_id)?;
        server_execute(profile_id, AzdoOperation::SetVote {
            project: project.into(), repository: repo.into(), id, reviewer_id, vote,
        })?;
    }
    if let Some(coordinates) = coordinates.as_ref() {
        for (index, comment) in comments.iter().enumerate() {
            add_inline_comment_azure_server_with_coordinates(
                profile_id,
                project,
                repo,
                id,
                &comment.body,
                &comment.path,
                comment.start_line,
                comment.end_line,
                comment.side,
                coordinates,
            )
            .map_err(|error| azure_review_inline_write_error(event, index, error))?;
        }
    }
    if !body.trim().is_empty() {
        add_comment_azure_server(profile_id, project.into(), repo.into(), id, body)
            .map_err(|error| azure_review_summary_error(event, comments.len(), error))?;
    }
    Ok(())
}

fn reset_review_azure_server(
    profile_id: Uuid,
    project: &str,
    repo: &str,
    id: u64,
    review_id: &str,
) -> Result<()> {
    let viewer_id = azure_server_viewer_id(profile_id)?;
    if viewer_id != review_id {
        return Err("Azure DevOps only lets Strand reset the signed-in reviewer's vote".into());
    }
    let current = server_show(profile_id, project, repo, id)?;
    let has_vote = array(&current, "reviewers").iter().any(|reviewer| {
        text(reviewer.get("id")).as_deref() == Some(review_id)
            && reviewer.get("vote").and_then(Value::as_i64).unwrap_or(0) != 0
    });
    if !has_vote {
        return Err("The signed-in Azure DevOps review no longer has a vote to reset".into());
    }
    server_execute(profile_id, AzdoOperation::SetVote {
        project: project.into(),
        repository: repo.into(),
        id,
        reviewer_id: viewer_id,
        vote: AzdoReviewVote::Reset,
    })?;
    Ok(())
}

fn azure_server_viewer_id(profile_id: Uuid) -> Result<String> {
    let value = server_execute(profile_id, AzdoOperation::Viewer)?;
    text(value.pointer("/authenticatedUser/id"))
        .ok_or_else(|| "Azure DevOps Server returned no signed-in reviewer id".into())
}

fn merge_azure_server(
    profile_id: Uuid,
    project: String,
    repo: String,
    id: u64,
    strategy: PullRequestMergeStrategy,
    expected_head: &str,
) -> Result<()> {
    server_execute(
        profile_id,
        AzdoOperation::Complete {
            project,
            repository: repo,
            id,
            expected_head: expected_head.into(),
            strategy: match strategy {
                PullRequestMergeStrategy::MergeCommit => AzdoMergeStrategy::MergeCommit,
                PullRequestMergeStrategy::Squash => AzdoMergeStrategy::Squash,
                PullRequestMergeStrategy::Rebase => AzdoMergeStrategy::Rebase,
            },
        },
    )?;
    Ok(())
}

fn mark_ready_azure_server(profile_id: Uuid, project: String, repo: String, id: u64) -> Result<()> {
    server_execute(
        profile_id,
        AzdoOperation::MarkReady {
            project,
            repository: repo,
            id,
        },
    )?;
    Ok(())
}

fn set_lifecycle_azure_server(
    profile_id: Uuid,
    project: String,
    repo: String,
    id: u64,
    action: PullRequestLifecycleAction,
) -> Result<()> {
    server_execute(
        profile_id,
        AzdoOperation::SetStatus {
            project,
            repository: repo,
            id,
            status: azure_lifecycle_status(action),
        },
    )?;
    Ok(())
}

fn server_execute(profile_id: Uuid, operation: AzdoOperation) -> Result<Value> {
    azdo_helper::execute(azdo_helper::handle()?, profile_id, operation)
}

fn azure_server_label(collection_url: &str, project: &str, repo: &str) -> String {
    let collection = collection_url
        .trim_start_matches("https://")
        .trim_end_matches('/');
    format!("{collection}/{project}/{repo}")
}

fn azure_server_pr_url(collection_url: &str, project: &str, repo: &str, id: u64) -> String {
    let mut url = match url::Url::parse(collection_url) {
        Ok(url) => url,
        Err(_) => return collection_url.to_string(),
    };
    let id = id.to_string();
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.pop_if_empty();
        segments.extend([project, "_git", repo, "pullrequest", &id]);
    }
    url.to_string()
}

fn for_branch_azure(
    cwd: &str,
    remote: String,
    organization: String,
    project: String,
    repo: String,
    branch: &str,
) -> Result<Option<PullRequestBranchMatch>> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
    let output = run_command(
        cwd,
        "az",
        &[
            "repos",
            "pr",
            "list",
            "--organization",
            &organization_url,
            "--project",
            &project,
            "--repository",
            &repo,
            "--source-branch",
            branch,
            "--status",
            AZURE_BRANCH_STATUS,
            "--top",
            "1",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    let values: Vec<Value> = serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid JSON: {error}"))?;
    Ok(values.first().and_then(|value| {
        parse_azure_pr(value, &organization, &project, &repo, None).map(|pull_request| {
            PullRequestBranchMatch {
                repository: PullRequestRepository {
                    provider: PullRequestProvider::AzureDevOps,
                    remote,
                    label: format!("{organization}/{project}/{repo}"),
                    viewer: None,
                },
                pull_request,
            }
        })
    }))
}

fn azure_viewer(cwd: &str) -> Result<String> {
    let output = run_command(
        cwd,
        "az",
        &[
            "account",
            "show",
            "--query",
            "user.name",
            "--output",
            "tsv",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    non_empty_text(&output, "Azure CLI returned no signed-in account")
}

fn non_empty_text(output: &[u8], empty_message: &str) -> Result<String> {
    let value = String::from_utf8(output.to_vec())
        .map_err(|error| format!("Provider CLI returned invalid text: {error}"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        Err(empty_message.into())
    } else {
        Ok(value)
    }
}

#[allow(clippy::too_many_arguments)]
fn create_azure(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
    is_draft: bool,
) -> Result<PullRequestCreateOutcome> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let source_branch = branch_name(source_branch.to_string());
    let target_branch = branch_name(target_branch.to_string());
    let draft = if is_draft { "true" } else { "false" };
    let output = run_command(
        cwd,
        "az",
        &[
            "repos",
            "pr",
            "create",
            "--organization",
            &organization_url,
            "--project",
            project,
            "--repository",
            repo,
            "--source-branch",
            &source_branch,
            "--target-branch",
            &target_branch,
            "--title",
            title,
            "--description",
            description,
            "--draft",
            draft,
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid JSON: {error}"))?;
    let id = value
        .get("pullRequestId")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Azure CLI created the pull request but returned no PR id".to_string())?;
    Ok(PullRequestCreateOutcome {
        id,
        url: format!("https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{id}"),
    })
}

fn detail_azure(
    cwd: &str,
    organization: String,
    project: String,
    repo: String,
    id: u64,
) -> Result<PullRequest> {
    let (value, viewer) = thread::scope(|scope| {
        let value = scope.spawn(|| azure_pr_value(cwd, &organization, id));
        let viewer = scope.spawn(|| azure_viewer(cwd));
        (value.join(), viewer.join())
    });
    let value = value.map_err(|_| "Azure pull-request query worker failed".to_string())??;
    let viewer = viewer.ok().and_then(Result::ok);
    let mut pull_request =
        parse_azure_pr(&value, &organization, &project, &repo, viewer.as_deref())
            .ok_or_else(|| format!("Azure CLI returned no data for PR #{id}"))?;
    let (comments, commits, checks) = thread::scope(|scope| {
        let comments = scope.spawn(|| azure_comments(cwd, &organization, &project, &repo, id));
        let commits = scope.spawn(|| azure_commits(cwd, &organization, &project, &repo, id));
        let checks = scope.spawn(|| azure_policies(cwd, &organization, id));
        (comments.join(), commits.join(), checks.join())
    });
    let discussion = comments.map_err(|_| "Azure discussion query worker failed".to_string())??;
    pull_request.comments = discussion.comments;
    pull_request.review_threads = discussion.review_threads;
    pull_request.comment_count = pull_request.comments.len();
    pull_request.commits =
        commits.map_err(|_| "Azure commit query worker failed".to_string())??;
    pull_request.commit_count = pull_request.commits.len();
    if let Ok(Ok(checks)) = checks {
        pull_request.checks = checks
            .iter()
            .map(|check| PullRequestCheck {
                name: check.name.clone(),
                status: check.status.clone(),
            })
            .collect();
        pull_request.checks_complete = true;
    }
    Ok(pull_request)
}

fn activity_azure(
    cwd: &str,
    remote: String,
    organization: String,
    project: String,
    repo: String,
    id: u64,
) -> Result<PullRequestActivitySnapshot> {
    let value = azure_pr_value(cwd, &organization, id)?;
    let pull_request = parse_azure_pr(&value, &organization, &project, &repo, None)
        .ok_or_else(|| format!("Azure CLI returned no data for PR #{id}"))?;
    let comments = azure_comments(cwd, &organization, &project, &repo, id)?
        .comments
        .into_iter()
        .map(|comment| PullRequestActivityComment {
            id: comment.id,
            author: comment.author,
            kind: if comment.path.is_some() {
                "thread"
            } else {
                "comment"
            }
            .into(),
            is_system: comment.is_system,
        })
        .collect();
    let reviews = array(&value, "reviewers")
        .iter()
        .filter_map(parse_azure_activity_review)
        .collect();
    let checks = azure_policies(cwd, &organization, id)?;
    Ok(PullRequestActivitySnapshot {
        repository: PullRequestRepository {
            provider: PullRequestProvider::AzureDevOps,
            remote,
            label: format!("{organization}/{project}/{repo}"),
            viewer: None,
        },
        id: pull_request.id,
        title: pull_request.title,
        url: pull_request.url,
        state: pull_request.state,
        source_branch: pull_request.source_branch,
        source_commit: pull_request.source_commit,
        updated_at: pull_request.updated_at,
        comments,
        reviews,
        checks,
        checks_complete: true,
    })
}

fn azure_pr_value(cwd: &str, organization: &str, id: u64) -> Result<Value> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let id = id.to_string();
    let output = run_command(
        cwd,
        "az",
        &[
            "repos",
            "pr",
            "show",
            "--id",
            &id,
            "--organization",
            &organization_url,
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid JSON: {error}"))
}

fn azure_comments(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    id: u64,
) -> Result<AzureDiscussion> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let id_text = id.to_string();
    let project_arg = format!("project={project}");
    let repository_arg = format!("repositoryId={repo}");
    let pull_request_arg = format!("pullRequestId={id}");
    let output = run_command(
        cwd,
        "az",
        &[
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--route-parameters",
            &project_arg,
            &repository_arg,
            &pull_request_arg,
            "--organization",
            &organization_url,
            "--api-version",
            "7.1",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid discussion JSON: {error}"))?;
    Ok(parse_azure_discussion(
        &value,
        &format!(
            "https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{id_text}"
        ),
        id,
    ))
}

fn azure_commits(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    id: u64,
) -> Result<Vec<PullRequestCommit>> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let project_arg = format!("project={project}");
    let repository_arg = format!("repositoryId={repo}");
    let pull_request_arg = format!("pullRequestId={id}");
    let output = run_command(
        cwd,
        "az",
        &[
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestCommits",
            "--route-parameters",
            &project_arg,
            &repository_arg,
            &pull_request_arg,
            "--organization",
            &organization_url,
            "--api-version",
            "7.1",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid commit JSON: {error}"))?;
    Ok(parse_azure_commits(&value))
}

fn azure_policies(cwd: &str, organization: &str, id: u64) -> Result<Vec<PullRequestActivityCheck>> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let id = id.to_string();
    let output = run_command(
        cwd,
        "az",
        &[
            "repos",
            "pr",
            "policy",
            "list",
            "--id",
            &id,
            "--organization",
            &organization_url,
            "--top",
            "100",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid policy JSON: {error}"))?;
    Ok(parse_azure_policies(&value))
}

fn azure_invoke_json(
    cwd: &str,
    organization: &str,
    resource: &str,
    route_parameters: &[String],
    query_parameters: &[String],
) -> Result<Value> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let mut args = vec![
        "devops".to_string(),
        "invoke".to_string(),
        "--area".to_string(),
        "git".to_string(),
        "--resource".to_string(),
        resource.to_string(),
        "--route-parameters".to_string(),
    ];
    args.extend_from_slice(route_parameters);
    if !query_parameters.is_empty() {
        args.push("--query-parameters".into());
        args.extend_from_slice(query_parameters);
    }
    args.extend([
        "--organization".into(),
        organization_url,
        "--api-version".into(),
        "7.1".into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_command(
        cwd,
        "az",
        &arg_refs,
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid {resource} JSON: {error}"))
}

fn azure_invoke_write_json(
    cwd: &str,
    organization: &str,
    resource: &str,
    route_parameters: &[String],
    method: &str,
    payload: &Value,
) -> Result<Value> {
    let mut request = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Could not prepare Azure {resource} request: {error}"))?;
    serde_json::to_writer(&mut request, payload)
        .map_err(|error| format!("Could not encode Azure {resource} request: {error}"))?;
    request
        .flush()
        .map_err(|error| format!("Could not prepare Azure {resource} request: {error}"))?;
    let request_path = request
        .path()
        .to_str()
        .ok_or_else(|| format!("Azure {resource} request path is not valid UTF-8"))?;
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let mut args = vec![
        "devops".to_string(),
        "invoke".to_string(),
        "--area".to_string(),
        "git".to_string(),
        "--resource".to_string(),
        resource.to_string(),
        "--route-parameters".to_string(),
    ];
    args.extend_from_slice(route_parameters);
    args.extend([
        "--organization".into(),
        organization_url,
        "--api-version".into(),
        "7.1".into(),
        "--http-method".into(),
        method.into(),
        "--in-file".into(),
        request_path.into(),
        "--media-type".into(),
        "application/json".into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_command(
        cwd,
        "az",
        &arg_refs,
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    serde_json::from_slice(&output)
        .map_err(|error| format!("Azure CLI returned invalid {resource} JSON: {error}"))
}

fn reply_to_thread_azure(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    thread_id: &str,
    body: &str,
) -> Result<PullRequestComment> {
    let (pull_request_id, azure_thread_id, parent_comment_id) =
        parse_azure_thread_id(thread_id)?;
    let routes = vec![
        format!("project={project}"),
        format!("repositoryId={repo}"),
        format!("pullRequestId={pull_request_id}"),
        format!("threadId={azure_thread_id}"),
    ];
    let value = azure_invoke_write_json(
        cwd,
        organization,
        "pullRequestThreadComments",
        &routes,
        "POST",
        &serde_json::json!({
            "parentCommentId": parent_comment_id,
            "content": body,
            "commentType": 1
        }),
    )?;
    parse_azure_comment(
        &value,
        azure_thread_id,
        &format!(
            "https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{pull_request_id}"
        ),
        None,
    )
    .ok_or_else(|| "Azure DevOps returned no usable review-thread reply".into())
}

fn set_thread_resolved_azure(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    thread_id: &str,
    resolved: bool,
) -> Result<PullRequestReviewThreadUpdate> {
    let (pull_request_id, azure_thread_id, parent_comment_id) =
        parse_azure_thread_id(thread_id)?;
    let routes = vec![
        format!("project={project}"),
        format!("repositoryId={repo}"),
        format!("pullRequestId={pull_request_id}"),
        format!("threadId={azure_thread_id}"),
    ];
    let value = azure_invoke_write_json(
        cwd,
        organization,
        "pullRequestThreads",
        &routes,
        "PATCH",
        &serde_json::json!({ "status": if resolved { 2 } else { 1 } }),
    )?;
    Ok(parse_azure_thread_update(
        &value,
        pull_request_id,
        azure_thread_id,
        parent_comment_id,
        resolved,
    ))
}

fn azure_review_coordinates(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    id: u64,
    expected_head: &str,
) -> Result<AzureReviewCoordinates> {
    let routes = vec![
        format!("project={project}"),
        format!("repositoryId={repo}"),
        format!("pullRequestId={id}"),
    ];
    let iterations = azure_invoke_json(
        cwd,
        organization,
        "pullRequestIterations",
        &routes,
        &[],
    )?;
    let iteration_id = azure_latest_iteration(&iterations, expected_head)?;
    let mut coordinates = AzureReviewCoordinates {
        iteration_id,
        change_tracking_ids: HashMap::new(),
    };
    let mut skip = 0;
    for _ in 0..MAX_AZURE_ITERATION_CHANGE_PAGES {
        let mut change_routes = routes.clone();
        change_routes.push(format!("iterationId={iteration_id}"));
        let query = vec![
            format!("$top={AZURE_ITERATION_CHANGE_PAGE_SIZE}"),
            format!("$skip={skip}"),
            "$compareTo=0".into(),
        ];
        let changes = azure_invoke_json(
            cwd,
            organization,
            "pullRequestIterationChanges",
            &change_routes,
            &query,
        )?;
        add_azure_change_tracking_ids(&mut coordinates, &changes)?;
        let next_skip = changes.get("nextSkip").and_then(Value::as_u64).unwrap_or(0);
        if next_skip == 0 {
            return Ok(coordinates);
        }
        skip = u32::try_from(next_skip)
            .map_err(|_| "Azure DevOps returned an invalid iteration-change cursor".to_string())?;
    }
    Err("Azure DevOps pull request changes exceed Strand's 64,000-file review limit".into())
}

#[allow(clippy::too_many_arguments)]
fn add_inline_comment_azure_with_coordinates(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    id: u64,
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    coordinates: &AzureReviewCoordinates,
) -> Result<()> {
    let change_tracking_id = azure_change_tracking_id(coordinates, file_path)?;
    let payload = azure_inline_comment_payload(
        body,
        file_path,
        start_line,
        end_line,
        side,
        coordinates.iteration_id,
        change_tracking_id,
    );
    let mut request = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Could not prepare Azure inline comment: {error}"))?;
    serde_json::to_writer(&mut request, &payload)
        .map_err(|error| format!("Could not encode Azure inline comment: {error}"))?;
    request
        .flush()
        .map_err(|error| format!("Could not prepare Azure inline comment: {error}"))?;
    let request_path = request
        .path()
        .to_str()
        .ok_or_else(|| "Azure inline comment request path is not valid UTF-8".to_string())?;
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let project_arg = format!("project={project}");
    let repository_arg = format!("repositoryId={repo}");
    let pull_request_arg = format!("pullRequestId={id}");
    run_command(
        cwd,
        "az",
        &[
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--route-parameters",
            &project_arg,
            &repository_arg,
            &pull_request_arg,
            "--organization",
            &organization_url,
            "--api-version",
            "7.1",
            "--http-method",
            "POST",
            "--in-file",
            request_path,
            "--media-type",
            "application/json",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_inline_comment_azure(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    id: u64,
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    expected_head: &str,
) -> Result<()> {
    let current = azure_pr_value(cwd, organization, id)?;
    let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure DevOps did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    let coordinates =
        azure_review_coordinates(cwd, organization, project, repo, id, expected_head)?;
    let current = azure_pr_value(cwd, organization, id)?;
    let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure DevOps did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    add_inline_comment_azure_with_coordinates(
        cwd,
        organization,
        project,
        repo,
        id,
        body,
        file_path,
        start_line,
        end_line,
        side,
        &coordinates,
    )
}

fn add_comment_azure(
    cwd: &str,
    organization: String,
    project: String,
    repo: String,
    id: u64,
    body: &str,
) -> Result<()> {
    let mut request = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Could not prepare Azure comment: {error}"))?;
    serde_json::to_writer(
        &mut request,
        &serde_json::json!({
            "comments": [{"parentCommentId": 0, "content": body, "commentType": 1}],
            "status": 1
        }),
    )
    .map_err(|error| format!("Could not encode Azure comment: {error}"))?;
    request
        .flush()
        .map_err(|error| format!("Could not prepare Azure comment: {error}"))?;
    let request_path = request
        .path()
        .to_str()
        .ok_or_else(|| "Azure comment request path is not valid UTF-8".to_string())?;
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let project_arg = format!("project={project}");
    let repository_arg = format!("repositoryId={repo}");
    let pull_request_arg = format!("pullRequestId={id}");
    run_command(
        cwd,
        "az",
        &[
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            "--route-parameters",
            &project_arg,
            &repository_arg,
            &pull_request_arg,
            "--organization",
            &organization_url,
            "--api-version",
            "7.1",
            "--http-method",
            "POST",
            "--in-file",
            request_path,
            "--media-type",
            "application/json",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn submit_review_azure(
    cwd: &str, organization: &str, project: &str, repo: &str, id: u64,
    event: PullRequestReviewEvent, body: &str, comments: &[PullRequestPendingComment],
    expected_head: &str,
) -> Result<()> {
    let current = azure_pr_value(cwd, organization, id)?;
    let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure DevOps did not return the pull request head commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    let coordinates = if comments.is_empty() {
        None
    } else {
        let coordinates =
            azure_review_coordinates(cwd, organization, project, repo, id, expected_head)?;
        let current = azure_pr_value(cwd, organization, id)?;
        let current_head = text(current.pointer("/lastMergeSourceCommit/commitId"))
            .ok_or_else(|| "Azure DevOps did not return the pull request head commit".to_string())?;
        ensure_review_head(&current_head, expected_head)?;
        Some(coordinates)
    };
    if let Some(vote) = azure_review_vote_label(event) {
        let organization_url = format!("https://dev.azure.com/{organization}/");
        let id_arg = id.to_string();
        run_command(
            cwd, "az",
            &["repos", "pr", "set-vote", "--id", &id_arg, "--vote", vote,
              "--organization", &organization_url, "--output", "json", "--only-show-errors"],
            &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
        )?;
    }
    if let Some(coordinates) = coordinates.as_ref() {
        for (index, comment) in comments.iter().enumerate() {
            add_inline_comment_azure_with_coordinates(
                cwd,
                organization,
                project,
                repo,
                id,
                &comment.body,
                &comment.path,
                comment.start_line,
                comment.end_line,
                comment.side,
                coordinates,
            )
            .map_err(|error| azure_review_inline_write_error(event, index, error))?;
        }
    }
    if !body.trim().is_empty() {
        add_comment_azure(
            cwd, organization.into(), project.into(), repo.into(), id, body,
        ).map_err(|error| azure_review_summary_error(event, comments.len(), error))?;
    }
    Ok(())
}

fn reset_review_azure(cwd: &str, organization: &str, id: u64, review_id: &str) -> Result<()> {
    let viewer = azure_viewer(cwd)?;
    let current = azure_pr_value(cwd, organization, id)?;
    let owns_vote = array(&current, "reviewers").iter().any(|reviewer| {
        text(reviewer.get("id")).as_deref() == Some(review_id)
            && text(reviewer.get("uniqueName"))
                .is_some_and(|identity| identity.eq_ignore_ascii_case(&viewer))
            && reviewer.get("vote").and_then(Value::as_i64).unwrap_or(0) != 0
    });
    if !owns_vote {
        return Err("Azure DevOps only lets Strand reset the signed-in reviewer's current vote".into());
    }
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let id_arg = id.to_string();
    run_command(
        cwd, "az",
        &["repos", "pr", "set-vote", "--id", &id_arg, "--vote", "reset",
          "--organization", &organization_url, "--output", "json", "--only-show-errors"],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    Ok(())
}

fn merge_azure(
    cwd: &str,
    organization: &str,
    project: &str,
    repo: &str,
    id: u64,
    strategy: PullRequestMergeStrategy,
    expected_head: &str,
) -> Result<()> {
    let mut request = tempfile::NamedTempFile::new()
        .map_err(|error| format!("Could not prepare Azure merge: {error}"))?;
    serde_json::to_writer(
        &mut request,
        &serde_json::json!({
            "status": "completed",
            "lastMergeSourceCommit": {"commitId": expected_head},
            "completionOptions": {
                "mergeStrategy": azure_merge_strategy(strategy),
                "deleteSourceBranch": false,
                "transitionWorkItems": false
            }
        }),
    )
    .map_err(|error| format!("Could not encode Azure merge: {error}"))?;
    request
        .flush()
        .map_err(|error| format!("Could not prepare Azure merge: {error}"))?;
    let request_path = request
        .path()
        .to_str()
        .ok_or_else(|| "Azure merge request path is not valid UTF-8".to_string())?;
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let project_arg = format!("project={project}");
    let repository_arg = format!("repositoryId={repo}");
    let pull_request_arg = format!("pullRequestId={id}");
    run_command(
        cwd,
        "az",
        &[
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequests",
            "--route-parameters",
            &project_arg,
            &repository_arg,
            &pull_request_arg,
            "--organization",
            &organization_url,
            "--api-version",
            "7.1",
            "--http-method",
            "PATCH",
            "--in-file",
            request_path,
            "--media-type",
            "application/json",
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    Ok(())
}

fn mark_ready_azure(cwd: &str, organization: &str, id: u64) -> Result<()> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let id = id.to_string();
    run_command(
        cwd,
        "az",
        &[
            "repos",
            "pr",
            "update",
            "--id",
            &id,
            "--draft",
            "false",
            "--organization",
            &organization_url,
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    Ok(())
}

fn set_lifecycle_azure(
    cwd: &str,
    organization: &str,
    id: u64,
    action: PullRequestLifecycleAction,
) -> Result<()> {
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let id = id.to_string();
    let status = azure_lifecycle_status_label(action);
    run_command(
        cwd,
        "az",
        &[
            "repos",
            "pr",
            "update",
            "--id",
            &id,
            "--status",
            status,
            "--organization",
            &organization_url,
            "--output",
            "json",
            "--only-show-errors",
        ],
        &[("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no")],
    )?;
    Ok(())
}

fn diff_azure(
    cwd: &str,
    remote: String,
    organization: String,
    _project: String,
    _repo: String,
    id: u64,
) -> Result<String> {
    let value = azure_pr_value(cwd, &organization, id)?;
    diff_azure_value(cwd, remote, value)
}

fn diff_azure_server(
    cwd: &str,
    remote: String,
    profile_id: Uuid,
    project: String,
    repo: String,
    id: u64,
) -> Result<String> {
    let value = server_show(profile_id, &project, &repo, id)?;
    diff_azure_value(cwd, remote, value)
}

fn prepare_checkout_azure_value(
    cwd: &str,
    remote: &str,
    value: Value,
    expected_head: &str,
) -> Result<PullRequestCheckoutPreparation> {
    let source_ref = text(value.get("sourceRefName"))
        .ok_or_else(|| "Azure PR did not report its source branch".to_string())?;
    let current_head = text(value.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure PR did not report its source commit".to_string())?;
    ensure_review_head(&current_head, expected_head)?;
    let source_remote = text(value.pointer("/forkSource/repository/remoteUrl"));
    let fetch_remote = source_remote.as_deref().unwrap_or(remote);
    Repo::discover(cwd)
        .map_err(|error| error.to_string())?
        .fetch_refs_for_read(fetch_remote, &[&source_ref])
        .map_err(|error| format!("Could not fetch the Azure PR source for a worktree: {error}"))?;
    let branch = branch_name(source_ref);
    if branch.is_empty() {
        return Err("Azure PR returned an invalid source branch".into());
    }
    Ok(PullRequestCheckoutPreparation {
        branch,
        start_point: expected_head.into(),
    })
}

fn diff_azure_value(cwd: &str, remote: String, value: Value) -> Result<String> {
    let source_ref = text(value.get("sourceRefName"))
        .ok_or_else(|| "Azure PR did not report its source branch".to_string())?;
    let target_ref = text(value.get("targetRefName"))
        .ok_or_else(|| "Azure PR did not report its target branch".to_string())?;
    let source_commit = text(value.pointer("/lastMergeSourceCommit/commitId"))
        .ok_or_else(|| "Azure PR did not report its source commit".to_string())?;
    let target_commit = text(value.pointer("/lastMergeTargetCommit/commitId"))
        .ok_or_else(|| "Azure PR did not report its target commit".to_string())?;
    let source_remote = text(value.pointer("/forkSource/repository/remoteUrl"));

    let local = Repo::discover(cwd).map_err(|error| error.to_string())?;
    let completed_merge = text(value.get("status"))
        .is_some_and(|status| status.eq_ignore_ascii_case("completed"))
        .then(|| text(value.pointer("/lastMergeCommit/commitId")))
        .flatten();
    let (base, head) = if let Some(merge_commit) = completed_merge {
        // Azure keeps the immutable result commit after completion even when
        // completion deletes the source branch. The target branch reaches both
        // this result and the pre-merge target commit, so historical Code views
        // need only the durable target ref.
        local
            .fetch_refs_for_read(&remote, &[target_ref.as_str()])
            .map_err(|error| error.to_string())?;
        (target_commit, merge_commit)
    } else {
        if source_remote
            .as_deref()
            .is_none_or(|source| source == remote)
        {
            local
                .fetch_refs_for_read(&remote, &[target_ref.as_str(), source_ref.as_str()])
                .map_err(|error| error.to_string())?;
        } else {
            local
                .fetch_refs_for_read(&remote, &[target_ref.as_str()])
                .map_err(|error| error.to_string())?;
            local
                .fetch_refs_for_read(
                    source_remote.as_deref().expect("checked above"),
                    &[source_ref.as_str()],
                )
                .map_err(|error| error.to_string())?;
        }
        let base = local
            .merge_base(&target_commit, &source_commit)
            .map_err(|error| error.to_string())?;
        (base, source_commit)
    };
    let files = local
        .diff_between(&base, &head)
        .map_err(|error| error.to_string())?;
    let patch = files
        .into_iter()
        .map(|file| file.patch)
        .filter(|patch| !patch.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if patch.len() > MAX_DIFF_BYTES {
        return Err("Pull request diff exceeds Strand's 16 MB display limit".into());
    }
    Ok(patch)
}

fn run_command(cwd: &str, program: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<Vec<u8>> {
    run_command_input(cwd, program, args, envs, None)
}

fn run_command_input(
    cwd: &str,
    program: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin_data: Option<&[u8]>,
) -> Result<Vec<u8>> {
    // Resolve strictly through PATH before setting the untrusted repository as
    // cwd. On Windows, CreateProcess otherwise searches cwd and could execute
    // a repository-owned `gh.exe`/`az.exe`. Reuse the AI CLI resolver so batch
    // shims and hidden-console behavior stay consistent.
    let resolved = resolve_cli(program, None).ok_or_else(|| {
        let install = if program == "gh" {
            "Install GitHub CLI and run `gh auth login`"
        } else {
            "Install Azure CLI with the azure-devops extension and run `az login`"
        };
        format!("Could not find {program} on PATH. {install}.")
    })?;
    let resolved = std::fs::canonicalize(&resolved)
        .map_err(|error| format!("Could not resolve {}: {error}", resolved.display()))?;
    let mut command = base_command(&resolved, true);
    command
        .args(args)
        .current_dir(cwd)
        .envs(envs.iter().copied())
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| {
        let install = if program == "gh" {
            "Install GitHub CLI and run `gh auth login`"
        } else {
            "Install Azure CLI with the azure-devops extension and run `az login`"
        };
        format!("Could not start {program}: {e}. {install}.")
    })?;

    let mut stdin_writer = child.stdin.take().map(|mut stdin| {
        let data = stdin_data.unwrap_or_default().to_vec();
        thread::spawn(move || stdin.write_all(&data))
    });

    // Drain both pipes while the command runs. A 100-PR JSON response easily
    // exceeds an OS pipe buffer; waiting for exit before reading can deadlock.
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                if let Some(writer) = stdin_writer.take() {
                    let _ = writer.join();
                }
                return Err(format!("{program} wait failed: {error}"));
            }
        }
        if started.elapsed() >= COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            if let Some(writer) = stdin_writer.take() {
                let _ = writer.join();
            }
            return Err(format!("{program} timed out after 30 seconds"));
        }
        thread::sleep(Duration::from_millis(25));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| format!("{program} output reader failed"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| format!("{program} error reader failed"))?;
    if let Some(writer) = stdin_writer.take() {
        writer
            .join()
            .map_err(|_| format!("{program} input writer failed"))?
            .map_err(|error| format!("{program} input failed: {error}"))?;
    }
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        let hint = auth_hint(program, &stderr);
        return Err(if stderr.is_empty() {
            format!("{program} failed{hint}")
        } else {
            format!("{program} failed: {stderr}{hint}")
        });
    }
    Ok(stdout)
}

fn auth_hint(program: &str, stderr: &str) -> &'static str {
    let lower = stderr.to_ascii_lowercase();
    let is_auth = [
        "auth login",
        "az login",
        "not logged",
        "authentication",
        "unauthorized",
        "bad credentials",
        "http 401",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !is_auth {
        ""
    } else if program == "gh" {
        " Sign in with `gh auth login`, then try again."
    } else if program == "glab" {
        " Sign in with `glab auth login --hostname HOST` for this remote, then try again."
    } else {
        " Sign in with `az login`, then try again."
    }
}

fn validate_comment(body: &str) -> Result<()> {
    if body.trim().is_empty() {
        return Err("Comment cannot be empty".into());
    }
    if body.len() > MAX_COMMENT_BYTES {
        return Err("Comment exceeds Strand's 64 KB limit".into());
    }
    Ok(())
}

fn validate_review(
    event: PullRequestReviewEvent,
    body: &str,
    comments: &[PullRequestPendingComment],
) -> Result<()> {
    if comments.len() > MAX_PENDING_REVIEW_COMMENTS {
        return Err("A review can contain at most 100 pending comments".into());
    }
    if body.len() > MAX_COMMENT_BYTES {
        return Err("Review summary exceeds Strand's 64 KB limit".into());
    }
    if matches!(event, PullRequestReviewEvent::Comment)
        && body.trim().is_empty()
        && comments.is_empty()
    {
        return Err("A comment review needs a summary or pending comment".into());
    }
    if matches!(event, PullRequestReviewEvent::RequestChanges) && body.trim().is_empty() {
        return Err("Request changes needs a review summary".into());
    }
    for comment in comments {
        validate_comment(&comment.body)?;
        if comment.path.trim().is_empty() || comment.path.contains(['\r', '\n', '\0']) {
            return Err("A pending review comment has an invalid file path".into());
        }
        if comment.start_line == 0 || comment.end_line < comment.start_line {
            return Err("A pending review comment has an invalid line range".into());
        }
    }
    Ok(())
}

fn ensure_review_head(current: &str, expected: &str) -> Result<()> {
    if current == expected {
        Ok(())
    } else {
        Err("The pull request changed while this review was being written. Refresh Code and review the new head before submitting.".into())
    }
}

fn review_summary_error(event: PullRequestReviewEvent, error: String) -> String {
    if matches!(event, PullRequestReviewEvent::Comment) {
        error
    } else {
        format!("The review decision was recorded, but its summary could not be added: {error}. The draft was preserved so you can retry the summary.")
    }
}

fn azure_review_inline_write_error(
    event: PullRequestReviewEvent,
    completed: usize,
    error: String,
) -> String {
    let decision_recorded = !matches!(event, PullRequestReviewEvent::Comment);
    if completed == 0 && !decision_recorded {
        error
    } else {
        let earlier = match (decision_recorded, completed) {
            (true, 0) => "the review decision".to_string(),
            (true, count) => format!(
                "the review decision and {count} inline comment{}",
                if count == 1 { "" } else { "s" }
            ),
            (false, count) => format!(
                "{count} inline comment{}",
                if count == 1 { "" } else { "s" }
            ),
        };
        format!(
            "Azure DevOps recorded {earlier} before the next inline write failed: {error}. The draft was preserved; remove any already-posted inline comments before retrying."
        )
    }
}

fn azure_review_summary_error(
    event: PullRequestReviewEvent,
    inline_comments: usize,
    error: String,
) -> String {
    if inline_comments == 0 {
        return review_summary_error(event, error);
    }
    let decision = if matches!(event, PullRequestReviewEvent::Comment) {
        ""
    } else {
        " and the review decision"
    };
    format!(
        "Azure DevOps recorded {inline_comments} inline comment{}{decision}, but the summary could not be added: {error}. The draft was preserved; remove the already-posted inline comments before retrying the summary.",
        if inline_comments == 1 { "" } else { "s" }
    )
}

fn validate_thread_id(thread_id: &str) -> Result<()> {
    if thread_id.trim().is_empty()
        || thread_id.len() > MAX_THREAD_ID_BYTES
        || thread_id.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(
            "Review thread is missing or invalid; refresh the pull request and try again".into(),
        );
    }
    Ok(())
}

fn azure_thread_id(pull_request_id: u64, thread_id: u64, parent_comment_id: u64) -> String {
    format!("azure:{pull_request_id}:{thread_id}:{parent_comment_id}")
}

fn parse_azure_thread_id(thread_id: &str) -> Result<(u64, u64, u64)> {
    let mut parts = thread_id.split(':');
    if parts.next() != Some("azure") {
        return Err("Azure review thread is invalid; refresh the pull request and try again".into());
    }
    let pull_request_id = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    let azure_thread_id = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    let parent_comment_id = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    if parts.next().is_some()
        || pull_request_id.is_none()
        || azure_thread_id.is_none()
        || parent_comment_id.is_none()
    {
        return Err("Azure review thread is invalid; refresh the pull request and try again".into());
    }
    Ok((
        pull_request_id.unwrap(),
        azure_thread_id.unwrap(),
        parent_comment_id.unwrap(),
    ))
}

fn validate_review_id(review_id: &str) -> Result<()> {
    if review_id.trim().is_empty()
        || review_id.len() > MAX_THREAD_ID_BYTES
        || review_id.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(
            "Review is missing or invalid; refresh the pull request and try again".into(),
        );
    }
    Ok(())
}

fn validate_create(
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
) -> Result<()> {
    for (label, branch) in [("Source", source_branch), ("Target", target_branch)] {
        if branch.trim().is_empty() || branch.contains(['\r', '\n', '\0']) {
            return Err(format!("{label} branch is invalid"));
        }
    }
    if title.trim().is_empty() {
        return Err("Pull request title is required".into());
    }
    if title.contains(['\r', '\n', '\0']) || title.len() > MAX_PR_TITLE_BYTES {
        return Err("Pull request title is invalid or exceeds Strand's 512-byte limit".into());
    }
    if description.len() > MAX_PR_DESCRIPTION_BYTES {
        return Err("Pull request description exceeds Strand's 64 KB limit".into());
    }
    Ok(())
}

fn validate_commit(commit: &str) -> Result<()> {
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(
            "Pull request source commit is missing or invalid; refresh the PR and try again".into(),
        );
    }
    Ok(())
}

fn github_merge_flag(strategy: PullRequestMergeStrategy) -> &'static str {
    match strategy {
        PullRequestMergeStrategy::MergeCommit => "--merge",
        PullRequestMergeStrategy::Squash => "--squash",
        PullRequestMergeStrategy::Rebase => "--rebase",
    }
}

fn github_lifecycle_verb(action: PullRequestLifecycleAction) -> &'static str {
    match action {
        PullRequestLifecycleAction::Close => "close",
        PullRequestLifecycleAction::Reopen => "reopen",
    }
}

fn azure_lifecycle_status(action: PullRequestLifecycleAction) -> AzdoPullRequestStatus {
    match action {
        PullRequestLifecycleAction::Close => AzdoPullRequestStatus::Abandoned,
        PullRequestLifecycleAction::Reopen => AzdoPullRequestStatus::Active,
    }
}

fn azure_lifecycle_status_label(action: PullRequestLifecycleAction) -> &'static str {
    match azure_lifecycle_status(action) {
        AzdoPullRequestStatus::Active => "active",
        AzdoPullRequestStatus::Abandoned => "abandoned",
    }
}

fn azure_review_vote(event: PullRequestReviewEvent) -> Option<AzdoReviewVote> {
    match event {
        PullRequestReviewEvent::Comment => None,
        PullRequestReviewEvent::Approve => Some(AzdoReviewVote::Approve),
        PullRequestReviewEvent::RequestChanges => Some(AzdoReviewVote::RequestChanges),
    }
}

fn azure_review_vote_label(event: PullRequestReviewEvent) -> Option<&'static str> {
    match event {
        PullRequestReviewEvent::Comment => None,
        PullRequestReviewEvent::Approve => Some("approve"),
        PullRequestReviewEvent::RequestChanges => Some("reject"),
    }
}

fn azure_latest_iteration(value: &Value, expected_head: &str) -> Result<u32> {
    let iterations = value
        .get("value")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let latest = iterations
        .iter()
        .filter_map(|iteration| Some((iteration.get("id")?.as_u64()?, iteration)))
        .max_by_key(|(id, _)| *id)
        .ok_or_else(|| "Azure DevOps returned no pull request iterations".to_string())?;
    let iteration_id = u32::try_from(latest.0)
        .map_err(|_| "Azure DevOps returned an invalid pull request iteration".to_string())?;
    if iteration_id > i16::MAX as u32 {
        return Err("Azure DevOps returned a pull request iteration outside its comment API range".into());
    }
    let iteration_head = text(latest.1.pointer("/sourceRefCommit/commitId"))
        .ok_or_else(|| "Azure DevOps did not return the latest iteration head commit".to_string())?;
    ensure_review_head(&iteration_head, expected_head)?;
    Ok(iteration_id)
}

fn add_azure_change_tracking_ids(
    coordinates: &mut AzureReviewCoordinates,
    value: &Value,
) -> Result<()> {
    for change in array(value, "changeEntries") {
        let Some(raw_id) = change.get("changeTrackingId").and_then(Value::as_u64) else {
            continue;
        };
        let id = u32::try_from(raw_id)
            .map_err(|_| "Azure DevOps returned an invalid file change-tracking ID".to_string())?;
        for path in [
            text(change.pointer("/item/path")),
            text(change.get("originalPath")),
        ]
        .into_iter()
        .flatten()
        {
            let normalized = path.trim_start_matches('/').to_string();
            if let Some(previous) = coordinates.change_tracking_ids.insert(normalized.clone(), id) {
                if previous != id {
                    return Err(format!(
                        "Azure DevOps returned ambiguous change tracking for {normalized}"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn azure_change_tracking_id(coordinates: &AzureReviewCoordinates, file_path: &str) -> Result<u32> {
    let normalized = file_path.trim_start_matches('/');
    coordinates
        .change_tracking_ids
        .get(normalized)
        .copied()
        .ok_or_else(|| {
            format!(
                "Azure DevOps no longer reports {normalized} in the reviewed iteration. Refresh Code and select the lines again."
            )
        })
}

fn azure_inline_comment_payload(
    body: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    side: PullRequestDiffSide,
    iteration_id: u32,
    change_tracking_id: u32,
) -> Value {
    let position = |line| serde_json::json!({ "line": line, "offset": 1 });
    let (left_start, left_end, right_start, right_end) = match side {
        PullRequestDiffSide::Additions => (
            Value::Null,
            Value::Null,
            position(start_line),
            position(end_line),
        ),
        PullRequestDiffSide::Deletions => (
            position(start_line),
            position(end_line),
            Value::Null,
            Value::Null,
        ),
    };
    serde_json::json!({
        "comments": [{"parentCommentId": 0, "content": body, "commentType": 1}],
        "status": 1,
        "threadContext": {
            "filePath": format!("/{}", file_path.trim_start_matches('/')),
            "leftFileStart": left_start,
            "leftFileEnd": left_end,
            "rightFileStart": right_start,
            "rightFileEnd": right_end
        },
        "pullRequestThreadContext": {
            "changeTrackingId": change_tracking_id,
            "iterationContext": {
                "firstComparingIteration": iteration_id,
                "secondComparingIteration": iteration_id
            }
        }
    })
}

fn azure_merge_strategy(strategy: PullRequestMergeStrategy) -> &'static str {
    match strategy {
        PullRequestMergeStrategy::MergeCommit => "noFastForward",
        PullRequestMergeStrategy::Squash => "squash",
        PullRequestMergeStrategy::Rebase => "rebase",
    }
}

fn parse_github_activity(
    value: &Value,
    repository: PullRequestRepository,
) -> Result<PullRequestActivitySnapshot> {
    let id = value
        .get("number")
        .and_then(Value::as_u64)
        .ok_or_else(|| "GitHub activity did not include a pull request number".to_string())?;
    let mut comments = value
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|comment| {
            Some(PullRequestActivityComment {
                id: text(comment.get("id"))?,
                author: text(comment.pointer("/author/login")).unwrap_or_else(|| "unknown".into()),
                kind: "comment".into(),
                is_system: false,
            })
        })
        .collect::<Vec<_>>();
    for thread in value
        .pointer("/reviewThreads/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        comments.extend(
            thread
                .pointer("/comments/nodes")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|comment| {
                    Some(PullRequestActivityComment {
                        id: text(comment.get("id"))?,
                        author: text(comment.pointer("/author/login"))
                            .unwrap_or_else(|| "unknown".into()),
                        kind: "thread".into(),
                        is_system: false,
                    })
                }),
        );
    }
    comments.sort_by(|left, right| left.id.cmp(&right.id));
    comments.dedup_by(|left, right| left.id == right.id);

    let reviews = value
        .pointer("/reviews/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|review| {
            Some(PullRequestActivityReview {
                id: text(review.get("id"))?,
                author: text(review.pointer("/author/login")).unwrap_or_else(|| "unknown".into()),
                state: text(review.get("state")).unwrap_or_else(|| "unknown".into()),
            })
        })
        .collect();
    let checks = value
        .pointer("/statusCheckRollup/contexts/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(parse_github_activity_check)
        .collect();

    Ok(PullRequestActivitySnapshot {
        repository,
        id,
        title: text(value.get("title")).unwrap_or_default(),
        url: text(value.get("url")).unwrap_or_default(),
        state: text(value.get("state"))
            .unwrap_or_else(|| "unknown".into())
            .to_lowercase(),
        source_branch: text(value.get("headRefName")).unwrap_or_default(),
        source_commit: text(value.get("headRefOid")).unwrap_or_default(),
        updated_at: text(value.get("updatedAt")).unwrap_or_default(),
        comments,
        reviews,
        checks,
        checks_complete: true,
    })
}

fn parse_github_activity_check(value: &Value) -> Option<PullRequestActivityCheck> {
    let kind = text(value.get("__typename")).unwrap_or_else(|| "Check".into());
    let name = text(value.get("name")).or_else(|| text(value.get("context")))?;
    let raw_id = value
        .get("databaseId")
        .and_then(Value::as_i64)
        .map(|id| id.to_string())
        .or_else(|| text(value.get("id")))
        .unwrap_or_else(|| name.clone());
    Some(PullRequestActivityCheck {
        id: format!("{kind}:{raw_id}"),
        name,
        status: text(value.get("conclusion"))
            .filter(|status| !status.is_empty())
            .or_else(|| text(value.get("state")))
            .or_else(|| text(value.get("status")))
            .unwrap_or_else(|| "unknown".into()),
    })
}

fn parse_azure_activity_review(value: &Value) -> Option<PullRequestActivityReview> {
    let vote = value.get("vote").and_then(Value::as_i64).unwrap_or(0);
    Some(PullRequestActivityReview {
        id: text(value.get("id"))
            .or_else(|| text(value.get("descriptor")))
            .or_else(|| text(value.get("uniqueName")))?,
        author: text(value.get("displayName")).unwrap_or_else(|| "unknown".into()),
        state: match vote {
            10 => "approved",
            5 => "approved_with_suggestions",
            -5 => "waiting_for_author",
            -10 => "changes_requested",
            _ => "pending",
        }
        .into(),
    })
}

fn parse_azure_policies(value: &Value) -> Vec<PullRequestActivityCheck> {
    value
        .as_array()
        .or_else(|| value.get("value").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|policy| {
            let name = text(policy.pointer("/configuration/type/displayName"))
                .or_else(|| text(policy.pointer("/configuration/settings/displayName")))
                .unwrap_or_else(|| "Azure policy".into());
            PullRequestActivityCheck {
                id: text(policy.get("evaluationId"))
                    .or_else(|| {
                        policy
                            .get("configuration")
                            .and_then(|config| config.get("id"))
                            .and_then(Value::as_i64)
                            .map(|id| id.to_string())
                    })
                    .unwrap_or_else(|| name.clone()),
                name,
                status: normalize_azure_policy_status(
                    &text(policy.get("status")).unwrap_or_else(|| "unknown".into()),
                ),
            }
        })
        .collect()
}

fn normalize_azure_policy_status(status: &str) -> String {
    match status.trim().to_ascii_lowercase().as_str() {
        "approved" => "success",
        "rejected" | "broken" => "failure",
        "queued" | "running" => "pending",
        value => value,
    }
    .into()
}

fn parse_github_pr(value: &Value, viewer: Option<&str>) -> Option<PullRequest> {
    let id = value.get("number")?.as_u64()?;
    let author = text(value.pointer("/author/login")).unwrap_or_else(|| "unknown".into());
    let comments = array(value, "comments")
        .iter()
        .filter_map(|comment| {
            let author = text(comment.pointer("/author/login")).unwrap_or_else(|| "unknown".into());
            Some(PullRequestComment {
                id: text(comment.get("id"))?,
                avatar_url: github_avatar_url(&author),
                author,
                body: text(comment.get("body")).unwrap_or_default(),
                created_at: text(comment.get("createdAt")).unwrap_or_default(),
                url: text(comment.get("url")).unwrap_or_default(),
                is_system: false,
                path: None,
            })
        })
        .collect::<Vec<_>>();
    let reviewers = array(value, "latestReviews")
        .iter()
        .filter_map(|review| {
            Some(PullRequestReviewer {
                name: text(review.pointer("/author/login"))?,
                status: text(review.get("state")).unwrap_or_else(|| "reviewed".into()),
                required: false,
            })
        })
        .chain(
            array(value, "reviewRequests")
                .iter()
                .filter_map(|reviewer| {
                    Some(PullRequestReviewer {
                        name: text(reviewer.get("login"))?,
                        status: "requested".into(),
                        required: true,
                    })
                }),
        )
        .collect();
    let checks = array(value, "statusCheckRollup")
        .iter()
        .filter_map(|check| {
            Some(PullRequestCheck {
                name: text(check.get("name")).or_else(|| text(check.get("context")))?,
                status: text(check.get("conclusion"))
                    .filter(|status| !status.is_empty())
                    .or_else(|| text(check.get("status")))
                    .unwrap_or_else(|| "unknown".into()),
            })
        })
        .collect();
    Some(PullRequest {
        capabilities: None,
        id,
        title: text(value.get("title")).unwrap_or_default(),
        state: text(value.get("state"))
            .unwrap_or_else(|| "unknown".into())
            .to_lowercase(),
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        can_mark_ready: false,
        author: author.clone(),
        source_branch: text(value.get("headRefName")).unwrap_or_default(),
        source_commit: text(value.get("headRefOid")).unwrap_or_default(),
        target_branch: text(value.get("baseRefName")).unwrap_or_default(),
        created_at: text(value.get("createdAt")).unwrap_or_default(),
        updated_at: text(value.get("updatedAt")).unwrap_or_default(),
        completed_at: text(value.get("mergedAt")).or_else(|| text(value.get("closedAt"))),
        url: text(value.get("url")).unwrap_or_default(),
        description: text(value.get("body")).unwrap_or_default(),
        merge_status: text(value.get("mergeStateStatus")).unwrap_or_default(),
        review_status: text(value.get("reviewDecision")).unwrap_or_default(),
        comment_count: comments.len(),
        commit_count: array(value, "commits").len(),
        additions: value.get("additions").and_then(Value::as_u64),
        deletions: value.get("deletions").and_then(Value::as_u64),
        changed_files: value.get("changedFiles").and_then(Value::as_u64),
        labels: array(value, "labels")
            .iter()
            .filter_map(|label| text(label.get("name")))
            .collect(),
        reviewers,
        reviews: Vec::new(),
        checks,
        checks_complete: value.get("statusCheckRollup").is_some(),
        comments,
        review_threads: Vec::new(),
        authored_by_viewer: viewer.is_some_and(|login| login.eq_ignore_ascii_case(&author)),
        commits: parse_github_commits(value),
    })
}

fn parse_github_commits(value: &Value) -> Vec<PullRequestCommit> {
    array(value, "commits")
        .iter()
        .filter_map(|commit| {
            let author_value = array(commit, "authors").first();
            let login = author_value.and_then(|author| text(author.get("login")));
            let author = author_value
                .and_then(|author| {
                    text(author.get("name"))
                        .or_else(|| text(author.get("login")))
                        .or_else(|| text(author.get("email")))
                })
                .unwrap_or_else(|| "unknown".into());
            Some(PullRequestCommit {
                id: text(commit.get("oid"))?,
                title: text(commit.get("messageHeadline"))
                    .unwrap_or_else(|| "Untitled commit".into()),
                author,
                avatar_url: login.as_deref().and_then(github_avatar_url),
                committed_at: text(commit.get("committedDate"))
                    .or_else(|| text(commit.get("authoredDate")))
                    .unwrap_or_default(),
                url: None,
            })
        })
        .collect()
}

fn parse_github_reviews(value: &Value) -> Vec<PullRequestReview> {
    let can_manage = value
        .pointer("/data/repository/pullRequest/viewerCanUpdate")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    value
        .pointer("/data/repository/pullRequest/reviews/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|review| {
            let state = text(review.get("state")).unwrap_or_else(|| "unknown".into());
            Some(PullRequestReview {
                id: text(review.get("id"))?,
                author: text(review.pointer("/author/login"))
                    .unwrap_or_else(|| "unknown".into()),
                avatar_url: text(review.pointer("/author/avatarUrl")),
                body: text(review.get("body")).unwrap_or_default(),
                submitted_at: text(review.get("submittedAt")).unwrap_or_default(),
                url: text(review.get("url")).unwrap_or_default(),
                can_update: review
                    .get("viewerCanUpdate")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                can_dismiss: can_manage
                    && matches!(state.as_str(), "APPROVED" | "CHANGES_REQUESTED"),
                state,
            })
        })
        .collect()
}

fn parse_github_review_threads(value: &Value) -> Vec<PullRequestReviewThread> {
    value
        .pointer("/data/repository/pullRequest/reviewThreads/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|thread| {
            let path = text(thread.get("path"))?;
            let end_line = thread
                .get("line")
                .and_then(Value::as_u64)
                .or_else(|| thread.get("originalLine").and_then(Value::as_u64))?
                as u32;
            let start_line = thread
                .get("startLine")
                .and_then(Value::as_u64)
                .or_else(|| thread.get("originalStartLine").and_then(Value::as_u64))
                .unwrap_or(u64::from(end_line)) as u32;
            let side = match text(thread.get("diffSide"))?.as_str() {
                "LEFT" => PullRequestDiffSide::Deletions,
                "RIGHT" => PullRequestDiffSide::Additions,
                _ => return None,
            };
            let comments = thread
                .pointer("/comments/nodes")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|comment| {
                    let author =
                        text(comment.pointer("/author/login")).unwrap_or_else(|| "unknown".into());
                    Some(PullRequestComment {
                        id: text(comment.get("id"))?,
                        avatar_url: text(comment.pointer("/author/avatarUrl"))
                            .or_else(|| github_avatar_url(&author)),
                        author,
                        body: text(comment.get("body")).unwrap_or_default(),
                        created_at: text(comment.get("createdAt")).unwrap_or_default(),
                        url: text(comment.get("url")).unwrap_or_default(),
                        is_system: false,
                        path: Some(path.clone()),
                    })
                })
                .collect::<Vec<_>>();
            if comments.is_empty() {
                return None;
            }
            Some(PullRequestReviewThread {
                id: text(thread.get("id"))?,
                path,
                start_line,
                end_line,
                side,
                is_resolved: thread
                    .get("isResolved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                is_outdated: thread
                    .get("isOutdated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                can_reply: thread
                    .get("viewerCanReply")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                can_resolve: thread
                    .get("viewerCanResolve")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                can_unresolve: thread
                    .get("viewerCanUnresolve")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                comments,
            })
        })
        .collect()
}

fn parse_github_can_mark_ready(value: &Value) -> bool {
    value
        .pointer("/data/repository/pullRequest/viewerCanUpdate")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn parse_github_thread_reply(value: &Value) -> Option<PullRequestComment> {
    let comment = value.pointer("/data/addPullRequestReviewThreadReply/comment")?;
    let author = text(comment.pointer("/author/login")).unwrap_or_else(|| "unknown".into());
    Some(PullRequestComment {
        id: text(comment.get("id"))?,
        avatar_url: text(comment.pointer("/author/avatarUrl"))
            .or_else(|| github_avatar_url(&author)),
        author,
        body: text(comment.get("body")).unwrap_or_default(),
        created_at: text(comment.get("createdAt")).unwrap_or_default(),
        url: text(comment.get("url")).unwrap_or_default(),
        is_system: false,
        path: text(comment.get("path")),
    })
}

fn parse_github_thread_update(
    value: &Value,
    resolved: bool,
) -> Option<PullRequestReviewThreadUpdate> {
    let mutation = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    let thread = value.pointer(&format!("/data/{mutation}/thread"))?;
    Some(PullRequestReviewThreadUpdate {
        id: text(thread.get("id"))?,
        is_resolved: thread.get("isResolved").and_then(Value::as_bool)?,
        is_outdated: thread.get("isOutdated").and_then(Value::as_bool)?,
        can_reply: thread
            .get("viewerCanReply")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        can_resolve: thread
            .get("viewerCanResolve")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        can_unresolve: thread
            .get("viewerCanUnresolve")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_azure_pr(
    value: &Value,
    organization_or_collection: &str,
    project: &str,
    repo: &str,
    viewer: Option<&str>,
) -> Option<PullRequest> {
    let id = value.get("pullRequestId")?.as_u64()?;
    let author = text(value.pointer("/createdBy/displayName")).unwrap_or_else(|| "unknown".into());
    let author_identity = text(value.pointer("/createdBy/uniqueName"));
    let authored_by_viewer = viewer.is_some_and(|identity| {
        author_identity
            .as_deref()
            .is_some_and(|author| author.eq_ignore_ascii_case(identity))
    });
    let reviewers = array(value, "reviewers")
        .iter()
        .filter_map(|reviewer| {
            let vote = reviewer.get("vote").and_then(Value::as_i64).unwrap_or(0);
            let status = match vote {
                10 => "approved",
                5 => "approved with suggestions",
                -5 => "waiting for author",
                -10 => "rejected",
                _ => "no vote",
            };
            Some(PullRequestReviewer {
                name: text(reviewer.get("displayName"))?,
                status: status.into(),
                required: reviewer
                    .get("isRequired")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    let reviews = array(value, "reviewers")
        .iter()
        .filter_map(|reviewer| {
            let vote = reviewer.get("vote").and_then(Value::as_i64).unwrap_or(0);
            if vote == 0 {
                return None;
            }
            let state = match vote {
                10 => "approved",
                5 => "approved with suggestions",
                -5 => "waiting for author",
                -10 => "changes requested",
                _ => "reviewed",
            };
            let reviewer_identity = text(reviewer.get("uniqueName"));
            Some(PullRequestReview {
                id: text(reviewer.get("id"))?,
                author: text(reviewer.get("displayName")).unwrap_or_else(|| "unknown".into()),
                avatar_url: text(reviewer.get("imageUrl")),
                state: state.into(),
                body: String::new(),
                submitted_at: String::new(),
                url: String::new(),
                can_update: false,
                can_dismiss: viewer.is_some_and(|identity| {
                    reviewer_identity
                        .as_deref()
                        .is_some_and(|reviewer| reviewer.eq_ignore_ascii_case(identity))
                }),
            })
        })
        .collect::<Vec<_>>();
    let review_status = if reviewers.is_empty() {
        String::new()
    } else if reviewers
        .iter()
        .any(|reviewer| reviewer.status == "rejected")
    {
        "changes requested".into()
    } else if reviewers
        .iter()
        .any(|reviewer| reviewer.status == "approved")
    {
        "approved".into()
    } else {
        "review required".into()
    };
    Some(PullRequest {
        capabilities: None,
        id,
        title: text(value.get("title")).unwrap_or_default(),
        state: text(value.get("status"))
            .unwrap_or_else(|| "unknown".into())
            .to_lowercase(),
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        can_mark_ready: authored_by_viewer
            && value
                .get("isDraft")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        author,
        source_branch: branch_name(text(value.get("sourceRefName")).unwrap_or_default()),
        source_commit: text(value.pointer("/lastMergeSourceCommit/commitId")).unwrap_or_default(),
        target_branch: branch_name(text(value.get("targetRefName")).unwrap_or_default()),
        created_at: text(value.get("creationDate")).unwrap_or_default(),
        updated_at: text(value.get("closedDate")).unwrap_or_default(),
        completed_at: text(value.get("closedDate")),
        url: if organization_or_collection.starts_with("https://") {
            azure_server_pr_url(organization_or_collection, project, repo, id)
        } else {
            format!("https://dev.azure.com/{organization_or_collection}/{project}/_git/{repo}/pullrequest/{id}")
        },
        description: text(value.get("description")).unwrap_or_default(),
        merge_status: text(value.get("mergeStatus")).unwrap_or_default(),
        review_status,
        comment_count: 0,
        commit_count: array(value, "commits").len(),
        additions: None,
        deletions: None,
        changed_files: None,
        labels: array(value, "labels")
            .iter()
            .filter_map(|label| text(label.get("name")))
            .collect(),
        reviewers,
        reviews,
        checks: Vec::new(),
        checks_complete: false,
        comments: Vec::new(),
        review_threads: Vec::new(),
        authored_by_viewer,
        commits: parse_azure_commits(value),
    })
}

fn parse_azure_commits(value: &Value) -> Vec<PullRequestCommit> {
    value
        .get("value")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|commit| {
            Some(PullRequestCommit {
                id: text(commit.get("commitId"))?,
                title: text(commit.get("comment"))
                    .and_then(|comment| comment.lines().next().map(str::to_string))
                    .unwrap_or_else(|| "Untitled commit".into()),
                author: text(commit.pointer("/author/name")).unwrap_or_else(|| "unknown".into()),
                avatar_url: text(commit.pointer("/author/imageUrl")),
                committed_at: text(commit.pointer("/committer/date"))
                    .or_else(|| text(commit.pointer("/author/date")))
                    .unwrap_or_default(),
                url: text(commit.get("remoteUrl")),
            })
        })
        .collect()
}

fn azure_threads(value: &Value) -> &[Value] {
    value
        .get("value")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn parse_azure_comment(
    value: &Value,
    thread_id: u64,
    pr_url: &str,
    path: Option<String>,
) -> Option<PullRequestComment> {
    let comment = value.get("value").filter(|value| value.is_object()).unwrap_or(value);
    if comment
        .get("isDeleted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let body = text(comment.get("content")).unwrap_or_default();
    if body.trim().is_empty() {
        return None;
    }
    let comment_id = comment.get("id").and_then(Value::as_u64)?;
    Some(PullRequestComment {
        id: format!("{thread_id}:{comment_id}"),
        author: text(comment.pointer("/author/displayName")).unwrap_or_else(|| "unknown".into()),
        avatar_url: text(comment.pointer("/author/imageUrl"))
            .or_else(|| text(comment.pointer("/author/_links/avatar/href"))),
        body,
        created_at: text(comment.get("publishedDate")).unwrap_or_default(),
        url: pr_url.to_string(),
        is_system: text(comment.get("commentType"))
            .is_some_and(|kind| kind.eq_ignore_ascii_case("system")),
        path,
    })
}

fn parse_azure_comments(value: &Value, pr_url: &str) -> Vec<PullRequestComment> {
    azure_threads(value)
        .iter()
        .filter(|thread| {
            !thread
                .get("isDeleted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .flat_map(|thread| {
            let thread_id = thread.get("id").and_then(Value::as_u64).unwrap_or(0);
            let path = text(thread.pointer("/threadContext/filePath"));
            array(thread, "comments")
                .iter()
                .filter_map(move |comment| parse_azure_comment(comment, thread_id, pr_url, path.clone()))
        })
        .collect()
}

fn azure_thread_resolved(value: &Value, fallback: bool) -> bool {
    match value.get("status") {
        Some(Value::Number(status)) => match status.as_u64() {
            Some(1 | 6) => false,
            Some(2..=5) => true,
            _ => fallback,
        },
        Some(Value::String(status)) => match status.to_ascii_lowercase().as_str() {
            "active" | "pending" => false,
            "fixed" | "wontfix" | "closed" | "bydesign" => true,
            _ => fallback,
        },
        _ => fallback,
    }
}

fn parse_azure_review_threads(
    value: &Value,
    pr_url: &str,
    pull_request_id: u64,
) -> Vec<PullRequestReviewThread> {
    azure_threads(value)
        .iter()
        .filter(|thread| {
            !thread
                .get("isDeleted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|thread| {
            let thread_id = thread.get("id").and_then(Value::as_u64)?;
            let path = text(thread.pointer("/threadContext/filePath"))?
                .trim_start_matches('/')
                .to_string();
            if path.is_empty() {
                return None;
            }
            let right_start = thread.pointer("/threadContext/rightFileStart/line").and_then(Value::as_u64);
            let right_end = thread.pointer("/threadContext/rightFileEnd/line").and_then(Value::as_u64);
            let left_start = thread.pointer("/threadContext/leftFileStart/line").and_then(Value::as_u64);
            let left_end = thread.pointer("/threadContext/leftFileEnd/line").and_then(Value::as_u64);
            let (start_line, end_line, side) = if right_start.is_some() || right_end.is_some() {
                let end = right_end.or(right_start)?;
                (right_start.unwrap_or(end), end, PullRequestDiffSide::Additions)
            } else {
                let end = left_end.or(left_start)?;
                (left_start.unwrap_or(end), end, PullRequestDiffSide::Deletions)
            };
            let comments = array(thread, "comments")
                .iter()
                .filter_map(|comment| {
                    parse_azure_comment(comment, thread_id, pr_url, Some(path.clone()))
                })
                .collect::<Vec<_>>();
            if comments.is_empty() {
                return None;
            }
            let parent_comment_id = array(thread, "comments")
                .iter()
                .find_map(|comment| comment.get("id").and_then(Value::as_u64))?;
            let is_resolved = azure_thread_resolved(thread, false);
            Some(PullRequestReviewThread {
                id: azure_thread_id(pull_request_id, thread_id, parent_comment_id),
                path,
                start_line: u32::try_from(start_line).ok()?,
                end_line: u32::try_from(end_line).ok()?,
                side,
                is_resolved,
                is_outdated: false,
                can_reply: true,
                can_resolve: !is_resolved,
                can_unresolve: is_resolved,
                comments,
            })
        })
        .collect()
}

fn parse_azure_thread_update(
    value: &Value,
    pull_request_id: u64,
    thread_id: u64,
    parent_comment_id: u64,
    resolved: bool,
) -> PullRequestReviewThreadUpdate {
    let is_resolved = azure_thread_resolved(value, resolved);
    PullRequestReviewThreadUpdate {
        id: azure_thread_id(pull_request_id, thread_id, parent_comment_id),
        is_resolved,
        is_outdated: false,
        can_reply: true,
        can_resolve: !is_resolved,
        can_unresolve: is_resolved,
    }
}

fn parse_azure_discussion(value: &Value, pr_url: &str, pull_request_id: u64) -> AzureDiscussion {
    AzureDiscussion {
        comments: parse_azure_comments(value, pr_url),
        review_threads: parse_azure_review_threads(value, pr_url, pull_request_id),
    }
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn github_avatar_url(login: &str) -> Option<String> {
    let valid = !login.is_empty()
        && login.len() <= 39
        && login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !login.starts_with('-')
        && !login.ends_with('-');
    valid.then(|| format!("https://github.com/{login}.png?size=80"))
}

fn branch_name(value: String) -> String {
    value
        .strip_prefix("refs/heads/")
        .unwrap_or(&value)
        .to_string()
}

fn parse_hosted_remote(remote: &str, configured: Option<&str>) -> Option<HostRepo> {
    let remote = if remote.contains("://") { remote.to_string() }
        else { let (user_host, path) = remote.split_once(':')?; format!("ssh://{user_host}/{path}") };
    let url = url::Url::parse(&remote).ok()?;
    if !matches!(url.scheme(), "https" | "ssh") || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return None; }
    let host = format!("{}{}", url.host_str()?, url.port().map(|p| format!(":{p}")).unwrap_or_default());
    transport::validate_host(&host).ok()?;
    let path = url.path().trim_matches('/').trim_end_matches(".git");
    let parts = path.split('/').map(percent_decode).collect::<Vec<_>>();
    if parts.len() < 2 || parts.iter().any(|p| p.is_empty() || p == "." || p == ".." || p.contains(['/', '\\', '\0', '\r', '\n'])) { return None; }
    let provider = match host.as_str() { "github.com" => "github", "gitlab.com" => "gitlab", "bitbucket.org" => "bitbucket", _ => configured? };
    match provider {
        "github" if parts.len() == 2 => Some(HostRepo::GitHub { host, owner: parts[0].clone(), repo: parts[1].clone() }),
        "gitlab" | "bitbucket" if provider == "gitlab" || host == "bitbucket.org" && parts.len() == 2 => Some(HostRepo::Hosted(hosted::HostedRepo {
            provider: provider.into(), host, namespace: parts[..parts.len()-1].join("/"), repo: parts.last()?.clone(),
        })),
        _ => None,
    }
}

#[derive(Debug, Serialize)]
pub struct RemoteHostingProvider { pub remote: String, pub url: String, pub provider: String }

pub fn hosting_providers(path: &str) -> Result<Vec<RemoteHostingProvider>> {
    let repo = Repo::discover(path).map_err(|e| e.to_string())?;
    repo.refs().map_err(|e| e.to_string())?.remotes.into_iter().map(|remote| {
        let url = repo.configured_remote_url(&remote.name).map_err(|e| e.to_string())?.unwrap_or_default();
        let provider = run_command(path, "git", &["config", "--get", &format!("remote.{}.strand-provider", remote.name)], &[]).ok().and_then(|v| String::from_utf8(v).ok()).unwrap_or_default().trim().to_string();
        Ok(RemoteHostingProvider { remote: remote.name, url, provider })
    }).collect()
}

pub fn set_hosting_provider(path: &str, remote: &str, provider: &str) -> Result<()> {
    let remotes = hosting_providers(path)?;
    let remote = remotes.iter().find(|r| r.remote == remote).ok_or("Remote no longer exists")?;
    if !matches!(provider, "" | "github" | "gitlab") { return Err("Select automatic detection, GitHub, or GitLab".into()); }
    if !provider.is_empty() && parse_hosted_remote(&remote.url, Some(provider)).is_none() { return Err("This remote has no supported HTTPS/SSH repository coordinates".into()); }
    run_command(path, "git", &["config", "--local", &format!("remote.{}.strand-provider", remote.remote), provider], &[])?;
    Ok(())
}

fn parse_remote(url: &str) -> Option<HostRepo> {
    if let Some(host) = parse_hosted_remote(url, None) { return Some(host); }
    let trimmed = url.trim().trim_end_matches(".git").trim_end_matches('/');
    if let Some(rest) = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("git@github.com:"))
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
    {
        let mut parts = rest.split('/');
        return Some(HostRepo::GitHub {
            host: "github.com".into(),
            owner: percent_decode(parts.next()?),
            repo: percent_decode(parts.next()?),
        });
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        let (host, path) = rest.split_once('/')?;
        if host.ends_with("@dev.azure.com") {
            return parse_azure_https_path(path);
        }
    }

    if let Some(rest) = trimmed
        .strip_prefix("https://dev.azure.com/")
        .or_else(|| trimmed.strip_prefix("http://dev.azure.com/"))
    {
        let mut parts = rest.split('/');
        let organization = parts.next()?.split('@').next_back()?;
        let project = parts.next()?;
        if parts.next()? != "_git" {
            return None;
        }
        return Some(HostRepo::Azure {
            organization: percent_decode(organization),
            project: percent_decode(project),
            repo: percent_decode(parts.next()?),
        });
    }
    if let Some(rest) = trimmed
        .strip_prefix("git@ssh.dev.azure.com:v3/")
        .or_else(|| trimmed.strip_prefix("ssh://git@ssh.dev.azure.com/v3/"))
    {
        let mut parts = rest.split('/');
        return Some(HostRepo::Azure {
            organization: percent_decode(parts.next()?),
            project: percent_decode(parts.next()?),
            repo: percent_decode(parts.next()?),
        });
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        let (host, path) = rest.split_once('/')?;
        if let Some(organization) = host.strip_suffix(".visualstudio.com") {
            let mut parts = path.split('/');
            let project = parts.next()?;
            if parts.next()? != "_git" {
                return None;
            }
            return Some(HostRepo::Azure {
                organization: percent_decode(organization),
                project: percent_decode(project),
                repo: percent_decode(parts.next()?),
            });
        }
    }
    None
}

fn parse_azure_https_path(rest: &str) -> Option<HostRepo> {
    let mut parts = rest.split('/');
    let organization = parts.next()?.split('@').next_back()?;
    let project = parts.next()?;
    if parts.next()? != "_git" {
        return None;
    }
    Some(HostRepo::Azure {
        organization: percent_decode(organization),
        project: percent_decode(project),
        repo: percent_decode(parts.next()?),
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                output.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command};

    #[test]
    fn custom_hosts_require_explicit_adapter_and_preserve_auth_coordinates() {
        assert!(parse_hosted_remote("git@enterprise.example:team/repo.git", None).is_none());
        assert_eq!(parse_hosted_remote("ssh://git@enterprise.example:8443/team/repo.git", Some("github")), Some(HostRepo::GitHub {host:"enterprise.example:8443".into(),owner:"team".into(),repo:"repo".into()}));
        assert!(matches!(parse_hosted_remote("https://gitlab.example/group/sub/repo.git",Some("gitlab")), Some(HostRepo::Hosted(host)) if host.namespace == "group/sub" && host.host == "gitlab.example"));
        assert!(parse_hosted_remote("https://bitbucket.example/projects/A/repos/b",Some("bitbucket")).is_none());
        assert!(parse_hosted_remote("https://enterprise.example/team/repo/extra",Some("github")).is_none());
        assert!(parse_hosted_remote("https://token:secret@enterprise.example/team/repo",Some("github")).is_none());
        assert!(parse_hosted_remote("https://enterprise.example/team%2Frepo/app",Some("github")).is_none());
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn parses_supported_remote_shapes() {
        assert_eq!(
            parse_remote("git@github.com:openai/codex.git"),
            Some(HostRepo::GitHub {
            host: "github.com".into(),
                owner: "openai".into(),
                repo: "codex".into()
            })
        );
        assert_eq!(
            parse_remote("https://dev.azure.com/acme/My%20Project/_git/web"),
            Some(HostRepo::Azure {
                organization: "acme".into(),
                project: "My Project".into(),
                repo: "web".into()
            })
        );
        assert_eq!(
            parse_remote("git@ssh.dev.azure.com:v3/acme/platform/api"),
            Some(HostRepo::Azure {
                organization: "acme".into(),
                project: "platform".into(),
                repo: "api".into()
            })
        );
        assert_eq!(
            parse_remote("https://acme@dev.azure.com/acme/platform/_git/api"),
            Some(HostRepo::Azure {
                organization: "acme".into(),
                project: "platform".into(),
                repo: "api".into()
            })
        );
    }

    #[test]
    fn rejects_unimplemented_hosts() {
        assert!(matches!(parse_remote("git@gitlab.com:acme/web.git"), Some(HostRepo::Hosted(_))));
        assert!(matches!(parse_remote("https://bitbucket.org/acme/web.git"), Some(HostRepo::Hosted(_))));
    }

    #[test]
    fn publishes_only_a_missing_checked_out_source_branch() {
        let base = std::env::temp_dir().join(format!(
            "strand-pr-source-push-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let local = base.join("local");
        let remote = base.join("remote.git");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&local).unwrap();
        git(&local, &["init", "-q", "-b", "topic"]);
        git(&local, &["config", "user.name", "Test"]);
        git(&local, &["config", "user.email", "test@example.com"]);
        git(&local, &["config", "commit.gpgsign", "false"]);
        std::fs::write(local.join("a.txt"), "one\n").unwrap();
        git(&local, &["add", "a.txt"]);
        git(&local, &["commit", "-q", "-m", "first"]);
        git(&base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(
            &local,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );

        ensure_source_branch_on_remote(local.to_str().unwrap(), "origin", "topic").unwrap();
        let published = git(&local, &["rev-parse", "refs/remotes/origin/topic"]);
        assert_eq!(published, git(&local, &["rev-parse", "HEAD"]));
        assert_eq!(
            git(&local, &["config", "--get", "branch.topic.remote"]),
            "origin"
        );

        std::fs::write(local.join("a.txt"), "two\n").unwrap();
        git(&local, &["commit", "-qam", "second"]);
        ensure_source_branch_on_remote(local.to_str().unwrap(), "origin", "topic").unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "refs/remotes/origin/topic"]),
            published,
            "PR creation must not push again once the remote branch exists"
        );
        assert!(
            ensure_source_branch_on_remote(local.to_str().unwrap(), "origin", "different").is_err()
        );

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn completed_azure_diff_survives_a_deleted_source_branch() {
        let base = std::env::temp_dir().join(format!(
            "strand-pr-completed-diff-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let publisher = base.join("publisher");
        let consumer = base.join("consumer");
        let remote = base.join("remote.git");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&publisher).unwrap();
        git(&publisher, &["init", "-q", "-b", "main"]);
        git(&publisher, &["config", "user.name", "Test"]);
        git(&publisher, &["config", "user.email", "test@example.com"]);
        git(&publisher, &["config", "commit.gpgsign", "false"]);
        std::fs::write(publisher.join("a.txt"), "one\n").unwrap();
        git(&publisher, &["add", "a.txt"]);
        git(&publisher, &["commit", "-q", "-m", "base"]);
        let target_commit = git(&publisher, &["rev-parse", "HEAD"]);
        git(&publisher, &["checkout", "-q", "-b", "topic"]);
        std::fs::write(publisher.join("a.txt"), "two\n").unwrap();
        git(&publisher, &["commit", "-qam", "topic"]);
        let source_commit = git(&publisher, &["rev-parse", "HEAD"]);
        git(&publisher, &["checkout", "-q", "main"]);
        git(&publisher, &["merge", "-q", "--no-ff", "topic", "-m", "merge"]);
        let merge_commit = git(&publisher, &["rev-parse", "HEAD"]);

        git(&base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(
            &publisher,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&publisher, &["push", "-q", "origin", "main", "topic"]);
        git(&publisher, &["push", "-q", "origin", "--delete", "topic"]);

        std::fs::create_dir_all(&consumer).unwrap();
        git(&consumer, &["init", "-q", "-b", "main"]);
        git(
            &consumer,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let patch = diff_azure_value(
            consumer.to_str().unwrap(),
            "origin".into(),
            serde_json::json!({
                "status": "completed",
                "sourceRefName": "refs/heads/topic",
                "targetRefName": "refs/heads/main",
                "lastMergeSourceCommit": { "commitId": source_commit },
                "lastMergeTargetCommit": { "commitId": target_commit },
                "lastMergeCommit": { "commitId": merge_commit }
            }),
        )
        .unwrap();
        assert!(patch.contains("-one"));
        assert!(patch.contains("+two"));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn normalizes_github_and_azure_payloads() {
        let github: Value = serde_json::from_str(
            r#"{
              "number": 42, "title": "Ship it", "state": "MERGED", "isDraft": false,
              "author": {"login": "octo"}, "headRefName": "feature", "baseRefName": "main",
              "headRefOid": "1111111111111111111111111111111111111111",
              "mergedAt": "2026-07-15T10:00:00Z",
              "comments": [{"id": "c"}], "commits": [{
                "oid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "messageHeadline": "Finish the inbox",
                "committedDate": "2026-07-15T09:30:00Z",
                "authors": [{"login": "octo", "name": "Octo Cat"}]
              }],
              "latestReviews": [{"author": {"login": "reviewer"}, "state": "APPROVED"}],
              "statusCheckRollup": [{"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}]
            }"#,
        )
        .unwrap();
        let github = parse_github_pr(&github, Some("OCTO")).unwrap();
        assert_eq!(github.id, 42);
        assert_eq!(github.state, "merged");
        assert_eq!(
            github.source_commit,
            "1111111111111111111111111111111111111111"
        );
        assert_eq!(github.completed_at.as_deref(), Some("2026-07-15T10:00:00Z"));
        assert!(github.authored_by_viewer);
        assert!(!github.can_mark_ready);
        assert_eq!(github.comment_count, 1);
        assert_eq!(github.comments.len(), 1);
        assert_eq!(github.commits[0].title, "Finish the inbox");
        assert_eq!(github.commits[0].author, "Octo Cat");
        assert_eq!(github.reviewers[0].status, "APPROVED");
        assert_eq!(github.checks[0].status, "SUCCESS");

        let azure: Value = serde_json::from_str(
            r#"{
              "pullRequestId": 7, "title": "Azure PR", "status": "active", "isDraft": true,
              "createdBy": {"displayName": "Ada", "uniqueName": "ada@example.com"},
              "sourceRefName": "refs/heads/topic",
              "targetRefName": "refs/heads/main",
              "closedDate": "2026-07-15T12:00:00Z",
              "lastMergeSourceCommit": {"commitId": "2222222222222222222222222222222222222222"},
              "reviewers": [
                {"id": "grace-id", "displayName": "Grace", "uniqueName": "grace@example.com", "vote": 10, "isRequired": true},
                {"id": "ada-id", "displayName": "Ada", "uniqueName": "ada@example.com", "vote": -5, "isRequired": false}
              ]
            }"#,
        )
        .unwrap();
        let azure =
            parse_azure_pr(&azure, "org", "project", "repo", Some("ADA@example.com")).unwrap();
        assert_eq!(azure.id, 7);
        assert_eq!(azure.source_branch, "topic");
        assert_eq!(
            azure.source_commit,
            "2222222222222222222222222222222222222222"
        );
        assert_eq!(azure.completed_at.as_deref(), Some("2026-07-15T12:00:00Z"));
        assert!(azure.authored_by_viewer);
        assert!(azure.can_mark_ready);
        assert_eq!(azure.review_status, "approved");
        assert!(azure.reviewers[0].required);
        assert_eq!(azure.reviews.len(), 2);
        assert!(!azure.reviews[0].can_dismiss);
        assert!(azure.reviews[1].can_dismiss);
        assert_eq!(azure.reviews[1].state, "waiting for author");
        assert!(azure.reviews[1].url.is_empty());

        let commits = parse_azure_commits(&serde_json::json!({ "value": [{
            "commitId": "3333333333333333333333333333333333333333",
            "comment": "Normalize commits\n\nDetails",
            "author": {
              "name": "Ada",
              "date": "2026-07-15T11:00:00Z",
              "imageUrl": "https://dev.azure.com/org/_apis/GraphProfile/MemberAvatars/ada"
            },
            "remoteUrl": "https://dev.azure.com/org/project/_git/repo/commit/333"
        }] }));
        assert_eq!(commits[0].title, "Normalize commits");
        assert_eq!(commits[0].author, "Ada");
        assert_eq!(commits[0].committed_at, "2026-07-15T11:00:00Z");
        assert_eq!(
            commits[0].avatar_url.as_deref(),
            Some("https://dev.azure.com/org/_apis/GraphProfile/MemberAvatars/ada")
        );
    }

    #[test]
    fn github_list_query_stays_shallow_and_auth_hints_are_specific() {
        for field in [
            "additions",
            "deletions",
            "changedFiles",
            "closedAt",
            "mergedAt",
            "headRefOid",
        ] {
            assert!(GITHUB_LIST_FIELDS.contains(field));
        }
        for nested in ["comments", "commits", "latestReviews", "statusCheckRollup"] {
            assert!(!GITHUB_LIST_FIELDS.contains(nested));
            assert!(GITHUB_DETAIL_FIELDS.contains(nested));
        }
        assert_eq!(
            auth_hint(
                "gh",
                "GraphQL query requests too many possible nodes (maximum 500,000)"
            ),
            ""
        );
        assert!(auth_hint("gh", "authentication required").contains("gh auth login"));
        assert!(auth_hint("az", "Please run az login").contains("az login"));
    }

    #[test]
    fn azure_server_urls_use_the_collection_and_escape_names() {
        assert_eq!(
            azure_server_pr_url(
                "https://ado.corp/tfs/DefaultCollection",
                "Platform Team",
                "web/api",
                17,
            ),
            "https://ado.corp/tfs/DefaultCollection/Platform%20Team/_git/web%2Fapi/pullrequest/17"
        );
        let value = serde_json::json!({
            "pullRequestId": 17,
            "title": "Server PR",
            "status": "active",
            "createdBy": { "displayName": "Ada" }
        });
        let pr = parse_azure_pr(
            &value,
            "https://ado.corp/tfs/DefaultCollection",
            "Platform Team",
            "web/api",
            None,
        ).unwrap();
        assert_eq!(pr.url, "https://ado.corp/tfs/DefaultCollection/Platform%20Team/_git/web%2Fapi/pullrequest/17");
    }

    #[test]
    fn identity_failure_is_optional_and_closed_github_prs_keep_their_completion_time() {
        let value = serde_json::json!({
            "number": 9,
            "title": "Not merged",
            "state": "CLOSED",
            "author": { "login": "octo" },
            "closedAt": "2026-07-15T13:00:00Z"
        });
        let pr = parse_github_pr(&value, None).unwrap();
        assert!(!pr.authored_by_viewer);
        assert_eq!(pr.state, "closed");
        assert_eq!(pr.completed_at.as_deref(), Some("2026-07-15T13:00:00Z"));

        let azure = serde_json::json!({
            "pullRequestId": 10,
            "title": "Missing account",
            "status": "abandoned",
            "createdBy": { "displayName": "Ada", "uniqueName": "ada@example.com" },
            "closedDate": "2026-07-15T14:00:00Z"
        });
        let pr = parse_azure_pr(&azure, "org", "project", "repo", None).unwrap();
        assert!(!pr.authored_by_viewer);
        assert_eq!(pr.completed_at.as_deref(), Some("2026-07-15T14:00:00Z"));
    }

    #[test]
    fn branch_lookup_is_active_only_and_uses_shallow_fields() {
        assert_eq!(GITHUB_BRANCH_STATE, "open");
        assert_eq!(AZURE_BRANCH_STATUS, "active");
        for nested in [
            "comments",
            "commits",
            "latestReviews",
            "statusCheckRollup",
            "body",
        ] {
            assert!(!GITHUB_LIST_FIELDS.contains(nested));
        }
    }

    #[test]
    fn github_activity_query_is_bounded_and_never_requests_a_patch() {
        assert!(GITHUB_ACTIVITY_QUERY.contains("comments(last: 100)"));
        assert!(GITHUB_ACTIVITY_QUERY.contains("reviews(last: 100)"));
        assert!(GITHUB_ACTIVITY_QUERY.contains("reviewThreads(last: 100)"));
        assert!(GITHUB_ACTIVITY_QUERY.contains("contexts(first: 100)"));
        for heavy in ["patch", "diff", "files(", "body"] {
            assert!(!GITHUB_ACTIVITY_QUERY.contains(heavy));
        }
    }

    #[test]
    fn github_review_thread_query_requests_write_capabilities() {
        assert!(!GITHUB_LIST_FIELDS.contains("viewerCanUpdate"));
        for field in [
            "viewerCanUpdate",
            "viewerCanReply",
            "viewerCanResolve",
            "viewerCanUnresolve",
        ] {
            assert!(GITHUB_REVIEW_THREADS_QUERY.contains(field));
        }
    }

    #[test]
    fn normalizes_github_activity_with_stable_ids() {
        let value = serde_json::json!({
            "number": 42,
            "title": "Ship it",
            "state": "OPEN",
            "url": "https://github.com/acme/app/pull/42",
            "updatedAt": "2026-07-14T10:00:00Z",
            "headRefName": "feature",
            "headRefOid": "1111111111111111111111111111111111111111",
            "comments": { "nodes": [
                { "id": "IC_1", "author": { "login": "ada" } }
            ] },
            "reviews": { "nodes": [
                { "id": "PRR_1", "state": "APPROVED", "author": { "login": "grace" } }
            ] },
            "reviewThreads": { "nodes": [{ "comments": { "nodes": [
                { "id": "PRRC_1", "author": { "login": "linus" } }
            ] } }] },
            "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "CheckRun", "databaseId": 99, "name": "CI", "status": "COMPLETED", "conclusion": "FAILURE" },
                { "__typename": "StatusContext", "id": "SC_1", "context": "lint", "state": "SUCCESS" }
            ] } }
        });
        let activity = parse_github_activity(
            &value,
            PullRequestRepository {
                provider: PullRequestProvider::GitHub,
                remote: "origin".into(),
                label: "acme/app".into(),
                viewer: None,
            },
        )
        .unwrap();
        assert_eq!(
            activity.source_commit,
            "1111111111111111111111111111111111111111"
        );
        assert_eq!(activity.comments[0].id, "IC_1");
        assert_eq!(activity.comments[1].id, "PRRC_1");
        assert_eq!(activity.reviews[0].id, "PRR_1");
        assert_eq!(activity.checks[0].id, "CheckRun:99");
        assert_eq!(activity.checks[0].status, "FAILURE");
        assert_eq!(activity.checks[1].id, "StatusContext:SC_1");
        assert!(activity.checks_complete);
    }

    #[test]
    fn normalizes_azure_policy_states_for_readiness() {
        let value = serde_json::json!([
            { "evaluationId": "one", "status": "approved", "configuration": { "type": { "displayName": "Build" } } },
            { "evaluationId": "two", "status": "rejected", "configuration": { "type": { "displayName": "Coverage" } } },
            { "evaluationId": "three", "status": "broken", "configuration": { "type": { "displayName": "Security" } } },
            { "evaluationId": "four", "status": "queued", "configuration": { "type": { "displayName": "Deploy" } } },
            { "evaluationId": "five", "status": "running", "configuration": { "type": { "displayName": "Test" } } }
        ]);
        let checks = parse_azure_policies(&value);
        assert_eq!(
            checks
                .iter()
                .map(|check| check.status.as_str())
                .collect::<Vec<_>>(),
            ["success", "failure", "failure", "pending", "pending",]
        );
        assert_eq!(checks[1].id, "two");
    }

    #[test]
    fn normalizes_github_and_azure_comments() {
        let github: Value = serde_json::from_str(
            r#"{
              "number": 42,
              "comments": [{
                "id": "IC_1", "body": "**Looks good**", "createdAt": "2026-07-13T12:00:00Z",
                "url": "https://github.com/acme/repo/pull/42#issuecomment-1",
                "author": {"login": "octo"}
              }]
            }"#,
        )
        .unwrap();
        let github = parse_github_pr(&github, None).unwrap();
        assert_eq!(github.comments[0].author, "octo");
        assert_eq!(
            github.comments[0].avatar_url.as_deref(),
            Some("https://github.com/octo.png?size=80")
        );
        assert_eq!(github.comments[0].body, "**Looks good**");

        let azure: Value = serde_json::from_str(
            r#"{"value":[{"id":9,"threadContext":{"filePath":"/src/lib.rs"},"comments":[
              {"id":1,"content":"Please rename this","commentType":"text","publishedDate":"2026-07-13T12:00:00Z","author":{"displayName":"Ada","imageUrl":"https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/ada"}},
              {"id":2,"content":"Policy updated","commentType":"system","author":{"displayName":"Build Service"}}
            ]}]}"#,
        )
        .unwrap();
        let comments = parse_azure_comments(&azure, "https://dev.azure.com/acme/pr/7");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].path.as_deref(), Some("/src/lib.rs"));
        assert_eq!(
            comments[0].avatar_url.as_deref(),
            Some("https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/ada")
        );
        assert!(comments[1].is_system);
    }

    #[test]
    fn normalizes_azure_review_threads_with_replies_ranges_and_statuses() {
        let value = serde_json::json!({ "value": [
            {
                "id": 9,
                "status": "active",
                "threadContext": {
                    "filePath": "/src/lib.rs",
                    "rightFileStart": { "line": 27, "offset": 1 },
                    "rightFileEnd": { "line": 29, "offset": 1 }
                },
                "comments": [
                    { "id": 1, "content": "Please validate this.", "commentType": "text",
                      "publishedDate": "2026-07-13T12:00:00Z", "author": { "displayName": "Octo" } },
                    { "id": 2, "content": "Fixed.", "commentType": "text",
                      "publishedDate": "2026-07-13T12:05:00Z", "author": { "displayName": "Ada" } }
                ]
            },
            {
                "id": 10,
                "status": 2,
                "threadContext": {
                    "filePath": "/src/old.rs",
                    "leftFileStart": { "line": 4, "offset": 1 },
                    "leftFileEnd": { "line": 4, "offset": 1 }
                },
                "comments": [
                    { "id": 1, "content": "Why remove this?", "commentType": "text",
                      "author": { "displayName": "Grace" } }
                ]
            },
            { "id": 11, "status": "active", "comments": [
                { "id": 1, "content": "General comment", "commentType": "text",
                  "author": { "displayName": "Linus" } }
            ] }
        ] });

        let discussion = parse_azure_discussion(&value, "https://dev.azure.com/acme/pr/7", 7);
        assert_eq!(discussion.comments.len(), 4);
        assert_eq!(discussion.review_threads.len(), 2);
        let added = &discussion.review_threads[0];
        assert_eq!(added.id, "azure:7:9:1");
        assert_eq!(added.path, "src/lib.rs");
        assert_eq!((added.start_line, added.end_line), (27, 29));
        assert_eq!(added.side, PullRequestDiffSide::Additions);
        assert!(!added.is_resolved);
        assert!(added.can_reply);
        assert!(added.can_resolve);
        assert!(!added.can_unresolve);
        assert_eq!(added.comments[1].author, "Ada");
        assert_eq!(added.comments[0].path.as_deref(), Some("src/lib.rs"));
        let deleted = &discussion.review_threads[1];
        assert_eq!(deleted.side, PullRequestDiffSide::Deletions);
        assert!(deleted.is_resolved);
        assert!(!deleted.can_resolve);
        assert!(deleted.can_unresolve);
    }

    #[test]
    fn normalizes_github_review_threads_with_replies_and_ranges() {
        let value = serde_json::json!({
            "data": { "repository": { "pullRequest": { "viewerCanUpdate": true,
              "reviews": { "nodes": [{
                "id": "PRR_1", "body": "Looks good.", "state": "APPROVED",
                "submittedAt": "2026-07-13T11:00:00Z", "url": "https://github.com/acme/repo/pull/42#pullrequestreview-1",
                "viewerCanUpdate": true, "viewerDidAuthor": true,
                "author": { "login": "ada", "avatarUrl": "https://avatars.example/ada" }
              }, {
                "id": "PRR_2", "body": "Pending note.", "state": "COMMENTED",
                "viewerCanUpdate": false, "viewerDidAuthor": false,
                "author": { "login": "octo" }
              }] },
              "reviewThreads": { "nodes": [{
                "id": "PRRT_1", "isResolved": false, "isOutdated": false,
                "viewerCanReply": true, "viewerCanResolve": true, "viewerCanUnresolve": false,
                "path": "src/lib.rs", "line": 29, "startLine": 27,
                "originalLine": 29, "originalStartLine": 27, "diffSide": "RIGHT",
                "comments": { "nodes": [
                    { "id": "PRRC_1", "body": "Please validate this.",
                      "createdAt": "2026-07-13T12:00:00Z", "url": "https://github.com/acme/repo/pull/42#discussion_r1",
                      "author": { "login": "octo", "avatarUrl": "https://avatars.example/octo" } },
                    { "id": "PRRC_2", "body": "Fixed.",
                      "createdAt": "2026-07-13T12:05:00Z", "url": "https://github.com/acme/repo/pull/42#discussion_r2",
                      "author": { "login": "ada", "avatarUrl": "https://avatars.example/ada" } }
                ] }
            }] } } } }
        });

        let threads = parse_github_review_threads(&value);
        let reviews = parse_github_reviews(&value);
        assert!(parse_github_can_mark_ready(&value));
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].path, "src/lib.rs");
        assert_eq!((threads[0].start_line, threads[0].end_line), (27, 29));
        assert_eq!(threads[0].side, PullRequestDiffSide::Additions);
        assert!(!threads[0].is_resolved);
        assert!(threads[0].can_reply);
        assert!(threads[0].can_resolve);
        assert!(!threads[0].can_unresolve);
        assert_eq!(threads[0].comments.len(), 2);
        assert_eq!(threads[0].comments[1].author, "ada");
        assert_eq!(threads[0].comments[0].path.as_deref(), Some("src/lib.rs"));
        assert_eq!(reviews.len(), 2);
        assert!(reviews[0].can_update);
        assert!(reviews[0].can_dismiss);
        assert!(!reviews[1].can_update);
        assert!(!reviews[1].can_dismiss);
    }

    #[test]
    fn rejects_empty_and_oversized_comments() {
        assert!(validate_comment(" \n ").is_err());
        assert!(validate_comment("Looks good").is_ok());
        assert!(validate_comment(&"x".repeat(MAX_COMMENT_BYTES + 1)).is_err());
    }

    #[test]
    fn review_thread_capabilities_fail_closed_when_missing() {
        let value = serde_json::json!({
            "data": { "repository": { "pullRequest": { "reviewThreads": { "nodes": [{
                "id": "PRRT_1", "path": "src/lib.rs", "line": 3, "diffSide": "RIGHT",
                "comments": { "nodes": [{ "id": "PRRC_1", "body": "Question",
                    "createdAt": "2026-07-13T12:00:00Z", "url": "https://example.test/comment",
                    "author": { "login": "octo" } }] }
            }] } } } }
        });
        let threads = parse_github_review_threads(&value);
        assert!(!parse_github_can_mark_ready(&value));
        assert_eq!(threads.len(), 1);
        assert!(!threads[0].can_reply);
        assert!(!threads[0].can_resolve);
        assert!(!threads[0].can_unresolve);
    }

    #[test]
    fn builds_and_parses_github_thread_mutations() {
        let payload = github_graphql_payload(
            GITHUB_THREAD_REPLY_MUTATION,
            serde_json::json!({ "threadId": "PRRT_1", "body": "Fixed." }),
        );
        assert_eq!(payload["variables"]["threadId"], "PRRT_1");
        assert_eq!(payload["variables"]["body"], "Fixed.");
        assert!(payload["query"]
            .as_str()
            .unwrap()
            .contains("addPullRequestReviewThreadReply"));

        let update = github_graphql_payload(
            GITHUB_REVIEW_UPDATE_MUTATION,
            serde_json::json!({ "reviewId": "PRR_1", "body": "Updated." }),
        );
        assert_eq!(update["variables"]["reviewId"], "PRR_1");
        assert!(update["query"].as_str().unwrap().contains("updatePullRequestReview"));
        let dismiss = github_graphql_payload(
            GITHUB_REVIEW_DISMISS_MUTATION,
            serde_json::json!({ "reviewId": "PRR_1", "message": "Superseded." }),
        );
        assert_eq!(dismiss["variables"]["message"], "Superseded.");
        assert!(dismiss["query"].as_str().unwrap().contains("dismissPullRequestReview"));

        let reply = parse_github_thread_reply(&serde_json::json!({
            "data": { "addPullRequestReviewThreadReply": { "comment": {
                "id": "PRRC_2", "body": "Fixed.", "createdAt": "2026-07-15T10:00:00Z",
                "url": "https://github.com/acme/repo/pull/42#discussion_r2", "path": "src/lib.rs",
                "author": { "login": "ada", "avatarUrl": "https://avatars.example/ada" }
            } } }
        }))
        .unwrap();
        assert_eq!(reply.id, "PRRC_2");
        assert_eq!(reply.path.as_deref(), Some("src/lib.rs"));

        for resolved in [true, false] {
            let value = if resolved {
                serde_json::json!({ "data": { "resolveReviewThread": { "thread": {
                    "id": "PRRT_1", "isResolved": true, "isOutdated": false,
                    "viewerCanReply": true, "viewerCanResolve": false, "viewerCanUnresolve": true
                } } } })
            } else {
                serde_json::json!({ "data": { "unresolveReviewThread": { "thread": {
                    "id": "PRRT_1", "isResolved": false, "isOutdated": false,
                    "viewerCanReply": true, "viewerCanResolve": true, "viewerCanUnresolve": false
                } } } })
            };
            let update = parse_github_thread_update(&value, resolved).unwrap();
            assert_eq!(update.is_resolved, resolved);
            assert_eq!(update.can_unresolve, resolved);
        }
    }

    #[test]
    fn validates_provider_thread_ids() {
        assert!(validate_thread_id("PRRT_kwDOExample").is_ok());
        assert!(validate_thread_id(" ").is_err());
        assert!(validate_thread_id("bad\nid").is_err());
        assert!(validate_thread_id(&"x".repeat(MAX_THREAD_ID_BYTES + 1)).is_err());
        assert_eq!(azure_thread_id(7, 9, 1), "azure:7:9:1");
        assert_eq!(
            parse_azure_thread_id("azure:7:9:1").unwrap(),
            (7, 9, 1)
        );
        for invalid in [
            "thread-1",
            "azure:7:9",
            "azure:0:9:1",
            "azure:7:0:1",
            "azure:7:9:0",
            "azure:7:9:1:10",
        ] {
            assert!(parse_azure_thread_id(invalid).is_err());
        }

        let resolved = parse_azure_thread_update(
            &serde_json::json!({ "id": 9, "status": "fixed" }),
            7,
            9,
            1,
            true,
        );
        assert_eq!(resolved.id, "azure:7:9:1");
        assert!(resolved.is_resolved);
        assert!(resolved.can_unresolve);
    }

    #[test]
    fn validates_pull_request_creation_fields() {
        assert!(validate_create("feature", "main", "Ship it", "Details").is_ok());
        assert!(validate_create("feature", "main", " ", "Details").is_err());
        assert!(validate_create("feature\nother", "main", "Ship it", "Details").is_err());
        assert!(validate_create("feature", "main\0other", "Ship it", "Details").is_err());
        assert!(validate_create(
            "feature",
            "main",
            "Ship it",
            &"x".repeat(MAX_PR_DESCRIPTION_BYTES + 1),
        )
        .is_err());
    }

    #[test]
    fn maps_github_missing_branch_errors_to_actionable_guidance() {
        let source_error = map_github_create_error(
            "gh failed: GraphQL: Head sha can't be blank, Base sha can't be blank, Head ref must be a branch".into(),
            "feature/topic",
            "main",
        );
        assert_eq!(
            source_error,
            "Source branch `feature/topic` is not available on GitHub. Push this branch to the repository remote, then create the pull request again."
        );

        let target_error = map_github_create_error(
            "gh failed: GraphQL: Base ref must be a branch".into(),
            "feature/topic",
            "release",
        );
        assert!(target_error.contains("Target branch `release`"));

        let unrelated = "gh failed: rate limited".to_string();
        assert_eq!(
            map_github_create_error(unrelated.clone(), "feature/topic", "main"),
            unrelated
        );
    }

    #[test]
    fn validates_expected_heads_and_maps_provider_merge_strategies() {
        assert!(validate_commit("0123456789abcdef0123456789abcdef01234567").is_ok());
        assert!(validate_commit("0123456").is_err());
        assert!(validate_commit("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        assert_eq!(
            github_merge_flag(PullRequestMergeStrategy::MergeCommit),
            "--merge"
        );
        assert_eq!(
            github_merge_flag(PullRequestMergeStrategy::Squash),
            "--squash"
        );
        assert_eq!(
            azure_merge_strategy(PullRequestMergeStrategy::MergeCommit),
            "noFastForward"
        );
        assert_eq!(
            azure_merge_strategy(PullRequestMergeStrategy::Rebase),
            "rebase"
        );
    }

    #[test]
    fn maps_provider_lifecycle_states() {
        assert_eq!(
            github_lifecycle_verb(PullRequestLifecycleAction::Close),
            "close"
        );
        assert_eq!(
            github_lifecycle_verb(PullRequestLifecycleAction::Reopen),
            "reopen"
        );
        assert_eq!(
            azure_lifecycle_status(PullRequestLifecycleAction::Close),
            AzdoPullRequestStatus::Abandoned
        );
        assert_eq!(
            azure_lifecycle_status_label(PullRequestLifecycleAction::Reopen),
            "active"
        );
    }

    #[test]
    fn builds_github_inline_comment_ranges_with_blob_sides() {
        let multi = github_inline_comment_payload(
            "Please simplify this.",
            "src/lib.rs",
            10,
            12,
            PullRequestDiffSide::Additions,
            "0123456789abcdef0123456789abcdef01234567",
        );
        assert_eq!(multi["path"], "src/lib.rs");
        assert_eq!(multi["start_line"], 10);
        assert_eq!(multi["line"], 12);
        assert_eq!(multi["start_side"], "RIGHT");
        assert_eq!(multi["side"], "RIGHT");

        let single = github_inline_comment_payload(
            "Why remove this?",
            "src/lib.rs",
            7,
            7,
            PullRequestDiffSide::Deletions,
            "0123456789abcdef0123456789abcdef01234567",
        );
        assert_eq!(single["line"], 7);
        assert_eq!(single["side"], "LEFT");
        assert!(single.get("start_line").is_none());
        assert!(single.get("start_side").is_none());
    }

    #[test]
    fn resolves_azure_iteration_coordinates_and_builds_tracked_ranges() {
        let head = "0123456789abcdef0123456789abcdef01234567";
        let iterations = serde_json::json!({ "value": [
            { "id": 1, "sourceRefCommit": { "commitId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
            { "id": 3, "sourceRefCommit": { "commitId": head } }
        ] });
        assert_eq!(azure_latest_iteration(&iterations, head).unwrap(), 3);
        assert!(azure_latest_iteration(
            &iterations,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        )
        .is_err());

        let mut coordinates = AzureReviewCoordinates {
            iteration_id: 3,
            change_tracking_ids: HashMap::new(),
        };
        add_azure_change_tracking_ids(
            &mut coordinates,
            &serde_json::json!({ "changeEntries": [{
                "changeTrackingId": 27,
                "item": { "path": "/src/new.rs" },
                "originalPath": "/src/old.rs"
            }] }),
        )
        .unwrap();
        assert_eq!(azure_change_tracking_id(&coordinates, "src/new.rs").unwrap(), 27);
        assert_eq!(azure_change_tracking_id(&coordinates, "src/old.rs").unwrap(), 27);

        let added = azure_inline_comment_payload(
            "Please simplify this.",
            "src/new.rs",
            8,
            10,
            PullRequestDiffSide::Additions,
            3,
            27,
        );
        assert_eq!(added["threadContext"]["filePath"], "/src/new.rs");
        assert_eq!(added["threadContext"]["rightFileStart"]["line"], 8);
        assert_eq!(added["threadContext"]["rightFileEnd"]["line"], 10);
        assert!(added["threadContext"]["leftFileStart"].is_null());
        assert_eq!(
            added["pullRequestThreadContext"]["iterationContext"]
                ["firstComparingIteration"],
            3
        );
        assert_eq!(
            added["pullRequestThreadContext"]["iterationContext"]
                ["secondComparingIteration"],
            3
        );
        assert_eq!(added["pullRequestThreadContext"]["changeTrackingId"], 27);

        let deleted = azure_inline_comment_payload(
            "Why remove this?",
            "src/old.rs",
            4,
            4,
            PullRequestDiffSide::Deletions,
            3,
            27,
        );
        assert_eq!(deleted["threadContext"]["leftFileStart"]["line"], 4);
        assert!(deleted["threadContext"]["rightFileStart"].is_null());
    }

    #[test]
    fn builds_exact_head_batched_github_reviews() {
        let head = "0123456789abcdef0123456789abcdef01234567";
        let comments = vec![
            PullRequestPendingComment {
                path: "src/lib.rs".into(), start_line: 10, end_line: 12,
                side: PullRequestDiffSide::Additions, body: "Please simplify this.".into(),
            },
            PullRequestPendingComment {
                path: "old.rs".into(), start_line: 7, end_line: 7,
                side: PullRequestDiffSide::Deletions, body: "Keep this branch.".into(),
            },
        ];
        let payload = github_review_payload(
            PullRequestReviewEvent::RequestChanges, "Two blocking points.", &comments, head,
        );
        assert_eq!(payload["commit_id"], head);
        assert_eq!(payload["event"], "REQUEST_CHANGES");
        assert_eq!(payload["comments"][0]["start_line"], 10);
        assert_eq!(payload["comments"][0]["start_side"], "RIGHT");
        assert_eq!(payload["comments"][1]["side"], "LEFT");
        assert!(payload["comments"][1].get("start_line").is_none());
    }

    #[test]
    fn validates_review_drafts_and_provider_decisions() {
        let comment = PullRequestPendingComment {
            path: "src/lib.rs".into(), start_line: 4, end_line: 4,
            side: PullRequestDiffSide::Additions, body: "Question".into(),
        };
        assert!(validate_review(PullRequestReviewEvent::Comment, "", &[comment]).is_ok());
        assert!(validate_review(PullRequestReviewEvent::Comment, "", &[]).is_err());
        assert!(validate_review(PullRequestReviewEvent::RequestChanges, "", &[]).is_err());
        assert!(ensure_review_head("a", "a").is_ok());
        assert!(ensure_review_head("b", "a").is_err());
        assert_eq!(azure_review_vote(PullRequestReviewEvent::Approve), Some(AzdoReviewVote::Approve));
        assert_eq!(azure_review_vote_label(PullRequestReviewEvent::RequestChanges), Some("reject"));
    }

    #[test]
    fn pins_branch_updates_and_worktree_fetches_to_the_reviewed_head() {
        let head = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(github_update_branch_payload(head)["expected_head_sha"], head);
        assert_eq!(github_pull_head_ref(42), "refs/pull/42/head");
    }
}
