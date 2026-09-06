//! Explicit, bounded GitHub connection pages. No traversal on inbox focus.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

static READS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

pub struct ReadGuard {
    id: String,
    pub cancelled: Arc<AtomicBool>,
}
impl ReadGuard {
    pub fn new(id: &str) -> Result<Self> {
        Uuid::parse_str(id).map_err(|_| "Invalid read request ID".to_string())?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut reads = READS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Read lock failed")?;
        if reads.contains_key(id) {
            return Err("Read request already active".into());
        }
        reads.insert(id.into(), cancelled.clone());
        Ok(Self {
            id: id.into(),
            cancelled,
        })
    }
}
impl Drop for ReadGuard {
    fn drop(&mut self) {
        if let Ok(mut reads) = READS.get_or_init(Default::default).lock() {
            reads.remove(&self.id);
        }
    }
}
pub fn cancel(id: &str) {
    if let Ok(reads) = READS.get_or_init(Default::default).lock() {
        if let Some(cancelled) = reads.get(id) {
            cancelled.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Comments,
    Commits,
    Reviews,
    Threads,
    Replies,
    Checks,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub kind: Kind,
    pub thread_id: Option<String>,
    pub cursor: Option<String>,
    pub total: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Page {
    pub source_commit: String,
    pub request: Cursor,
    pub pending: Vec<Cursor>,
    pub comments: Vec<PullRequestComment>,
    pub commits: Vec<PullRequestCommit>,
    pub reviews: Vec<PullRequestReview>,
    pub review_threads: Vec<PullRequestReviewThread>,
    pub checks: Vec<PullRequestCheck>,
}

const INFO: &str = "totalCount pageInfo { hasNextPage endCursor }";
const COMMENT: &str = "id body createdAt url author { login avatarUrl }";
const REVIEW: &str =
    "id body state submittedAt url commit { oid } viewerCanUpdate viewerDidAuthor author { login avatarUrl }";
const CHECK: &str = "__typename ... on CheckRun { id databaseId name status conclusion } ... on StatusContext { id context state }";
const COMMIT: &str =
    "commit { oid messageHeadline committedDate url author { name avatarUrl user { login } } }";

fn connection(kind: Kind, after: &str) -> String {
    let (name, fields) = match kind {
        Kind::Comments | Kind::Replies => ("comments", COMMENT.to_string()),
        Kind::Reviews => ("reviews", REVIEW.to_string()),
        Kind::Commits => ("commits", COMMIT.to_string()),
        Kind::Checks => ("contexts", CHECK.to_string()),
        // Only the root comment per thread; replies have their own connection.
        Kind::Threads => ("reviewThreads", format!("id isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve path line startLine originalLine originalStartLine diffSide startDiffSide comments(first: 1) {{ {INFO} nodes {{ {COMMENT} }} }}")),
    };
    let field = format!("{name}(first: 50, after: {after}) {{ {INFO} nodes {{ {fields} }} }}");
    if kind == Kind::Checks {
        format!("statusCheckRollup {{ {field} }}")
    } else {
        field
    }
}

#[cfg(test)]
pub fn review_query_contract() -> String {
    format!(
        "viewerCanUpdate {} {}",
        connection(Kind::Threads, "null"),
        connection(Kind::Reviews, "null")
    )
}

/// Background snapshots keep bodies/patches out, but never truncate checks.
pub(super) fn activity_checks(
    cwd: &GitHubContext<'_>,
    owner: &str,
    repo: &str,
    id: u64,
    value: &mut Value,
) -> Result<()> {
    if value.get("statusCheckRollup") == Some(&Value::Null) {
        return Ok(());
    }
    let mut cursor = next_cursor(&value["statusCheckRollup"]["contexts"], None)?;
    let head = text(value.get("headRefOid")).ok_or("Missing GitHub head")?;
    let mut seen = std::collections::HashSet::new();
    while let Some(after) = cursor {
        if !seen.insert(after.clone()) {
            return Err("Repeated GitHub check cursor".into());
        }
        let field = connection(Kind::Checks, "$cursor");
        let query_text = format!("query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {{ repository(owner: $owner, name: $repo) {{ pullRequest(number: $number) {{ headRefOid {field} }} }} }}");
        let next = query(
            cwd,
            &query_text,
            serde_json::json!({"owner":owner,"repo":repo,"number":id,"cursor":after}),
            None,
        )?;
        let pr = &next["data"]["repository"]["pullRequest"];
        ensure_review_head(pr["headRefOid"].as_str().unwrap_or_default(), &head)?;
        let contexts = &pr["statusCheckRollup"]["contexts"];
        cursor = next_cursor(contexts, Some(&after))?;
        value["statusCheckRollup"]["contexts"]["nodes"]
            .as_array_mut()
            .ok_or("Missing check nodes")?
            .extend(array(contexts, "nodes").iter().cloned());
        value["statusCheckRollup"]["contexts"]["pageInfo"] = contexts["pageInfo"].clone();
    }
    if let Some(nodes) = value["statusCheckRollup"]["contexts"]["nodes"].as_array_mut() {
        let mut ids = std::collections::HashSet::new();
        nodes.retain(|c| parse_github_activity_check(c).is_some_and(|c| ids.insert(c.id)));
    }
    Ok(())
}

pub(super) fn query(
    cwd: &GitHubContext<'_>,
    query: &str,
    variables: Value,
    cancelled: Option<&AtomicBool>,
) -> Result<Value> {
    let input =
        serde_json::to_vec(&github_graphql_payload(query, variables)).map_err(|e| e.to_string())?;
    let output = run_command_input_cancellable(
        cwd.path,
        "gh",
        &["api", "graphql", "--hostname", cwd.host, "--method", "POST", "--input", "-"],
        &[("GH_PROMPT_DISABLED", "1"), ("GH_HOST", cwd.host)],
        Some(&input),
        cancelled,
    )?;
    let value: Value =
        serde_json::from_slice(&output).map_err(|e| format!("Invalid GitHub page: {e}"))?;
    if let Some(errors) = value
        .get("errors")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        return Err(format!(
            "GitHub page failed: {}",
            errors
                .iter()
                .filter_map(|e| e.get("message").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    Ok(value)
}

pub fn inbox(path: &str, cursor: Option<&str>, request_id: &str) -> Result<PullRequestList> {
    let guard = ReadGuard::new(request_id)?;
    let (remote, host) = host_for_path(path)?;
    let HostRepo::GitHub { host, owner, repo } = host else {
        if cursor.is_some() {
            return Err("Inbox pagination is unavailable for this provider".into());
        }
        return list(path);
    };
    let value = query(
        &GitHubContext { path, host: &host },
        r#"query($owner: String!, $repo: String!, $cursor: String) {
      viewer { login }
      repository(owner: $owner, name: $repo) {
        pullRequests(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes { number title state isDraft author { login } headRefName headRefOid baseRefName createdAt updatedAt closedAt mergedAt url reviewDecision additions deletions changedFiles }
        }
      }
    }"#,
        serde_json::json!({"owner":owner,"repo":repo,"cursor":cursor}),
        Some(&guard.cancelled),
    )?;
    let connection = value
        .pointer("/data/repository/pullRequests")
        .ok_or("Missing GitHub inbox")?;
    let next_cursor = next_cursor(connection, cursor)?;
    let viewer = text(value.pointer("/data/viewer/login"));
    let mut seen = std::collections::HashSet::new();
    Ok(PullRequestList {
        repository: PullRequestRepository {
            provider: PullRequestProvider::GitHub,
            remote,
            label: GitHubContext { path, host: &host }.slug(&owner, &repo),
            viewer: viewer.clone(),
        },
        pull_requests: array(connection, "nodes")
            .iter()
            .filter_map(|v| parse_github_pr(v, viewer.as_deref()))
            .filter(|pr| seen.insert(pr.id))
            .collect(),
        next_cursor,
        total_count: connection.get("totalCount").and_then(Value::as_u64),
    })
}

fn next_cursor(value: &Value, previous: Option<&str>) -> Result<Option<String>> {
    match value
        .pointer("/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
    {
        Some(false) => Ok(None),
        Some(true) => text(value.pointer("/pageInfo/endCursor"))
            .filter(|cursor| !cursor.is_empty() && Some(cursor.as_str()) != previous)
            .map(Some)
            .ok_or_else(|| "GitHub returned a missing or repeated cursor; refresh to retry".into()),
        None => Err("GitHub did not report whether this connection is complete".into()),
    }
}

const KINDS: [Kind; 5] = [
    Kind::Comments,
    Kind::Commits,
    Kind::Reviews,
    Kind::Threads,
    Kind::Checks,
];

pub(super) fn initial(cwd: &GitHubContext<'_>, owner: &str, repo: &str, pr: &mut PullRequest) {
    let fields = KINDS
        .iter()
        .map(|kind| connection(*kind, "null"))
        .collect::<Vec<_>>()
        .join(" ");
    let fields = format!("{} {fields}", completion::GITHUB_FIELDS);
    let query_text = format!("query($owner: String!, $repo: String!, $number: Int!) {{ repository(owner: $owner, name: $repo) {{ pullRequest(number: $number) {{ headRefOid viewerCanUpdate {fields} }} }} }}");
    let result = query(
        cwd,
        &query_text,
        serde_json::json!({"owner":owner,"repo":repo,"number":pr.id}),
        None,
    );
    if let Ok(value) = &result {
        pr.can_mark_ready = pr.is_draft && parse_github_can_mark_ready(value);
        pr.completion = Some(completion::github(&value["data"]["repository"]["pullRequest"]));
    }
    for kind in KINDS {
        let request = Cursor {
            kind,
            thread_id: None,
            cursor: None,
            total: None,
            error: None,
        };
        let page = result
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|value| parse_page(value, request.clone(), &pr.source_commit));
        match page {
            Ok(page) => {
                pr.comments.extend(page.comments);
                pr.commits.extend(page.commits);
                pr.reviews.extend(page.reviews);
                pr.review_threads.extend(page.review_threads);
                pr.checks.extend(page.checks);
                pr.data_pages.extend(page.pending);
            }
            Err(error) => pr.data_pages.push(Cursor {
                error: Some(error),
                ..request
            }),
        }
    }
    pr.comments.extend(
        pr.review_threads
            .iter()
            .flat_map(|t| t.comments.iter().cloned()),
    );
    let mut seen = std::collections::HashSet::new();
    pr.comments.retain(|c| seen.insert(c.id.clone()));
    pr.comment_count = pr.comments.len();
    pr.commit_count = pr.commits.len();
    pr.checks_complete = !pr.data_pages.iter().any(|p| p.kind == Kind::Checks);
}

pub fn read(
    path: &str,
    id: u64,
    expected_head: &str,
    request: Cursor,
    request_id: &str,
) -> Result<Page> {
    let guard = ReadGuard::new(request_id)?;
    read_cancellable(path, id, expected_head, request, &guard.cancelled)
}

pub fn read_cancellable(path: &str, id: u64, expected_head: &str, request: Cursor, cancelled: &AtomicBool) -> Result<Page> {
    validate_commit(expected_head)?;
    let (_, host) = host_for_path(path)?;
    let HostRepo::GitHub { host, owner, repo } = host else {
        return Err("Connection pages are unavailable for this provider".into());
    };
    let field = connection(request.kind, "$cursor");
    let selection = if request.kind == Kind::Replies {
        validate_thread_id(request.thread_id.as_deref().unwrap_or_default())?;
        format!("node(id: $threadId) {{ ... on PullRequestReviewThread {{ pullRequest {{ number repository {{ nameWithOwner }} }} {field} }} }}")
    } else {
        String::new()
    };
    let thread_variable = if request.kind == Kind::Replies {
        ", $threadId: ID!"
    } else {
        ""
    };
    let pr_field = if request.kind == Kind::Replies {
        ""
    } else {
        &field
    };
    let query_text = format!("query($owner: String!, $repo: String!, $number: Int!, $cursor: String{thread_variable}) {{ repository(owner: $owner, name: $repo) {{ pullRequest(number: $number) {{ headRefOid viewerCanUpdate {pr_field} }} }} {selection} }}");
    let value = query(
        &GitHubContext { path, host: &host },
        &query_text,
        serde_json::json!({"owner":owner,"repo":repo,"number":id,"cursor":request.cursor,"threadId":request.thread_id}),
        Some(cancelled),
    )?;
    if request.kind == Kind::Replies
        && (value
            .pointer("/data/node/pullRequest/number")
            .and_then(Value::as_u64)
            != Some(id)
            || text(value.pointer("/data/node/pullRequest/repository/nameWithOwner")).as_deref()
                != Some(format!("{owner}/{repo}").as_str()))
    {
        return Err("Thread does not belong to this pull request".into());
    }
    let mut page = parse_page(&value, request, expected_head)?;
    scope_page(&mut page, &GitHubContext { path, host: &host }, &owner, &repo);
    Ok(page)
}

fn scope_page(page: &mut Page, context: &GitHubContext<'_>, owner: &str, repo: &str) {
    for commit in &mut page.commits {
        commit.url = Some(format!("https://{}/{owner}/{repo}/commit/{}", context.host, commit.id));
        context.scope_avatar(&mut commit.avatar_url);
    }
    for comment in &mut page.comments { context.scope_avatar(&mut comment.avatar_url); }
    for review in &mut page.reviews { context.scope_avatar(&mut review.avatar_url); }
    for thread in &mut page.review_threads {
        for comment in &mut thread.comments { context.scope_avatar(&mut comment.avatar_url); }
    }
}

fn parse_page(value: &Value, request: Cursor, expected_head: &str) -> Result<Page> {
    let pr = value
        .pointer("/data/repository/pullRequest")
        .ok_or("Missing GitHub pull request")?;
    let head = text(pr.get("headRefOid")).ok_or("Missing GitHub head")?;
    ensure_review_head(&head, expected_head)?;
    let key = match request.kind {
        Kind::Comments => "/comments",
        Kind::Commits => "/commits",
        Kind::Reviews => "/reviews",
        Kind::Threads => "/reviewThreads",
        Kind::Checks => "/statusCheckRollup/contexts",
        Kind::Replies => "",
    };
    let empty_checks =
        serde_json::json!({"nodes":[],"pageInfo":{"hasNextPage":false},"totalCount":0});
    let connection = if request.kind == Kind::Replies {
        value.pointer("/data/node/comments")
    } else if request.kind == Kind::Checks && pr.get("statusCheckRollup") == Some(&Value::Null) {
        Some(&empty_checks)
    } else {
        pr.pointer(key)
    }
    .ok_or("Missing GitHub connection; loaded data is incomplete")?;
    let mut pending = Vec::new();
    if let Some(cursor) = next_cursor(connection, request.cursor.as_deref())? {
        pending.push(Cursor {
            cursor: Some(cursor),
            total: connection.get("totalCount").and_then(Value::as_u64),
            error: None,
            ..request.clone()
        });
    }
    let mut page = Page {
        source_commit: head,
        request: request.clone(),
        pending,
        comments: vec![],
        commits: vec![],
        reviews: vec![],
        review_threads: vec![],
        checks: vec![],
    };
    match request.kind {
        Kind::Reviews => page.reviews = parse_github_reviews(value),
        Kind::Threads => {
            page.review_threads = parse_github_review_threads(value);
            for thread in array(connection, "nodes") {
                if let Some(cursor) = next_cursor(&thread["comments"], None)? {
                    page.pending.push(Cursor {
                        kind: Kind::Replies,
                        thread_id: text(thread.get("id")),
                        cursor: Some(cursor),
                        total: thread
                            .pointer("/comments/totalCount")
                            .and_then(Value::as_u64),
                        error: None,
                    });
                }
            }
        }
        Kind::Comments | Kind::Replies => {
            let mock = serde_json::json!({"number":1,"comments":connection["nodes"]});
            page.comments = parse_github_pr(&mock, None).unwrap().comments;
        }
        Kind::Checks => {
            page.checks = array(connection, "nodes")
                .iter()
                .filter_map(parse_github_activity_check)
                .map(|c| PullRequestCheck {
                    id: c.id,
                    name: c.name,
                    status: c.status,
                })
                .collect()
        }
        Kind::Commits => {
            page.commits = array(connection, "nodes")
                .iter()
                .filter_map(|node| {
                    let c = &node["commit"];
                    Some(PullRequestCommit {
                        id: text(c.get("oid"))?,
                        title: text(c.get("messageHeadline")).unwrap_or_default(),
                        author: text(c.pointer("/author/name")).unwrap_or_else(|| "unknown".into()),
                        avatar_url: text(c.pointer("/author/avatarUrl")),
                        committed_at: text(c.get("committedDate")).unwrap_or_default(),
                        url: text(c.get("url")),
                    })
                })
                .collect()
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enterprise_commit_pages_keep_links_and_avatars_on_the_selected_host() {
        let head = "a".repeat(40);
        let value = serde_json::json!({"data":{"repository":{"pullRequest":{
            "headRefOid":head,"commits":{"nodes":[{"commit":{"oid":head,
                "author":{"name":"Reviewer","avatarUrl":"https://github.com/reviewer.png"}}}],
                "pageInfo":{"hasNextPage":false}}
        }}}});
        let request = Cursor { kind: Kind::Commits, thread_id: None, cursor: None, total: None, error: None };
        let mut page = parse_page(&value, request, &head).unwrap();
        scope_page(&mut page, &GitHubContext { path: ".", host: "git.example:8443" }, "team", "app");
        assert_eq!(page.commits[0].url.as_deref(), Some(format!("https://git.example:8443/team/app/commit/{head}").as_str()));
        assert_eq!(page.commits[0].avatar_url.as_deref(), Some("https://git.example:8443/reviewer.png"));
    }

    #[test]
    fn missing_or_repeated_cursor_is_an_error() {
        assert!(next_cursor(&serde_json::json!({}), None).is_err());
        assert!(next_cursor(
            &serde_json::json!({"pageInfo":{"hasNextPage":true,"endCursor":"same"}}),
            Some("same")
        )
        .is_err());
        assert_eq!(
            next_cursor(&serde_json::json!({"pageInfo":{"hasNextPage":false}}), None).unwrap(),
            None
        );
    }
    #[test]
    fn cancellation_is_scoped_and_removed() {
        let id = Uuid::new_v4().to_string();
        let guard = ReadGuard::new(&id).unwrap();
        assert!(ReadGuard::new(&id).is_err());
        cancel(&id);
        assert!(guard.cancelled.load(Ordering::Relaxed));
        drop(guard);
        assert!(!ReadGuard::new(&id)
            .unwrap()
            .cancelled
            .load(Ordering::Relaxed));
    }
    #[test]
    fn thread_pages_keep_nested_reads_shallow() {
        let query = connection(Kind::Threads, "$cursor");
        assert!(query.contains("comments(first: 1)"));
        assert!(query.contains("after: $cursor"));
    }

    #[test]
    fn all_connections_traverse_101_entries_and_reject_force_push() {
        let head = "a".repeat(40);
        for kind in [
            Kind::Comments,
            Kind::Reviews,
            Kind::Threads,
            Kind::Replies,
            Kind::Checks,
            Kind::Commits,
        ] {
            let mut count = 0;
            let mut cursor = None;
            for (start, end) in [(0, 50), (50, 100), (100, 101)] {
                let nodes = (start..end).map(|i| serde_json::json!({
                    "id":format!("node-{i}"),"body":"feedback","state":"APPROVED","author":{"login":"reviewer"},
                    "path":"file.rs","line":i+1,"diffSide":"RIGHT", "name":format!("check-{i}"),"status":"SUCCESS",
                    "comments":{"nodes":[{"id":format!("comment-{i}"),"body":"feedback"}],"pageInfo":{"hasNextPage":false}},
                    "commit":{"oid":format!("{i:040x}"),"messageHeadline":"Commit"}
                })).collect::<Vec<_>>();
                let connection = serde_json::json!({"nodes":nodes,"totalCount":101,"pageInfo":{"hasNextPage":end<101,"endCursor":end.to_string()}});
                let mut value =
                    serde_json::json!({"data":{"repository":{"pullRequest":{"headRefOid":head}}}});
                let pr = &mut value["data"]["repository"]["pullRequest"];
                match kind {
                    Kind::Comments => pr["comments"] = connection,
                    Kind::Commits => pr["commits"] = connection,
                    Kind::Reviews => pr["reviews"] = connection,
                    Kind::Threads => pr["reviewThreads"] = connection,
                    Kind::Checks => {
                        pr["statusCheckRollup"] = serde_json::json!({"contexts":connection})
                    }
                    Kind::Replies => {
                        value["data"]["node"] = serde_json::json!({"comments":connection})
                    }
                }
                let request = Cursor {
                    kind,
                    thread_id: None,
                    cursor,
                    total: None,
                    error: None,
                };
                assert!(parse_page(&value, request.clone(), &"b".repeat(40)).is_err());
                let page = parse_page(&value, request, &head).unwrap();
                count += page.comments.len()
                    + page.commits.len()
                    + page.reviews.len()
                    + page.review_threads.len()
                    + page.checks.len();
                cursor = page.pending.first().and_then(|p| p.cursor.clone());
            }
            assert_eq!(count, 101, "{kind:?}");
            assert!(cursor.is_none());
        }
    }

    #[test]
    fn cancellation_terminates_an_active_read() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            signal.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        #[cfg(windows)]
        let result = run_command_input_cancellable(
            ".",
            "powershell",
            &["-NoProfile", "-Command", "Start-Sleep -Seconds 20"],
            &[],
            None,
            Some(&cancelled),
        );
        #[cfg(not(windows))]
        let result =
            run_command_input_cancellable(".", "sleep", &["20"], &[], None, Some(&cancelled));
        worker.join().unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
