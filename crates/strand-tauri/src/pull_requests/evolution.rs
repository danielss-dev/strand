//! Immutable review boundaries and validated local application of hosted feedback.
use super::*;
use base64::Engine;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize)]
pub struct Boundary {
    pub head: String,
    pub label: String,
    pub iteration: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct Comparison {
    pub from: String,
    pub to: String,
    pub history_rewritten: bool,
    pub diffs: Vec<strand_core::diff::FileDiff>,
}

#[derive(Debug, Serialize)]
pub struct Feedback {
    pub source_commit: String,
    pub threads: Vec<PullRequestReviewThread>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuggestionRequest {
    pub thread_id: String,
    pub comment_id: String,
    pub suggestion_index: usize,
    pub expected_head: String,
    pub expected_body: String,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
pub struct SuggestionPreview {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub before: String,
    pub after: String,
    pub expected_file: String,
}

fn current_head(path: &str, host: &HostRepo, id: u64) -> Result<String> {
    match host {
        HostRepo::GitHub { owner, repo } => github_current_head(path, owner, repo, id),
        HostRepo::Azure { organization, .. } => {
            text(azure_pr_value(path, organization, id)?.pointer("/lastMergeSourceCommit/commitId"))
                .ok_or("Azure returned no source commit".into())
        }
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => text(
            server_show(*profile_id, project, repo, id)?.pointer("/lastMergeSourceCommit/commitId"),
        )
        .ok_or("Azure Server returned no source commit".into()),
    }
}

fn iterations(path: &str, host: &HostRepo, id: u64) -> Result<Value> {
    match host {
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => azure_invoke_json(
            path,
            organization,
            "pullRequestIterations",
            &[
                format!("project={project}"),
                format!("repositoryId={repo}"),
                format!("pullRequestId={id}"),
            ],
            &[],
        ),
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => server_execute(
            *profile_id,
            AzdoOperation::PullRequestIterations {
                project: project.clone(),
                repository: repo.clone(),
                id,
            },
        ),
        _ => Err("This provider has no iterations".into()),
    }
}

pub fn boundaries(path: &str, id: u64, head: &str, request_id: &str) -> Result<Vec<Boundary>> {
    validate_commit(head)?;
    let guard = pages::ReadGuard::new(request_id)?;
    let (_, host) = host_for_path(path)?;
    ensure_review_head(&current_head(path, &host, id)?, head)?;
    check_cancelled(&guard.cancelled)?;
    let mut result = Vec::new();
    match host {
        HostRepo::GitHub { .. } => {
            let mut request = pages::Cursor {
                kind: pages::Kind::Reviews,
                thread_id: None,
                cursor: None,
                total: None,
                error: None,
            };
            let mut cursors = std::collections::HashSet::new();
            loop {
                let page = pages::read_cancellable(path, id, head, request, &guard.cancelled)?;
                result.extend(page.reviews.into_iter().filter_map(|review| {
                    Some(Boundary {
                        head: review.source_commit?,
                        label: format!(
                            "{} · {} · {}",
                            review.author, review.state, review.submitted_at
                        ),
                        iteration: None,
                    })
                }));
                let Some(next) = page.pending.into_iter().next() else {
                    break;
                };
                if !cursors.insert(next.cursor.clone()) {
                    return Err("Repeated review cursor".into());
                }
                request = next;
            }
        }
        _ => {
            let value = iterations(path, &host, id)?;
            azure_latest_iteration(&value, head)?;
            result.extend(
                value
                    .as_array()
                    .or_else(|| value.get("value").and_then(Value::as_array))
                    .into_iter()
                    .flatten()
                    .filter_map(|iteration| {
                        let number = u32::try_from(iteration.get("id")?.as_u64()?).ok()?;
                        Some(Boundary {
                            head: text(iteration.pointer("/sourceRefCommit/commitId"))?,
                            label: format!(
                                "Iteration {number} · {}",
                                text(iteration.get("createdDate")).unwrap_or_default()
                            ),
                            iteration: Some(number),
                        })
                    }),
            );
        }
    }
    let mut seen = std::collections::HashSet::new();
    result.retain(|boundary| seen.insert(boundary.head.clone()));
    check_cancelled(&guard.cancelled)?;
    Ok(result)
}

pub fn compare(path: &str, id: u64, from: &str, head: &str) -> Result<Comparison> {
    validate_commit(from)?;
    validate_commit(head)?;
    let (remote, host) = host_for_path(path)?;
    ensure_review_head(&current_head(path, &host, id)?, head)?;
    let local = Repo::discover(path).map_err(|e| e.to_string())?;
    if local.diff_between(head, head).is_err() {
        prepare_checkout(path, id, head)?;
    }
    if local.diff_between(from, from).is_err() {
        local.fetch_refs_for_read(&remote, &[from]).map_err(|e| format!("The reviewed commit is unavailable after a rebase or force push. Its boundary is preserved; fetch that exact commit if the provider still retains it. {e}"))?;
    }
    compare_local(&local, from, head)
}

fn compare_local(local: &Repo, from: &str, head: &str) -> Result<Comparison> {
    let diffs = local.diff_between(from, head).map_err(|e| e.to_string())?;
    if diffs.iter().map(|d| d.patch.len()).sum::<usize>() > MAX_DIFF_BYTES {
        return Err("Review comparison exceeds the 16 MB display limit".into());
    }
    Ok(Comparison {
        from: from.into(),
        to: head.into(),
        history_rewritten: local.merge_base(from, head).ok().as_deref() != Some(from),
        diffs,
    })
}

/// Explicit feedback export/preview may exhaust discussion pages. Inbox and
/// background reads never enter this path. Stop at any error, not a partial export.
fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err("Read cancelled".into())
    } else {
        Ok(())
    }
}

fn discussion(path: &str, id: u64, head: &str, request_id: &str) -> Result<Feedback> {
    let guard = pages::ReadGuard::new(request_id)?;
    let (_, host) = host_for_path(path)?;
    let mut threads;
    if matches!(host, HostRepo::GitHub { .. }) {
        threads = Vec::<PullRequestReviewThread>::new();
        let mut pending = std::collections::VecDeque::from([pages::Cursor {
            kind: pages::Kind::Threads,
            thread_id: None,
            cursor: None,
            total: None,
            error: None,
        }]);
        let mut seen = std::collections::HashSet::new();
        while let Some(request) = pending.pop_front() {
            check_cancelled(&guard.cancelled)?;
            if !seen.insert(format!(
                "{:?}:{:?}:{:?}",
                request.kind, request.thread_id, request.cursor
            )) {
                return Err("Repeated discussion cursor".into());
            }
            let page = pages::read_cancellable(path, id, head, request.clone(), &guard.cancelled)?;
            pending.extend(page.pending);
            merge_discussion(
                &mut threads,
                page.review_threads,
                request.thread_id.as_deref(),
                page.comments,
            )?;
            if threads
                .iter()
                .flat_map(|t| &t.comments)
                .map(|c| c.body.len())
                .sum::<usize>()
                > MAX_DIFF_BYTES
            {
                return Err("Feedback exceeds the 16 MB export limit".into());
            }
        }
    } else {
        let pr = detail(path, id)?;
        ensure_review_head(&pr.source_commit, head)?;
        threads = pr.review_threads;
    }
    check_cancelled(&guard.cancelled)?;
    if threads
        .iter()
        .flat_map(|t| &t.comments)
        .map(|c| c.body.len())
        .sum::<usize>()
        > MAX_DIFF_BYTES
    {
        return Err("Feedback exceeds the 16 MB export limit".into());
    }
    ensure_review_head(&current_head(path, &host, id)?, head)?;
    check_cancelled(&guard.cancelled)?;
    Ok(Feedback {
        source_commit: head.into(),
        threads,
    })
}

fn merge_discussion(
    threads: &mut Vec<PullRequestReviewThread>,
    incoming: Vec<PullRequestReviewThread>,
    reply_to: Option<&str>,
    comments: Vec<PullRequestComment>,
) -> Result<()> {
    for mut thread in incoming {
        if let Some(existing) = threads.iter_mut().find(|t| t.id == thread.id) {
            let mut ids = thread
                .comments
                .iter()
                .map(|c| c.id.clone())
                .collect::<std::collections::HashSet<_>>();
            thread.comments.extend(
                existing
                    .comments
                    .drain(..)
                    .filter(|c| ids.insert(c.id.clone())),
            );
            *existing = thread;
        } else {
            threads.push(thread);
        }
    }
    if let Some(id) = reply_to {
        let thread = threads
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or("Reply page has no loaded thread")?;
        let mut ids = thread
            .comments
            .iter()
            .map(|c| c.id.clone())
            .collect::<std::collections::HashSet<_>>();
        thread.comments.extend(
            comments
                .into_iter()
                .filter(|c| ids.insert(c.id.clone()))
                .map(|mut c| {
                    c.path = Some(thread.path.clone());
                    c
                }),
        );
    }
    Ok(())
}

pub fn feedback(path: &str, id: u64, head: &str, request_id: &str) -> Result<Feedback> {
    validate_commit(head)?;
    let mut feedback = discussion(path, id, head, request_id)?;
    feedback
        .threads
        .retain(|t| !t.is_resolved && t.comments.iter().any(|c| !c.is_system));
    Ok(feedback)
}

/// Standard provider suggestion fences only. No guessed offset semantics.
pub fn suggestions(body: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut fence: Option<(usize, bool, Vec<&str>)> = None;
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some((width, wanted, lines)) = &mut fence {
            if trimmed.len() >= *width && trimmed.chars().all(|c| c == '`') {
                if *wanted {
                    result.push(if lines.is_empty() {
                        String::new()
                    } else {
                        lines.join("\n") + "\n"
                    });
                }
                fence = None;
            } else {
                lines.push(line);
            }
        } else {
            let width = trimmed.chars().take_while(|c| *c == '`').count();
            if width >= 3 {
                fence = Some((width, trimmed[width..].trim() == "suggestion", Vec::new()));
            }
        }
    }
    result
}

