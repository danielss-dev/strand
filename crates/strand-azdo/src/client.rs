use std::{fs, io::Read, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{
    blocking::{Client, Response},
    redirect::Policy,
    Method, StatusCode,
};
use serde_json::{json, Value};
use strand_azdo_protocol::{
    AuthMode, ErrorCode, MergeStrategy, Operation, ProtocolError, ServerProfile, MAX_RESPONSE_BYTES,
};
use url::Url;
use zeroize::Zeroizing;

use crate::{config, credentials};

const API_VERSION: &str = "6.0";
const CONNECTION_API_VERSION: &str = "6.0-preview.1";
const POLICY_API_VERSION: &str = "6.0-preview.1";

pub fn execute(profile: &ServerProfile, operation: Operation) -> Result<Value, ProtocolError> {
    match profile.auth_mode {
        AuthMode::Pat => PatClient::new(profile)?.execute(operation),
        AuthMode::Windows => windows::execute(profile, operation),
    }
}

struct PatClient {
    profile: ServerProfile,
    client: Client,
    authorization: Zeroizing<String>,
}

impl PatClient {
    fn new(profile: &ServerProfile) -> Result<Self, ProtocolError> {
        let ca = config::ca_path(profile)?
            .map(fs::read)
            .transpose()
            .map_err(|_| {
                config::error(ErrorCode::Tls, "Could not read the profile CA certificate")
            })?;
        let token = credentials::get(profile.id)?;
        Self::with_token(profile, token, ca.as_deref())
    }

    fn with_token(
        profile: &ServerProfile,
        token: Zeroizing<String>,
        ca: Option<&[u8]>,
    ) -> Result<Self, ProtocolError> {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .user_agent(concat!("strand-azdo/", env!("CARGO_PKG_VERSION")));
        if let Some(bytes) = ca {
            let certificate = reqwest::Certificate::from_pem(bytes).map_err(|_| {
                config::error(ErrorCode::Tls, "The profile CA certificate is invalid")
            })?;
            // Use the explicitly imported profile CA as the trust boundary.
            // This avoids platform-verifier differences for private roots and
            // keeps PAT profiles deterministic across desktop platforms.
            builder = builder.tls_certs_only([certificate]);
        }
        let client = builder.build().map_err(|_| {
            config::error(ErrorCode::Tls, "Could not initialize secure HTTP transport")
        })?;
        let mut basic = Zeroizing::new(Vec::with_capacity(token.len() + 1));
        basic.push(b':');
        basic.extend_from_slice(token.as_bytes());
        let mut authorization = Zeroizing::new(String::from("Basic "));
        STANDARD.encode_string(basic.as_slice(), &mut authorization);
        Ok(Self {
            profile: profile.clone(),
            client,
            authorization,
        })
    }

    fn execute(&self, operation: Operation) -> Result<Value, ProtocolError> {
        let spec = request_spec(operation);
        let result = self.request(
            spec.method.clone(),
            &spec.path,
            &spec.query,
            spec.body.clone(),
        )?;
        Ok(spec.finish(result))
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, ProtocolError> {
        let mut url = collection_url(&self.profile, path)?;
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(key, value)| (*key, value)));
        let mut request = self
            .client
            .request(method, url)
            .header("Authorization", self.authorization.as_str());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(map_reqwest)?;
        parse_response(response)
    }
}

