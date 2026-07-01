use std::path::Path;

use super::bin::{resolve_claude, run_capture, spawn_detached};
use super::AiProviderStatus;

const CLAUDE_INSTALL: &str = "https://code.claude.com/docs/en/setup";

pub fn status(cli_override: Option<&str>) -> AiProviderStatus {
    let Some(bin) = resolve_claude(cli_override) else {
        return AiProviderStatus {
            provider: super::AiProvider::Anthropic,
            installed: false,
            logged_in: false,
            account_hint: None,
        };
    };

    let (logged_in, hint) = match run_capture(&bin, &["auth", "status"], None) {
        Ok(out) => parse_auth_status(&out),
        Err(_) => (false, None),
    };

    AiProviderStatus {
        provider: super::AiProvider::Anthropic,
        installed: true,
        logged_in,
        account_hint: hint,
    }
}

fn parse_auth_status(out: &str) -> (bool, Option<String>) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(out) {
        let logged_in = v
            .get("loggedIn")
            .or_else(|| v.get("logged_in"))
            .and_then(|x| x.as_bool())
            .unwrap_or(true);
        let hint = v
            .get("email")
            .or_else(|| v.get("account"))
            .and_then(|x| x.as_str())
            .map(String::from);
        return (logged_in, hint);
    }
    // Non-JSON success output — treat as logged in.
    (true, None)
}

pub fn login(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_claude(cli_override).ok_or_else(not_installed)?;
    spawn_detached(&bin, &["auth", "login"], None)
}

pub fn logout(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_claude(cli_override).ok_or_else(not_installed)?;
    run_capture(&bin, &["auth", "logout"], None).map(|_| ())
}

pub fn suggest(repo_path: &Path, prompt: &str, cli_override: Option<&str>) -> Result<String, String> {
    let bin = resolve_claude(cli_override).ok_or_else(not_installed)?;
    let status = super::provider_status(super::AiProvider::Anthropic, cli_override);
    if !status.logged_in {
        return Err(
            "Not signed in — open Settings → AI and sign in to Claude Code, or run `claude auth login --console` for API billing.".into(),
        );
    }

    let full_prompt = format!(
        "{prompt}\n\nRemember: reply with JSON only: {{\"subject\":\"...\",\"body\":\"...\"}}"
    );

    run_capture(
        &bin,
        &[
            "-p",
            &full_prompt,
            "--output-format",
            "json",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
            "--disallowedTools",
            "*",
        ],
        Some(repo_path),
    )
    .and_then(extract_claude_print_output)
}

/// Claude `-p --output-format json` wraps the model text in a JSON envelope.
fn extract_claude_print_output(raw: String) -> Result<String, String> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(text) = v.get("result").and_then(|r| r.as_str()) {
            return Ok(text.to_string());
        }
        if let Some(text) = v.get("content").and_then(|r| r.as_str()) {
            return Ok(text.to_string());
        }
    }
    Ok(raw)
}

fn not_installed() -> String {
    format!(
        "Claude Code CLI not found — install it from {CLAUDE_INSTALL} or set a custom path in Settings → AI"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_claude_json_envelope() {
        let raw = r#"{"type":"result","result":"{\"subject\":\"fix: x\",\"body\":\"\"}"}"#;
        let text = extract_claude_print_output(raw.to_string()).unwrap();
        assert!(text.contains("fix: x"));
    }
}
