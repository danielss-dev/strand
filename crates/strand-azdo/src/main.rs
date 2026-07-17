mod client;
mod config;
mod credentials;

use std::{
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

use serde_json::{json, Value};
use strand_azdo_protocol::{
    ErrorCode, MergeStrategy, Operation, ProtocolError, RequestEnvelope, ResponseEnvelope,
    ServerProfile, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};
use uuid::Uuid;
use zeroize::Zeroizing;

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            if let Some(value) = value {
                if let Err(error) = write_json(&value) {
                    eprintln!("{error}");
                    return ExitCode::FAILURE;
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            let _ = write_json_to_stderr(&error);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<Option<Value>, ProtocolError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [command] if command == "version" => Ok(Some(version_json())),
        [command, format] if command == "version" && format == "--json" => Ok(Some(version_json())),
        [command] if command == "rpc" => {
            let request: RequestEnvelope = read_json_stdin()?;
            let request_id = request.request_id.clone();
            let response = match execute_request(request) {
                Ok(result) => ResponseEnvelope::success(request_id, result),
                Err(error) => ResponseEnvelope::failure(request_id, error),
            };
            if response.error.is_some() {
                write_json(&response).map_err(|message| config::error(ErrorCode::Internal, &message))?;
                std::process::exit(1);
            }
            Ok(Some(serde_json::to_value(response).expect("response serializes")))
        }
        [group, command] if group == "config" && command == "show" => {
            Ok(Some(serde_json::to_value(config::load()?).expect("config serializes")))
        }
        [group, command] if group == "config" && (command == "enable" || command == "disable") => {
            Ok(Some(serde_json::to_value(config::set_enabled(command == "enable")?).expect("config serializes")))
        }
        [group, command] if group == "profile" && command == "list" => {
            Ok(Some(json!(config::load()?.profiles)))
        }
        [group, command] if group == "profile" && command == "upsert" => {
            let profile: ServerProfile = read_json_stdin()?;
            Ok(Some(json!(config::upsert(profile, None)?)))
        }
        [group, command, id] if group == "profile" && command == "remove" => {
            let id = parse_id(id)?;
            credentials::clear(id)?;
            config::remove(id)?;
            Ok(Some(Value::Null))
        }
        [group, command, id, ca] if group == "profile" && command == "import-ca" => {
            let mut profile = config::find(parse_id(id)?)?;
            profile.ca_certificate = None;
            Ok(Some(json!(config::upsert(profile, Some(&PathBuf::from(ca)))?)))
        }
        [group, command, id] if group == "auth" && command == "set" => {
            let id = parse_id(id)?;
            let value = read_secret_stdin()?;
            credentials::set(id, Zeroizing::new(value.trim_end_matches(['\r', '\n']).to_string()))?;
            Ok(Some(Value::Null))
        }
        [group, command, id] if group == "auth" && command == "login" => {
            let id = parse_id(id)?;
            let value = rpassword::prompt_password("Azure DevOps Server PAT: ")
                .map_err(|_| config::error(ErrorCode::Internal, "Could not read the personal access token"))?;
            credentials::set(id, Zeroizing::new(value))?;
            Ok(Some(Value::Null))
        }
        [group, command, id] if group == "auth" && command == "clear" => {
            credentials::clear(parse_id(id)?)?;
            Ok(Some(Value::Null))
        }
        [group, command, id] if group == "auth" && command == "status" => {
            Ok(Some(json!({"stored": credentials::exists(parse_id(id)?)})))
        }
        [group, command, id] if group == "request" && command == "run" => {
            let operation: Operation = read_json_stdin()?;
            Ok(Some(client::execute(&config::find(parse_id(id)?)?, operation)?))
        }
        [group, command, id] if group == "pr" && command == "viewer" => {
            execute_profile(id, Operation::Viewer)
        }
        [group, command, id, project, repository] if group == "pr" && command == "list" => {
            execute_profile(id, Operation::ListPullRequests {
                project: project.into(), repository: repository.into(), source_branch: None,
                status: Some("all".into()), top: 100,
            })
        }
        [group, command, id, project, repository, branch] if group == "pr" && command == "list" => {
            execute_profile(id, Operation::ListPullRequests {
                project: project.into(), repository: repository.into(), source_branch: Some(branch.into()),
                status: Some("active".into()), top: 100,
            })
        }
        [group, command, id, project, repository, pr]
            if group == "pr" && matches!(command.as_str(), "show" | "threads" | "commits" | "ready" | "comment") => {
            let pr = parse_pr_id(pr)?;
            let operation = match command.as_str() {
                "show" => Operation::ShowPullRequest { project: project.into(), repository: repository.into(), id: pr },
                "threads" => Operation::Threads { project: project.into(), repository: repository.into(), id: pr },
                "commits" => Operation::Commits { project: project.into(), repository: repository.into(), id: pr },
                "ready" => Operation::MarkReady { project: project.into(), repository: repository.into(), id: pr },
                "comment" => Operation::AddComment {
                    project: project.into(), repository: repository.into(), id: pr, body: read_text_stdin()?,
                },
                _ => unreachable!(),
            };
            execute_profile(id, operation)
        }
        [group, command, id, project, project_id, pr] if group == "pr" && command == "policies" => {
            execute_profile(id, Operation::Policies {
                project: project.into(), project_id: project_id.into(), id: parse_pr_id(pr)?,
            })
        }
        [group, command, id, project, repository, pr, expected_head, strategy]
            if group == "pr" && command == "complete" => {
            execute_profile(id, Operation::Complete {
                project: project.into(), repository: repository.into(), id: parse_pr_id(pr)?,
                expected_head: expected_head.into(), strategy: parse_strategy(strategy)?,
            })
        }
        [group, command, id, project, repository, source, target, title, draft]
            if group == "pr" && command == "create" => {
            execute_profile(id, Operation::CreatePullRequest {
                project: project.into(), repository: repository.into(), source_branch: source.into(),
                target_branch: target.into(), title: title.into(), description: read_text_stdin()?,
                is_draft: parse_bool(draft)?,
            })
        }
        _ => Err(config::error(
            ErrorCode::Validation,
            "Usage: strand-azdo version [--json] | rpc | config show|enable|disable | profile list|upsert|remove|import-ca | auth set|login|clear|status | pr viewer|list|show|create|threads|commits|policies|comment|ready|complete | request run",
        )),
    }
}

fn execute_profile(id: &str, operation: Operation) -> Result<Option<Value>, ProtocolError> {
    Ok(Some(client::execute(
        &config::find(parse_id(id)?)?,
        operation,
    )?))
}

fn parse_pr_id(value: &str) -> Result<u64, ProtocolError> {
    value
        .parse()
        .map_err(|_| config::error(ErrorCode::Validation, "Pull request id is invalid"))
}

fn parse_strategy(value: &str) -> Result<MergeStrategy, ProtocolError> {
    match value {
        "merge_commit" => Ok(MergeStrategy::MergeCommit),
        "squash" => Ok(MergeStrategy::Squash),
        "rebase" => Ok(MergeStrategy::Rebase),
        _ => Err(config::error(
            ErrorCode::Validation,
            "Merge strategy must be merge_commit, squash, or rebase",
        )),
    }
}

fn parse_bool(value: &str) -> Result<bool, ProtocolError> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(config::error(
            ErrorCode::Validation,
            "Draft must be true or false",
        )),
    }
}

