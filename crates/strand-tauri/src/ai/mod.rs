//! AI commit-message suggestions via vendor CLIs (Codex / Claude Code).
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

pub(crate) fn map_cli_failure(logged_in: bool, provider_label: &str, err: String) -> String {
    if logged_in {
        err
    } else {
        format!("{AI_AUTH_REQUIRED} {provider_label} is not signed in.")
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitMessageSuggestion {
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
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
    let text = prompt::build_prompt(diffs);
    let raw = match provider {
        AiProvider::Openai => codex::suggest(repo_path, &text, cli_override)?,
        AiProvider::Anthropic => claude::suggest(repo_path, &text, cli_override)?,
    };
    parse::parse_suggestion(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_cli_failure_prompts_login_when_logged_out() {
        let err = map_cli_failure(false, "Claude Code", "exit 1".into());
        assert!(err.starts_with(AI_AUTH_REQUIRED));
    }

    #[test]
    fn map_cli_failure_preserves_error_when_logged_in() {
        let err = map_cli_failure(true, "Claude Code", "rate limited".into());
        assert_eq!(err, "rate limited");
    }
}
