use std::path::Path;

use super::bin::{resolve_codex, run_capture, spawn_detached};
use super::AiProviderStatus;

const CODEX_INSTALL: &str = "https://developers.openai.com/codex";

pub fn status(cli_override: Option<&str>) -> AiProviderStatus {
    let Some(bin) = resolve_codex(cli_override) else {
        return AiProviderStatus {
            provider: super::AiProvider::Openai,
            installed: false,
            logged_in: false,
            account_hint: None,
        };
    };

    let logged_in = run_capture(&bin, &["login", "status"], None)
        .map(|_| true)
        .unwrap_or(false);

    AiProviderStatus {
        provider: super::AiProvider::Openai,
        installed: true,
        logged_in,
        account_hint: if logged_in {
            Some("Signed in via Codex CLI".into())
        } else {
            None
        },
    }
}

pub fn login(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;
    spawn_detached(&bin, &["login"], None)
}

pub fn logout(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;
    run_capture(&bin, &["logout"], None).map(|_| ())
}

pub fn suggest(repo_path: &Path, prompt: &str, cli_override: Option<&str>) -> Result<String, String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;

    let full_prompt = format!(
        "{prompt}\n\nRemember: reply with JSON only: {{\"subject\":\"...\",\"body\":\"...\"}}"
    );

    match run_capture(
        &bin,
        &[
            "exec",
            "--cd",
            repo_path.to_str().ok_or("invalid repo path")?,
            "--sandbox",
            "read-only",
            "--",
            &full_prompt,
        ],
        Some(repo_path),
    ) {
        Ok(out) => Ok(out),
        Err(err) => {
            let logged_in = status(cli_override).logged_in;
            Err(super::map_cli_failure(logged_in, "Codex", err))
        }
    }
}

fn not_installed() -> String {
    format!(
        "Codex CLI not found — install it from {CODEX_INSTALL} or set a custom path in Settings → AI"
    )
}
