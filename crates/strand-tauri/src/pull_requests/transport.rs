//! Host-scoped hosted API transport. Credentials never cross provider origins.
use super::{run_command_input, Result};
use serde_json::Value;
use std::{collections::HashSet, io::Read, time::Duration};
use zeroize::Zeroizing;

pub(crate) fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

pub(crate) fn validate_host(host: &str) -> Result<()> {
    let url =
        url::Url::parse(&format!("https://{host}/")).map_err(|_| "Invalid hosting hostname")?;
    if host.is_empty()
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || host.contains(['/', '\\', '@', '?', '#', '\r', '\n'])
    {
        return Err(
            "Enter a hostname with optional port, without a URL path or credentials".into(),
        );
    }
    Ok(())
}

pub(crate) trait Api {
    fn request(&self, method: &str, endpoint: &str, body: Option<&Value>) -> Result<Vec<u8>>;
    fn json(&self, method: &str, endpoint: &str, body: Option<&Value>) -> Result<Value> {
        let bytes = self.request(method, endpoint, body)?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON".into())
    }
}

pub(crate) struct Client<'a> {
    pub cwd: &'a str,
    pub provider: &'a str,
    pub host: &'a str,
}

impl Api for Client<'_> {
    fn request(&self, method: &str, endpoint: &str, body: Option<&Value>) -> Result<Vec<u8>> {
        validate_host(self.host)?;
        if endpoint.starts_with('/')
            || endpoint.contains("://")
            || endpoint.contains(['\r', '\n', '\0'])
        {
            return Err("Invalid provider API endpoint".into());
        }
        let input = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|e| e.to_string())?;
        if self.provider == "bitbucket" {
            if self.host != "bitbucket.org" {
                return Err("Only Bitbucket Cloud is supported".into());
            }
            // API tokens use the API origin and Atlassian account email. Never
            // reuse a GitHub/GitLab token or send credentials to a returned link.
            let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
            let bytes = Zeroizing::new(run_command_input(
                &scratch.path().to_string_lossy(), "git", &["credential", "fill"],
                &[("GIT_TERMINAL_PROMPT", "0"), ("GCM_INTERACTIVE", "never")],
                Some(b"protocol=https\nhost=api.bitbucket.org\n\n"),
            ).map_err(|_| "Configure a Bitbucket API credential for https://api.bitbucket.org in your Git credential helper (Atlassian email and scoped API token)".to_string())?);
            let credential =
                std::str::from_utf8(&bytes).map_err(|_| "Invalid Bitbucket credential")?;
            let username = credential
                .lines()
                .find_map(|line| line.strip_prefix("username="))
                .ok_or("Bitbucket API credential has no username")?;
            let password = credential
                .lines()
                .find_map(|line| line.strip_prefix("password="))
                .ok_or("Bitbucket API credential has no token")?;
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?;
            let mut request = client
                .request(
                    method.parse().map_err(|_| "Invalid HTTP method")?,
                    format!("https://api.bitbucket.org/2.0/{endpoint}"),
                )
                .basic_auth(username, Some(password))
                .header("Accept", "application/json");
            if let Some(input) = input {
                request = request
                    .header("Content-Type", "application/json")
                    .body(input);
            }
            let mut response = request
                .send()
                .map_err(|_| "Bitbucket API request failed; check your connection")?;
            // Cloud's PR diff endpoint redirects to the same repository's
            // immutable diff route. Follow only that documented read redirect.
            if response.status().is_redirection() && method == "GET" && endpoint.ends_with("/diff")
            {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or("Bitbucket diff redirect has no location")?;
                let location = bitbucket_diff_redirect(location, endpoint)?;
                response = client
                    .get(location)
                    .basic_auth(username, Some(password))
                    .send()
                    .map_err(|_| "Bitbucket diff request failed")?;
            }
            if !response.status().is_success() {
                return Err(format!("Bitbucket API returned HTTP {}. Check account permissions and token scopes; refresh before retrying a write.", response.status()));
            }
            let mut bytes = Vec::new();
            response
                .take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 16 * 1024 * 1024 {
                return Err("Provider response exceeds 16 MB".into());
            }
            return Ok(bytes);
        }
        let cli = if self.provider == "github" {
            "gh"
        } else {
            "glab"
        };
        let mut args = vec!["api", "--hostname", self.host, "--method", method, endpoint];
        if input.is_some() {
            args.extend(["--input", "-"]);
        }
        let bytes = run_command_input(
            self.cwd,
            cli,
            &args,
            &[
                ("GH_HOST", self.host),
                ("GH_PROMPT_DISABLED", "1"),
                ("GITLAB_HOST", self.host),
                ("GLAB_CHECK_UPDATE", "false"),
            ],
            input.as_deref(),
        )?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("Provider response exceeds 16 MB".into());
        }
        Ok(bytes)
    }
}

