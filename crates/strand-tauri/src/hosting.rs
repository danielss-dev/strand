//! Read-only connection status for hosted-provider CLIs shown in Settings.
//! These checks stay outside repository working directories and use the same
//! resolved, persisted PATH boundary as pull-request and AI subprocesses.

use serde::Serialize;

use crate::ai::bin::{resolve_cli, run_capture, STATUS_TIMEOUT};

#[derive(Debug, Clone, Serialize)]
pub struct ProviderConnectionStatus {
    pub installed: bool,
    pub connected: bool,
    pub account: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostingConnectionStatus {
    pub github: ProviderConnectionStatus,
    pub azure_dev_ops: ProviderConnectionStatus,
}

pub fn status() -> HostingConnectionStatus {
    // Both CLIs may cold-start or touch the network. Keep the Settings refresh
    // bounded by the slower provider instead of checking them serially.
    std::thread::scope(|scope| {
        let github = scope.spawn(github_status);
        let azure_dev_ops = scope.spawn(azure_dev_ops_status);
        HostingConnectionStatus {
            github: github
                .join()
                .unwrap_or_else(|_| unavailable("GitHub CLI status check failed")),
            azure_dev_ops: azure_dev_ops
                .join()
                .unwrap_or_else(|_| unavailable("Azure CLI status check failed")),
        }
    })
}

fn github_status() -> ProviderConnectionStatus {
    let Some(bin) = resolve_cli("gh", None) else {
        return unavailable("Install GitHub CLI, then run gh auth login");
    };
    match run_capture(
        &bin,
        &["api", "user", "--jq", ".login"],
        None,
        None,
        STATUS_TIMEOUT,
    ) {
        Ok(output) => connected(output, "Connected via gh"),
        Err(_) => ProviderConnectionStatus {
            installed: true,
            connected: false,
            account: None,
            detail: "Run gh auth login to connect".into(),
        },
    }
}

fn azure_dev_ops_status() -> ProviderConnectionStatus {
    let Some(bin) = resolve_cli("az", None) else {
        return unavailable("Install Azure CLI and its azure-devops extension");
    };
    if run_capture(
        &bin,
        &[
            "extension",
            "show",
            "--name",
            "azure-devops",
            "--query",
            "name",
            "--output",
            "tsv",
        ],
        None,
        None,
        STATUS_TIMEOUT,
    )
    .is_err()
    {
        return ProviderConnectionStatus {
            installed: true,
            connected: false,
            account: None,
            detail: "Run az extension add --name azure-devops".into(),
        };
    }
    match run_capture(
        &bin,
        &["account", "show", "--query", "user.name", "--output", "tsv"],
        None,
        None,
        STATUS_TIMEOUT,
    ) {
        Ok(output) => connected(output, "Connected via az"),
        Err(_) => ProviderConnectionStatus {
            installed: true,
            connected: false,
            account: None,
            detail: "Run az login to connect".into(),
        },
    }
}

fn connected(output: String, detail: &str) -> ProviderConnectionStatus {
    let account = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .filter(|line| line.len() <= 320)
        .map(str::to_string);
    ProviderConnectionStatus {
        installed: true,
        connected: account.is_some(),
        account,
        detail: detail.into(),
    }
}

fn unavailable(detail: &str) -> ProviderConnectionStatus {
    ProviderConnectionStatus {
        installed: false,
        connected: false,
        account: None,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connected_status_uses_the_first_bounded_non_empty_line() {
        let status = connected("\nada@example.test\nignored\n".into(), "Connected");
        assert!(status.connected);
        assert_eq!(status.account.as_deref(), Some("ada@example.test"));

        let status = connected(format!("{}\n", "x".repeat(321)), "Connected");
        assert!(!status.connected);
        assert_eq!(status.account, None);
    }
}
