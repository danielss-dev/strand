//! Provider-specific deferred completion; never infer readiness from loaded checks.
use super::*;

pub const GITHUB_FIELDS: &str = r#"
  id state isDraft headRefOid mergeStateStatus
  repository { viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }
  isMergeQueueEnabled isInMergeQueue mergeQueueEntry { position state }
  autoMergeRequest { enabledAt } viewerCanEnableAutoMerge viewerCanDisableAutoMerge
"#;

#[derive(Debug, Clone, Serialize)]
pub struct Completion {
    pub kind: String,
    pub status: String,
    pub source_commit: String,
    pub position: Option<u64>,
    pub can_enable: bool,
    pub can_cancel: bool,
    pub blockers: Vec<String>,
    pub strategies: Vec<String>,
}

pub fn github(value: &Value) -> Completion {
    let queue = value["isMergeQueueEnabled"].as_bool() == Some(true);
    let queued = value["isInMergeQueue"].as_bool() == Some(true);
    let auto = value.get("autoMergeRequest").is_some_and(|v| !v.is_null());
    let open = value["state"].as_str() == Some("OPEN") && value["isDraft"].as_bool() == Some(false);
    let writer = matches!(
        value["repository"]["viewerPermission"].as_str(),
        Some("WRITE" | "MAINTAIN" | "ADMIN")
    );
    let status = match value["state"].as_str() {
        Some("MERGED") => "merged",
        Some("CLOSED") => "closed",
        _ if queued => "queued",
        _ if auto => "waiting_for_policies",
        _ => "disabled",
    };
    let merge_status = value["mergeStateStatus"].as_str().unwrap_or("UNKNOWN");
    Completion {
        kind: if queue {
            "github_queue"
        } else {
            "github_auto_merge"
        }
        .into(),
        status: status.into(),
        source_commit: text(value.get("headRefOid")).unwrap_or_default(),
        position: value
            .pointer("/mergeQueueEntry/position")
            .and_then(Value::as_u64),
        can_enable: open
            && !queued
            && !auto
            && if queue {
                writer
            } else {
                value["viewerCanEnableAutoMerge"].as_bool() == Some(true)
            },
        can_cancel: open
            && if queued {
                writer
            } else {
                auto && value["viewerCanDisableAutoMerge"].as_bool() == Some(true)
            },
        blockers: if matches!(merge_status, "CLEAN" | "HAS_HOOKS") {
            vec![]
        } else {
            vec![format!("GitHub merge status: {merge_status}")]
        },
        strategies: [
            ("mergeCommitAllowed", "merge_commit"),
            ("squashMergeAllowed", "squash"),
            ("rebaseMergeAllowed", "rebase"),
        ]
        .iter()
        .filter(|(field, _)| value["repository"][*field].as_bool() == Some(true))
        .map(|(_, strategy)| (*strategy).into())
        .collect(),
    }
}

pub fn azure(value: &Value, viewer: Option<&str>) -> Completion {
    let author = text(value.pointer("/createdBy/uniqueName"));
    let setter = text(value.pointer("/autoCompleteSetBy/uniqueName"));
    let enabled = text(value.pointer("/autoCompleteSetBy/id"))
        .is_some_and(|id| !id.is_empty() && id != "00000000-0000-0000-0000-000000000000");
    let open =
        value["status"].as_str() == Some("active") && value["isDraft"].as_bool() == Some(false);
    // Azure has no viewerCanUpdate field. As with draft handoff, fail closed to
    // the provider-authenticated PR author (or the existing auto-complete owner).
    let owns = viewer.is_some_and(|v| author.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(v)));
    let owns_auto =
        viewer.is_some_and(|v| setter.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(v)));
    let merge_status = value["mergeStatus"].as_str().unwrap_or("unknown");
    Completion {
        kind: "azure_auto_complete".into(),
        status: match value["status"].as_str() {
            Some("completed") => "merged",
            Some("abandoned") => "closed",
            _ if enabled => "waiting_for_policies",
            _ => "disabled",
        }
        .into(),
        source_commit: text(value.pointer("/lastMergeSourceCommit/commitId")).unwrap_or_default(),
        position: None,
        can_enable: open && !enabled && owns,
        can_cancel: open && enabled && (owns || owns_auto),
        blockers: if merge_status == "succeeded" {
            vec![]
        } else {
            vec![format!("Azure merge status: {merge_status}")]
        },
        strategies: vec!["merge_commit".into(), "squash".into(), "rebase".into()],
    }
}

