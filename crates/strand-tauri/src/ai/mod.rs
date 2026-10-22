//! AI writing suggestions via vendor CLIs (Codex / Claude Code).
//!
//! Auth and billing stay in the official tools — Strand only orchestrates
//! subprocess calls and parses JSON responses.

pub(crate) mod bin;
mod claude;
mod codex;
mod input;
mod markers;
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
        model: Option<&str>,
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
    let diagnostic = cli_diagnostic_prefix(&err);
    if let Some(health_error) = &status.error {
        health_error.clone()
    } else if !status.logged_in || is_auth_failure(diagnostic) {
        format!("{AI_AUTH_REQUIRED} {provider_label} is not signed in.")
    } else {
        user_facing_cli_failure(provider_label, diagnostic, diagnostic.len() == err.len())
    }
}

fn cli_diagnostic_prefix(err: &str) -> &str {
    ["<untrusted-", "\nuser\n", "\nUser\n"]
        .iter()
        .filter_map(|marker| err.find(marker))
        .min()
        .map_or(err, |end| &err[..end])
}

fn user_facing_cli_failure(provider_label: &str, err: &str, allow_detail: bool) -> String {
    let lower = err.to_ascii_lowercase();
    if lower.contains("rate limit") || lower.contains("too many requests") || lower.contains("429") {
        return format!("{provider_label} is rate-limited right now. Wait a moment, then try again.");
    }
    if lower.contains("quota")
        || lower.contains("billing")
        || lower.contains("insufficient credits")
    {
        return format!(
            "{provider_label} could not generate a suggestion because the provider quota or billing limit was reached."
        );
    }
    if (lower.contains("model") && lower.contains("not found"))
        || lower.contains("unsupported model")
        || lower.contains("invalid model")
    {
        return format!(
            "{provider_label} does not support the selected model. Choose another model in Settings → AI and try again."
        );
    }
    if lower.contains("context length")
        || lower.contains("context window")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
    {
        return format!(
            "{provider_label} could not fit these changes in its context window. Stage or select fewer changes, then try again."
        );
    }
    if lower.contains("timed out") {
        return format!("{provider_label} took too long to respond. Check your connection and try again.");
    }
    if lower.contains("network")
        || lower.contains("connection reset")
        || lower.contains("connection refused")
        || lower.contains("could not resolve host")
        || lower.contains("dns")
    {
        return format!("{provider_label} could not be reached. Check your connection and try again.");
    }

    // Vendor CLIs can emit their full session preamble and echoed stdin on a
    // failed run. That stdin contains repository paths and patches, so never
    // surface or persist an unclassified transcript. A short single-line
    // diagnostic is safe and usually already actionable.
    let detail = err.trim();
    if allow_detail
        && !detail.is_empty()
        && detail.len() <= 240
        && !detail.contains(['\n', '\r'])
        && !detail.contains("<untrusted-")
    {
        return format!("{provider_label} could not generate a suggestion: {detail}");
    }
    format!(
        "{provider_label} could not generate a suggestion. Check the selected model, provider status, and connection, then try again."
    )
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CodeReviewSeverity {
    Critical,
    High,
    #[default]
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum CodeReviewSide {
    #[default]
    New,
    Old,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeReviewFinding {
    pub path: String,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub side: CodeReviewSide,
    #[serde(default)]
    pub severity: CodeReviewSeverity,
    pub title: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeReviewSuggestion {
    #[serde(default)]
    pub findings: Vec<CodeReviewFinding>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConflictHunkSuggestion {
    pub text: String,
    pub explanation: String,
    pub confidence: ConflictConfidence,
    /// A side or base was cut to fit the prompt; the UI blocks one-click Accept.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConflictResolutionSuggestion {
    pub hunks: Vec<ConflictHunkSuggestion>,
}

const MAX_CONFLICT_HUNKS: usize = 64;
const MAX_CONFLICT_FILE_BYTES: usize = 1_048_576;

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
    model: Option<&str>,
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
    let raw = adapter(provider).suggest(repo_path, &text, model, cli_override, cancel)?;
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
    model: Option<&str>,
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
    let raw = adapter(provider).suggest(repo_path, &text, model, cli_override, cancel)?;
    let suggestion = parse::parse_pull_request_suggestion(&raw)?;
    Ok(AiGenerationOutcome::Generated {
        suggestion,
        coverage,
        provider,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn review_changes_with_request(
    provider: AiProvider,
    repo_path: &std::path::Path,
    diffs: &[FileDiff],
    model: Option<&str>,
    cli_override: Option<&str>,
    cancel: Option<&bin::AiCancelHandle>,
    decision: &AiSensitiveDecision,
) -> Result<AiGenerationOutcome<CodeReviewSuggestion>, String> {
    if diffs.is_empty() {
        return Err("Nothing changed — make a change before starting AI review.".into());
    }
    let prepared = match input::prepare_input(diffs, AiInputScope::Review, decision)? {
        input::InputPreparation::NeedsConfirmation {
            fingerprint,
            mut coverage,
            sensitive_files,
        } => {
            let built = prompt::build_code_review_prompt(diffs);
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
    let built = prompt::build_code_review_prompt(&prepared.diffs);
    apply_prompt_coverage(&mut coverage, &built);
    let raw = adapter(provider).suggest(repo_path, &built.text, model, cli_override, cancel)?;
    let mut suggestion = parse::parse_code_review_suggestion(&raw)?;
    normalize_review_findings(&mut suggestion, &prepared.diffs);
    Ok(AiGenerationOutcome::Generated {
        suggestion,
        coverage,
        provider,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn suggest_conflict_resolution_with_request(
    provider: AiProvider,
    repo_path: &std::path::Path,
    file: &str,
    expected_hunks: usize,
    model: Option<&str>,
    cli_override: Option<&str>,
    cancel: Option<&bin::AiCancelHandle>,
    decision: &AiSensitiveDecision,
) -> Result<AiGenerationOutcome<ConflictResolutionSuggestion>, String> {
    if cancel.is_some_and(bin::AiCancelHandle::is_cancelled) {
        return Err("cancelled".into());
    }
    let path = repo_path
        .to_str()
        .ok_or_else(|| "Repository path is not valid Unicode.".to_string())?;
    let repo = strand_core::Repo::discover(path).map_err(|err| err.to_string())?;
    let raw = repo.read_conflict_file(file).map_err(|err| err.to_string())?;
    if raw.len() > MAX_CONFLICT_FILE_BYTES {
        return Err("This conflicted file is too large for an AI suggestion. Resolve it manually. Nothing was written.".into());
    }
    if is_lfs_conflict(&raw) {
        return Err("AI conflict resolution does not support Git LFS conflicts. Nothing was written.".into());
    }
    let parsed = markers::parse_conflict_text(&raw);
    if parsed.hunks.len() != expected_hunks {
        return Err(format!(
            "Conflict hunk count changed (file has {}, the resolver expected {expected_hunks}). Reload the file. Nothing was written.",
            parsed.hunks.len()
        ));
    }
    if parsed.hunks.is_empty() {
        return Err("No conflict markers found. Nothing was written.".into());
    }
    if parsed.hunks.len() > MAX_CONFLICT_HUNKS {
        return Err(format!(
            "This file has {} conflict hunks. Resolve some manually before asking AI (limit {MAX_CONFLICT_HUNKS}). Nothing was written.",
            parsed.hunks.len()
        ));
    }

    let diff = conflict_input_diff(file, &raw);
    let subjects = repo.conflict_side_subjects();
    let prepared = match input::prepare_input(
        std::slice::from_ref(&diff),
        AiInputScope::Conflict,
        decision,
    )? {
        input::InputPreparation::NeedsConfirmation {
            fingerprint,
            mut coverage,
            sensitive_files,
        } => {
            let built = prompt::build_conflict_prompt(
                &parsed.hunks,
                subjects.ours.as_deref(),
                subjects.theirs.as_deref(),
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
    let built = prompt::build_conflict_prompt(
        &parsed.hunks,
        subjects.ours.as_deref(),
        subjects.theirs.as_deref(),
    );
    apply_prompt_coverage(&mut coverage, &built);
    if cancel.is_some_and(bin::AiCancelHandle::is_cancelled) {
        return Err("cancelled".into());
    }
    let text = format!(
        "{}\n\nRemember: reply with JSON only and include exactly {expected_hunks} hunks. Do not write a file.",
        built.text
    );
    // The adapters wrap a cancelled run in their failure text; report it as
    // the plain "cancelled" the UI treats as a user cancel, not an error.
    let raw_output = adapter(provider)
        .suggest(repo.path(), &text, model, cli_override, cancel)
        .map_err(|err| {
            if cancel.is_some_and(bin::AiCancelHandle::is_cancelled) {
                "cancelled".to_string()
            } else {
                err
            }
        })?;
    let mut suggestion = parse::parse_conflict_resolution(&raw_output, expected_hunks)?;
    for (hunk, source) in suggestion.hunks.iter_mut().zip(&parsed.hunks) {
        hunk.truncated = prompt::conflict_hunk_truncated(source);
    }
    Ok(AiGenerationOutcome::Generated {
        suggestion,
        coverage,
        provider,
    })
}

fn is_lfs_conflict(text: &str) -> bool {
    text.contains("https://git-lfs.github.com/spec/v1")
}

fn conflict_input_diff(path: &str, raw: &str) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        old_path: None,
        status: strand_core::diff::DiffStatus::Modified,
        adds: 0,
        dels: 0,
        binary: false,
        patch: raw.to_string(),
        note: None,
    }
}

fn normalize_review_findings(suggestion: &mut CodeReviewSuggestion, diffs: &[FileDiff]) {
    suggestion.findings.truncate(50);
    suggestion.findings.retain_mut(|finding| {
        let candidate = normalize_path(&finding.path);
        let exact = |diff: &&FileDiff, candidate: &str| {
            normalize_path(&diff.path) == candidate
                || diff
                    .old_path
                    .as_deref()
                    .is_some_and(|path| normalize_path(path) == candidate)
        };
        let diff = diffs.iter().find(|diff| exact(diff, &candidate)).or_else(|| {
            candidate
                .strip_prefix("a/")
                .or_else(|| candidate.strip_prefix("b/"))
                .and_then(|stripped| diffs.iter().find(|diff| exact(diff, stripped)))
        });
        let Some(diff) = diff else {
            return false;
        };
        finding.path = diff.path.clone();
        finding.title = truncate_utf8(finding.title.trim(), 160).to_string();
        finding.body = truncate_utf8(finding.body.trim(), 2_000).to_string();
        if finding.title.is_empty() {
            return false;
        }
        finding.line = finding
            .line
            .filter(|line| *line > 0 && patch_contains_line(&diff.patch, *line, finding.side));
        true
    });
}

fn normalize_path(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    path.strip_prefix("./")
        .unwrap_or(&path)
        .to_string()
}

fn patch_contains_line(patch: &str, wanted: u32, side: CodeReviewSide) -> bool {
    let mut old_line = None;
    let mut new_line = None;
    for row in patch.lines() {
        if row.starts_with("@@ ") {
            let mut parts = row.split_whitespace();
            let _marker = parts.next();
            old_line = parts.next().and_then(|part| patch_range_start(part, '-'));
            new_line = parts.next().and_then(|part| patch_range_start(part, '+'));
            continue;
        }
        let (Some(old), Some(new)) = (old_line, new_line) else {
            continue;
        };
        match row.as_bytes().first().copied() {
            Some(b' ') => {
                if (side == CodeReviewSide::Old && old == wanted)
                    || (side == CodeReviewSide::New && new == wanted)
                {
                    return true;
                }
                old_line = Some(old + 1);
                new_line = Some(new + 1);
            }
            Some(b'-') => {
                if side == CodeReviewSide::Old && old == wanted {
                    return true;
                }
                old_line = Some(old + 1);
            }
            Some(b'+') => {
                if side == CodeReviewSide::New && new == wanted {
                    return true;
                }
                new_line = Some(new + 1);
            }
            _ => {}
        }
    }
    false
}

fn patch_range_start(value: &str, prefix: char) -> Option<u32> {
    value.strip_prefix(prefix)?.split(',').next()?.parse().ok()
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
    fn map_cli_failure_explains_rate_limits_when_logged_in() {
        let status = AiProviderStatus {
            provider: AiProvider::Anthropic,
            installed: true,
            logged_in: true,
            account_hint: None,
            error: None,
        };
        let err = map_cli_failure(&status, "Claude Code", "rate limited".into());
        assert_eq!(
            err,
            "Claude Code is rate-limited right now. Wait a moment, then try again."
        );
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
    fn map_cli_failure_never_exposes_vendor_transcripts_or_prompts() {
        let status = AiProviderStatus {
            provider: AiProvider::Openai,
            installed: true,
            logged_in: true,
            account_hint: None,
            error: None,
        };
        let raw = "OpenAI Codex v0.144.3\nworkdir: C:\\repo\nsession id: secret\n\
                   <untrusted-patches>private source patch</untrusted-patches>";
        let err = map_cli_failure(&status, "Codex", raw.into());
        assert_eq!(
            err,
            "Codex could not generate a suggestion. Check the selected model, provider status, and connection, then try again."
        );
        assert!(!err.contains("C:\\repo"));
        assert!(!err.contains("private source patch"));
    }

    #[test]
    fn map_cli_failure_explains_an_invalid_model_without_echoing_the_transcript() {
        let status = AiProviderStatus {
            provider: AiProvider::Openai,
            installed: true,
            logged_in: true,
            account_hint: None,
            error: None,
        };
        let err = map_cli_failure(
            &status,
            "Codex",
            "session preamble\nError: selected model not found\n<untrusted-patches>secret</untrusted-patches>".into(),
        );
        assert_eq!(
            err,
            "Codex does not support the selected model. Choose another model in Settings → AI and try again."
        );
        assert!(!err.contains("secret"));
    }

    #[test]
    fn map_cli_failure_does_not_classify_words_echoed_from_the_prompt() {
        let status = AiProviderStatus {
            provider: AiProvider::Openai,
            installed: true,
            logged_in: true,
            account_hint: None,
            error: None,
        };
        let err = map_cli_failure(
            &status,
            "Codex",
            "session preamble\n<untrusted-patches>not logged in; invalid model; rate limit</untrusted-patches>".into(),
        );
        assert_eq!(
            err,
            "Codex could not generate a suggestion. Check the selected model, provider status, and connection, then try again."
        );
    }

    #[test]
    fn truncates_recent_subjects_on_utf8_boundaries() {
        let subject = "é".repeat(100);
        let truncated = truncate_utf8(&subject, 120);
        assert_eq!(truncated.len(), 120);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn review_findings_are_bounded_and_anchored_to_supplied_diffs() {
        let diffs = vec![FileDiff {
            path: "src/lib.rs".into(),
            old_path: None,
            status: strand_core::diff::DiffStatus::Modified,
            adds: 1,
            dels: 1,
            binary: false,
            patch:
                "diff --git a/src/lib.rs b/src/lib.rs\n@@ -10,2 +10,2 @@\n-old\n+new\n context\n"
                    .into(),
            note: None,
        }];
        let mut suggestion = CodeReviewSuggestion {
            findings: vec![
                CodeReviewFinding {
                    path: "b/src/lib.rs".into(),
                    line: Some(10),
                    side: CodeReviewSide::New,
                    severity: CodeReviewSeverity::High,
                    title: " Race ".into(),
                    body: " Unsynchronized write. ".into(),
                },
                CodeReviewFinding {
                    path: "src/lib.rs".into(),
                    line: Some(99),
                    side: CodeReviewSide::New,
                    severity: CodeReviewSeverity::Low,
                    title: "Bad line".into(),
                    body: String::new(),
                },
                CodeReviewFinding {
                    path: "invented.rs".into(),
                    line: Some(1),
                    side: CodeReviewSide::New,
                    severity: CodeReviewSeverity::Critical,
                    title: "Hallucinated".into(),
                    body: String::new(),
                },
            ],
        };

        normalize_review_findings(&mut suggestion, &diffs);

        assert_eq!(suggestion.findings.len(), 2);
        assert_eq!(suggestion.findings[0].path, "src/lib.rs");
        assert_eq!(suggestion.findings[0].line, Some(10));
        assert_eq!(suggestion.findings[0].title, "Race");
        assert_eq!(suggestion.findings[0].body, "Unsynchronized write.");
        assert_eq!(suggestion.findings[1].line, None);
    }

    const CONFLICT: &str = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n";

    fn init_repo(dir: &std::path::Path) {
        let git = bin::resolve_cli("git", None).expect("git on PATH");
        bin::run_capture(
            &git,
            &["init", "-q", "-b", "main"],
            Some(dir),
            None,
            bin::STATUS_TIMEOUT,
        )
        .expect("git init");
    }

    fn conflict_file(dir: &std::path::Path, name: &str, contents: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn cancelled_conflict_suggestion_does_not_write_or_start_a_provider() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let file = conflict_file(dir.path(), "f.txt", CONFLICT);
        let cancel = bin::AiCancelHandle::new();
        cancel.cancel();
        let err = suggest_conflict_resolution_with_request(
            AiProvider::Openai,
            dir.path(),
            "f.txt",
            1,
            None,
            None,
            Some(&cancel),
            &AiSensitiveDecision::Scan,
        )
        .unwrap_err();
        assert_eq!(err, "cancelled");
        assert_eq!(std::fs::read_to_string(file).unwrap(), CONFLICT);
    }

    /// A fake Codex CLI. `login status` succeeds so the failure path's health
    /// check does not hang; anything else runs `body`.
    #[cfg(unix)]
    fn fake_codex(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-codex");
        std::fs::write(
            &path,
            format!("#!/bin/sh\ncase \"$*\" in *login*) exit 0;; esac\n{body}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn cancel_mid_generation_kills_the_provider_and_leaves_the_conflict_file() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let file = conflict_file(dir.path(), "f.txt", CONFLICT);
        let state = tempfile::tempdir().unwrap();
        let ready = state.path().join("ready");
        let child = state.path().join("child");
        // Codex runs in its own temp dir, so the script reports by absolute path.
        let cli = fake_codex(
            state.path(),
            &format!(
                "sleep 30 &\necho $! > '{}'\nprintf ready > '{}'\nwait",
                child.display(),
                ready.display()
            ),
        );
        let cancel = bin::AiCancelHandle::new();
        let worker_cancel = cancel.clone();
        let repo = dir.path().to_path_buf();
        let cli_path = cli.to_string_lossy().into_owned();
        let worker = std::thread::spawn(move || {
            suggest_conflict_resolution_with_request(
                AiProvider::Openai,
                &repo,
                "f.txt",
                1,
                None,
                Some(&cli_path),
                Some(&worker_cancel),
                &AiSensitiveDecision::Scan,
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !ready.exists() && !worker.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ready.exists(), "fake provider never started");
        let started = std::time::Instant::now();
        cancel.cancel();
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        assert_eq!(std::fs::read(&file).unwrap(), CONFLICT.as_bytes());

        let pid: i32 = std::fs::read_to_string(&child).unwrap().trim().parse().unwrap();
        let gone = std::time::Instant::now() + std::time::Duration::from_secs(3);
        // The grandchild `sleep` must die with the provider's process group.
        // A reaped or zombie process no longer runs.
        let alive = || {
            // SAFETY: signal 0 only checks that the pid exists.
            let exists = unsafe { libc::kill(pid, 0) } == 0;
            let zombie = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .is_ok_and(|stat| stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')));
            exists && !zombie
        };
        while alive() && std::time::Instant::now() < gone {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!alive(), "provider child {pid} survived cancellation");
    }

    #[cfg(unix)]
    #[test]
    fn generated_conflict_suggestion_flags_truncated_hunks_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let long = "x".repeat(5_000);
        let contents = format!(
            "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\nmid\n<<<<<<< HEAD\n{long}\n=======\nb\n>>>>>>> feature\n"
        );
        let file = conflict_file(dir.path(), "f.txt", &contents);
        let state = tempfile::tempdir().unwrap();
        let cli = fake_codex(
            state.path(),
            r#"cat > /dev/null
printf '%s' '{"hunks":[{"text":"ours","explanation":"Keep ours.","confidence":"high"},{"text":"b","explanation":"Take theirs.","confidence":"low"}]}'"#,
        );
        let outcome = suggest_conflict_resolution_with_request(
            AiProvider::Openai,
            dir.path(),
            "f.txt",
            2,
            None,
            Some(&cli.to_string_lossy()),
            None,
            &AiSensitiveDecision::Scan,
        )
        .unwrap();
        let AiGenerationOutcome::Generated { suggestion, .. } = outcome else {
            panic!("expected a generated suggestion");
        };
        assert_eq!(
            suggestion.hunks.iter().map(|hunk| hunk.truncated).collect::<Vec<_>>(),
            [false, true]
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), contents);
    }

    #[test]
    fn mismatched_hunk_count_and_lfs_conflicts_do_not_write() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let file = conflict_file(dir.path(), "f.txt", CONFLICT);
        let err = suggest_conflict_resolution_with_request(
            AiProvider::Openai,
            dir.path(),
            "f.txt",
            4,
            None,
            None,
            None,
            &AiSensitiveDecision::Scan,
        )
        .unwrap_err();
        assert!(err.contains("expected 4"), "{err}");
        assert!(err.contains("Nothing was written"), "{err}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), CONFLICT);

        let lfs = "<<<<<<< HEAD\nversion https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n=======\nversion https://git-lfs.github.com/spec/v1\noid sha256:def\nsize 2\n>>>>>>> feature\n";
        conflict_file(dir.path(), "f.txt", lfs);
        let err = suggest_conflict_resolution_with_request(
            AiProvider::Anthropic,
            dir.path(),
            "f.txt",
            1,
            None,
            None,
            None,
            &AiSensitiveDecision::Scan,
        )
        .unwrap_err();
        assert!(err.contains("Git LFS"), "{err}");
        assert_eq!(std::fs::read_to_string(file).unwrap(), lfs);
    }

    #[test]
    fn sensitive_conflict_asks_before_calling_a_provider_and_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let contents = "<<<<<<< HEAD\nAPI_KEY=super-secret-value-123456\n=======\nsafe\n>>>>>>> feature\n";
        let file = conflict_file(dir.path(), ".env", contents);
        let outcome = suggest_conflict_resolution_with_request(
            AiProvider::Openai,
            dir.path(),
            ".env",
            1,
            None,
            None,
            None,
            &AiSensitiveDecision::Scan,
        )
        .unwrap();
        let AiGenerationOutcome::NeedsConfirmation { fingerprint, .. } = outcome else {
            panic!("expected a sensitive-file confirmation before any provider call");
        };
        assert_eq!(std::fs::read_to_string(&file).unwrap(), contents);

        let err = suggest_conflict_resolution_with_request(
            AiProvider::Openai,
            dir.path(),
            ".env",
            1,
            None,
            None,
            None,
            &AiSensitiveDecision::Exclude { fingerprint },
        )
        .unwrap_err();
        assert!(err.contains("No non-sensitive changes remain"), "{err}");
        assert_eq!(std::fs::read_to_string(file).unwrap(), contents);
    }
}