/// Fully traverse new adapters' collections. Fail explicitly on malformed,
/// repeated, or oversized pagination instead of reporting a partial set.
pub(crate) fn pages(api: &impl Api, endpoint: &str, bitbucket: bool) -> Result<Vec<Value>> {
    let join = if endpoint.contains('?') { '&' } else { '?' };
    let mut next = format!(
        "{endpoint}{join}{}=100",
        if bitbucket { "pagelen" } else { "per_page" }
    );
    let mut visited = HashSet::new();
    let mut ids = HashSet::new();
    let mut items = Vec::new();
    for page in 1..=500 {
        if !visited.insert(next.clone()) {
            return Err("Provider repeated a pagination cursor; collection is incomplete".into());
        }
        let value = api.json("GET", &next, None)?;
        let rows = if bitbucket {
            value.get("values")
        } else {
            Some(&value)
        }
        .and_then(Value::as_array)
        .ok_or("Provider returned an invalid collection")?;
        for row in rows {
            let id = row
                .get("id")
                .or_else(|| row.get("uuid"))
                .or_else(|| row.get("hash"))
                .map(Value::to_string);
            if id.is_none() || ids.insert(id.unwrap()) {
                items.push(row.clone());
            }
        }
        if bitbucket {
            let Some(link) = value.get("next").and_then(Value::as_str) else {
                return Ok(items);
            };
            next = bitbucket_next(link, endpoint)?;
        } else {
            if rows.len() < 100 {
                return Ok(items);
            }
            next = format!("{endpoint}{join}per_page=100&page={}", page + 1);
        }
    }
    Err("Provider collection exceeds 500 pages; narrow the query on the provider website".into())
}

fn bitbucket_next(link: &str, endpoint: &str) -> Result<String> {
    let url = url::Url::parse(link).map_err(|_| "Invalid Bitbucket pagination link")?;
    let original_path = endpoint.split('?').next().unwrap_or_default();
    if url.scheme() != "https"
        || url.host_str() != Some("api.bitbucket.org")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.path() != format!("/2.0/{original_path}")
    {
        return Err("Rejected Bitbucket pagination outside the requested API collection".into());
    }
    Ok(format!(
        "{}{}",
        url.path().trim_start_matches("/2.0/"),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    ))
}

fn bitbucket_diff_redirect(link: &str, endpoint: &str) -> Result<url::Url> {
    let url = url::Url::parse(link).map_err(|_| "Invalid Bitbucket diff redirect")?;
    let repo = endpoint
        .split("/pullrequests/")
        .next()
        .ok_or("Invalid Bitbucket diff route")?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.bitbucket.org")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with(&format!("/2.0/{repo}/diff/"))
    {
        return Err("Rejected Bitbucket diff redirect outside this repository".into());
    }
    Ok(url)
}

pub(super) struct GitHubContext<'a> {
    pub path: &'a str,
    pub host: &'a str,
}

impl GitHubContext<'_> {
    pub fn scope_avatar(&self, avatar: &mut Option<String>) {
        if self.host != "github.com" {
            if let Some(path) = avatar
                .as_ref()
                .and_then(|url| url.strip_prefix("https://github.com/"))
            {
                *avatar = Some(format!("https://{}/{path}", self.host));
            }
        }
    }
    pub fn slug(&self, owner: &str, repo: &str) -> String {
        if self.host == "github.com" {
            format!("{owner}/{repo}")
        } else {
            format!("{}/{owner}/{repo}", self.host)
        }
    }
}

