//! GitLab and Bitbucket Cloud adapters. Existing GitHub/Azure paths stay separate.
use super::transport::{pages, segment, Api, Client};
use super::*;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HostedRepo {
    pub provider: String,
    pub host: String,
    pub namespace: String,
    pub repo: String,
}

impl HostedRepo {
    fn bb(&self) -> bool {
        self.provider == "bitbucket"
    }
    fn root(&self) -> String {
        if self.bb() {
            format!(
                "repositories/{}/{}",
                segment(&self.namespace),
                segment(&self.repo)
            )
        } else {
            format!(
                "projects/{}",
                segment(&format!("{}/{}", self.namespace, self.repo))
            )
        }
    }
    fn prs(&self) -> String {
        format!(
            "{}/{}",
            self.root(),
            if self.bb() {
                "pullrequests"
            } else {
                "merge_requests"
            }
        )
    }
    fn pr(&self, id: u64) -> String {
        format!("{}/{id}", self.prs())
    }
    pub fn client<'a>(&'a self, cwd: &'a str) -> Client<'a> {
        Client {
            cwd,
            provider: &self.provider,
            host: &self.host,
        }
    }
    fn repository(&self, remote: String, viewer: Option<String>) -> PullRequestRepository {
        PullRequestRepository {
            provider: if self.bb() {
                PullRequestProvider::Bitbucket
            } else {
                PullRequestProvider::GitLab
            },
            remote,
            label: format!("{}/{}/{}", self.host, self.namespace, self.repo),
            viewer,
        }
    }
    fn viewer(&self, api: &impl Api) -> Result<Value> {
        api.json("GET", "user", None)
    }
    fn viewer_name(&self, viewer: &Value) -> String {
        field(
            viewer,
            if self.bb() {
                "/display_name"
            } else {
                "/username"
            },
        )
    }
    fn same_user(&self, a: &Value, b: &Value) -> bool {
        let key = if self.bb() { "uuid" } else { "id" };
        a.get(key)
            .is_some_and(|id| !id.is_null() && b.get(key) == Some(id))
    }
    pub fn list(
        &self,
        api: &impl Api,
        remote: String,
        branch: Option<&str>,
    ) -> Result<PullRequestList> {
        let query = if self.bb() {
            let filter = branch
                .map(|b| {
                    format!(
                        "&q={}",
                        segment(&format!(
                            "source.branch.name={}",
                            json!(b.trim_start_matches("refs/heads/"))
                        ))
                    )
                })
                .unwrap_or_default();
            format!("{}?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on{filter}", self.prs())
        } else {
            format!(
                "{}?scope=all&state=all&order_by=updated_at&sort=desc{}",
                self.prs(),
                branch
                    .map(|b| format!(
                        "&source_branch={}",
                        segment(b.trim_start_matches("refs/heads/"))
                    ))
                    .unwrap_or_default()
            )
        };
        let viewer = self.viewer(api)?;
        let values = if branch.is_some() {
            let value = api.json(
                "GET",
                &format!(
                    "{query}&{}=1",
                    if self.bb() { "pagelen" } else { "per_page" }
                ),
                None,
            )?;
            (if self.bb() {
                value.get("values")
            } else {
                Some(&value)
            })
            .and_then(Value::as_array)
            .ok_or("Provider returned an invalid branch request lookup")?
            .clone()
        } else {
            pages(api, &query, self.bb())?
        };
        Ok(PullRequestList {
            next_cursor: None,
            total_count: Some(values.len() as u64),
            repository: self.repository(remote, Some(self.viewer_name(&viewer))),
            pull_requests: values
                .iter()
                .map(|v| self.parse(v, &viewer))
                .collect::<Result<_>>()?,
        })
    }
    fn parse(&self, v: &Value, viewer: &Value) -> Result<PullRequest> {
        let id = v
            .get(if self.bb() { "id" } else { "iid" })
            .and_then(Value::as_u64)
            .ok_or("Provider returned no request number")?;
        let bb = self.bb();
        let author = &v["author"];
        let state = field(v, "/state");
        let state = match state.as_str() {
            "opened" | "OPEN" => "open",
            "MERGED" => "merged",
            "DECLINED" | "SUPERSEDED" => "closed",
            _ => &state,
        }
        .to_string();
        let authored = self.same_user(author, viewer);
        let mut pr = PullRequest {
            capabilities: Some(PullRequestCapabilities::default()),
            id,
            title: field(v, "/title"),
            state,
            is_draft: v["draft"].as_bool().unwrap_or(false),
            author: self.viewer_name(author),
            authored_by_viewer: authored,
            source_branch: field(
                v,
                if bb {
                    "/source/branch/name"
                } else {
                    "/source_branch"
                },
            ),
            source_commit: field(v, if bb { "/source/commit/hash" } else { "/sha" }),
            target_branch: field(
                v,
                if bb {
                    "/destination/branch/name"
                } else {
                    "/target_branch"
                },
            ),
            created_at: field(v, if bb { "/created_on" } else { "/created_at" }),
            updated_at: field(v, if bb { "/updated_on" } else { "/updated_at" }),
            completed_at: text(v.get("merged_at")).or_else(|| text(v.get("closed_at"))),
            url: field(v, if bb { "/links/html/href" } else { "/web_url" }),
            description: field(v, "/description"),
            merge_status: field(v, "/detailed_merge_status"),
            comment_count: v[if bb {
                "comment_count"
            } else {
                "user_notes_count"
            }]
            .as_u64()
            .unwrap_or(0) as usize,
            labels: array(v, "labels")
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            ..PullRequest::default()
        };
        if !bb {
            pr.merge_status = match pr.merge_status.as_str() {
                "mergeable" => "CLEAN",
                "conflict" => "CONFLICTING",
                "checking" | "approvals_syncing" => "CHECKING",
                x => x,
            }
            .into();
        }
        pr.reviewers = array(v, if bb { "participants" } else { "reviewers" })
            .iter()
            .filter(|r| !bb || r["role"] == "REVIEWER")
            .map(|r| PullRequestReviewer {
                name: self.viewer_name(if bb { &r["user"] } else { r }),
                required: false,
                status: if r["approved"] == true {
                    "APPROVED"
                } else if r["state"] == "changes_requested" {
                    "CHANGES_REQUESTED"
                } else {
                    "REQUESTED"
                }
                .into(),
            })
            .collect();
        Ok(pr)
    }
    fn permissions(
        &self,
        api: &impl Api,
        v: &Value,
        viewer: &Value,
    ) -> Result<PullRequestCapabilities> {
        let open = matches!(field(v, "/state").as_str(), "opened" | "OPEN");
        let author = self.same_user(&v["author"], viewer);
        let write = if self.bb() {
            let query = format!(
                "user/workspaces/{}/permissions/repositories?q={}",
                segment(&self.namespace),
                segment(&format!(
                    "repository.full_name={}",
                    json!(format!("{}/{}", self.namespace, self.repo))
                ))
            );
            pages(api, &query, true)?
                .iter()
                .any(|p| matches!(p["permission"].as_str(), Some("write" | "admin")))
        } else {
            let project = api.json("GET", &self.root(), None)?;
            [
                "/permissions/project_access/access_level",
                "/permissions/group_access/access_level",
            ]
            .iter()
            .any(|p| project.pointer(p).and_then(Value::as_u64).unwrap_or(0) >= 30)
        };
        Ok(PullRequestCapabilities {
            can_comment: open,
            can_review: open && !author,
            can_request_changes: open && !author && self.bb(),
            can_close: open && (write || author),
            can_reopen: !open && (write || author) && !self.bb() && v["state"] == "closed",
            // Cloud merge has no expected-head guard. GitLab's merge method
            // belongs to project settings; do not reinterpret it as rebase.
            merge_strategies: if open && write && !self.bb() {
                vec!["merge_commit".into(), "squash".into()]
            } else {
                vec![]
            },
        })
    }
    pub fn detail(&self, api: &impl Api, id: u64) -> Result<PullRequest> {
        let v = api.json("GET", &self.pr(id), None)?;
        let viewer = self.viewer(api)?;
        let mut pr = self.parse(&v, &viewer)?;
        let capabilities = self.permissions(api, &v, &viewer)?;
        pr.can_mark_ready = pr.is_draft && capabilities.can_close && !self.bb();
        pr.capabilities = Some(capabilities);
        let commits = pages(api, &format!("{}/commits", self.pr(id)), self.bb())?;
        pr.commits = commits
            .iter()
            .map(|c| PullRequestCommit {
                id: field(c, if self.bb() { "/hash" } else { "/id" }),
                title: field(c, if self.bb() { "/message" } else { "/title" }),
                author: field(
                    c,
                    if self.bb() {
                        "/author/raw"
                    } else {
                        "/author_name"
                    },
                ),
                avatar_url: None,
                committed_at: field(
                    c,
                    if self.bb() {
                        "/date"
                    } else {
                        "/committed_date"
                    },
                ),
                url: text(c.pointer(if self.bb() {
                    "/links/html/href"
                } else {
                    "/web_url"
                })),
            })
            .collect();
        pr.commit_count = pr.commits.len();
        let discussions = pages(
            api,
            &format!(
                "{}/{}",
                self.pr(id),
                if self.bb() { "comments" } else { "discussions" }
            ),
            self.bb(),
        )?;
        self.discussions(&mut pr, &discussions);
        if self.bb() {
            let checks = pages(api, &format!("{}/statuses", self.pr(id)), true)?;
            pr.checks = checks
                .iter()
                .map(|c| PullRequestCheck {
                    id: field(c, "/key"),
                    name: field(c, "/name"),
                    status: field(c, "/state"),
                })
                .collect();
            // Commit statuses do not describe all Cloud merge restrictions.
            pr.checks_complete = false;
        } else {
            if let Some(pipeline) = v.get("head_pipeline").filter(|p| !p.is_null()) {
                pr.checks.push(PullRequestCheck {
                    id: pipeline["id"].to_string(),
                    name: "Head pipeline".into(),
                    status: field(pipeline, "/status"),
                });
            }
            // Approvals may be unavailable by tier/permission; absence is not green.
            if let Ok(approval) = api.json("GET", &format!("{}/approvals", self.pr(id)), None) {
                pr.review_status = if approval["approvals_left"].as_u64().unwrap_or(1) == 0 {
                    "APPROVED"
                } else {
                    "REVIEW_REQUIRED"
                }
                .into();
                pr.reviews = array(&approval, "approved_by")
                    .iter()
                    .map(|r| PullRequestReview {
                        source_commit: None,
                        id: format!("gitlab:{id}:{}", r["user"]["id"]),
                        author: self.viewer_name(&r["user"]),
                        avatar_url: text(r["user"].get("avatar_url")),
                        state: "APPROVED".into(),
                        body: String::new(),
                        submitted_at: String::new(),
                        url: pr.url.clone(),
                        can_update: false,
                        can_dismiss: false,
                    })
                    .collect();
            }
        }
        Ok(pr)
    }
    fn comment(&self, v: &Value, id: u64, url: &str) -> PullRequestComment {
        let raw_id = v["id"].as_u64().unwrap_or(0);
        PullRequestComment {
            id: format!("{}:{id}:{raw_id}", self.provider),
            author: self.viewer_name(&v[if self.bb() { "user" } else { "author" }]),
            avatar_url: text(v.pointer(if self.bb() {
                "/user/links/avatar/href"
            } else {
                "/author/avatar_url"
            })),
            body: field(v, if self.bb() { "/content/raw" } else { "/body" }),
            created_at: field(
                v,
                if self.bb() {
                    "/created_on"
                } else {
                    "/created_at"
                },
            ),
            url: format!(
                "{url}#{}_{raw_id}",
                if self.bb() { "comment" } else { "note" }
            ),
            is_system: v["system"] == true,
            path: text(v.pointer(if self.bb() {
                "/inline/path"
            } else {
                "/position/new_path"
            })),
        }
    }
    fn discussions(&self, pr: &mut PullRequest, values: &[Value]) {
        let writable = pr.capabilities.as_ref().is_some_and(|c| c.can_comment);
        let mut children: HashMap<u64, Vec<&Value>> = HashMap::new();
        if self.bb() {
            for value in values.iter().filter(|v| v["deleted"] != true) {
                pr.comments.push(self.comment(value, pr.id, &pr.url));
                if let Some(parent) = value["parent"]["id"].as_u64() {
                    children.entry(parent).or_default().push(value);
                }
            }
        }
        for v in values {
            if self.bb() && (v["deleted"] == true || v.get("parent").is_some_and(|p| !p.is_null()))
            {
                continue;
            }
            let notes = if self.bb() {
                vec![v]
            } else {
                array(v, "notes").iter().collect()
            };
            let Some(first) = notes.first() else {
                continue;
            };
            let mut comments = notes
                .iter()
                .map(|n| self.comment(n, pr.id, &pr.url))
                .collect::<Vec<_>>();
            if self.bb() {
                let mut pending = vec![v["id"].as_u64().unwrap_or(0)];
                let mut visited = std::collections::HashSet::new();
                while let Some(parent) = pending.pop() {
                    if !visited.insert(parent) {
                        continue;
                    }
                    for reply in children.get(&parent).into_iter().flatten() {
                        comments.push(self.comment(reply, pr.id, &pr.url));
                        if let Some(id) = reply["id"].as_u64() {
                            pending.push(id);
                        }
                    }
                }
            } else {
                pr.comments.extend(comments.clone());
            }
            let position = &first[if self.bb() { "inline" } else { "position" }];
            let old = if self.bb() { "from" } else { "old_line" };
            let new = if self.bb() { "to" } else { "new_line" };
            let addition = position[new].as_u64().is_some();
            let line = position[if addition { new } else { old }]
                .as_u64()
                .unwrap_or(0) as u32;
            if line == 0 {
                continue;
            }
            let resolved = if self.bb() {
                first.get("resolution").is_some_and(|r| !r.is_null())
            } else {
                first["resolved"] == true
            };
            let outdated = !self.bb()
                && position["head_sha"]
                    .as_str()
                    .is_some_and(|h| h != pr.source_commit);
            let can_resolve = !self.bb()
                && writable
                && first["resolvable"] == true
                && pr.capabilities.as_ref().is_some_and(|c| c.can_close);
            let discussion_id = if self.bb() {
                v["id"].to_string()
            } else {
                field(v, "/id")
            };
            pr.review_threads.push(PullRequestReviewThread {
                iteration_id: None,
                suggestion_range_valid: false,
                id: format!("{}:{}:{discussion_id}", self.provider, pr.id),
                path: field(
                    position,
                    if self.bb() {
                        "/path"
                    } else if addition {
                        "/new_path"
                    } else {
                        "/old_path"
                    },
                ),
                start_line: (if self.bb() {
                    position.get(if addition { "start_to" } else { "start_from" })
                } else {
                    position.pointer(if addition {
                        "/line_range/start/new_line"
                    } else {
                        "/line_range/start/old_line"
                    })
                })
                .and_then(Value::as_u64)
                .unwrap_or(line as u64) as u32,
                end_line: line,
                side: if addition {
                    PullRequestDiffSide::Additions
                } else {
                    PullRequestDiffSide::Deletions
                },
                is_resolved: resolved,
                is_outdated: outdated,
                can_reply: writable,
                can_resolve: can_resolve && !resolved,
                can_unresolve: can_resolve && resolved,
                comments,
            });
        }
        pr.comment_count = pr.comments.len();
    }
    pub fn diff(&self, api: &impl Api, id: u64) -> Result<String> {
        let bytes = api.request(
            "GET",
            &format!(
                "{}/{}",
                self.pr(id),
                if self.bb() { "diff" } else { "raw_diffs" }
            ),
            None,
        )?;
        String::from_utf8(bytes).map_err(|_| "Provider returned a non-UTF-8 patch".into())
    }
    fn current(&self, api: &impl Api, id: u64, expected: Option<&str>) -> Result<Value> {
        let v = api.json("GET", &self.pr(id), None)?;
        if !matches!(field(&v, "/state").as_str(), "opened" | "OPEN") {
            return Err("This request is no longer open; refresh before writing".into());
        }
        if let Some(expected) = expected {
            ensure_review_head(
                &field(
                    &v,
                    if self.bb() {
                        "/source/commit/hash"
                    } else {
                        "/sha"
                    },
                ),
                expected,
            )?;
        }
        Ok(v)
    }
    pub fn add_comment(&self, api: &impl Api, id: u64, body: &str) -> Result<()> {
        self.current(api, id, None)?;
        api.json(
            "POST",
            &format!(
                "{}/{}",
                self.pr(id),
                if self.bb() { "comments" } else { "notes" }
            ),
            Some(&if self.bb() {
                json!({"content":{"raw":body}})
            } else {
                json!({"body":body})
            }),
        )?;
        Ok(())
    }
    pub fn inline(
        &self,
        api: &impl Api,
        id: u64,
        comment: &PullRequestPendingComment,
        head: &str,
    ) -> Result<()> {
        let v = self.current(api, id, Some(head))?;
        if self.bb() {
            // Cloud does not accept an immutable commit coordinate on comments.
            // Detect changes before and after; never report a raced write as safe.
            let payload = bitbucket_inline(comment);
            api.json("POST", &format!("{}/comments", self.pr(id)), Some(&payload))?;
            self.current(api, id, Some(head)).map_err(|e| format!("Comment was posted, but the head changed. Inspect it on Bitbucket before retrying: {e}"))?;
        } else {
            let diffs = pages(api, &format!("{}/diffs", self.pr(id)), false)?;
            let payload = gitlab_inline(&v, &diffs, comment, head)?;
            self.current(api, id, Some(head))?;
            api.json(
                "POST",
                &format!("{}/discussions", self.pr(id)),
                Some(&payload),
            )?;
        }
        Ok(())
    }
    pub fn review(
        &self,
        api: &impl Api,
        id: u64,
        event: PullRequestReviewEvent,
        body: &str,
        comments: &[PullRequestPendingComment],
        head: &str,
    ) -> Result<()> {
        let v = self.current(api, id, Some(head))?;
        let viewer = self.viewer(api)?;
        if event != PullRequestReviewEvent::Comment && self.same_user(&v["author"], &viewer) {
            return Err("You cannot review your own request".into());
        }
        if event == PullRequestReviewEvent::RequestChanges && !self.bb() {
            return Err("Request changes on the GitLab website; this adapter supports comments and approvals".into());
        }
        let mut posted = 0;
        let result = (|| {
            if event != PullRequestReviewEvent::Comment {
                self.current(api, id, Some(head))?;
                let verb = if event == PullRequestReviewEvent::Approve {
                    "approve"
                } else {
                    "request-changes"
                };
                api.json(
                    "POST",
                    &format!("{}/{verb}", self.pr(id)),
                    Some(&if self.bb() {
                        json!({})
                    } else {
                        json!({"sha":head})
                    }),
                )?;
                posted += 1;
            }
            for comment in comments {
                self.inline(api, id, comment, head)?;
                posted += 1;
            }
            if !body.trim().is_empty() {
                self.current(api, id, Some(head))?;
                self.add_comment(api, id, body)?;
                posted += 1;
            }
            self.current(api, id, Some(head))?;
            Ok(())
        })();
        result.map_err(|e: String| format!("{posted} review writes were confirmed; draft retained. Refresh and reconcile posted items before retrying. {e}"))
    }
    fn thread<'a>(&self, thread: &'a str) -> Result<(u64, &'a str)> {
        let parts = thread.split(':').collect::<Vec<_>>();
        if parts.len() != 3
            || parts[0] != self.provider
            || !parts[2].bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err("Invalid provider discussion ID".into());
        }
        Ok((
            parts[1].parse().map_err(|_| "Invalid request ID")?,
            parts[2],
        ))
    }
    pub fn reply(&self, api: &impl Api, thread: &str, body: &str) -> Result<PullRequestComment> {
        let (id, discussion) = self.thread(thread)?;
        let current = self.current(api, id, None)?;
        let url = field(
            &current,
            if self.bb() {
                "/links/html/href"
            } else {
                "/web_url"
            },
        );
        let endpoint = if self.bb() {
            format!("{}/comments", self.pr(id))
        } else {
            format!("{}/discussions/{discussion}/notes", self.pr(id))
        };
        let payload = if self.bb() {
            json!({"content":{"raw":body},"parent":{"id":discussion.parse::<u64>().map_err(|_| "Invalid comment ID")?}})
        } else {
            json!({"body":body})
        };
        let reply = api.json("POST", &endpoint, Some(&payload))?;
        Ok(self.comment(&reply, id, &url))
    }
    pub fn resolve(
        &self,
        api: &impl Api,
        thread: &str,
        resolved: bool,
    ) -> Result<PullRequestReviewThreadUpdate> {
        if self.bb() {
            return Err("Resolve this discussion on Bitbucket".into());
        }
        let (id, discussion) = self.thread(thread)?;
        let current = self.current(api, id, None)?;
        let updated = api.json(
            "PUT",
            &format!("{}/discussions/{discussion}", self.pr(id)),
            Some(&json!({"resolved":resolved})),
        )?;
        let note = array(&updated, "notes")
            .iter()
            .find(|n| n["resolvable"] == true)
            .ok_or(
                "GitLab updated the thread but returned no resolvable note; refresh its state",
            )?;
        let resolved = note["resolved"]
            .as_bool()
            .ok_or("GitLab returned no resolution state")?;
        Ok(PullRequestReviewThreadUpdate {
            id: thread.into(),
            is_resolved: resolved,
            is_outdated: note
                .pointer("/position/head_sha")
                .and_then(Value::as_str)
                .is_some_and(|h| h != field(&current, "/sha")),
            can_reply: true,
            can_resolve: !resolved,
            can_unresolve: resolved,
        })
    }
    pub fn merge(
        &self,
        api: &impl Api,
        id: u64,
        strategy: PullRequestMergeStrategy,
        head: &str,
    ) -> Result<()> {
        if self.bb() {
            return Err(
                "Merge on Bitbucket: its Cloud API cannot atomically guard the reviewed head"
                    .into(),
            );
        }
        if strategy == PullRequestMergeStrategy::Rebase {
            return Err("GitLab merge method is controlled by project settings".into());
        }
        self.current(api, id, Some(head))?;
        api.json("PUT", &format!("{}/merge", self.pr(id)), Some(&json!({"sha":head,"squash":strategy == PullRequestMergeStrategy::Squash,"should_remove_source_branch":false})))?;
        Ok(())
    }
    pub fn lifecycle(
        &self,
        api: &impl Api,
        id: u64,
        action: PullRequestLifecycleAction,
    ) -> Result<()> {
        let v = api.json("GET", &self.pr(id), None)?;
        let viewer = self.viewer(api)?;
        let caps = self.permissions(api, &v, &viewer)?;
        if !(if action == PullRequestLifecycleAction::Close {
            caps.can_close
        } else {
            caps.can_reopen
        }) {
            return Err("This lifecycle action is not available to the signed-in account".into());
        }
        if self.bb() {
            api.json(
                "POST",
                &format!("{}/decline", self.pr(id)),
                Some(&json!({})),
            )?;
        } else {
            api.json("PUT", &self.pr(id), Some(&json!({"state_event":if action == PullRequestLifecycleAction::Close { "close" } else { "reopen" }})))?;
        }
        Ok(())
    }
    pub fn ready(&self, api: &impl Api, id: u64) -> Result<()> {
        if self.bb() {
            return Err("Manage drafts on Bitbucket".into());
        }
        let v = self.current(api, id, None)?;
        let title = field(&v, "/title");
        let lower = title.to_ascii_lowercase();
        let prefix = ["draft:", "[draft]", "(draft)", "wip:", "[wip]", "(wip)"]
            .iter()
            .find(|prefix| lower.starts_with(**prefix))
            .ok_or("Unrecognized GitLab draft title; mark ready on the provider")?;
        let title = title[prefix.len()..].trim_start();
        let updated = api.json("PUT", &self.pr(id), Some(&json!({"title":title})))?;
        if updated["draft"] == true || updated["work_in_progress"] == true {
            return Err(
                "GitLab still reports this request as a draft; inspect it on the provider".into(),
            );
        }
        Ok(())
    }
    pub fn create(
        &self,
        api: &impl Api,
        source: &str,
        target: &str,
        title: &str,
        description: &str,
        draft: bool,
    ) -> Result<PullRequestCreateOutcome> {
        let payload = if self.bb() {
            json!({"title":title,"description":description,"draft":draft,"source":{"branch":{"name":source}},"destination":{"branch":{"name":target}},"close_source_branch":false})
        } else {
            json!({"source_branch":source,"target_branch":target,"title":if draft { format!("Draft: {title}") } else { title.into() },"description":description,"remove_source_branch":false})
        };
        let v = api.json("POST", &self.prs(), Some(&payload))?;
        Ok(PullRequestCreateOutcome {
            id: v[if self.bb() { "id" } else { "iid" }].as_u64().ok_or(
                "Request created but number unavailable; check the provider before retrying",
            )?,
            url: field(
                &v,
                if self.bb() {
                    "/links/html/href"
                } else {
                    "/web_url"
                },
            ),
        })
    }
    pub fn checkout(
        &self,
        api: &impl Api,
        cwd: &str,
        remote: &str,
        id: u64,
        head: &str,
    ) -> Result<PullRequestCheckoutPreparation> {
        let v = api.json("GET", &self.pr(id), None)?;
        ensure_review_head(
            &field(
                &v,
                if self.bb() {
                    "/source/commit/hash"
                } else {
                    "/sha"
                },
            ),
            head,
        )?;
        let branch = field(
            &v,
            if self.bb() {
                "/source/branch/name"
            } else {
                "/source_branch"
            },
        );
        let reference = if self.bb() {
            if field(&v, "/source/repository/full_name")
                != format!("{}/{}", self.namespace, self.repo)
            {
                return Err("Clone the Bitbucket fork to open this source branch locally".into());
            }
            format!("refs/heads/{branch}")
        } else {
            format!("refs/merge-requests/{id}/head")
        };
        Repo::discover(cwd)
            .map_err(|e| e.to_string())?
            .fetch_refs_for_read(remote, &[&reference])
            .map_err(|e| e.to_string())?;
        Ok(PullRequestCheckoutPreparation {
            branch,
            start_point: head.into(),
        })
    }
    pub fn activity(
        &self,
        api: &impl Api,
        remote: String,
        id: u64,
    ) -> Result<PullRequestActivitySnapshot> {
        // Monitoring must not reload commits, permissions, or patches.
        let value = api.json("GET", &self.pr(id), None)?;
        let mut pr = self.parse(&value, &Value::Null)?;
        let discussions = pages(
            api,
            &format!(
                "{}/{}",
                self.pr(id),
                if self.bb() { "comments" } else { "discussions" }
            ),
            self.bb(),
        )?;
        self.discussions(&mut pr, &discussions);
        if self.bb() {
            pr.checks = pages(api, &format!("{}/statuses", self.pr(id)), true)?
                .iter()
                .map(|c| PullRequestCheck {
                    id: field(c, "/key"),
                    name: field(c, "/name"),
                    status: field(c, "/state"),
                })
                .collect();
            pr.reviews = array(&value, "participants")
                .iter()
                .filter(|r| r["approved"] == true || r["state"] == "changes_requested")
                .map(|r| PullRequestReview {
                        source_commit: None,
                    id: field(r, "/user/uuid"),
                    author: self.viewer_name(&r["user"]),
                    avatar_url: None,
                    state: if r["approved"] == true {
                        "APPROVED"
                    } else {
                        "CHANGES_REQUESTED"
                    }
                    .into(),
                    body: String::new(),
                    submitted_at: String::new(),
                    url: pr.url.clone(),
                    can_update: false,
                    can_dismiss: false,
                })
                .collect();
        } else {
            if let Some(pipeline) = value.get("head_pipeline").filter(|v| !v.is_null()) {
                pr.checks.push(PullRequestCheck {
                    id: pipeline["id"].to_string(),
                    name: "Head pipeline".into(),
                    status: field(pipeline, "/status"),
                });
            }
            if let Ok(approval) = api.json("GET", &format!("{}/approvals", self.pr(id)), None) {
                pr.reviews = array(&approval, "approved_by")
                    .iter()
                    .map(|r| PullRequestReview {
                        source_commit: None,
                        id: r["user"]["id"].to_string(),
                        author: self.viewer_name(&r["user"]),
                        avatar_url: None,
                        state: "APPROVED".into(),
                        body: String::new(),
                        submitted_at: String::new(),
                        url: pr.url.clone(),
                        can_update: false,
                        can_dismiss: false,
                    })
                    .collect();
            }
        }
        Ok(PullRequestActivitySnapshot {
            repository: self.repository(remote, None),
            id,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            source_branch: pr.source_branch,
            source_commit: pr.source_commit,
            updated_at: pr.updated_at,
            comments: pr
                .comments
                .into_iter()
                .map(|c| PullRequestActivityComment {
                    id: c.id,
                    author: c.author,
                    kind: "comment".into(),
                    is_system: c.is_system,
                })
                .collect(),
            reviews: pr
                .reviews
                .into_iter()
                .map(|r| PullRequestActivityReview {
                    id: r.id,
                    author: r.author,
                    state: r.state,
                })
                .collect(),
            checks: pr
                .checks
                .into_iter()
                .map(|c| PullRequestActivityCheck {
                    id: c.name.clone(),
                    name: c.name,
                    status: c.status,
                })
                .collect(),
            checks_complete: pr.checks_complete,
        })
    }
}

