use std::path::Path;

use super::bin::{resolve_codex, run_capture, spawn_detached, STATUS_TIMEOUT, SUGGEST_TIMEOUT};
use super::AiProviderStatus;

const CODEX_INSTALL: &str = "https://developers.openai.com/codex";

pub fn status(cli_override: Option<&str>) -> AiProviderStatus {
    let Some(bin) = resolve_codex(cli_override) else {
        return AiProviderStatus {
            provider: super::AiProvider::Openai,
            installed: false,
            logged_in: false,
            account_hint: None,
            error: None,
        };
    };

    let (logged_in, error) =
        match run_capture(&bin, &["login", "status"], None, None, STATUS_TIMEOUT) {
            Ok(_) => (true, None),
            Err(err) if super::is_auth_failure(&err) => (false, None),
            Err(err) => (false, Some(super::cli_health_error("Codex", &err))),
        };

    AiProviderStatus {
        provider: super::AiProvider::Openai,
        installed: true,
        logged_in,
        account_hint: if logged_in {
            Some("Signed in via Codex CLI".into())
        } else {
            None
        },
        error,
    }
}

pub fn login(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;
    run_capture(&bin, &["--version"], None, None, STATUS_TIMEOUT)
        .map_err(|err| super::cli_health_error("Codex", &err))?;
    spawn_detached(&bin, &["login"], None)
}

pub fn logout(cli_override: Option<&str>) -> Result<(), String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;
    run_capture(&bin, &["logout"], None, None, STATUS_TIMEOUT).map(|_| ())
}

pub fn suggest(
    repo_path: &Path,
    prompt: &str,
    cli_override: Option<&str>,
) -> Result<String, String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;

    // `-` makes `codex exec` read the prompt from stdin — see the note in
    // `claude::suggest` for why prompts don't travel as argv.
    match run_capture(
        &bin,
        &[
            "exec",
            "--cd",
            repo_path.to_str().ok_or("invalid repo path")?,
            "--sandbox",
            "read-only",
            "-",
        ],
        Some(repo_path),
        Some(prompt),
        SUGGEST_TIMEOUT,
    ) {
        Ok(out) => Ok(out),
        Err(err) => {
            let status = status(cli_override);
            Err(super::map_cli_failure(&status, "Codex", err))
        }
    }
}

fn not_installed() -> String {
    format!(
        "Codex CLI not found — install it from {CODEX_INSTALL} or set a custom path in Settings → AI"
    )
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn broken_launcher_is_health_error_and_login_does_not_start() {
        let path = std::env::temp_dir().join(format!(
            "strand-broken-codex-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        std::fs::write(
            &path,
            "#!/bin/sh\necho 'Error: spawn /vendor/codex ENOENT' >&2\nexit 1\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&path, permissions).unwrap();

        let override_path = path.to_str().unwrap();
        let status = status(Some(override_path));
        assert!(status.installed);
        assert!(!status.logged_in);
        assert!(status
            .error
            .as_deref()
            .is_some_and(|error| error.contains("ENOENT")));

        let login_error = login(Some(override_path)).unwrap_err();
        assert!(login_error.contains("ENOENT"));
        assert!(login_error.contains("Reinstall or update"));

        std::fs::remove_file(path).ok();
    }
}