pub fn set(
    path: &str,
    id: u64,
    enable: bool,
    strategy: PullRequestMergeStrategy,
    expected_head: &str,
) -> Result<()> {
    validate_commit(expected_head)?;
    let (_, host) = host_for_path(path)?;
    match host {
        HostRepo::GitHub { owner, repo } => {
            let query = format!("query($owner: String!, $repo: String!, $number: Int!) {{ repository(owner: $owner, name: $repo) {{ pullRequest(number: $number) {{ {GITHUB_FIELDS} }} }} }}");
            let value = pages::query(
                path,
                &query,
                serde_json::json!({"owner":owner,"repo":repo,"number":id}),
                None,
            )?;
            let pr = &value["data"]["repository"]["pullRequest"];
            let state = github(pr);
            authorize(&state, enable, expected_head)?;
            let node_id = text(pr.get("id")).ok_or("GitHub returned no PR node ID")?;
            let (query, input) =
                github_mutation(&state, enable, strategy, &node_id, expected_head)?;
            pages::query(path, query, serde_json::json!({"input":input}), None)?;
        }
        HostRepo::Azure {
            organization,
            project,
            repo,
        } => {
            let viewer = azure_viewer(path)?;
            let value = azure_pr_value(path, &organization, id)?;
            let state = azure(&value, Some(&viewer));
            authorize(&state, enable, expected_head)?;
            let viewer_id = if enable {
                text(value.pointer("/createdBy/id")).ok_or("Azure returned no author ID")?
            } else {
                String::new()
            };
            azure_invoke_write_json(
                path,
                &organization,
                "pullRequests",
                &[
                    format!("project={project}"),
                    format!("repositoryId={repo}"),
                    format!("pullRequestId={id}"),
                ],
                "PATCH",
                &azure_payload(enable, &viewer_id, strategy, expected_head),
            )?;
        }
        HostRepo::AzureServer {
            profile_id,
            project,
            repo,
            ..
        } => {
            let viewer = azure_server_viewer(profile_id)?;
            let value = server_show(profile_id, &project, &repo, id)?;
            authorize(&azure(&value, Some(&viewer)), enable, expected_head)?;
            server_execute(
                profile_id,
                AzdoOperation::SetAutoComplete {
                    project,
                    repository: repo,
                    id,
                    enabled: enable,
                    expected_head: expected_head.into(),
                    viewer_id: if enable {
                        azure_server_viewer_id(profile_id)?
                    } else {
                        String::new()
                    },
                    strategy: match strategy {
                        PullRequestMergeStrategy::MergeCommit => AzdoMergeStrategy::MergeCommit,
                        PullRequestMergeStrategy::Squash => AzdoMergeStrategy::Squash,
                        PullRequestMergeStrategy::Rebase => AzdoMergeStrategy::Rebase,
                    },
                },
            )?;
        }
    }
    Ok(())
}

fn authorize(state: &Completion, enable: bool, expected: &str) -> Result<()> {
    if enable {
        ensure_review_head(&state.source_commit, expected)?;
    }
    if if enable {
        !state.can_enable
    } else {
        !state.can_cancel
    } {
        return Err(
            "The provider no longer permits this completion action. Refresh the pull request."
                .into(),
        );
    }
    Ok(())
}

fn github_mutation(
    state: &Completion,
    enable: bool,
    strategy: PullRequestMergeStrategy,
    id: &str,
    head: &str,
) -> Result<(&'static str, Value)> {
    if state.status == "queued" && !enable {
        return Ok(("mutation($input: DequeuePullRequestInput!) { dequeuePullRequest(input: $input) { clientMutationId } }", serde_json::json!({"pullRequestId":id})));
    }
    if !enable {
        return Ok(("mutation($input: DisablePullRequestAutoMergeInput!) { disablePullRequestAutoMerge(input: $input) { clientMutationId } }", serde_json::json!({"pullRequestId":id})));
    }
    if state.kind == "github_queue" {
        return Ok(("mutation($input: EnqueuePullRequestInput!) { enqueuePullRequest(input: $input) { clientMutationId } }", serde_json::json!({"pullRequestId":id,"expectedHeadOid":head,"jump":false})));
    }
    let (key, method) = match strategy {
        PullRequestMergeStrategy::MergeCommit => ("merge_commit", "MERGE"),
        PullRequestMergeStrategy::Squash => ("squash", "SQUASH"),
        PullRequestMergeStrategy::Rebase => ("rebase", "REBASE"),
    };
    if !state.strategies.iter().any(|s| s == key) {
        return Err("This merge strategy is disabled by the repository".into());
    }
    Ok(("mutation($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { clientMutationId } }", serde_json::json!({"pullRequestId":id,"expectedHeadOid":head,"mergeMethod":method})))
}