struct RequestSpec {
    method: Method,
    path: String,
    query: Vec<(&'static str, String)>,
    body: Option<Value>,
    unwrap_value: bool,
}

impl RequestSpec {
    fn finish(&self, value: Value) -> Value {
        if self.unwrap_value {
            value.get("value").cloned().unwrap_or(value)
        } else {
            value
        }
    }
}

fn request_spec(operation: Operation) -> RequestSpec {
    let api = || vec![("api-version", API_VERSION.into())];
    match operation {
        Operation::TestConnection | Operation::Viewer => RequestSpec {
            method: Method::GET,
            path: "_apis/connectionData".into(),
            query: vec![
                ("connectOptions", "1".into()),
                ("api-version", CONNECTION_API_VERSION.into()),
            ],
            body: None,
            unwrap_value: false,
        },
        Operation::ListPullRequests {
            project,
            repository,
            source_branch,
            status,
            top,
        } => {
            let mut query = vec![
                (
                    "searchCriteria.status",
                    status.unwrap_or_else(|| "all".into()),
                ),
                ("$top", top.min(100).to_string()),
                ("api-version", API_VERSION.into()),
            ];
            if let Some(branch) = source_branch {
                query.push(("searchCriteria.sourceRefName", full_ref(&branch)));
            }
            RequestSpec {
                method: Method::GET,
                path: git_path(&project, &repository, "pullrequests"),
                query,
                body: None,
                unwrap_value: true,
            }
        }
        Operation::ShowPullRequest {
            project,
            repository,
            id,
        } => RequestSpec {
            method: Method::GET,
            path: git_path(&project, &repository, &format!("pullrequests/{id}")),
            query: api(),
            body: None,
            unwrap_value: false,
        },
        Operation::CreatePullRequest {
            project,
            repository,
            source_branch,
            target_branch,
            title,
            description,
            is_draft,
        } => RequestSpec {
            method: Method::POST,
            path: git_path(&project, &repository, "pullrequests"),
            query: api(),
            body: Some(json!({
                "sourceRefName": full_ref(&source_branch),
                "targetRefName": full_ref(&target_branch),
                "title": title,
                "description": description,
                "isDraft": is_draft,
                "supportsIterations": true
            })),
            unwrap_value: false,
        },
        Operation::Threads {
            project,
            repository,
            id,
        } => RequestSpec {
            method: Method::GET,
            path: git_path(&project, &repository, &format!("pullrequests/{id}/threads")),
            query: api(),
            body: None,
            unwrap_value: false,
        },
        Operation::Commits {
            project,
            repository,
            id,
        } => RequestSpec {
            method: Method::GET,
            path: git_path(&project, &repository, &format!("pullrequests/{id}/commits")),
            query: vec![("api-version", API_VERSION.into()), ("$top", "100".into())],
            body: None,
            unwrap_value: false,
        },
        Operation::Policies {
            project,
            project_id,
            id,
        } => RequestSpec {
            method: Method::GET,
            path: format!("{}/_apis/policy/evaluations", encode_segment(&project)),
            query: vec![
                (
                    "artifactId",
                    format!("vstfs:///CodeReview/CodeReviewId/{project_id}/{id}"),
                ),
                ("$top", "100".into()),
                ("api-version", POLICY_API_VERSION.into()),
            ],
            body: None,
            unwrap_value: false,
        },
        Operation::AddComment {
            project,
            repository,
            id,
            body,
        } => RequestSpec {
            method: Method::POST,
            path: git_path(&project, &repository, &format!("pullrequests/{id}/threads")),
            query: api(),
            body: Some(json!({
                "comments": [{"parentCommentId": 0, "content": body, "commentType": 1}],
                "status": 1
            })),
            unwrap_value: false,
        },
        Operation::MarkReady {
            project,
            repository,
            id,
        } => RequestSpec {
            method: Method::PATCH,
            path: git_path(&project, &repository, &format!("pullrequests/{id}")),
            query: api(),
            body: Some(json!({"isDraft": false})),
            unwrap_value: false,
        },
        Operation::SetStatus {
            project,
            repository,
            id,
            status,
        } => RequestSpec {
            method: Method::PATCH,
            path: git_path(&project, &repository, &format!("pullrequests/{id}")),
            query: api(),
            body: Some(json!({
                "status": match status {
                    strand_azdo_protocol::PullRequestStatus::Active => "active",
                    strand_azdo_protocol::PullRequestStatus::Abandoned => "abandoned",
                }
            })),
            unwrap_value: false,
        },
        Operation::SetVote {
            project,
            repository,
            id,
            reviewer_id,
            vote,
        } => RequestSpec {
            method: Method::PUT,
            path: git_path(
                &project,
                &repository,
                &format!(
                    "pullrequests/{id}/reviewers/{}",
                    encode_segment(&reviewer_id)
                ),
            ),
            query: api(),
            body: Some(json!({
                "vote": match vote {
                    strand_azdo_protocol::ReviewVote::Approve => 10,
                    strand_azdo_protocol::ReviewVote::RequestChanges => -10,
                    strand_azdo_protocol::ReviewVote::Reset => 0,
                }
            })),
            unwrap_value: false,
        },
        Operation::Complete {
            project,
            repository,
            id,
            expected_head,
            strategy,
        } => RequestSpec {
            method: Method::PATCH,
            path: git_path(&project, &repository, &format!("pullrequests/{id}")),
            query: api(),
            body: Some(json!({
                "status": "completed",
                "lastMergeSourceCommit": {"commitId": expected_head},
                "completionOptions": {
                    "mergeStrategy": match strategy {
                        MergeStrategy::MergeCommit => "noFastForward",
                        MergeStrategy::Squash => "squash",
                        MergeStrategy::Rebase => "rebase"
                    },
                    "deleteSourceBranch": false,
                    "transitionWorkItems": false
                }
            })),
            unwrap_value: false,
        },
    }
}

fn collection_url(profile: &ServerProfile, path: &str) -> Result<Url, ProtocolError> {
    let base = format!("{}/", profile.collection_url.trim_end_matches('/'));
    Url::parse(&base)
        .and_then(|url| url.join(path))
        .map_err(|_| {
            config::error(
                ErrorCode::Validation,
                "Could not build an Azure DevOps Server REST URL",
            )
        })
}

fn git_path(project: &str, repository: &str, suffix: &str) -> String {
    format!(
        "{}/_apis/git/repositories/{}/{}",
        encode_segment(project),
        encode_segment(repository),
        suffix
    )
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn full_ref(value: &str) -> String {
    if value.starts_with("refs/heads/") {
        value.into()
    } else {
        format!("refs/heads/{value}")
    }
}

fn parse_response(response: Response) -> Result<Value, ProtocolError> {
    let status = response.status();
    let mut bytes = Vec::new();
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            config::error(
                ErrorCode::Network,
                "Could not read Azure DevOps Server response",
            )
        })?;
    parse_bytes(status.as_u16(), &bytes)
}

