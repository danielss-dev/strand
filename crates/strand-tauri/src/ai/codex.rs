use std::path::Path;

use super::bin::{
    resolve_codex, run_capture, run_capture_cancellable, spawn_detached, AiCancelHandle,
    STATUS_TIMEOUT, SUGGEST_TIMEOUT,
};
use super::AiProviderStatus;

pub struct Codex;
pub static CODEX: Codex = Codex;

impl super::AiProviderAdapter for Codex {
    fn status(&self, cli_override: Option<&str>) -> AiProviderStatus {
        status(cli_override)
    }

    fn login(&self, cli_override: Option<&str>) -> Result<(), String> {
        login(cli_override)
    }

    fn logout(&self, cli_override: Option<&str>) -> Result<(), String> {
        logout(cli_override)
    }

    fn suggest(
        &self,
        repo_path: &Path,
        prompt: &str,
        cli_override: Option<&str>,
        cancel: Option<&AiCancelHandle>,
    ) -> Result<String, String> {
        suggest(repo_path, prompt, cli_override, cancel)
    }
}

const CODEX_INSTALL: &str = "https://developers.openai.com/codex";
/// A fast, focused model is sufficient for short commit and PR copy.
const SUGGEST_MODEL: &str = "gpt-5.6-luna";

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
    _repo_path: &Path,
    prompt: &str,
    cli_override: Option<&str>,
    cancel: Option<&AiCancelHandle>,
) -> Result<String, String> {
    let bin = resolve_codex(cli_override).ok_or_else(not_installed)?;
    let isolated = tempfile::tempdir()
        .map_err(|err| format!("Could not create an isolated Codex workspace: {err}"))?;

    // `-` makes `codex exec` read the prompt from stdin — see the note in
    // `claude::suggest` for why prompts don't travel as argv.
    match run_capture_cancellable(
        &bin,
        &[
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--model",
            SUGGEST_MODEL,
            "--sandbox",
            "read-only",
            "--ask-for-approval",
            "never",
            "-c",
            "web_search=\"disabled\"",
            "-",
        ],
        Some(isolated.path()),
        Some(prompt),
        SUGGEST_TIMEOUT,
        cancel,
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