fn field(v: &Value, pointer: &str) -> String {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}

fn bitbucket_inline(c: &PullRequestPendingComment) -> Value {
    let mut inline = json!({"path":c.path});
    let addition = c.side == PullRequestDiffSide::Additions;
    inline[if addition { "to" } else { "from" }] = c.end_line.into();
    if c.start_line != c.end_line {
        inline[if addition { "start_to" } else { "start_from" }] = c.start_line.into();
    }
    json!({"content":{"raw":c.body},"inline":inline})
}

fn gitlab_inline(
    v: &Value,
    diffs: &[Value],
    c: &PullRequestPendingComment,
    head: &str,
) -> Result<Value> {
    let refs = &v["diff_refs"];
    ensure_review_head(&field(refs, "/head_sha"), head)?;
    for key in ["base_sha", "start_sha", "head_sha"] {
        validate_commit(&field(refs, &format!("/{key}")))?;
    }
    let addition = c.side == PullRequestDiffSide::Additions;
    let diff = diffs
        .iter()
        .find(|d| d[if addition { "new_path" } else { "old_path" }].as_str() == Some(&c.path))
        .ok_or("Selected path is absent from this GitLab diff version")?;
    if diff["too_large"] == true || diff["collapsed"] == true {
        return Err("GitLab omitted this file's diff; comment on the provider website".into());
    }
    let mut position = json!({"position_type":"text","base_sha":refs["base_sha"],"start_sha":refs["start_sha"],"head_sha":refs["head_sha"],"old_path":diff["old_path"],"new_path":diff["new_path"]});
    let patch = diff["diff"]
        .as_str()
        .ok_or("GitLab omitted the file patch needed for line coordinates")?;
    let end = gitlab_line(patch, c.end_line, addition)?;
    if let Some(old) = end.old {
        position["old_line"] = old.into();
    }
    if let Some(new) = end.new {
        position["new_line"] = new.into();
    }
    if c.start_line != c.end_line {
        let start = gitlab_line(patch, c.start_line, addition)?;
        if start.hunk != end.hunk {
            return Err("Select a GitLab comment range within one diff hunk".into());
        }
        let filename = if diff["deleted_file"] == true {
            field(diff, "/old_path")
        } else {
            field(diff, "/new_path")
        };
        let hash = sha1_smol::Sha1::from(filename.as_bytes())
            .digest()
            .to_string();
        let coordinate = |line: &GitLabLine| json!({"line_code":format!("{hash}_{}_{}",line.old.unwrap_or(0),line.new.unwrap_or(0)),"type":if line.old.is_none() {"new"} else {"old"},"old_line":line.old,"new_line":line.new});
        position["line_range"] = json!({"start":coordinate(&start),"end":coordinate(&end)});
    }
    Ok(json!({"body":c.body,"position":position}))
}

