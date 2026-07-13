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

use serde::Serialize;
use serde_json::Value;
use strand_core::Repo;

use crate::ai::bin::{base_command, resolve_cli};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_COMMENT_BYTES: usize = 65_536;
const MAX_DIFF_BYTES: usize = 16 * 1024 * 1024;
const GITHUB_LIST_FIELDS: &str = concat!(
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,",
    "url,reviewDecision"
);
const GITHUB_DETAIL_FIELDS: &str = concat!(
    "number,title,state,isDraft,author,headRefName,baseRefName,createdAt,updatedAt,",
    "url,body,mergeStateStatus,reviewDecision,comments,commits,additions,deletions,",
    "changedFiles,reviewRequests,latestReviews,labels,statusCheckRollup"
);
type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestProvider {
    GitHub,
    AzureDevOps,
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
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub is_system: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequest {
    pub id: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub source_branch: String,
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
    pub comments: Vec<PullRequestComment>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestList {
    pub repository: PullRequestRepository,
    pub pull_requests: Vec<PullRequest>,
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

fn detail_github(cwd: &str, owner: String, repo: String, id: u64) -> Result<PullRequest> {
    let slug = format!("{owner}/{repo}");
    let id = id.to_string();
    let output = run_command(
        cwd,
        "gh",
        &[
            "pr",
            "view",
            &id,
            "--repo",
            &slug,
            "--json",
            GITHUB_DETAIL_FIELDS,
        ],
        &[("GH_PROMPT_DISABLED", "1")],
    )?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("GitHub CLI returned invalid JSON: {error}"))?;
    parse_github_pr(&value).ok_or_else(|| format!("GitHub CLI returned no data for PR #{id}"))
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
    Ok(pull_request)
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

fn parse_github_pr(value: &Value) -> Option<PullRequest> {
    let id = value.get("number")?.as_u64()?;
    let comments = array(value, "comments")
        .iter()
        .filter_map(|comment| {
            Some(PullRequestComment {
                id: text(comment.get("id"))?,
                author: text(comment.pointer("/author/login")).unwrap_or_else(|| "unknown".into()),
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
        comments,
    })
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
        comments: Vec::new(),
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
    fn normalizes_github_and_azure_payloads() {
        let github: Value = serde_json::from_str(
            r#"{
              "number": 42, "title": "Ship it", "state": "OPEN", "isDraft": false,
              "author": {"login": "octo"}, "headRefName": "feature", "baseRefName": "main",
              "comments": [{"id": "c"}], "commits": [{"oid": "a"}],
              "latestReviews": [{"author": {"login": "reviewer"}, "state": "APPROVED"}],
              "statusCheckRollup": [{"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"}]
            }"#,
        )
        .unwrap();
        let github = parse_github_pr(&github).unwrap();
        assert_eq!(github.id, 42);
        assert_eq!(github.state, "open");
        assert_eq!(github.comment_count, 1);
        assert_eq!(github.comments.len(), 1);
        assert_eq!(github.reviewers[0].status, "APPROVED");
        assert_eq!(github.checks[0].status, "SUCCESS");

        let azure: Value = serde_json::from_str(
            r#"{
              "pullRequestId": 7, "title": "Azure PR", "status": "active", "isDraft": true,
              "createdBy": {"displayName": "Ada"}, "sourceRefName": "refs/heads/topic",
              "targetRefName": "refs/heads/main",
              "reviewers": [{"displayName": "Grace", "vote": 10, "isRequired": true}]
            }"#,
        )
        .unwrap();
        let azure = parse_azure_pr(&azure, "org", "project", "repo").unwrap();
        assert_eq!(azure.id, 7);
        assert_eq!(azure.source_branch, "topic");
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
        assert_eq!(github.comments[0].body, "**Looks good**");

        let azure: Value = serde_json::from_str(
            r#"{"value":[{"id":9,"threadContext":{"filePath":"/src/lib.rs"},"comments":[
              {"id":1,"content":"Please rename this","commentType":"text","publishedDate":"2026-07-13T12:00:00Z","author":{"displayName":"Ada"}},
              {"id":2,"content":"Policy updated","commentType":"system","author":{"displayName":"Build Service"}}
            ]}]}"#,
        )
        .unwrap();
        let comments = parse_azure_comments(&azure, "https://dev.azure.com/acme/pr/7");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].path.as_deref(), Some("/src/lib.rs"));
        assert!(comments[1].is_system);
    }

    #[test]
    fn rejects_empty_and_oversized_comments() {
        assert!(validate_comment(" \n ").is_err());
        assert!(validate_comment("Looks good").is_ok());
        assert!(validate_comment(&"x".repeat(MAX_COMMENT_BYTES + 1)).is_err());
    }
}