fn suggestion_content(
    path: &str,
    id: u64,
    request: &SuggestionRequest,
    request_id: &str,
) -> Result<(SuggestionPreview, String)> {
    validate_commit(&request.expected_head)?;
    validate_comment(&request.expected_body)?;
    let pr = discussion(path, id, &request.expected_head, request_id)?;
    let thread = pr
        .threads
        .iter()
        .find(|t| t.id == request.thread_id)
        .ok_or("Review thread no longer exists")?;
    if !thread.suggestion_range_valid
        || thread.is_resolved
        || thread.is_outdated
        || thread.side != PullRequestDiffSide::Additions
    {
        return Err("Only unresolved suggestions with an unambiguous full-line range on the current source can be applied".into());
    }
    let (_, host) = host_for_path(path)?;
    if !matches!(host, HostRepo::GitHub { .. }) {
        let current =
            azure_latest_iteration(&iterations(path, &host, id)?, &request.expected_head)?;
        if thread.iteration_id != Some(current) {
            return Err("Suggestion belongs to an older or unknown Azure iteration; ask for feedback on the current iteration".into());
        }
    }
    let comment = thread
        .comments
        .iter()
        .find(|c| c.id == request.comment_id)
        .ok_or("Suggestion comment no longer exists")?;
    if comment.body != request.expected_body {
        return Err("Suggestion changed since preview; reload feedback".into());
    }
    let replacement = suggestions(&comment.body)
        .get(request.suggestion_index)
        .cloned()
        .ok_or("Standard suggestion block no longer exists")?;
    let local = Repo::discover(path).map_err(|e| e.to_string())?;
    let expected = clean_source_file(&local, &thread.path, &request.expected_head)?;
    let (before, content) =
        replace_lines(&expected, thread.start_line, thread.end_line, &replacement)?;
    Ok((
        SuggestionPreview {
            path: thread.path.clone(),
            start_line: thread.start_line,
            end_line: thread.end_line,
            before,
            after: replacement,
            expected_file: expected,
        },
        content,
    ))
}

