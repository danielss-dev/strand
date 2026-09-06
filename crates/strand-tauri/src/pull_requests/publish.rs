//! Repository publishing is a resumable sequence, never an implicit push.
use super::transport::{pages, segment, validate_host, Api, Client};
use super::{run_command, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use strand_core::Repo;

// Serialize journal transitions; PR reads and ordinary Git operations do not use this lock.
static PUBLISH_WRITE: Mutex<()> = Mutex::new(());
const JOURNAL: &str = "strand.publish-state";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Destination {
    pub id: String,
    pub label: String,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishAccount {
    pub account: String,
    pub account_id: String,
    pub destinations: Vec<Destination>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishRequest {
    pub provider: String,
    pub host: String,
    pub account_id: String,
    pub destination: String,
    pub name: String,
    pub visibility: String,
    pub remote: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishState {
    pub id: String,
    pub request: PublishRequest,
    pub account: String,
    pub destination: Destination,
    pub url: String,
    pub clone_url: String,
    pub branch: String,
    pub head: String,
    pub stage: String,
    pub error: Option<String>,
}

fn check_provider(provider: &str, host: &str) -> Result<()> {
    validate_host(host)?;
    if !matches!(provider, "github" | "gitlab" | "bitbucket") {
        return Err("Choose GitHub, GitLab, or Bitbucket Cloud".into());
    }
    if provider == "bitbucket" && host != "bitbucket.org" {
        return Err("Bitbucket Server is outside the Cloud adapter scope".into());
    }
    Ok(())
}

pub fn accounts(path: &str, provider: &str, host: &str) -> Result<PublishAccount> {
    check_provider(provider, host)?;
    Repo::discover(path).map_err(|e| e.to_string())?;
    account(
        &Client {
            cwd: path,
            provider,
            host,
        },
        provider,
    )
}

fn account(api: &impl Api, provider: &str) -> Result<PublishAccount> {
    let viewer = api.json("GET", "user", None)?;
    let account_id = viewer
        .get(if provider == "bitbucket" {
            "uuid"
        } else {
            "id"
        })
        .filter(|v| !v.is_null())
        .ok_or("Provider returned no account identity")?
        .to_string();
    let account = string(
        &viewer,
        if provider == "github" {
            "/login"
        } else if provider == "gitlab" {
            "/username"
        } else {
            "/display_name"
        },
    )?;
    let destinations = match provider {
        "github" => {
            let mut rows = vec![Destination {
                id: account.clone(),
                label: account.clone(),
                kind: "account".into(),
            }];
            rows.extend(
                pages(api, "user/orgs", false)?
                    .iter()
                    .map(|o| {
                        let login = string(o, "/login")?;
                        Ok(Destination {
                            id: login.clone(),
                            label: login,
                            kind: "organization".into(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?,
            );
            rows
        }
        "gitlab" => pages(api, "namespaces", false)?
            .iter()
            .map(|n| {
                Ok(Destination {
                    id: n["id"].as_u64().ok_or("Invalid namespace ID")?.to_string(),
                    label: string(n, "/full_path")?,
                    kind: string(n, "/kind")?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        _ => pages(api, "user/workspaces", true)?
            .iter()
            .map(|n| {
                Ok(Destination {
                    id: string(n, "/workspace/slug")?,
                    label: string(n, "/workspace/slug")?,
                    kind: "workspace".into(),
                })
            })
            .collect::<Result<Vec<_>>>()?,
    };
    Ok(PublishAccount {
        account,
        account_id,
        destinations,
    })
}

pub fn state(path: &str) -> Result<Option<PublishState>> {
    Repo::discover(path).map_err(|e| e.to_string())?;
    let Ok(bytes) = run_command(path, "git", &["config", "--local", "--get", JOURNAL], &[]) else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Publish recovery record is invalid".into())
}
fn save(path: &str, state: &PublishState) -> Result<()> {
    let value = serde_json::to_string(state).map_err(|e| e.to_string())?;
    run_command(path, "git", &["config", "--local", JOURNAL, &value], &[])?;
    Ok(())
}

pub fn forget(path: &str) -> Result<()> {
    let _lock = PUBLISH_WRITE
        .lock()
        .map_err(|_| "Publish state lock failed")?;
    if state(path)?.is_some() {
        run_command(
            path,
            "git",
            &["config", "--local", "--unset-all", JOURNAL],
            &[],
        )?;
    }
    Ok(())
}

fn validate_request(request: &PublishRequest) -> Result<()> {
    check_provider(&request.provider, &request.host)?;
    if !matches!(request.visibility.as_str(), "private" | "public") {
        return Err("Choose private or public visibility".into());
    }
    if request.name.is_empty()
        || request.name.len() > 100
        || request.name.starts_with(['-', '.'])
        || request.name.ends_with(".git")
        || !request
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("Use a repository name of 1–100 letters, digits, hyphens, underscores or dots; do not start with a dot or hyphen, or end with .git".into());
    }
    if request.provider == "bitbucket" && request.name != request.name.to_lowercase() {
        return Err("Bitbucket repository slugs must be lowercase".into());
    }
    if request.remote.is_empty()
        || request.remote.len() > 100
        || request.remote.starts_with(['-', '.'])
        || !request
            .remote
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err("Use a remote name with letters, digits, hyphens or underscores".into());
    }
    Ok(())
}

pub fn preview(path: &str, request: PublishRequest) -> Result<PublishState> {
    let _lock = PUBLISH_WRITE
        .lock()
        .map_err(|_| "Publish state lock failed")?;
    validate_request(&request)?;
    if state(path)?.is_some_and(|s| !matches!(s.stage.as_str(), "review" | "pushed")) {
        return Err("Resume or dismiss the existing publish recovery record first".into());
    }
    let repo = Repo::discover(path).map_err(|e| e.to_string())?;
    if repo
        .refs()
        .map_err(|e| e.to_string())?
        .remotes
        .iter()
        .any(|r| r.name == request.remote)
    {
        return Err("That remote already exists. Choose a new remote name".into());
    }
    let account = accounts(path, &request.provider, &request.host)?;
    if account.account_id != request.account_id {
        return Err("The signed-in account changed; reload destinations".into());
    }
    let destination = account
        .destinations
        .into_iter()
        .find(|d| d.id == request.destination)
        .ok_or("Destination is no longer available to this account")?;
    let meta = repo.meta().map_err(|e| e.to_string())?;
    if meta.detached {
        return Err("Switch to a local branch before publishing".into());
    }
    let head = run_command(path, "git", &["rev-parse", "--verify", "HEAD"], &[])
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
        .unwrap_or_default()
        .trim()
        .to_string();
    let url = format!(
        "https://{}/{}/{}",
        request.host,
        destination
            .label
            .split('/')
            .map(segment)
            .collect::<Vec<_>>()
            .join("/"),
        segment(&request.name)
    );
    let state = PublishState {
        id: uuid::Uuid::new_v4().to_string(),
        request,
        account: account.account,
        destination,
        clone_url: format!("{url}.git"),
        url,
        branch: meta.branch,
        head,
        stage: "review".into(),
        error: None,
    };
    save(path, &state)?;
    Ok(state)
}

fn existing_endpoint(s: &PublishState) -> String {
    match s.request.provider.as_str() {
        "github" => format!(
            "repos/{}/{}",
            segment(&s.destination.label),
            segment(&s.request.name)
        ),
        "gitlab" => format!(
            "projects/{}",
            segment(&format!("{}/{}", s.destination.label, s.request.name))
        ),
        _ => format!(
            "repositories/{}/{}",
            segment(&s.destination.label),
            segment(&s.request.name)
        ),
    }
}
fn create_payload(s: &PublishState) -> (String, Value) {
    let r = &s.request;
    match r.provider.as_str() {
        "github" => (
            if s.destination.kind == "account" {
                "user/repos".into()
            } else {
                format!("orgs/{}/repos", segment(&s.destination.label))
            },
            json!({"name":r.name,"private":r.visibility == "private","auto_init":false}),
        ),
        "gitlab" => (
            "projects".into(),
            json!({"name":r.name,"path":r.name,"namespace_id":s.destination.id.parse::<u64>().unwrap_or(0),"visibility":r.visibility,"initialize_with_readme":false}),
        ),
        _ => (
            existing_endpoint(s),
            json!({"scm":"git","is_private":r.visibility == "private","name":r.name}),
        ),
    }
}

fn validate_created(s: &PublishState, v: &Value) -> Result<()> {
    let full = string(
        v,
        match s.request.provider.as_str() {
            "github" => "/full_name",
            "gitlab" => "/path_with_namespace",
            _ => "/full_name",
        },
    )?;
    if !full.eq_ignore_ascii_case(&format!("{}/{}", s.destination.label, s.request.name)) {
        return Err("Provider returned a different repository destination. Inspect it on the provider website".into());
    }
    let private = match s.request.provider.as_str() {
        "gitlab" => v["visibility"] == "private",
        "bitbucket" => v["is_private"] == true,
        _ => v["private"] == true,
    };
    if private != (s.request.visibility == "private") {
        return Err("Repository visibility differs from the reviewed choice. Inspect it on the provider website".into());
    }
    Ok(())
}

/// `check` is read-only recovery after an uncertain create. The next explicit
/// `attach` action is the user's decision to use the inspected destination.
pub fn advance(path: &str, id: &str, action: &str) -> Result<PublishState> {
    let _lock = PUBLISH_WRITE
        .lock()
        .map_err(|_| "Publish state lock failed")?;
    let s = state(path)?.ok_or("No publish recovery record")?;
    let request = s.request.clone();
    advance_using(
        path,
        id,
        action,
        s,
        &Client {
            cwd: path,
            provider: &request.provider,
            host: &request.host,
        },
    )
}

fn advance_using(
    path: &str,
    id: &str,
    action: &str,
    mut s: PublishState,
    api: &impl Api,
) -> Result<PublishState> {
    if s.id != id {
        return Err("The publish review changed. Reopen the dialog".into());
    }
    validate_request(&s.request)?;
    let destination_url = format!(
        "https://{}/{}/{}",
        s.request.host,
        s.destination
            .label
            .split('/')
            .map(segment)
            .collect::<Vec<_>>()
            .join("/"),
        segment(&s.request.name)
    );
    if s.url != destination_url || s.clone_url != format!("{destination_url}.git") {
        return Err(
            "The saved publish destination changed. Dismiss recovery and review it again".into(),
        );
    }
    s.error = None;
    let result = match action {
        "create" if s.stage == "review" => {
            let account = account(api, &s.request.provider)?;
            if account.account_id != s.request.account_id {
                return Err("The signed-in account changed; review the destination again".into());
            }
            // Persist before the POST: even a timeout/process exit must not
            // invite a blind duplicate creation on the next launch.
            s.stage = "uncertain".into();
            save(path, &s)?;
            let (endpoint, payload) = create_payload(&s);
            api.json("POST", &endpoint, Some(&payload))
                .and_then(|v| validate_created(&s, &v))
                .map(|_| {
                    s.stage = "created".into();
                })
        }
        "check" if s.stage == "uncertain" => api
            .json("GET", &existing_endpoint(&s), None)
            .and_then(|v| validate_created(&s, &v))
            .map(|_| {
                s.stage = "created".into();
            }),
        "attach" if s.stage == "created" => attach(path, &s).map(|_| {
            s.stage = "remote_ready".into();
        }),
        "push" if s.stage == "remote_ready" => push(path, &s).map(|_| {
            s.stage = "pushed".into();
        }),
        _ => return Err("That publish step is not available; refresh the recovery state".into()),
    };
    if let Err(error) = result {
        s.error = Some(error);
    }
    save(path, &s)?;
    Ok(s)
}

fn attach(path: &str, s: &PublishState) -> Result<()> {
    let repo = Repo::discover(path).map_err(|e| e.to_string())?;
    let refs = repo.refs().map_err(|e| e.to_string())?;
    if let Some(remote) = refs.remotes.iter().find(|r| r.name == s.request.remote) {
        if repo
            .configured_remote_url(&remote.name)
            .map_err(|e| e.to_string())?
            .as_deref()
            != Some(&s.clone_url)
            || remote.push_url.is_some()
        {
            return Err("The remote now exists with another destination. Resolve it in Manage remotes before retrying".into());
        }
    } else {
        repo.add_remote(&s.request.remote, &s.clone_url, None)
            .map_err(|e| e.to_string())?;
    }
    if s.request.host != "github.com" && s.request.provider == "github"
        || s.request.provider == "gitlab"
    {
        super::set_hosting_provider(path, &s.request.remote, &s.request.provider)?;
    }
    Ok(())
}

fn push(path: &str, s: &PublishState) -> Result<()> {
    if s.head.is_empty() {
        return Err("This repository had no commit at review time. Create a commit and use the ordinary Push action".into());
    }
    super::validate_commit(&s.head)?;
    let repo = Repo::discover(path).map_err(|e| e.to_string())?;
    let remote = repo
        .refs()
        .map_err(|e| e.to_string())?
        .remotes
        .into_iter()
        .find(|r| r.name == s.request.remote)
        .ok_or("Remote no longer exists")?;
    if repo
        .configured_remote_url(&remote.name)
        .map_err(|e| e.to_string())?
        .as_deref()
        != Some(&s.clone_url)
        || remote.push_url.is_some()
    {
        return Err("Remote destination changed; initial push stopped".into());
    }
    let effective = run_command(
        path,
        "git",
        &["remote", "get-url", "--push", "--all", &remote.name],
        &[],
    )?;
    if String::from_utf8_lossy(&effective).trim() != s.clone_url {
        return Err("Git URL rewriting changes the reviewed push destination; inspect remote configuration before pushing".into());
    }
    let meta = repo.meta().map_err(|e| e.to_string())?;
    if meta.detached || meta.branch != s.branch {
        return Err("The checked-out branch changed; use the ordinary Push action to review a new destination".into());
    }
    run_command(
        path,
        "git",
        &["check-ref-format", &format!("refs/heads/{}", s.branch)],
        &[],
    )?;
    // Pin the refspec to the reviewed object: a concurrent local commit cannot
    // silently expand the first publication. Never force an existing branch.
    run_command(
        path,
        "git",
        &[
            "push",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--",
            &s.request.remote,
            &format!("{}:refs/heads/{}", s.head, s.branch),
        ],
        &[("GIT_TERMINAL_PROMPT", "0")],
    )?;
    // Do not overwrite an existing upstream configuration.
    let upstream = run_command(
        path,
        "git",
        &["config", "--get", &format!("branch.{}.remote", s.branch)],
        &[],
    );
    if upstream.is_err() {
        run_command(path, "git", &["branch", &format!("--set-upstream-to={}/{}", s.request.remote, s.branch), &s.branch], &[])
            .map_err(|e| format!("Push succeeded, but upstream setup failed. Retry is safe (same reviewed commit): {e}"))?;
    }
    Ok(())
}

fn string(v: &Value, pointer: &str) -> Result<String> {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Provider returned no {pointer}"))
}

#[cfg(test)]
mod tests {
    use super::super::transport::fixtures::FixtureApi;
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        run_command(path, "git", &["init", "-q", "-b", "main"], &[]).unwrap();
        run_command(
            path,
            "git",
            &[
                "config",
                "core.hooksPath",
                dir.path().join("empty-hooks").to_str().unwrap(),
            ],
            &[],
        )
        .unwrap();
        run_command(
            path,
            "git",
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
            &[],
        )
        .unwrap();
        dir
    }
    fn plan() -> PublishState {
        PublishState {
            id: "fixture-plan".into(),
            request: PublishRequest {
                provider: "github".into(),
                host: "github.com".into(),
                account_id: "1".into(),
                destination: "me".into(),
                name: "app".into(),
                visibility: "private".into(),
                remote: "publish".into(),
            },
            account: "me".into(),
            destination: Destination {
                id: "me".into(),
                label: "me".into(),
                kind: "account".into(),
            },
            url: "https://github.com/me/app".into(),
            clone_url: "https://github.com/me/app.git".into(),
            branch: "main".into(),
            head: "a".repeat(40),
            stage: "review".into(),
            error: None,
        }
    }
    #[test]
    fn validates_names_visibility_cloud_scope_and_provider_creation_payloads() {
        let mut s = plan();
        assert_eq!(
            create_payload(&s),
            (
                "user/repos".into(),
                json!({"name":"app","private":true,"auto_init":false})
            )
        );
        s.destination.kind = "organization".into();
        assert_eq!(create_payload(&s).0, "orgs/me/repos");
        s.request.provider = "gitlab".into();
        s.destination.id = "123".into();
        assert_eq!(create_payload(&s).1["namespace_id"], 123);
        assert_eq!(create_payload(&s).1["initialize_with_readme"], false);
        s.request.provider = "bitbucket".into();
        s.request.host = "bitbucket.org".into();
        assert_eq!(create_payload(&s).0, "repositories/me/app");
        assert_eq!(create_payload(&s).1["is_private"], true);
        for name in ["../escape", "-option", "has space", "repo.git", "UpperCase"] {
            s.request.name = name.into();
            assert!(validate_request(&s.request).is_err());
        }
        s.request.name = "app".into();
        s.request.host = "server.example".into();
        assert!(validate_request(&s.request).is_err());
        s = plan();
        assert!(validate_created(&s, &json!({"full_name":"other/app","private":true})).is_err());
        assert!(validate_created(&s, &json!({"full_name":"me/app","private":false})).is_err());
    }
    #[test]
    fn failed_create_is_journaled_and_recovery_never_reposts() {
        let dir = fixture();
        let path = dir.path().to_str().unwrap();
        let api = FixtureApi::new(vec![
            ("GET", "user", Ok(json!({"id":1,"login":"me"}))),
            ("GET", "user/orgs?per_page=100", Ok(json!([]))),
            ("POST", "user/repos", Err("HTTP 403 or timeout".into())),
        ]);
        let s = advance_using(path, "fixture-plan", "create", plan(), &api).unwrap();
        assert_eq!(s.stage, "uncertain");
        assert!(s.error.unwrap().contains("403"));
        assert_eq!(state(path).unwrap().unwrap().stage, "uncertain");
        assert!(Repo::discover(path)
            .unwrap()
            .refs()
            .unwrap()
            .remotes
            .is_empty());
        api.done();
        let api = FixtureApi::new(vec![(
            "GET",
            "repos/me/app",
            Ok(json!({"full_name":"me/app","private":true})),
        )]);
        let s = advance_using(
            path,
            "fixture-plan",
            "check",
            state(path).unwrap().unwrap(),
            &api,
        )
        .unwrap();
        assert_eq!(s.stage, "created");
        assert!(api.writes.borrow().is_empty());
        api.done();
        let api = FixtureApi::new(vec![]);
        assert!(advance_using(path, "fixture-plan", "create", s, &api).is_err());
        api.done();
    }
    #[test]
    fn changed_account_stops_creation_and_remote_failure_is_resumable() {
        let dir = fixture();
        let path = dir.path().to_str().unwrap();
        let api = FixtureApi::new(vec![
            ("GET", "user", Ok(json!({"id":2,"login":"other"}))),
            ("GET", "user/orgs?per_page=100", Ok(json!([]))),
        ]);
        assert!(advance_using(path, "fixture-plan", "create", plan(), &api)
            .unwrap_err()
            .contains("account changed"));
        assert!(api.writes.borrow().is_empty());
        let repo = Repo::discover(path).unwrap();
        repo.add_remote("publish", "https://example.test/other.git", None)
            .unwrap();
        let mut s = plan();
        s.stage = "created".into();
        let api = FixtureApi::new(vec![]);
        let s = advance_using(path, "fixture-plan", "attach", s, &api).unwrap();
        assert_eq!(s.stage, "created");
        assert!(s.error.as_ref().unwrap().contains("another destination"));
        repo.remove_remote("publish").unwrap();
        let s = advance_using(path, "fixture-plan", "attach", s, &api).unwrap();
        assert_eq!(s.stage, "remote_ready");
        assert_eq!(
            repo.configured_remote_url("publish").unwrap().unwrap(),
            s.clone_url
        );
        assert!(repo.refs().unwrap().remote_branches.is_empty());
        api.done();
    }
    #[test]
    fn explicit_push_sends_only_reviewed_object_and_preserves_existing_upstream() {
        let dir = fixture();
        let path = dir.path().to_str().unwrap();
        let bare = tempfile::tempdir().unwrap();
        run_command(
            bare.path().to_str().unwrap(),
            "git",
            &["init", "--bare", "-q"],
            &[],
        )
        .unwrap();
        let mut s = plan();
        s.clone_url = bare.path().to_str().unwrap().into();
        s.head = String::from_utf8(run_command(path, "git", &["rev-parse", "HEAD"], &[]).unwrap())
            .unwrap()
            .trim()
            .into();
        attach(path, &s).unwrap();
        run_command(
            path,
            "git",
            &["config", "branch.main.remote", "upstream"],
            &[],
        )
        .unwrap();
        run_command(
            path,
            "git",
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "new local commit",
            ],
            &[],
        )
        .unwrap();
        push(path, &s).unwrap();
        let pushed = run_command(
            bare.path().to_str().unwrap(),
            "git",
            &["rev-parse", "refs/heads/main"],
            &[],
        )
        .unwrap();
        assert_eq!(String::from_utf8_lossy(&pushed).trim(), s.head);
        assert_eq!(
            String::from_utf8_lossy(
                &run_command(path, "git", &["config", "branch.main.remote"], &[]).unwrap()
            )
            .trim(),
            "upstream"
        );
        Repo::discover(path)
            .unwrap()
            .set_remote_urls(
                "publish",
                &s.clone_url,
                Some("https://elsewhere.test/app.git"),
            )
            .unwrap();
        assert!(push(path, &s).unwrap_err().contains("destination changed"));
    }
}
