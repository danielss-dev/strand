//! Shared, versioned contract between Strand and the optional Azure DevOps
//! Server helper. Keep this crate small: the desktop app must not link the
//! helper's HTTP or credential-vault implementation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 4;
pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    Pat,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerProfile {
    pub id: Uuid,
    pub name: String,
    pub collection_url: String,
    pub auth_mode: AuthMode,
    #[serde(default)]
    pub remote_prefixes: Vec<String>,
    #[serde(default)]
    pub ca_certificate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileConfig {
    pub schema_version: u32,
    pub enabled: bool,
    #[serde(default)]
    pub profiles: Vec<ServerProfile>,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            enabled: false,
            profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryCoordinates {
    pub profile_id: Uuid,
    pub project: String,
    pub repository: String,
    pub remote: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    pub profile_id: Uuid,
    pub operation: Operation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    TestConnection,
    Viewer,
    ListPullRequests {
        project: String,
        repository: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_branch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        top: u32,
    },
    ShowPullRequest {
        project: String,
        repository: String,
        id: u64,
    },
    CreatePullRequest {
        project: String,
        repository: String,
        source_branch: String,
        target_branch: String,
        title: String,
        description: String,
        is_draft: bool,
    },
    Threads {
        project: String,
        repository: String,
        id: u64,
    },
    Commits {
        project: String,
        repository: String,
        id: u64,
    },
    Policies {
        project: String,
        project_id: String,
        id: u64,
    },
    AddComment {
        project: String,
        repository: String,
        id: u64,
        body: String,
    },
    MarkReady {
        project: String,
        repository: String,
        id: u64,
    },
    SetStatus {
        project: String,
        repository: String,
        id: u64,
        status: PullRequestStatus,
    },
    SetVote {
        project: String,
        repository: String,
        id: u64,
        reviewer_id: String,
        vote: ReviewVote,
    },
    Complete {
        project: String,
        repository: String,
        id: u64,
        expected_head: String,
        strategy: MergeStrategy,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestStatus {
    Active,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVote {
    Approve,
    RequestChanges,
    Reset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeStrategy {
    MergeCommit,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

impl ResponseEnvelope {
    pub fn success(request_id: String, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(request_id: String, error: ProtocolError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Disabled,
    NotInstalled,
    ProtocolMismatch,
    ProfileNotFound,
    AuthRequired,
    PermissionDenied,
    Tls,
    Timeout,
    ServerUnsupported,
    InvalidResponse,
    ResponseTooLarge,
    Conflict,
    Validation,
    CredentialStore,
    Network,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Resolve an HTTPS or SSH clone URL against configured collection prefixes.
/// The longest normalized prefix wins; an equal-length ambiguity is rejected.
pub fn resolve_remote(
    config: &ProfileConfig,
    remote_name: &str,
    remote_url: &str,
) -> Result<Option<RepositoryCoordinates>, ProtocolError> {
    if !config.enabled {
        return Ok(None);
    }
    let normalized_remote = normalize_remote(remote_url);
    let mut matches = Vec::new();
    for profile in &config.profiles {
        let mut profile_match = None;
        for prefix in std::iter::once(&profile.collection_url).chain(&profile.remote_prefixes) {
            let normalized_prefix = normalize_remote(prefix);
            let Some(suffix) = normalized_remote.strip_prefix(&normalized_prefix) else {
                continue;
            };
            if !suffix.starts_with('/') {
                continue;
            }
            if let Some((project, repository)) = parse_repo_suffix(suffix) {
                let candidate = (normalized_prefix.len(), profile.id, project, repository);
                if profile_match
                    .as_ref()
                    .is_none_or(|current: &(usize, Uuid, String, String)| candidate.0 > current.0)
                {
                    profile_match = Some(candidate);
                }
            }
        }
        if let Some(candidate) = profile_match {
            matches.push(candidate);
        }
    }
    matches.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    let Some(best) = matches.first() else {
        return Ok(None);
    };
    if matches
        .get(1)
        .is_some_and(|other| other.0 == best.0 && other.1 != best.1)
    {
        return Err(ProtocolError {
            code: ErrorCode::Validation,
            message: "The repository remote matches more than one Azure DevOps Server profile"
                .into(),
            status: None,
        });
    }
    Ok(Some(RepositoryCoordinates {
        profile_id: best.1,
        project: percent_decode(&best.2),
        repository: percent_decode(&best.3),
        remote: remote_name.to_string(),
    }))
}

pub fn validate_profile(profile: &ServerProfile) -> Result<(), ProtocolError> {
    if profile.name.trim().is_empty() || profile.name.len() > 128 {
        return validation("Profile name must be between 1 and 128 characters");
    }
    let url = Url::parse(&profile.collection_url)
        .map_err(|_| protocol_validation("Collection URL is not valid"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return validation(
            "Collection URL must be an HTTPS URL without credentials, query, or fragment",
        );
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "dev.azure.com" || host.ends_with(".visualstudio.com") {
        return validation("Azure DevOps Services continues to use the official az CLI");
    }
    if profile
        .remote_prefixes
        .iter()
        .any(|prefix| !valid_remote_prefix(prefix))
    {
        return validation("Remote prefixes must use HTTPS or SSH clone URL syntax");
    }
    if profile.auth_mode == AuthMode::Windows && profile.ca_certificate.is_some() {
        return validation("Windows authentication uses the Windows trusted-root store");
    }
    Ok(())
}

fn valid_remote_prefix(value: &str) -> bool {
    let value = value.trim();
    if let Ok(url) = Url::parse(value) {
        return matches!(url.scheme(), "https" | "ssh") && url.host_str().is_some();
    }
    // Git's scp-like SSH syntax, for example git@server:tfs/Collection.
    value.split_once(':').is_some_and(|(host, path)| {
        !host.contains('/') && host.contains('@') && !path.trim_matches('/').is_empty()
    })
}

fn validation<T>(message: &str) -> Result<T, ProtocolError> {
    Err(protocol_validation(message))
}

fn protocol_validation(message: &str) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Validation,
        message: message.into(),
        status: None,
    }
}

fn normalize_remote(value: &str) -> String {
    let trimmed = value
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .replace('\\', "/");
    if let Ok(url) = Url::parse(&trimmed) {
        if matches!(url.scheme(), "https" | "ssh") {
            if let Some(host) = url.host_str() {
                return format!(
                    "{}/{}",
                    host.to_ascii_lowercase(),
                    url.path().trim_matches('/')
                )
                .trim_end_matches('/')
                .to_string();
            }
        }
    }
    if let Some((authority, path)) = trimmed.split_once(':') {
        if !authority.contains('/') {
            let host = authority.split('@').next_back().unwrap_or(authority);
            return format!("{}/{}", host.to_ascii_lowercase(), path.trim_matches('/'));
        }
    }
    trimmed
}

fn parse_repo_suffix(suffix: &str) -> Option<(String, String)> {
    let parts = suffix
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let git = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case("_git"))?;
    if git == 0 || git + 1 >= parts.len() || git + 2 != parts.len() {
        return None;
    }
    Some((parts[..git].join("/"), parts[git + 1].to_string()))
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

    fn profile(id: Uuid, prefix: &str) -> ServerProfile {
        ServerProfile {
            id,
            name: "Corp".into(),
            collection_url: "https://ado.corp/tfs/DefaultCollection".into(),
            auth_mode: AuthMode::Pat,
            remote_prefixes: vec![prefix.into()],
            ca_certificate: None,
        }
    }

    #[test]
    fn resolves_https_and_percent_encoded_names() {
        let id = Uuid::new_v4();
        let config = ProfileConfig {
            enabled: true,
            profiles: vec![profile(id, "https://ado.corp/tfs/DefaultCollection")],
            ..ProfileConfig::default()
        };
        let found = resolve_remote(
            &config,
            "origin",
            "https://ado.corp/tfs/DefaultCollection/My%20Project/_git/web.git",
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.profile_id, id);
        assert_eq!(found.project, "My Project");
        assert_eq!(found.repository, "web");
    }

    #[test]
    fn collection_url_resolves_project_and_repository_without_extra_prefixes() {
        let id = Uuid::new_v4();
        let mut server = profile(id, "https://unused.invalid");
        server.collection_url = "https://azdo.example.test/tfs/DefaultCollection".into();
        server.remote_prefixes.clear();
        let config = ProfileConfig {
            enabled: true,
            profiles: vec![server],
            ..ProfileConfig::default()
        };

        let found = resolve_remote(
            &config,
            "origin",
            "https://azdo.example.test/tfs/DefaultCollection/ExampleProject/_git/ExampleRepo",
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.profile_id, id);
        assert_eq!(found.project, "ExampleProject");
        assert_eq!(found.repository, "ExampleRepo");

        let found = resolve_remote(
            &config,
            "origin",
            "ssh://git@azdo.example.test:22/tfs/DefaultCollection/ExampleProject/_git/ExampleRepo",
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.project, "ExampleProject");
        assert_eq!(found.repository, "ExampleRepo");
    }

    #[test]
    fn longest_prefix_wins_and_equal_matches_fail() {
        let broad = Uuid::new_v4();
        let narrow = Uuid::new_v4();
        let mut broad_profile = profile(broad, "ssh://ado.corp");
        broad_profile.collection_url = "https://ado.corp".into();
        let config = ProfileConfig {
            enabled: true,
            profiles: vec![
                broad_profile,
                profile(narrow, "ssh://ado.corp/tfs/DefaultCollection"),
            ],
            ..ProfileConfig::default()
        };
        let found = resolve_remote(
            &config,
            "origin",
            "ssh://ado.corp/tfs/DefaultCollection/Project/_git/api",
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.profile_id, narrow);

        let config = ProfileConfig {
            enabled: true,
            profiles: vec![
                profile(broad, "ssh://ado.corp/tfs/DefaultCollection"),
                profile(narrow, "ssh://ado.corp/tfs/DefaultCollection"),
            ],
            ..ProfileConfig::default()
        };
        assert!(resolve_remote(
            &config,
            "origin",
            "ssh://ado.corp/tfs/DefaultCollection/Project/_git/api",
        )
        .is_err());
    }

    #[test]
    fn rejects_cloud_and_non_https_profiles() {
        let mut value = profile(Uuid::new_v4(), "https://dev.azure.com/acme");
        value.collection_url = "https://dev.azure.com/acme".into();
        assert!(validate_profile(&value).is_err());
        value.collection_url = "http://ado.corp/tfs/DefaultCollection".into();
        assert!(validate_profile(&value).is_err());
    }

    #[test]
    fn validates_remote_prefix_schemes_and_strict_envelopes() {
        let mut value = profile(Uuid::new_v4(), "git@ado.corp:tfs/DefaultCollection");
        assert!(validate_profile(&value).is_ok());
        value.remote_prefixes = vec!["http://ado.corp/tfs/DefaultCollection".into()];
        assert!(validate_profile(&value).is_err());

        let request = serde_json::json!({
            "protocol_version": PROTOCOL_VERSION,
            "request_id": "req",
            "profile_id": Uuid::new_v4(),
            "operation": {"type": "viewer"},
            "unexpected": true
        });
        assert!(serde_json::from_value::<RequestEnvelope>(request).is_err());
    }
}
