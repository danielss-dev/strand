//! Pull-request host integration.
//!
//! Authentication stays with the provider CLIs (`gh` and `az`): Strand never
//! reads or stores their tokens. The list call stays shallow; a second command
//! loads nested metadata only for the selected pull request so provider query
//! limits and large repositories remain predictable.

use std::{
    io::{Read, Write},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use strand_core::Repo;

use crate::ai::bin::{base_command, resolve_cli};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_COMMENT_BYTES: usize = 65_536;
const MAX_PR_DESCRIPTION_BYTES: usize = 65_536;
const MAX_PR_TITLE_BYTES: usize = 512;
const MAX_DIFF_BYTES: usize = 16 * 1024 * 1024;
const GITHUB_BRANCH_STATE: &str = "open";
const AZURE_BRANCH_STATUS: &str = "active";
const GITHUB_LIST_FIELDS: &str = concat!(
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,",
    "url,reviewDecision"
);
const GITHUB_DETAIL_FIELDS: &str = concat!(
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,",
    "url,body,mergeStateStatus,reviewDecision,comments,commits,additions,deletions,",
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
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
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
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestProvider {
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

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestRepository {
    pub provider: PullRequestProvider,
    pub remote: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReviewer {
    pub name: String,
    pub status: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCheck {
    pub name: String,
    pub status: String,
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
    pub comments: Vec<PullRequestComment>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequest {
    pub id: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub source_branch: String,
    pub source_commit: String,
    pub target_branch: String,
    pub created_at: String,
    pub updated_at: String,
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
    pub checks: Vec<PullRequestCheck>,
    pub checks_complete: bool,
    pub comments: Vec<PullRequestComment>,
    pub review_threads: Vec<PullRequestReviewThread>,
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
    GitHub {
        owner: String,
        repo: String,
    },
    Azure {
        organization: String,
        project: String,
        repo: String,
    },
}

pub fn list(path: &str) -> Result<PullRequestList> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::GitHub { owner, repo } => list_github(path, remote, owner, repo),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => list_azure(path, remote, organization, project, repo),
    }
}

pub fn for_branch(path: &str, branch: &str) -> Result<Option<PullRequestBranchMatch>> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::GitHub { owner, repo } => for_branch_github(path, remote, owner, repo, branch),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => for_branch_azure(path, remote, organization, project, repo, branch),
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
        HostRepo::GitHub { owner, repo } => create_github(
            path,
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
        HostRepo::GitHub { owner, repo } => activity_github(path, remote, owner, repo, id),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => activity_azure(path, remote, organization, project, repo, id),
    }
}

pub fn detail(path: &str, id: u64) -> Result<PullRequest> {
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::GitHub { owner, repo } => detail_github(path, owner, repo, id),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => detail_azure(path, organization, project, repo, id),
    }
}

pub fn diff(path: &str, id: u64) -> Result<String> {
    let (remote, host) = host_for_path(path)?;
    match host {
        HostRepo::GitHub { owner, repo } => diff_github(path, owner, repo, id),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => diff_azure(path, remote, organization, project, repo, id),
    }
}

pub fn add_comment(path: &str, id: u64, body: &str) -> Result<()> {
    validate_comment(body)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::GitHub { owner, repo } => add_comment_github(path, owner, repo, id, body),
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => add_comment_azure(path, organization, project, repo, id, body),
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
        HostRepo::GitHub { owner, repo } => {
            let current = detail_github(path, owner.clone(), repo.clone(), id)?;
            if current.source_commit != expected_head {
                return Err("The pull request changed while this comment was being written. Refresh Changes and select the lines again.".to_string());
            }
            add_inline_comment_github(
                path, owner, repo, id, body, file_path, start_line, end_line, side,
                expected_head,
            )
        }
        HostRepo::Azure { .. } => Err(
            "Inline Azure DevOps comments need iteration tracking metadata that Strand does not load yet. Open this pull request on Azure DevOps to comment on these lines."
                .to_string(),
        ),
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
        HostRepo::GitHub { owner, repo } => {
            merge_github(path, &owner, &repo, id, strategy, expected_head)
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
    }
}

fn host_for_path(path: &str) -> Result<(String, HostRepo)> {
    let repo = Repo::discover(path).map_err(|error| error.to_string())?;
    let refs = repo.refs().map_err(|error| error.to_string())?;
    let mut supported = refs
        .remotes
        .into_iter()
        .filter_map(|remote| {
            let coordinates = parse_remote(remote.url.as_deref()?)?;
            Some((remote.name, coordinates))
        })
        .collect::<Vec<_>>();
    supported.sort_by_key(|(name, _)| (name != "origin", name.clone()));

    supported.into_iter().next().ok_or_else(|| {
        "No supported GitHub or Azure DevOps remote was found for this repository".to_string()
    })
}

fn list_github(cwd: &str, remote: String, owner: String, repo: String) -> Result<PullRequestList> {
    let slug = format!("{owner}/{repo}");
    // Keep the list query shallow. Asking GraphQL to expand nested comments,
    // commits, reviews, and checks across 100 PRs can exceed GitHub's 500k
    // possible-node cap even for a modest repository. Rich fields load only
    // for the selected PR via `detail_github`.
    let output = run_command(
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
    )?;
    let values: Vec<Value> = serde_json::from_slice(&output)
        .map_err(|e| format!("GitHub CLI returned invalid JSON: {e}"))?;
    let pull_requests = values.iter().filter_map(parse_github_pr).collect();
    Ok(PullRequestList {
        repository: PullRequestRepository {
            provider: PullRequestProvider::GitHub,
            remote,
            label: slug,
        },
        pull_requests,
    })
}

fn for_branch_github(
    cwd: &str,
    remote: String,
    owner: String,
    repo: String,
    branch: &str,
) -> Result<Option<PullRequestBranchMatch>> {
    let slug = format!("{owner}/{repo}");
    let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
    let output = run_command(
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
        .and_then(parse_github_pr)
        .map(|pull_request| PullRequestBranchMatch {
            repository: PullRequestRepository {
                provider: PullRequestProvider::GitHub,
                remote,
                label: slug,
            },
            pull_request,
        }))
}

#[allow(clippy::too_many_arguments)]
fn create_github(
    cwd: &str,
    owner: &str,
    repo: &str,
    source_branch: &str,
    target_branch: &str,
    title: &str,
    description: &str,
    is_draft: bool,
) -> Result<PullRequestCreateOutcome> {
    let slug = format!("{owner}/{repo}");
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
    let output = run_command_input(
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
        .ok_or_else(|| "GitHub created the pull request but returned no usable PR URL".to_string())?;
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
    cwd: &str,
    remote: String,
    owner: String,
    repo: String,
    id: u64,
) -> Result<PullRequestActivitySnapshot> {
    let query = format!("query={GITHUB_ACTIVITY_QUERY}");
    let owner_arg = format!("owner={owner}");
    let repo_arg = format!("repo={repo}");
    let number = format!("number={id}");
    let output = run_command(
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
            label: format!("{owner}/{repo}"),
        },
    )
}

fn detail_github(cwd: &str, owner: String, repo: String, id: u64) -> Result<PullRequest> {
    let slug = format!("{owner}/{repo}");
    let id_string = id.to_string();
    let output = run_command(
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
    let mut pull_request = parse_github_pr(&value)
        .ok_or_else(|| format!("GitHub CLI returned no data for PR #{id}"))?;
    pull_request.checks_complete = true;
    let review_threads = github_review_threads(cwd, &owner, &repo, id)?;
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
    Ok(pull_request)
}

fn github_review_threads(
    cwd: &str,
    owner: &str,
    repo: &str,
    id: u64,
) -> Result<Vec<PullRequestReviewThread>> {
    let query = format!("query={GITHUB_REVIEW_THREADS_QUERY}");
    let owner = format!("owner={owner}");
    let repo = format!("repo={repo}");
    let number = format!("number={id}");
    let output = run_command(
        cwd,
        "gh",
        &["api", "graphql", "-f", &query, "-F", &owner, "-F", &repo, "-F", &number],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid review-thread JSON: {error}"))?;
    Ok(parse_github_review_threads(&value))
}

fn diff_github(cwd: &str, owner: String, repo: String, id: u64) -> Result<String> {
    let slug = format!("{owner}/{repo}");
    let id = id.to_string();
    let output = run_command(
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

fn add_comment_github(cwd: &str, owner: String, repo: String, id: u64, body: &str) -> Result<()> {
    let slug = format!("{owner}/{repo}");
    let id = id.to_string();
    run_command_input(
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
    cwd: &str,
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
    let payload = github_inline_comment_payload(
        body, file_path, start_line, end_line, side, expected_head,
    );
    let input = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not encode GitHub inline comment: {error}"))?;
    run_command_input(
        cwd,
        "gh",
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        &[("GH_PROMPT_DISABLED", "1")],
        Some(&input),
    )?;
    Ok(())
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

fn merge_github(
    cwd: &str,
    owner: &str,
    repo: &str,
    id: u64,
    strategy: PullRequestMergeStrategy,
    expected_head: &str,
) -> Result<()> {
    let slug = format!("{owner}/{repo}");
    let id = id.to_string();
    run_command(
        cwd,
        "gh",
        &[
            "pr", "merge", &id, "--repo", &slug, github_merge_flag(strategy),
            "--match-head-commit", expected_head,
        ],
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
    )?;
    let values: Vec<Value> = serde_json::from_slice(&output)
        .map_err(|e| format!("Azure CLI returned invalid JSON: {e}"))?;
    let pull_requests = values
        .iter()
        .filter_map(|value| parse_azure_pr(value, &organization, &project, &repo))
        .collect();
    Ok(PullRequestList {
        repository: PullRequestRepository {
            provider: PullRequestProvider::AzureDevOps,
            remote,
            label: format!("{organization}/{project}/{repo}"),
        },
        pull_requests,
    })
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
        parse_azure_pr(value, &organization, &project, &repo).map(|pull_request| {
            PullRequestBranchMatch {
                repository: PullRequestRepository {
                    provider: PullRequestProvider::AzureDevOps,
                    remote,
                    label: format!("{organization}/{project}/{repo}"),
                },
                pull_request,
            }
        })
    }))
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
        url: format!(
            "https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{id}"
        ),
    })
}

fn detail_azure(
    cwd: &str,
    organization: String,
    project: String,
    repo: String,
    id: u64,
) -> Result<PullRequest> {
    let value = azure_pr_value(cwd, &organization, id)?;
    let mut pull_request = parse_azure_pr(&value, &organization, &project, &repo)
        .ok_or_else(|| format!("Azure CLI returned no data for PR #{id}"))?;
    pull_request.comments = azure_comments(cwd, &organization, &project, &repo, id)?;
    pull_request.comment_count = pull_request.comments.len();
    if let Ok(checks) = azure_policies(cwd, &organization, id) {
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
    let pull_request = parse_azure_pr(&value, &organization, &project, &repo)
        .ok_or_else(|| format!("Azure CLI returned no data for PR #{id}"))?;
    let comments = azure_comments(cwd, &organization, &project, &repo, id)?
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
) -> Result<Vec<PullRequestComment>> {
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
    Ok(parse_azure_comments(
        &value,
        &format!(
            "https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{id_text}"
        ),
    ))
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
    request.flush().map_err(|error| format!("Could not prepare Azure merge: {error}"))?;
    let request_path = request.path().to_str()
        .ok_or_else(|| "Azure merge request path is not valid UTF-8".to_string())?;
    let organization_url = format!("https://dev.azure.com/{organization}/");
    let project_arg = format!("project={project}");
    let repository_arg = format!("repositoryId={repo}");
    let pull_request_arg = format!("pullRequestId={id}");
    run_command(
        cwd,
        "az",
        &[
            "devops", "invoke", "--area", "git", "--resource", "pullRequests",
            "--route-parameters", &project_arg, &repository_arg, &pull_request_arg,
            "--organization", &organization_url, "--api-version", "7.1",
            "--http-method", "PATCH", "--in-file", request_path,
            "--media-type", "application/json", "--output", "json", "--only-show-errors",
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
    let files = local
        .diff_between(&base, &source_commit)
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
        return Err("Pull request source commit is missing or invalid; refresh the PR and try again".into());
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

fn parse_github_pr(value: &Value) -> Option<PullRequest> {
    let id = value.get("number")?.as_u64()?;
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
        id,
        title: text(value.get("title")).unwrap_or_default(),
        state: text(value.get("state"))
            .unwrap_or_else(|| "unknown".into())
            .to_lowercase(),
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        author: text(value.pointer("/author/login")).unwrap_or_else(|| "unknown".into()),
        source_branch: text(value.get("headRefName")).unwrap_or_default(),
        source_commit: text(value.get("headRefOid")).unwrap_or_default(),
        target_branch: text(value.get("baseRefName")).unwrap_or_default(),
        created_at: text(value.get("createdAt")).unwrap_or_default(),
        updated_at: text(value.get("updatedAt")).unwrap_or_default(),
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
        checks,
        checks_complete: value.get("statusCheckRollup").is_some(),
        comments,
        review_threads: Vec::new(),
    })
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
                .or_else(|| thread.get("originalLine").and_then(Value::as_u64))? as u32;
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
                    let author = text(comment.pointer("/author/login"))
                        .unwrap_or_else(|| "unknown".into());
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
                comments,
            })
        })
        .collect()
}

fn parse_azure_pr(
    value: &Value,
    organization: &str,
    project: &str,
    repo: &str,
) -> Option<PullRequest> {
    let id = value.get("pullRequestId")?.as_u64()?;
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
        id,
        title: text(value.get("title")).unwrap_or_default(),
        state: text(value.get("status"))
            .unwrap_or_else(|| "unknown".into())
            .to_lowercase(),
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        author: text(value.pointer("/createdBy/displayName")).unwrap_or_else(|| "unknown".into()),
        source_branch: branch_name(text(value.get("sourceRefName")).unwrap_or_default()),
        source_commit: text(value.pointer("/lastMergeSourceCommit/commitId")).unwrap_or_default(),
        target_branch: branch_name(text(value.get("targetRefName")).unwrap_or_default()),
        created_at: text(value.get("creationDate")).unwrap_or_default(),
        updated_at: text(value.get("closedDate")).unwrap_or_default(),
        url: format!("https://dev.azure.com/{organization}/{project}/_git/{repo}/pullrequest/{id}"),
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
        checks: Vec::new(),
        checks_complete: false,
        comments: Vec::new(),
        review_threads: Vec::new(),
    })
}