fn parse_bytes(status: u16, bytes: &[u8]) -> Result<Value, ProtocolError> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(config::error(
            ErrorCode::ResponseTooLarge,
            "Azure DevOps Server response exceeded 16 MB",
        ));
    }
    if !(200..300).contains(&status) {
        let provider_message = serde_json::from_slice::<Value>(bytes)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
        return Err(status_error(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            provider_message,
        ));
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(bytes).map_err(|_| {
        config::error(
            ErrorCode::InvalidResponse,
            "Azure DevOps Server returned invalid JSON",
        )
    })
}

fn status_error(status: StatusCode, provider_message: Option<String>) -> ProtocolError {
    let (code, fallback) = match status.as_u16() {
        401 => (ErrorCode::AuthRequired, "Authentication failed. Verify the PAT, its expiry and Code scope; Azure DevOps Server PATs also require IIS Basic Authentication to remain disabled."),
        403 => (ErrorCode::PermissionDenied, "The signed-in account does not have permission for this Azure DevOps Server operation"),
        404 => (ErrorCode::ServerUnsupported, "The Azure DevOps Server REST resource was not found; verify the collection, project, repository, and Server 2020+ requirement"),
        409 => (ErrorCode::Conflict, "Azure DevOps Server rejected the operation because the pull request changed"),
        _ => (ErrorCode::Network, "Azure DevOps Server rejected the request"),
    };
    // Never relay a 401 body: some IIS/proxy setups echo request diagnostics,
    // and authentication errors must not risk reproducing a PAT. The stable
    // guidance is more useful than the provider's generic message anyway.
    let message = if status == StatusCode::UNAUTHORIZED {
        fallback.into()
    } else {
        provider_message.unwrap_or_else(|| fallback.into())
    };
    ProtocolError {
        code,
        message,
        status: Some(status.as_u16()),
    }
}