struct GitLabLine {
    old: Option<u32>,
    new: Option<u32>,
    hunk: usize,
}

fn gitlab_line(patch: &str, wanted: u32, addition: bool) -> Result<GitLabLine> {
    let (mut old, mut new, mut hunk) = (0_u32, 0_u32, 0);
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let mut parts = line.split_whitespace().skip(1);
            let parse = |part: Option<&str>| {
                part.and_then(|p| p.get(1..))
                    .and_then(|p| p.split(',').next())
                    .and_then(|p| p.parse::<u32>().ok())
                    .ok_or("Invalid GitLab diff hunk")
            };
            old = parse(parts.next())?;
            new = parse(parts.next())?;
            hunk += 1;
        } else if hunk > 0 {
            let first = line.as_bytes().first().copied();
            let old_line = matches!(first, Some(b' ' | b'-')).then_some(old);
            let new_line = matches!(first, Some(b' ' | b'+')).then_some(new);
            if (if addition { new_line } else { old_line }) == Some(wanted) {
                return Ok(GitLabLine {
                    old: old_line,
                    new: new_line,
                    hunk,
                });
            }
            if old_line.is_some() {
                old = old.saturating_add(1);
            }
            if new_line.is_some() {
                new = new.saturating_add(1);
            }
        }
    }
    Err("Selected line is absent from the current GitLab diff".into())
}