fn read_text_stdin() -> Result<String, ProtocolError> {
    let mut input = String::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_string(&mut input)
        .map_err(|_| config::error(ErrorCode::InvalidResponse, "Could not read stdin"))?;
    if input.len() > MAX_REQUEST_BYTES {
        return Err(config::error(
            ErrorCode::ResponseTooLarge,
            "stdin exceeded 128 KB",
        ));
    }
    Ok(input)
}

fn read_secret_stdin() -> Result<Zeroizing<String>, ProtocolError> {
    let mut input = Zeroizing::new(String::new());
    io::stdin()
        .take(4097)
        .read_to_string(&mut input)
        .map_err(|_| {
            config::error(
                ErrorCode::Internal,
                "Could not read the personal access token",
            )
        })?;
    if input.len() > 4096 {
        return Err(config::error(
            ErrorCode::Validation,
            "The personal access token exceeds 4096 characters",
        ));
    }
    Ok(input)
}

fn version_json() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": PROTOCOL_VERSION
    })
}

fn execute_request(request: RequestEnvelope) -> Result<Value, ProtocolError> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(config::error(
            ErrorCode::ProtocolMismatch,
            "Strand and strand-azdo protocol versions do not match",
        ));
    }
    let config = config::load()?;
    if !config.enabled {
        return Err(config::error(
            ErrorCode::Disabled,
            "Azure DevOps Server integration is disabled",
        ));
    }
    let profile = config
        .profiles
        .into_iter()
        .find(|profile| profile.id == request.profile_id)
        .ok_or_else(|| {
            config::error(
                ErrorCode::ProfileNotFound,
                "Azure DevOps Server profile was not found",
            )
        })?;
    client::execute(&profile, request.operation)
}

fn read_json_stdin<T: serde::de::DeserializeOwned>() -> Result<T, ProtocolError> {
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| config::error(ErrorCode::Internal, "Could not read helper input"))?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(config::error(
            ErrorCode::Validation,
            "Helper request exceeded 128 KB",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| config::error(ErrorCode::Validation, "Helper request was not valid JSON"))
}

fn parse_id(value: &str) -> Result<Uuid, ProtocolError> {
    Uuid::parse_str(value)
        .map_err(|_| config::error(ErrorCode::Validation, "Profile id is not a valid UUID"))
}

fn write_json(value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Helper response exceeded 16 MB".into());
    }
    println!("{}", String::from_utf8_lossy(&bytes));
    Ok(())
}

fn write_json_to_stderr(value: &impl serde::Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    eprintln!("{}", String::from_utf8_lossy(&bytes));
    Ok(())
}