fn map_reqwest(error: reqwest::Error) -> ProtocolError {
    let mut causes = error.to_string().to_ascii_lowercase();
    let mut source = std::error::Error::source(&error);
    while let Some(value) = source {
        causes.push_str(&value.to_string().to_ascii_lowercase());
        source = value.source();
    }
    let (code, message) = if error.is_timeout() {
        (
            ErrorCode::Timeout,
            "Azure DevOps Server did not respond within 30 seconds",
        )
    } else if error.is_redirect() {
        (
            ErrorCode::Network,
            "Azure DevOps Server attempted an authenticated redirect, which Strand refuses",
        )
    } else if [
        "certificate",
        "unknownissuer",
        "unknown issuer",
        "invalid peer",
        "tls",
        "rustls",
    ]
    .iter()
    .any(|needle| causes.contains(needle))
    {
        (
            ErrorCode::Tls,
            "Azure DevOps Server TLS certificate validation failed",
        )
    } else {
        (ErrorCode::Network, "Could not reach Azure DevOps Server")
    };
    config::error(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair, KeyUsagePurpose};
    use std::{sync::mpsc, thread};
    use tiny_http::{
        Header, Response as MockResponse, Server, SslConfig, StatusCode as MockStatus,
    };
    use uuid::Uuid;

    #[test]
    fn list_route_is_escaped_bounded_and_shallow() {
        let spec = request_spec(Operation::ListPullRequests {
            project: "Platform Team".into(),
            repository: "web/api".into(),
            source_branch: Some("feature one".into()),
            status: None,
            top: 500,
        });
        assert_eq!(spec.method, Method::GET);
        assert_eq!(
            spec.path,
            "Platform%20Team/_apis/git/repositories/web%2Fapi/pullrequests"
        );
        assert!(spec.body.is_none());
        assert!(spec.query.contains(&("$top", "100".into())));
        assert!(spec.query.contains(&(
            "searchCriteria.sourceRefName",
            "refs/heads/feature one".into()
        )));
        assert!(spec.query.contains(&("api-version", "6.0".into())));
    }

    #[test]
    fn connection_probe_uses_the_server_preview_api() {
        let spec = request_spec(Operation::TestConnection);
        assert!(spec
            .query
            .contains(&("api-version", "6.0-preview.1".into())));
    }

    #[test]
    fn write_routes_preserve_exact_head_and_api_floor() {
        let create = request_spec(Operation::CreatePullRequest {
            project: "Project".into(),
            repository: "Repo".into(),
            source_branch: "topic".into(),
            target_branch: "main".into(),
            title: "Title".into(),
            description: "Body".into(),
            is_draft: true,
        });
        assert_eq!(create.method, Method::POST);
        assert_eq!(create.body.unwrap()["sourceRefName"], "refs/heads/topic");

        let complete = request_spec(Operation::Complete {
            project: "Project".into(),
            repository: "Repo".into(),
            id: 12,
            expected_head: "abc123".into(),
            strategy: MergeStrategy::Squash,
        });
        let body = complete.body.unwrap();
        assert_eq!(body["lastMergeSourceCommit"]["commitId"], "abc123");
        assert_eq!(body["completionOptions"]["mergeStrategy"], "squash");
        assert!(complete.query.contains(&("api-version", "6.0".into())));

        let close = request_spec(Operation::SetStatus {
            project: "Project".into(),
            repository: "Repo".into(),
            id: 12,
            status: strand_azdo_protocol::PullRequestStatus::Abandoned,
        });
        assert_eq!(close.method, Method::PATCH);
        assert_eq!(close.body.unwrap()["status"], "abandoned");

        let vote = request_spec(Operation::SetVote {
            project: "Project".into(),
            repository: "Repo".into(),
            id: 12,
            reviewer_id: "reviewer/id".into(),
            vote: strand_azdo_protocol::ReviewVote::RequestChanges,
        });
        assert_eq!(vote.method, Method::PUT);
        assert!(vote
            .path
            .ends_with("pullrequests/12/reviewers/reviewer%2Fid"));
        assert_eq!(vote.body.unwrap()["vote"], -10);

        let reset_vote = request_spec(Operation::SetVote {
            project: "Project".into(),
            repository: "Repo".into(),
            id: 12,
            reviewer_id: "reviewer/id".into(),
            vote: strand_azdo_protocol::ReviewVote::Reset,
        });
        assert_eq!(reset_vote.method, Method::PUT);
        assert_eq!(reset_vote.body.unwrap()["vote"], 0);

        let policy = request_spec(Operation::Policies {
            project: "Project".into(),
            project_id: "project-id".into(),
            id: 12,
        });
        assert!(policy
            .query
            .contains(&("api-version", "6.0-preview.1".into())));
        assert!(policy.query.contains(&(
            "artifactId",
            "vstfs:///CodeReview/CodeReviewId/project-id/12".into()
        )));
    }

    #[test]
    fn response_errors_are_stable_and_bounded() {
        assert_eq!(
            parse_bytes(200, br#"{"value":[]}"#).unwrap()["value"],
            json!([])
        );
        assert_eq!(
            parse_bytes(200, b"not-json").unwrap_err().code,
            ErrorCode::InvalidResponse
        );
        let unauthorized = parse_bytes(401, br#"{"message":"provider text"}"#).unwrap_err();
        assert_eq!(unauthorized.code, ErrorCode::AuthRequired);
        assert!(!unauthorized.message.contains("provider text"));
        assert!(unauthorized.message.contains("IIS Basic Authentication"));
        assert_eq!(
            parse_bytes(403, b"").unwrap_err().code,
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            parse_bytes(404, b"").unwrap_err().code,
            ErrorCode::ServerUnsupported
        );
        assert_eq!(parse_bytes(409, b"").unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(parse_bytes(500, b"").unwrap_err().code, ErrorCode::Network);
        assert_eq!(
            parse_bytes(200, &vec![b'x'; MAX_RESPONSE_BYTES + 1])
                .unwrap_err()
                .code,
            ErrorCode::ResponseTooLarge
        );
    }

    #[test]
    fn private_ca_auth_and_redirect_boundaries() {
        let (ca_pem, cert_pem, key_pem) = certificates();
        let (server, collection_url) = https_server(&cert_pem, &key_pem);
        let (sender, receiver) = mpsc::channel();
        let server_thread = thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .expect("trusted client request");
            sender
                .send((
                    request.url().to_string(),
                    request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv("Authorization"))
                        .map(|header| header.value.as_str().to_string()),
                ))
                .unwrap();
            request
                .respond(MockResponse::from_string(
                    r#"{"authenticatedUser":{"displayName":"Ada"}}"#,
                ))
                .unwrap();
        });
        let profile = test_profile(collection_url);
        let client = PatClient::with_token(
            &profile,
            Zeroizing::new("super-secret-pat".into()),
            Some(ca_pem.as_bytes()),
        )
        .unwrap();
        let value = client.execute(Operation::Viewer).unwrap();
        assert_eq!(value["authenticatedUser"]["displayName"], "Ada");
        let (url, authorization) = receiver.recv().unwrap();
        assert!(url.starts_with("/tfs/DefaultCollection/_apis/connectionData?"));
        let authorization = authorization.expect("authorization header");
        assert_eq!(
            authorization,
            format!("Basic {}", STANDARD.encode(":super-secret-pat"))
        );
        assert!(!url.contains("super-secret-pat"));
        server_thread.join().unwrap();

        let (server, collection_url) = https_server(&cert_pem, &key_pem);
        let untrusted_thread = thread::spawn(move || {
            let _ = server.recv_timeout(Duration::from_secs(2));
        });
        let untrusted = PatClient::with_token(
            &test_profile(collection_url),
            Zeroizing::new("not-logged".into()),
            None,
        )
        .unwrap()
        .execute(Operation::Viewer)
        .unwrap_err();
        assert_eq!(untrusted.code, ErrorCode::Tls);
        assert!(!untrusted.message.contains("not-logged"));
        untrusted_thread.join().unwrap();

        let (server, collection_url) = https_server(&cert_pem, &key_pem);
        let redirect_thread = thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .expect("redirect request");
            let response = MockResponse::empty(MockStatus(302))
                .with_header(Header::from_bytes("Location", "https://elsewhere.invalid/").unwrap());
            request.respond(response).unwrap();
            assert!(server
                .recv_timeout(Duration::from_millis(200))
                .unwrap()
                .is_none());
        });
        let redirected = PatClient::with_token(
            &test_profile(collection_url),
            Zeroizing::new("redirect-pat".into()),
            Some(ca_pem.as_bytes()),
        )
        .unwrap()
        .execute(Operation::Viewer)
        .unwrap_err();
        assert_eq!(redirected.code, ErrorCode::Network);
        assert_eq!(redirected.status, Some(302));
        redirect_thread.join().unwrap();
    }

    fn certificates() -> (String, String, String) {
        let mut ca_params = CertificateParams::new(vec!["Strand test CA".into()]).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        let ca_key = KeyPair::generate().unwrap();
        let ca = ca_params.self_signed(&ca_key).unwrap();

        let server_key = KeyPair::generate().unwrap();
        let server_params = CertificateParams::new(vec!["localhost".into()]).unwrap();
        let server = server_params.signed_by(&server_key, &ca, &ca_key).unwrap();
        (ca.pem(), server.pem(), server_key.serialize_pem())
    }

    fn https_server(cert_pem: &str, key_pem: &str) -> (Server, String) {
        let server = Server::https(
            "127.0.0.1:0",
            SslConfig {
                certificate: cert_pem.as_bytes().to_vec(),
                private_key: key_pem.as_bytes().to_vec(),
            },
        )
        .unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        (
            server,
            format!("https://localhost:{port}/tfs/DefaultCollection"),
        )
    }

    fn test_profile(collection_url: String) -> ServerProfile {
        ServerProfile {
            id: Uuid::new_v4(),
            name: "Mock Server".into(),
            collection_url: collection_url.clone(),
            auth_mode: AuthMode::Pat,
            remote_prefixes: vec![collection_url],
            ca_certificate: None,
        }
    }
}