#[cfg(test)]
mod tests {
    use super::super::transport::fixtures::FixtureApi;
    use super::*;
    const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BASE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fn repo(bb: bool) -> HostedRepo {
        HostedRepo {
            provider: if bb { "bitbucket" } else { "gitlab" }.into(),
            host: if bb { "bitbucket.org" } else { "gitlab.com" }.into(),
            namespace: "team".into(),
            repo: "app".into(),
        }
    }
    fn mr() -> Value {
        json!({"iid":7,"title":"Rename","state":"opened","sha":HEAD,"author":{"id":1,"username":"author"},"diff_refs":{"base_sha":BASE,"start_sha":BASE,"head_sha":HEAD}})
    }
    #[test]
    fn gitlab_ready_handles_title_markers_and_checks_provider_result() {
        for title in [
            "Draft: Rename",
            "[Draft] Rename",
            "(draft) Rename",
            "WIP: Rename",
        ] {
            let mut current = mr();
            current["title"] = json!(title);
            let api = FixtureApi::new(vec![
                ("GET", "projects/team%2Fapp/merge_requests/7", Ok(current)),
                (
                    "PUT",
                    "projects/team%2Fapp/merge_requests/7",
                    Ok(json!({"draft":false})),
                ),
            ]);
            repo(false).ready(&api, 7).unwrap();
            assert_eq!(api.writes.borrow()[0].1["title"], "Rename");
        }
        let api = FixtureApi::new(vec![(
            "GET",
            "projects/team%2Fapp/merge_requests/7",
            Ok(mr()),
        )]);
        assert!(repo(false).ready(&api, 7).is_err());
        assert!(api.writes.borrow().is_empty());
    }
    fn comment(side: PullRequestDiffSide, start: u32, end: u32) -> PullRequestPendingComment {
        PullRequestPendingComment {
            path: if side == PullRequestDiffSide::Additions {
                "after.txt"
            } else {
                "before.txt"
            }
            .into(),
            start_line: start,
            end_line: end,
            side,
            body: "Review text".into(),
        }
    }
    fn diffs() -> Vec<Value> {
        vec![
            json!({"old_path":"before.txt","new_path":"after.txt","diff":"@@ -1,4 +1,5 @@\n same\n-old\n+new\n+another\n context\n tail\n"}),
        ]
    }