pub fn preview(
    path: &str,
    id: u64,
    request: &SuggestionRequest,
    request_id: &str,
) -> Result<SuggestionPreview> {
    suggestion_content(path, id, request, request_id).map(|(preview, _)| preview)
}

pub fn apply(
    path: &str,
    id: u64,
    request: &SuggestionRequest,
    expected_preview: &SuggestionPreview,
    request_id: &str,
) -> Result<String> {
    let (preview, content) = suggestion_content(path, id, request, request_id)?;
    if &preview != expected_preview {
        return Err(
            "File or suggestion coordinates changed since preview; preview the suggestion again"
                .into(),
        );
    }
    let local = Repo::discover(path).map_err(|e| e.to_string())?;
    let (_, host) = host_for_path(path)?;
    ensure_review_head(&current_head(path, &host, id)?, &request.expected_head)?;
    apply_local(
        &local,
        &preview.path,
        &request.expected_head,
        &expected_preview.expected_file,
        &content,
    )?;
    Ok(preview.path)
}

fn clean_source_file(local: &Repo, file: &str, head: &str) -> Result<String> {
    if file.is_empty()
        || file.contains(':')
        || file.starts_with(['/', '\\'])
        || file
            .split(['/', '\\'])
            .any(|p| p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err("Suggestion path must be a file inside the working tree".into());
    }
    if local.meta().map_err(|e| e.to_string())?.head_oid.as_deref() != Some(head) {
        return Err("Open the PR's exact head in a worktree before applying suggestions".into());
    }
    let base = local
        .file_content(file, Some(head))
        .map_err(|e| e.to_string())?;
    let working = local.file_content(file, None).map_err(|e| e.to_string())?;
    if !base.editable || !working.editable || base.truncated || working.truncated {
        return Err("Suggestion requires a complete UTF-8 text file".into());
    }
    let index = local
        .file_blob(file, strand_core::file::BlobSource::Index)
        .map_err(|e| e.to_string())?;
    let index_bytes = base64::engine::general_purpose::STANDARD
        .decode(index.base64)
        .map_err(|e| e.to_string())?;
    if index.too_large || index_bytes != base.text.as_bytes() {
        return Err(
            "File has staged changes; preserve them before applying this suggestion".into(),
        );
    }
    if working.text.replace("\r\n", "\n") != base.text.replace("\r\n", "\n") {
        return Err("File has local changes; preserve them before applying this suggestion".into());
    }
    Ok(working.text)
}

