//! AI writing suggestions via vendor CLIs (Codex / Claude Code).
//!
//! Auth and billing stay in the official tools — Strand only orchestrates
//! subprocess calls and parses JSON responses.

pub(crate) mod bin;
mod claude;
mod codex;
mod input;
mod parse;
mod prompt;

pub use input::{AiGenerationOutcome, AiGenerationRequest, AiInputScope, AiSensitiveDecision};

use serde::{Deserialize, Serialize};
use strand_core::diff::FileDiff;

trait AiProviderAdapter: Sync {
    fn status(&self, cli_override: Option<&str>) -> AiProviderStatus;
    fn login(&self, cli_override: Option<&str>) -> Result<(), String>;
    fn logout(&self, cli_override: Option<&str>) -> Result<(), String>;
    fn suggest(
        &self,
        repo_path: &std::path::Path,
        prompt: &str,
        cli_override: Option<&str>,
        cancel: Option<&bin::AiCancelHandle>,
    ) -> Result<String, String>;
}

fn adapter(provider: AiProvider) -> &'static dyn AiProviderAdapter {
    match provider {
        AiProvider::Openai => &codex::CODEX,
        AiProvider::Anthropic => &claude::CLAUDE,
    }
}

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
    adapter(provider).status(cli_override)
}

pub fn provider_login(provider: AiProvider, cli_override: Option<&str>) -> Result<(), String> {
    adapter(provider).login(cli_override)
}

pub fn provider_logout(provider: AiProvider, cli_override: Option<&str>) -> Result<(), String> {
    adapter(provider).logout(cli_override)
}

#[allow(clippy::too_many_arguments)]
pub fn suggest_commit_message_with_request(
    provider: AiProvider,
    repo_path: &std::path::Path,
    diffs: &[FileDiff],
    cli_override: Option<&str>,
    cancel: Option<&bin::AiCancelHandle>,
    decision: &AiSensitiveDecision,
    scope: AiInputScope,
    recent_subjects: &[String],
    style_instruction: Option<&str>,
) -> Result<AiGenerationOutcome<CommitMessageSuggestion>, String> {
    if diffs.is_empty() {
        return Err("Nothing changed — make a change before generating a message.".into());
    }
    let prepared = match input::prepare_input(diffs, scope, decision)? {
        input::InputPreparation::NeedsConfirmation {
            fingerprint,
            mut coverage,
            sensitive_files,
        } => {
            let built = prompt::build_prompt(
                diffs,
                recent_subjects,
                style_instruction.map(|style| truncate_utf8(style.trim(), 1_000)),
            );
            apply_prompt_coverage(&mut coverage, &built);
            return Ok(AiGenerationOutcome::NeedsConfirmation {
                fingerprint,
                coverage,
                sensitive_files,
            });
        }
        input::InputPreparation::Ready(prepared) => prepared,
    };
    let mut coverage = prepared.coverage;
    let built = prompt::build_prompt(
        &prepared.diffs,
        recent_subjects,
        style_instruction.map(|style| truncate_utf8(style.trim(), 1_000)),
    );
    apply_prompt_coverage(&mut coverage, &built);
    let text = format!(
        "{}\n\nRemember: reply with JSON only: {{\"subject\":\"...\",\"body\":\"...\"}}",
        built.text
    );
    let raw = adapter(provider).suggest(repo_path, &text, cli_override, cancel)?;
    let suggestion = parse::parse_suggestion(&raw)?;
    Ok(AiGenerationOutcome::Generated {
        suggestion,
        coverage,
        provider,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn suggest_pull_request_with_request(
    provider: AiProvider,
    repo_path: &std::path::Path,
    source_branch: &str,
    target_branch: &str,
    diffs: &[FileDiff],
    cli_override: Option<&str>,
    cancel: Option<&bin::AiCancelHandle>,
    decision: &AiSensitiveDecision,
    recent_subjects: &[String],
    style_instruction: Option<&str>,
) -> Result<AiGenerationOutcome<PullRequestSuggestion>, String> {
    if diffs.is_empty() {
        return Err(format!(
            "No committed changes were found between {target_branch} and {source_branch}."
        ));
    }
    let prepared = match input::prepare_input(diffs, AiInputScope::Committed, decision)? {
        input::InputPreparation::NeedsConfirmation {
            fingerprint,
            mut coverage,
            sensitive_files,
        } => {
            let built = prompt::build_pull_request_prompt(
                source_branch,
                target_branch,
                diffs,
                recent_subjects,
                style_instruction.map(|style| truncate_utf8(style.trim(), 1_000)),
            );
            apply_prompt_coverage(&mut coverage, &built);
            return Ok(AiGenerationOutcome::NeedsConfirmation {
                fingerprint,
                coverage,
                sensitive_files,
            });
        }
        input::InputPreparation::Ready(prepared) => prepared,
    };
    let mut coverage = prepared.coverage;
    let built = prompt::build_pull_request_prompt(
        source_branch,
        target_branch,
        &prepared.diffs,
        recent_subjects,
        style_instruction.map(|style| truncate_utf8(style.trim(), 1_000)),
    );
    apply_prompt_coverage(&mut coverage, &built);
    let text = format!(
        "{}\n\nRemember: reply with JSON only: {{\"title\":\"...\",\"description\":\"...\"}}",
        built.text
    );
    let raw = adapter(provider).suggest(repo_path, &text, cli_override, cancel)?;
    let suggestion = parse::parse_pull_request_suggestion(&raw)?;
    Ok(AiGenerationOutcome::Generated {
        suggestion,
        coverage,
        provider,
    })
}

pub(crate) fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn apply_prompt_coverage(coverage: &mut input::AiInputCoverage, built: &prompt::PromptBuild) {
    coverage.manifest_files = built.manifest_files;
    coverage.patch_files = built.patch_files;
    coverage.omitted_patch_files = built.omitted_patch_files;
    coverage.truncated_patch_files = built.truncated_patch_files;
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

    #[test]
    fn truncates_recent_subjects_on_utf8_boundaries() {
        let subject = "é".repeat(100);
        let truncated = truncate_utf8(&subject, 120);
        assert_eq!(truncated.len(), 120);
        assert!(truncated.is_char_boundary(truncated.len()));
    }
}