    #[test]
    fn gitlab_rename_context_and_ranges_use_version_coordinates() {
        let added = gitlab_inline(
            &mr(),
            &diffs(),
            &comment(PullRequestDiffSide::Additions, 2, 3),
            HEAD,
        )
        .unwrap();
        assert_eq!(added["position"]["old_path"], "before.txt");
        assert_eq!(added["position"]["new_path"], "after.txt");
        assert_eq!(added["position"]["head_sha"], HEAD);
        assert!(added["position"].get("old_line").is_none());
        assert_eq!(added["position"]["line_range"]["start"]["new_line"], 2);
        assert_eq!(added["position"]["line_range"]["end"]["new_line"], 3);
        let context = gitlab_inline(
            &mr(),
            &diffs(),
            &comment(PullRequestDiffSide::Additions, 4, 4),
            HEAD,
        )
        .unwrap();
        assert_eq!(context["position"]["new_line"], 4);
        assert_eq!(context["position"]["old_line"], 3);
        let deleted = gitlab_inline(
            &mr(),
            &diffs(),
            &comment(PullRequestDiffSide::Deletions, 2, 2),
            HEAD,
        )
        .unwrap();
        assert_eq!(deleted["position"]["old_line"], 2);
        assert!(deleted["position"].get("new_line").is_none());
        assert!(gitlab_inline(
            &mr(),
            &diffs(),
            &comment(PullRequestDiffSide::Additions, 99, 99),
            HEAD
        )
        .is_err());
        assert!(gitlab_inline(
            &mr(),
            &diffs(),
            &comment(PullRequestDiffSide::Additions, 2, 2),
            BASE
        )
        .is_err());
    }
    #[test]
    fn bitbucket_coordinates_do_not_conflate_left_and_right_ranges() {
        let left = bitbucket_inline(&comment(PullRequestDiffSide::Deletions, 2, 4));
        assert_eq!(
            left["inline"],
            json!({"path":"before.txt","from":4,"start_from":2})
        );
        let right = bitbucket_inline(&comment(PullRequestDiffSide::Additions, 3, 3));
        assert_eq!(right["inline"], json!({"path":"after.txt","to":3}));
    }
    #[test]
    fn stale_heads_and_terminal_requests_never_write() {
        let api = FixtureApi::new(vec![(
            "GET",
            "projects/team%2Fapp/merge_requests/7",
            Ok(mr()),
        )]);
        assert!(repo(false)
            .inline(
                &api,
                7,
                &comment(PullRequestDiffSide::Additions, 2, 2),
                BASE
            )
            .is_err());
        assert!(api.writes.borrow().is_empty());
        api.done();
        let api = FixtureApi::new(vec![(
            "GET",
            "repositories/team/app/pullrequests/7",
            Ok(json!({"state":"OPEN","source":{"commit":{"hash":HEAD}}})),
        )]);
        assert!(repo(true)
            .review(&api, 7, PullRequestReviewEvent::Approve, "", &[], BASE)
            .is_err());
        assert!(api.writes.borrow().is_empty());
        api.done();
        let api = FixtureApi::new(vec![(
            "GET",
            "projects/team%2Fapp/merge_requests/7",
            Ok(json!({"state":"merged"})),
        )]);
        assert!(repo(false).add_comment(&api, 7, "hello").is_err());
        assert!(api.writes.borrow().is_empty());
    }
    #[test]
    fn gitlab_approval_pins_head_and_reports_partial_batch_failure() {
        let api = FixtureApi::new(vec![
            ("GET", "projects/team%2Fapp/merge_requests/7", Ok(mr())),
            ("GET", "user", Ok(json!({"id":2}))),
            ("GET", "projects/team%2Fapp/merge_requests/7", Ok(mr())),
            (
                "POST",
                "projects/team%2Fapp/merge_requests/7/approve",
                Ok(json!({})),
            ),
            (
                "GET",
                "projects/team%2Fapp/merge_requests/7",
                Err("head unavailable".into()),
            ),
        ]);
        let error = repo(false)
            .review(
                &api,
                7,
                PullRequestReviewEvent::Approve,
                "summary",
                &[],
                HEAD,
            )
            .unwrap_err();
        assert!(error.contains("1 review writes were confirmed"));
        assert_eq!(api.writes.borrow()[0].1, json!({"sha":HEAD}));
        api.done();
    }
    #[test]
    fn permission_denial_and_self_review_do_not_write() {
        let api = FixtureApi::new(vec![
            ("GET", "projects/team%2Fapp/merge_requests/7", Ok(mr())),
            ("GET", "user", Ok(json!({"id":1}))),
        ]);
        assert!(repo(false)
            .review(&api, 7, PullRequestReviewEvent::Approve, "", &[], HEAD)
            .unwrap_err()
            .contains("own"));
        assert!(api.writes.borrow().is_empty());
        let api = FixtureApi::new(vec![(
            "GET",
            "projects/team%2Fapp",
            Ok(json!({"permissions":{"project_access":{"access_level":10}}})),
        )]);
        let caps = repo(false)
            .permissions(&api, &mr(), &json!({"id":2}))
            .unwrap();
        assert!(!caps.can_close);
        assert!(caps.merge_strategies.is_empty());
        let api = FixtureApi::new(vec![("GET","user/workspaces/team/permissions/repositories?q=repository.full_name%3D%22team%2Fapp%22&pagelen=100",Err("HTTP 403".into()))]);
        assert!(repo(true)
            .permissions(&api, &json!({"state":"OPEN"}), &json!({"uuid":"me"}))
            .is_err());
        api.done();
    }
    #[test]
    fn bitbucket_merge_is_unavailable_without_atomic_head_guard() {
        let api = FixtureApi::new(vec![]);
        assert!(repo(true)
            .merge(&api, 7, PullRequestMergeStrategy::MergeCommit, HEAD)
            .unwrap_err()
            .contains("atomically"));
        api.done();
    }
    #[test]
    fn nested_bitbucket_replies_and_gitlab_thread_ranges_survive_normalization() {
        let mut pr = PullRequest {
            id: 7,
            source_commit: HEAD.into(),
            ..Default::default()
        };
        repo(true).discussions(&mut pr,&[
            json!({"id":1,"inline":{"path":"a","from":4,"start_from":2},"content":{"raw":"root"}}),
            json!({"id":2,"parent":{"id":1},"content":{"raw":"reply"}}),
            json!({"id":3,"parent":{"id":2},"content":{"raw":"nested reply"}}),
        ]);
        assert_eq!(pr.comment_count, 3);
        assert_eq!(pr.review_threads[0].comments.len(), 3);
        assert_eq!(pr.review_threads[0].id, "bitbucket:7:1");
        assert_eq!(pr.review_threads[0].start_line, 2);
        let mut pr = PullRequest {
            id: 7,
            source_commit: HEAD.into(),
            ..Default::default()
        };
        repo(false).discussions(&mut pr,&[json!({"id":"thread123","notes":[{"id":4,"position":{"new_path":"after.txt","new_line":5,"head_sha":BASE,"line_range":{"start":{"new_line":3}}},"resolvable":true}]})]);
        assert_eq!(pr.review_threads[0].start_line, 3);
        assert!(pr.review_threads[0].is_outdated);
        assert!(!pr.review_threads[0].can_reply);
        assert!(repo(true).thread("gitlab:7:123").is_err());
    }
}