fn apply_local(local: &Repo, file: &str, head: &str, expected: &str, content: &str) -> Result<()> {
    if clean_source_file(local, file, head)? != expected {
        return Err("File changed since preview".into());
    }
    local
        .write_file_content(file, expected, content)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn replace_lines(text: &str, start: u32, end: u32, replacement: &str) -> Result<(String, String)> {
    let lines = text.split_inclusive('\n').collect::<Vec<_>>();
    if start == 0 || end < start || end as usize > lines.len() {
        return Err("Suggestion range is outside the current file".into());
    }
    let before = lines[start as usize - 1..end as usize].concat();
    let crlf = text.contains("\r\n") && text.matches("\r\n").count() == text.matches('\n').count();
    let eol = if crlf { "\r\n" } else { "\n" };
    let mut after = replacement.replace("\r\n", "\n").replace('\n', eol);
    if !after.is_empty() && !after.ends_with(eol) && before.ends_with('\n') {
        after.push_str(eol);
    }
    if !before.ends_with('\n') && after.ends_with(eol) {
        after.truncate(after.len() - eol.len());
    }
    Ok((
        before,
        format!(
            "{}{}{}",
            lines[..start as usize - 1].concat(),
            after,
            lines[end as usize..].concat()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    fn git(path: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().into()
    }
    #[test]
    fn suggestions_preserve_ranges_newlines_and_reject_ambiguous_fences() {
        assert_eq!(
            suggestions("```text\n```suggestion\nno\n```\n"),
            Vec::<String>::new()
        );
        assert_eq!(
            suggestions("```suggestion\nx\ny\n```\n```suggestion\n```"),
            vec!["x\ny\n", ""]
        );
        assert!(suggestions("```suggestion:-1+2\nx\n```").is_empty());
        assert!(suggestions("```suggestion\nunterminated").is_empty());
        assert_eq!(
            replace_lines("a\r\nb\r\nc\r\n", 2, 2, "x\ny").unwrap().1,
            "a\r\nx\r\ny\r\nc\r\n"
        );
        assert_eq!(replace_lines("a\nb", 2, 2, "x").unwrap().1, "a\nx");
        assert_eq!(replace_lines("a\nb\nc\n", 2, 2, "").unwrap().1, "a\nc\n");
        assert!(replace_lines("a\n", 0, 1, "x").is_err());
        assert!(replace_lines("a\n", 1, 2, "x").is_err());
    }
    #[test]
    fn discussion_pages_keep_101_replies_and_file_feedback_with_safe_coordinates() {
        let value = serde_json::json!({ "data": { "repository": { "pullRequest": { "reviewThreads": { "nodes": [
            { "id": "T", "path": "file.txt", "line": 2, "diffSide": "RIGHT", "comments": { "nodes": [{ "id": "0", "body": "root" }] } },
            { "id": "F", "path": "file.txt", "comments": { "nodes": [{ "id": "file", "body": "file feedback" }] } }
        ] } } } } });
        let parsed = parse_github_review_threads(&value);
        assert!(parsed[0].suggestion_range_valid);
        assert!(!parsed[1].suggestion_range_valid);
        assert_eq!(parsed[1].end_line, 0);
        let mut threads = Vec::new();
        merge_discussion(&mut threads, parsed.clone(), None, Vec::new()).unwrap();
        let replies = (0..101)
            .map(|i| {
                let mut comment = parsed[0].comments[0].clone();
                comment.id = i.to_string();
                comment
            })
            .collect::<Vec<_>>();
        merge_discussion(&mut threads, Vec::new(), Some("T"), replies.clone()).unwrap();
        merge_discussion(&mut threads, parsed, Some("T"), replies).unwrap();
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].comments.len(), 101);
        assert_eq!(threads[0].comments[100].path.as_deref(), Some("file.txt"));
        assert!(merge_discussion(&mut threads, Vec::new(), Some("missing"), Vec::new()).is_err());
        assert!(check_cancelled(&AtomicBool::new(true)).is_err());
    }

    #[test]
    fn provider_boundaries_and_ambiguous_ranges_are_not_guessed() {
        let mut value = serde_json::json!({ "data": { "repository": { "pullRequest": {
            "reviews": { "nodes": [{ "id": "R", "commit": { "oid": "a".repeat(40) } }] },
            "reviewThreads": { "nodes": [{ "id": "T", "path": "file.txt", "line": 3, "startLine": 2, "startDiffSide": "LEFT", "diffSide": "RIGHT", "comments": { "nodes": [{ "id": "C", "body": "feedback" }] } }] }
        } } } });
        assert_eq!(
            parse_github_reviews(&value)[0].source_commit.as_deref(),
            Some("a".repeat(40).as_str())
        );
        assert!(!parse_github_review_threads(&value)[0].suggestion_range_valid);
        value["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0]["startDiffSide"] =
            "RIGHT".into();
        assert!(parse_github_review_threads(&value)[0].suggestion_range_valid);
        value["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0]["startLine"] = Value::Null;
        value["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0]["originalStartLine"] = 99.into();
        assert_eq!(parse_github_review_threads(&value)[0].start_line, 3);
        let mut azure = serde_json::json!({ "value": [{ "id": 1, "status": "active", "threadContext": { "filePath": "/file.txt", "rightFileStart": { "line": 2, "offset": 1 }, "rightFileEnd": { "line": 3, "offset": 1 } }, "pullRequestThreadContext": { "iterationContext": { "secondComparingIteration": 3 } }, "comments": [{ "id": 1, "content": "feedback", "commentType": "text" }] }] });
        let parsed = parse_azure_review_threads(&azure, "https://example.test/pr/1", 1);
        assert_eq!(parsed[0].iteration_id, Some(3));
        assert!(parsed[0].suggestion_range_valid);
        azure["value"][0]["threadContext"]["rightFileEnd"]["offset"] = 12.into();
        assert!(
            !parse_azure_review_threads(&azure, "https://example.test/pr/1", 1)[0]
                .suggestion_range_valid
        );
        assert_eq!(
            replace_lines("a\nb\n", 2, 2, &suggestions("```suggestion\n\n```")[0])
                .unwrap()
                .1,
            "a\n\n"
        );
    }
    #[test]
    fn local_apply_checks_head_index_worktree_and_preserves_crlf() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["config", "user.name", "Fixture"]);
        git(path, &["config", "user.email", "fixture@example.test"]);
        git(path, &["config", "commit.gpgsign", "false"]);
        git(path, &["config", "core.autocrlf", "false"]);
        std::fs::write(path.join("file.txt"), "a\r\nb\r\n").unwrap();
        git(path, &["add", "."]);
        git(path, &["commit", "-qm", "initial"]);
        let head = git(path, &["rev-parse", "HEAD"]);
        let local = Repo::discover(path).unwrap();
        let expected = clean_source_file(&local, "file.txt", &head).unwrap();
        assert!(clean_source_file(&local, "../file.txt", &head).is_err());
        assert!(clean_source_file(&local, ".git/config", &head).is_err());
        assert!(clean_source_file(&local, "file.txt", &"b".repeat(40)).is_err());
        std::fs::write(path.join("file.txt"), "dirty\n").unwrap();
        assert!(clean_source_file(&local, "file.txt", &head).is_err());
        git(path, &["add", "."]);
        std::fs::write(path.join("file.txt"), &expected).unwrap();
        let local = Repo::discover(path).unwrap();
        assert!(clean_source_file(&local, "file.txt", &head).is_err());
        git(path, &["reset", "-q", "HEAD", "--", "file.txt"]);
        let local = Repo::discover(path).unwrap();
        let (_, content) = replace_lines(&expected, 2, 2, "changed").unwrap();
        apply_local(&local, "file.txt", &head, &expected, &content).unwrap();
        assert_eq!(
            std::fs::read_to_string(path.join("file.txt")).unwrap(),
            "a\r\nchanged\r\n"
        );
        assert_eq!(git(path, &["diff", "--cached"]), "");
        assert!(apply_local(&local, "file.txt", &head, &expected, &content).is_err());
    }
    #[test]
    fn rewritten_history_compares_the_explicit_trees() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["config", "user.name", "Fixture"]);
        git(path, &["config", "user.email", "fixture@example.test"]);
        git(path, &["config", "commit.gpgsign", "false"]);
        std::fs::write(path.join("file.txt"), "base\n").unwrap();
        git(path, &["add", "."]);
        git(path, &["commit", "-qm", "base"]);
        let base = git(path, &["rev-parse", "HEAD"]);
        std::fs::write(path.join("file.txt"), "reviewed\n").unwrap();
        git(path, &["commit", "-qam", "reviewed"]);
        let reviewed = git(path, &["rev-parse", "HEAD"]);
        git(path, &["reset", "--hard", &base]);
        std::fs::write(path.join("file.txt"), "rebased\n").unwrap();
        git(path, &["commit", "-qam", "rebased"]);
        let head = git(path, &["rev-parse", "HEAD"]);
        let local = Repo::discover(path).unwrap();
        let compared = compare_local(&local, &reviewed, &head).unwrap();
        assert!(compared.history_rewritten);
        assert!(compared.diffs[0].patch.contains("-reviewed"));
        assert!(compared.diffs[0].patch.contains("+rebased"));
        assert!(
            !compare_local(&local, &base, &head)
                .unwrap()
                .history_rewritten
        );
    }
}
