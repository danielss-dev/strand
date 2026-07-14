use std::path::Path;

use super::bin::{resolve_claude, run_capture, spawn_detached, STATUS_TIMEOUT, SUGGEST_TIMEOUT};
use super::AiProviderStatus;

const CLAUDE_INSTALL: &str = "https://code.claude.com/docs/en/setup";

pub fn status(cli_override: Option<&str>) -> AiProviderStatus {
    let Some(bin) = resolve_claude(cli_override) else {
        return AiProviderStatus {
            provider: super::AiProvider::Anthropic,
            installed: false,
            logged_in: false,
            account_hint: None,
            error: None,
        };
    };

    let (logged_in, hint, error) =
        match run_capture(&bin, &["auth", "status"], None, None, STATUS_TIMEOUT) {
            Ok(out) => {
                let (logged_in, hint) = parse_auth_status(&out);
                (logged_in, hint, None)
            }
            Err(err) if super::is_auth_failure(&err) => (false, None, None),
            Err(err) => (
                false,
                None,
                Some(super::cli_health_error("Claude Code", &err)),
            ),
        };

    AiProviderStatus {
        provider: super::AiProvider::Anthropic,
        installed: true,
        logged_in,
        account_hint: hint,
        error,
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
    // Non-JSON success output — trust an explicit logged-out marker, treat
    // anything else as logged in.
    let lower = out.to_lowercase();
    let logged_out = ["not logged in", "logged out", "not authenticated"]
        .iter()
        .any(|m| lower.contains(m));
    (!logged_out, None)
}

pub fn login(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_claude(cli_override).ok_or_else(not_installed)?;
    run_capture(&bin, &["--version"], None, None, STATUS_TIMEOUT)
        .map_err(|err| super::cli_health_error("Claude Code", &err))?;
    spawn_detached(&bin, &["auth", "login"], None)
}

pub fn logout(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_claude(cli_override).ok_or_else(not_installed)?;
    run_capture(&bin, &["auth", "logout"], None, None, STATUS_TIMEOUT).map(|_| ())
}

pub fn suggest(
    repo_path: &Path,
    prompt: &str,
    cli_override: Option<&str>,
) -> Result<String, String> {
    let bin = resolve_claude(cli_override).ok_or_else(not_installed)?;

    // The prompt travels via stdin (`claude -p` reads it there): it can
    // exceed the Windows command-line ceiling and, when the CLI is an npm
    // `.cmd` shim run through `cmd /C`, multi-line args would be re-parsed.
    match run_capture(
        &bin,
        &[
            "-p",
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
        Some(prompt),
        SUGGEST_TIMEOUT,
    ) {
        Ok(out) => extract_claude_print_output(out),
        Err(err) => {
            let status = status(cli_override);
            Err(super::map_cli_failure(&status, "Claude Code", err))
        }
    }
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

    #[test]
    fn auth_status_json_reports_email() {
        let (logged_in, hint) = parse_auth_status(r#"{"loggedIn":true,"email":"a@b.c"}"#);
        assert!(logged_in);
        assert_eq!(hint.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn auth_status_plain_text_logged_out_detected() {
        let (logged_in, hint) = parse_auth_status("Not logged in. Run `claude auth login`.");
        assert!(!logged_in);
        assert!(hint.is_none());
    }

    #[test]
    fn auth_status_unknown_text_stays_optimistic() {
        let (logged_in, _) = parse_auth_status("Authenticated via claude.ai");
        assert!(logged_in);
    }
}