#[cfg(not(windows))]
mod windows {
    use super::*;

    pub fn execute(
        _profile: &ServerProfile,
        _operation: Operation,
    ) -> Result<Value, ProtocolError> {
        Err(config::error(
            ErrorCode::Validation,
            "Windows authentication is available only on Windows",
        ))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::GetLastError,
        Networking::WinHttp::{
            WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
            WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
            WinHttpSetOption, WinHttpSetTimeouts, ERROR_WINHTTP_LOGIN_FAILURE,
            ERROR_WINHTTP_SECURE_CHANNEL_ERROR, ERROR_WINHTTP_SECURE_FAILURE,
            ERROR_WINHTTP_SECURE_INVALID_CA, ERROR_WINHTTP_TIMEOUT,
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_AUTOLOGON_SECURITY_LEVEL_LOW,
            WINHTTP_DISABLE_REDIRECTS, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_AUTOLOGON_POLICY,
            WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
        },
    };

    struct Handle(*mut c_void);

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: WinHTTP handles are owned by this wrapper and closed once.
                unsafe { WinHttpCloseHandle(self.0) };
            }
        }
    }

    pub fn execute(profile: &ServerProfile, operation: Operation) -> Result<Value, ProtocolError> {
        let spec = request_spec(operation);
        let value = request(profile, &spec)?;
        Ok(spec.finish(value))
    }

    fn request(profile: &ServerProfile, spec: &RequestSpec) -> Result<Value, ProtocolError> {
        let mut url = collection_url(profile, &spec.path)?;
        url.query_pairs_mut()
            .extend_pairs(spec.query.iter().map(|(key, value)| (*key, value)));
        let host = wide(url.host_str().ok_or_else(|| {
            config::error(ErrorCode::Validation, "Azure DevOps Server URL has no host")
        })?);
        let object = wide(&format!(
            "{}{}{}",
            url.path(),
            if url.query().is_some() { "?" } else { "" },
            url.query().unwrap_or_default()
        ));
        let agent = wide(concat!("strand-azdo/", env!("CARGO_PKG_VERSION")));
        let verb = wide(spec.method.as_str());
        let body = spec
            .body
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| {
                config::error(
                    ErrorCode::Internal,
                    "Could not encode Azure DevOps Server request",
                )
            })?
            .unwrap_or_default();
        let headers = if body.is_empty() {
            Vec::new()
        } else {
            wide("Content-Type: application/json\r\n")
        };

        // SAFETY: All pointers refer to live, NUL-terminated UTF-16 buffers for
        // the duration of each call. Returned handles are checked and RAII-owned.
        unsafe {
            let session = Handle(WinHttpOpen(
                agent.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                ptr::null(),
                ptr::null(),
                0,
            ));
            check_handle(&session, "initialize WinHTTP")?;
            if WinHttpSetTimeouts(session.0, 10_000, 10_000, 30_000, 30_000) == 0 {
                return Err(last_error("configure WinHTTP timeouts"));
            }
            let connection = Handle(WinHttpConnect(
                session.0,
                host.as_ptr(),
                url.port_or_known_default().unwrap_or(443),
                0,
            ));
            check_handle(&connection, "connect to Azure DevOps Server")?;
            let request = Handle(WinHttpOpenRequest(
                connection.0,
                verb.as_ptr(),
                object.as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                WINHTTP_FLAG_SECURE,
            ));
            check_handle(&request, "open Azure DevOps Server request")?;

            // Automatic credentials apply only to authentication schemes such
            // as Negotiate and NTLM. Scope that policy to this exact request
            // handle and disable redirects before sending the request.
            let autologon = WINHTTP_AUTOLOGON_SECURITY_LEVEL_LOW;
            if WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_AUTOLOGON_POLICY,
                &autologon as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            ) == 0
            {
                return Err(last_error("configure Windows authentication"));
            }
            let disabled = WINHTTP_DISABLE_REDIRECTS;
            if WinHttpSetOption(
                request.0,
                WINHTTP_OPTION_DISABLE_FEATURE,
                &disabled as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            ) == 0
            {
                return Err(last_error("disable authenticated redirects"));
            }
            send_receive(&request, &headers, &body)?;
            let status = query_status(&request)?;
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 16 * 1024];
                let mut read = 0u32;
                if WinHttpReadData(
                    request.0,
                    chunk.as_mut_ptr() as *mut c_void,
                    chunk.len() as u32,
                    &mut read,
                ) == 0
                {
                    return Err(last_error("read Azure DevOps Server response"));
                }
                if read == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..read as usize]);
                if bytes.len() > MAX_RESPONSE_BYTES {
                    return Err(config::error(
                        ErrorCode::ResponseTooLarge,
                        "Azure DevOps Server response exceeded 16 MB",
                    ));
                }
            }
            parse_bytes(status as u16, &bytes)
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn send_receive(
        request: &Handle,
        headers: &[u16],
        body: &[u8],
    ) -> Result<(), ProtocolError> {
        if WinHttpSendRequest(
            request.0,
            if headers.is_empty() {
                ptr::null()
            } else {
                headers.as_ptr()
            },
            if headers.is_empty() {
                0
            } else {
                (headers.len() - 1) as u32
            },
            if body.is_empty() {
                ptr::null()
            } else {
                body.as_ptr() as *const c_void
            },
            body.len() as u32,
            body.len() as u32,
            0,
        ) == 0
        {
            return Err(last_error("send Azure DevOps Server request"));
        }
        if WinHttpReceiveResponse(request.0, ptr::null_mut()) == 0 {
            return Err(last_error("receive Azure DevOps Server response"));
        }
        Ok(())
    }

    unsafe fn query_status(request: &Handle) -> Result<u32, ProtocolError> {
        let mut status = 0u32;
        let mut status_size = std::mem::size_of::<u32>() as u32;
        if WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            ptr::null(),
            &mut status as *mut u32 as *mut c_void,
            &mut status_size,
            ptr::null_mut(),
        ) == 0
        {
            return Err(last_error("read Azure DevOps Server status"));
        }
        Ok(status)
    }

    fn check_handle(handle: &Handle, action: &str) -> Result<(), ProtocolError> {
        if handle.0.is_null() {
            Err(last_error(action))
        } else {
            Ok(())
        }
    }

    fn last_error(action: &str) -> ProtocolError {
        // SAFETY: GetLastError has no preconditions and is read immediately
        // after the failing WinHTTP call.
        let value = unsafe { GetLastError() };
        let (code, message) = match value {
            ERROR_WINHTTP_TIMEOUT => (ErrorCode::Timeout, "Azure DevOps Server did not respond within 30 seconds"),
            ERROR_WINHTTP_LOGIN_FAILURE => (ErrorCode::AuthRequired, "Windows could not authenticate the current user with Azure DevOps Server"),
            ERROR_WINHTTP_SECURE_CHANNEL_ERROR | ERROR_WINHTTP_SECURE_FAILURE | ERROR_WINHTTP_SECURE_INVALID_CA =>
                (ErrorCode::Tls, "Azure DevOps Server TLS certificate validation failed in the Windows trusted-root store"),
            _ => (ErrorCode::Network, "Windows could not complete the Azure DevOps Server request"),
        };
        ProtocolError {
            code,
            message: format!("{message} ({action}; WinHTTP {value})"),
            status: None,
        }
    }
}