pub fn github_merge_payload(strategy: PullRequestMergeStrategy, head: &str) -> Value {
    serde_json::json!({"sha":head,"merge_method":match strategy { PullRequestMergeStrategy::MergeCommit => "merge", PullRequestMergeStrategy::Squash => "squash", PullRequestMergeStrategy::Rebase => "rebase" }})
}

pub fn azure_payload(
    enable: bool,
    viewer: &str,
    strategy: PullRequestMergeStrategy,
    head: &str,
) -> Value {
    if !enable {
        return serde_json::json!({"autoCompleteSetBy":{"id":"00000000-0000-0000-0000-000000000000"}});
    }
    serde_json::json!({"autoCompleteSetBy":{"id":viewer}, "lastMergeSourceCommit":{"commitId":head}, "completionOptions":{"mergeStrategy":azure_merge_strategy(strategy),"deleteSourceBranch":false,"transitionWorkItems":false,"bypassPolicy":false}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_and_auto_merge_are_distinct_and_guard_enable_atomically() {
        let mut raw = serde_json::json!({"state":"OPEN","isDraft":false,"headRefOid":"a".repeat(40),"isMergeQueueEnabled":true,"repository":{"viewerPermission":"WRITE","squashMergeAllowed":true}});
        let state = github(&raw);
        assert!(state.can_enable);
        let (query, input) = github_mutation(
            &state,
            true,
            PullRequestMergeStrategy::Squash,
            "PR_1",
            &state.source_commit,
        )
        .unwrap();
        assert!(query.contains("EnqueuePullRequestInput"));
        assert_eq!(input["expectedHeadOid"], state.source_commit);
        assert_eq!(input["jump"], false);
        assert!(authorize(&state, true, &"b".repeat(40)).is_err());
        raw["isInMergeQueue"] = true.into();
        raw["mergeQueueEntry"] = serde_json::json!({"position":3});
        let queued = github(&raw);
        assert_eq!(queued.status, "queued");
        assert_eq!(queued.position, Some(3));
        assert!(!queued.can_enable);
        assert!(queued.can_cancel);
        assert!(
            github_mutation(&queued, false, PullRequestMergeStrategy::Squash, "PR_1", "")
                .unwrap()
                .0
                .contains("Dequeue")
        );
        raw["isMergeQueueEnabled"] = false.into();
        raw["isInMergeQueue"] = false.into();
        raw["viewerCanEnableAutoMerge"] = true.into();
        let auto = github(&raw);
        assert!(github_mutation(
            &auto,
            true,
            PullRequestMergeStrategy::Squash,
            "PR_1",
            &auto.source_commit
        )
        .unwrap()
        .0
        .contains("EnablePullRequestAutoMerge"));
        assert!(!github(&serde_json::json!({})).can_enable);
    }
    #[test]
    fn azure_reports_waiting_policies_without_queue_position_and_cancel_keeps_options() {
        let raw = serde_json::json!({"status":"active","isDraft":false,"createdBy":{"uniqueName":"ada"},"autoCompleteSetBy":{"id":"id","uniqueName":"ada"}});
        let state = azure(&raw, Some("ADA"));
        assert_eq!(state.status, "waiting_for_policies");
        assert!(state.position.is_none());
        assert!(state.can_cancel);
        assert!(!state.can_enable);
        assert!(!azure(&raw, None).can_cancel);
        let cancel = azure_payload(false, "", PullRequestMergeStrategy::Squash, "");
        assert!(cancel.get("completionOptions").is_none());
        let enable = azure_payload(true, "viewer", PullRequestMergeStrategy::Squash, "head");
        assert_eq!(enable["lastMergeSourceCommit"]["commitId"], "head");
        assert_eq!(enable["completionOptions"]["bypassPolicy"], false);
        assert!(enable.get("status").is_none());
    }
}