pub(super) fn github_command(
    cwd: &GitHubContext<'_>,
    program: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<Vec<u8>> {
    github_command_input(cwd, program, args, envs, None)
}

pub(super) fn github_command_input(
    cwd: &GitHubContext<'_>,
    program: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    input: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut scoped = envs.to_vec();
    scoped.push(("GH_HOST", cwd.host));
    // Explicit --hostname also scopes GraphQL IDs, viewer identity and REST.
    let mut args = args.to_vec();
    if program == "gh" && args.first() == Some(&"api") {
        args.extend(["--hostname", cwd.host]);
    }
    run_command_input(cwd.path, program, &args, &scoped, input)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use std::{cell::RefCell, collections::VecDeque};
    pub struct FixtureApi {
        steps: RefCell<VecDeque<(String, String, Result<Value>)>>,
        pub writes: RefCell<Vec<(String, Value)>>,
    }
    impl FixtureApi {
        pub fn new(steps: Vec<(&str, &str, Result<Value>)>) -> Self {
            Self {
                steps: RefCell::new(
                    steps
                        .into_iter()
                        .map(|(m, e, v)| (m.into(), e.into(), v))
                        .collect(),
                ),
                writes: RefCell::new(vec![]),
            }
        }
        pub fn done(&self) {
            assert!(
                self.steps.borrow().is_empty(),
                "Unconsumed fixture requests: {:?}",
                self.steps.borrow()
            );
        }
    }
    impl Api for FixtureApi {
        fn request(&self, method: &str, endpoint: &str, body: Option<&Value>) -> Result<Vec<u8>> {
            let (m, e, response) = self
                .steps
                .borrow_mut()
                .pop_front()
                .expect("Unexpected API request");
            assert_eq!((method, endpoint), (m.as_str(), e.as_str()));
            if method != "GET" {
                self.writes
                    .borrow_mut()
                    .push((endpoint.into(), body.cloned().unwrap_or(Value::Null)));
            }
            response.map(|v| serde_json::to_vec(&v).unwrap())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fixtures::FixtureApi;
    use serde_json::json;
    #[test]
    fn github_identity_preserves_public_follows_and_separates_custom_hosts() {
        let public = GitHubContext {
            path: ".",
            host: "github.com",
        };
        let enterprise = GitHubContext {
            path: ".",
            host: "git.example:8443",
        };
        assert_eq!(public.slug("team", "app"), "team/app");
        assert_eq!(enterprise.slug("team", "app"), "git.example:8443/team/app");
        let mut avatar = Some("https://github.com/reviewer.png?size=80".into());
        enterprise.scope_avatar(&mut avatar);
        assert_eq!(
            avatar.as_deref(),
            Some("https://git.example:8443/reviewer.png?size=80")
        );
    }
    #[test]
    fn gitlab_paginates_and_deduplicates_101_entries() {
        let first = (1..=100).map(|id| json!({"id":id})).collect::<Vec<_>>();
        let api = FixtureApi::new(vec![
            (
                "GET",
                "projects/a%2Fb/merge_requests?per_page=100",
                Ok(json!(first)),
            ),
            (
                "GET",
                "projects/a%2Fb/merge_requests?per_page=100&page=2",
                Ok(json!([{"id":100},{"id":101}])),
            ),
        ]);
        assert_eq!(
            pages(&api, "projects/a%2Fb/merge_requests", false)
                .unwrap()
                .len(),
            101
        );
        api.done();
    }
    #[test]
    fn bitbucket_follows_opaque_next_even_on_short_pages() {
        let api = FixtureApi::new(vec![
            (
                "GET",
                "repositories/a/b/pullrequests?pagelen=100",
                Ok(
                    json!({"values":[{"id":1}],"next":"https://api.bitbucket.org/2.0/repositories/a/b/pullrequests?cursor=opaque"}),
                ),
            ),
            (
                "GET",
                "repositories/a/b/pullrequests?cursor=opaque",
                Ok(json!({"values":[{"id":1},{"id":2}]})),
            ),
        ]);
        assert_eq!(
            pages(&api, "repositories/a/b/pullrequests", true)
                .unwrap()
                .len(),
            2
        );
        api.done();
    }
    #[test]
    fn pagination_fails_on_permission_errors_and_foreign_cursors() {
        let api = FixtureApi::new(vec![(
            "GET",
            "user/workspaces?pagelen=100",
            Err("HTTP 403".into()),
        )]);
        assert!(pages(&api, "user/workspaces", true)
            .unwrap_err()
            .contains("403"));
        for link in [
            "https://evil.test/2.0/user/workspaces?page=2",
            "https://api.bitbucket.org/2.0/user?page=2",
            "http://api.bitbucket.org/2.0/user/workspaces",
            "https://token@api.bitbucket.org/2.0/user/workspaces",
        ] {
            assert!(bitbucket_next(link, "user/workspaces").is_err());
        }
        assert!(bitbucket_diff_redirect(
            "https://api.bitbucket.org/2.0/repositories/a/b/diff/head..base",
            "repositories/a/b/pullrequests/1/diff"
        )
        .is_ok());
        assert!(bitbucket_diff_redirect(
            "https://api.bitbucket.org/2.0/repositories/other/b/diff/head",
            "repositories/a/b/pullrequests/1/diff"
        )
        .is_err());
    }
    #[test]
    fn hostname_rejects_credentials_paths_and_query_strings() {
        for host in [
            "https://git.example",
            "token@git.example",
            "git.example/api",
            "git.example?x=1",
            "",
            "git.example\\x",
        ] {
            assert!(validate_host(host).is_err(), "{host}");
        }
        assert!(validate_host("git.example:8443").is_ok());
        assert_eq!(segment("nested/team x/repo"), "nested%2Fteam%20x%2Frepo");
    }
}
