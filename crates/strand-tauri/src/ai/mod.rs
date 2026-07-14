//! AI writing suggestions via vendor CLIs (Codex / Claude Code).
//!
//! Auth and billing stay in the official tools — Strand only orchestrates
//! subprocess calls and parses JSON responses.

pub(crate) mod bin;
mod claude;
mod codex;
mod parse;
mod prompt;

use serde::{Deserialize, Serialize};
use strand_core::diff::FileDiff;

/// Prefix for errors where the vendor CLI is installed but not signed in.
/// The UI opens the provider login flow when it sees this.
pub const AI_AUTH_REQUIRED: &str = "AI_AUTH_REQUIRED:";

pub(crate) fn is_auth_failure(err: &str) -> bool {
    let lower = err.to_lowercase();
    [
        "not logged in",
        "not authenticated",
        "authentication required",
        "authentication is required",
        "please log in",
        "please login",
        "run `codex login`",
        "run 'codex login'",
        "unauthorized",
        "invalid api key",
        "\"loggedin\":false",
        "\"logged_in\":false",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

pub(crate) fn cli_health_error(provider_label: &str, err: &str) -> String {
    let detail = err.lines().next().unwrap_or(err).trim();
    format!(
        "{provider_label} CLI could not run: {detail}. Reinstall or update the CLI, or set a working custom path in Settings → AI."
    )
}

pub(crate) fn map_cli_failure(
    status: &AiProviderStatus,
    provider_label: &str,
    err: String,
) -> String {
    if let Some(health_error) = &status.error {
        health_error.clone()
    } else if !status.logged_in || is_auth_failure(&err) {
        format!("{AI_AUTH_REQUIRED} {provider_label} is not signed in.")
    } else {
        err
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderStatus {
    pub provider: AiProvider,
    pub installed: bool,
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_hint: Option<String>,
    /// Present when the CLI was found but could not execute successfully.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitMessageSuggestion {
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequestSuggestion {
    pub title: String,
    pub description: String,
}

pub fn provider_status(provider: AiProvider, cli_override: Option<&str>) -> AiProviderStatus {
    match provider {
        AiProvider::Openai => codex::status(cli_override),
        AiProvider::Anthropic => claude::status(cli_override),
    }
}

pub fn provider_login(provider: AiProvider, cli_override: Option<&str>) -> Result<(), String> {
    match provider {
        AiProvider::Openai => codex::login(cli_override),
        AiProvider::Anthropic => claude::login(cli_override),
    }
}

pub fn provider_logout(provider: AiProvider, cli_override: Option<&str>) -> Result<(), String> {
    match provider {
        AiProvider::Openai => codex::logout(cli_override),
        AiProvider::Anthropic => claude::logout(cli_override),
    }
}

pub fn suggest_commit_message(
    provider: AiProvider,
    repo_path: &std::path::Path,
    diffs: &[FileDiff],
    cli_override: Option<&str>,
) -> Result<CommitMessageSuggestion, String> {
    if diffs.is_empty() {
        return Err("Nothing staged — stage changes before generating a message.".into());
    }
    let text = format!(
        "{}\n\nRemember: reply with JSON only: {{\"subject\":\"...\",\"body\":\"...\"}}",
        prompt::build_prompt(diffs)
    );
    let raw = match provider {
        AiProvider::Openai => codex::suggest(repo_path, &text, cli_override)?,
        AiProvider::Anthropic => claude::suggest(repo_path, &text, cli_override)?,
    };
    parse::parse_suggestion(&raw)
}

pub fn suggest_pull_request(
    provider: AiProvider,
    repo_path: &std::path::Path,
    source_branch: &str,
    target_branch: &str,
    diffs: &[FileDiff],
    cli_override: Option<&str>,
) -> Result<PullRequestSuggestion, String> {
    if diffs.is_empty() {
        return Err(format!(
            "No committed changes were found between {target_branch} and {source_branch}."
        ));
    }
    let text = format!(
        "{}\n\nRemember: reply with JSON only: {{\"title\":\"...\",\"description\":\"...\"}}",
        prompt::build_pull_request_prompt(source_branch, target_branch, diffs)
    );
    let raw = match provider {
        AiProvider::Openai => codex::suggest(repo_path, &text, cli_override)?,
        AiProvider::Anthropic => claude::suggest(repo_path, &text, cli_override)?,
    };
    parse::parse_pull_request_suggestion(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_cli_failure_prompts_login_when_logged_out() {
        let status = AiProviderStatus {
            provider: AiProvider::Anthropic,
            installed: true,
            logged_in: false,
            account_hint: None,
            error: None,
        };
        let err = map_cli_failure(&status, "Claude Code", "not logged in".into());
        assert!(err.starts_with(AI_AUTH_REQUIRED));
    }

    #[test]
    fn map_cli_failure_preserves_error_when_logged_in() {
        let status = AiProviderStatus {
            provider: AiProvider::Anthropic,
            installed: true,
            logged_in: true,
            account_hint: None,
            error: None,
        };
        let err = map_cli_failure(&status, "Claude Code", "rate limited".into());
        assert_eq!(err, "rate limited");
    }

    #[test]
    fn map_cli_failure_preserves_cli_health_error() {
        let status = AiProviderStatus {
            provider: AiProvider::Openai,
            installed: true,
            logged_in: false,
            account_hint: None,
            error: Some("Codex CLI could not run: spawn ENOENT".into()),
        };
        let err = map_cli_failure(&status, "Codex", "not logged in".into());
        assert_eq!(err, "Codex CLI could not run: spawn ENOENT");
    }

    #[test]
    fn nested_login_argv_does_not_look_like_an_auth_failure() {
        let err = "Error: spawn /vendor/codex ENOENT\nspawnargs: [ 'login', 'status' ]";
        assert!(!is_auth_failure(err));
    }

    #[test]
    fn cli_health_error_keeps_only_the_actionable_first_line() {
        let err = cli_health_error("Codex", "Error: spawn /vendor/codex ENOENT\nstack trace");
        assert!(err.contains("Error: spawn /vendor/codex ENOENT"));
        assert!(!err.contains("stack trace"));
        assert!(err.contains("Settings → AI"));
    }
}
