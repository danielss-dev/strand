//! AI commit-message suggestions via vendor CLIs (Codex / Claude Code).
//!
//! Auth and billing stay in the official tools — Strand only orchestrates
//! subprocess calls and parses JSON responses.

mod bin;
mod claude;
mod codex;
mod parse;
mod prompt;

use serde::{Deserialize, Serialize};
use strand_core::diff::FileDiff;

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