fn parse_azure_comments(value: &Value, pr_url: &str) -> Vec<PullRequestComment> {
    let threads = value
        .get("value")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    threads
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
            array(thread, "comments").iter().filter_map(move |comment| {
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
                let comment_id = comment.get("id").and_then(Value::as_u64).unwrap_or(0);
                Some(PullRequestComment {
                    id: format!("{thread_id}:{comment_id}"),
                    author: text(comment.pointer("/author/displayName"))
                        .unwrap_or_else(|| "unknown".into()),
                    avatar_url: text(comment.pointer("/author/imageUrl"))
                        .or_else(|| text(comment.pointer("/author/_links/avatar/href"))),
                    body,
                    created_at: text(comment.get("publishedDate")).unwrap_or_default(),
                    url: pr_url.to_string(),
                    is_system: text(comment.get("commentType"))
                        .is_some_and(|kind| kind.eq_ignore_ascii_case("system")),
                    path: path.clone(),
                })
            })
        })
        .collect()
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
        && login.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
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

fn parse_remote(url: &str) -> Option<HostRepo> {
    let trimmed = url.trim().trim_end_matches(".git").trim_end_matches('/');
    if let Some(rest) = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("git@github.com:"))
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
    {
        let mut parts = rest.split('/');
        return Some(HostRepo::GitHub {
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
        assert_eq!(parse_remote("git@gitlab.com:acme/web.git"), None);
        assert_eq!(parse_remote("https://bitbucket.org/acme/web.git"), None);
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
        assert!(ensure_source_branch_on_remote(
            local.to_str().unwrap(),
            "origin",
            "different"
        )
        .is_err());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn normalizes_github_and_azure_payloads() {
        let github: Value = serde_json::from_str(
            r#"{
              "number": 42, "title": "Ship it", "state": "OPEN", "isDraft": false,
              "author": {"login": "octo"}, "headRefName": "feature", "baseRefName": "main",
              "headRefOid": "1111111111111111111111111111111111111111",
              "comments": [{"id": "c"}], "commits": [{"oid": "a"}],
              "latestReviews": [{"author": {"login": "reviewer"}, "state": "APPROVED"}],
              "statusCheckRollup": [{"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}]
            }"#,
        )
        .unwrap();
        let github = parse_github_pr(&github).unwrap();
        assert_eq!(github.id, 42);
        assert_eq!(github.state, "open");
        assert_eq!(github.source_commit, "1111111111111111111111111111111111111111");
        assert_eq!(github.comment_count, 1);
        assert_eq!(github.comments.len(), 1);
        assert_eq!(github.reviewers[0].status, "APPROVED");
        assert_eq!(github.checks[0].status, "SUCCESS");

        let azure: Value = serde_json::from_str(
            r#"{
              "pullRequestId": 7, "title": "Azure PR", "status": "active", "isDraft": true,
              "createdBy": {"displayName": "Ada"}, "sourceRefName": "refs/heads/topic",
              "targetRefName": "refs/heads/main",
              "lastMergeSourceCommit": {"commitId": "2222222222222222222222222222222222222222"},
              "reviewers": [{"displayName": "Grace", "vote": 10, "isRequired": true}]
            }"#,
        )
        .unwrap();
        let azure = parse_azure_pr(&azure, "org", "project", "repo").unwrap();
        assert_eq!(azure.id, 7);
        assert_eq!(azure.source_branch, "topic");
        assert_eq!(azure.source_commit, "2222222222222222222222222222222222222222");
        assert_eq!(azure.review_status, "approved");
        assert!(azure.reviewers[0].required);
    }

    #[test]
    fn github_list_query_stays_shallow_and_auth_hints_are_specific() {
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
        let github = parse_github_pr(&github).unwrap();
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
    fn normalizes_github_review_threads_with_replies_and_ranges() {
        let value = serde_json::json!({
            "data": { "repository": { "pullRequest": { "reviewThreads": { "nodes": [{
                "id": "PRRT_1", "isResolved": false, "isOutdated": false,
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
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].path, "src/lib.rs");
        assert_eq!((threads[0].start_line, threads[0].end_line), (27, 29));
        assert_eq!(threads[0].side, PullRequestDiffSide::Additions);
        assert!(!threads[0].is_resolved);
        assert_eq!(threads[0].comments.len(), 2);
        assert_eq!(threads[0].comments[1].author, "ada");
        assert_eq!(threads[0].comments[0].path.as_deref(), Some("src/lib.rs"));
    }

    #[test]
    fn rejects_empty_and_oversized_comments() {
        assert!(validate_comment(" \n ").is_err());
        assert!(validate_comment("Looks good").is_ok());
        assert!(validate_comment(&"x".repeat(MAX_COMMENT_BYTES + 1)).is_err());
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
        assert_eq!(github_merge_flag(PullRequestMergeStrategy::MergeCommit), "--merge");
        assert_eq!(github_merge_flag(PullRequestMergeStrategy::Squash), "--squash");
        assert_eq!(azure_merge_strategy(PullRequestMergeStrategy::MergeCommit), "noFastForward");
        assert_eq!(azure_merge_strategy(PullRequestMergeStrategy::Rebase), "rebase");
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
}
