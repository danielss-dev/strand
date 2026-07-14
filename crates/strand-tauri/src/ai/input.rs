use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use strand_core::diff::FileDiff;

use super::AiProvider;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGenerationRequest {
    pub op_id: String,
    pub sensitive_decision: AiSensitiveDecision,
    pub style_instruction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AiSensitiveDecision {
    Scan,
    Exclude { fingerprint: String },
    Include { fingerprint: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiInputScope {
    Staged,
    Unstaged,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInputCoverage {
    pub scope: AiInputScope,
    pub total_files: usize,
    pub manifest_files: usize,
    pub patch_files: usize,
    pub omitted_patch_files: usize,
    pub truncated_patch_files: usize,
    pub sensitive_excluded_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum AiSensitiveKind {
    EnvironmentFile,
    CredentialFile,
    PrivateKey,
    Certificate,
    CredentialPattern,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSensitiveFile {
    pub path: String,
    pub kinds: Vec<AiSensitiveKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AiGenerationOutcome<T: Serialize> {
    NeedsConfirmation {
        fingerprint: String,
        coverage: AiInputCoverage,
        sensitive_files: Vec<AiSensitiveFile>,
    },
    Generated {
        suggestion: T,
        coverage: AiInputCoverage,
        provider: AiProvider,
    },
}

pub struct PreparedInput {
    pub diffs: Vec<FileDiff>,
    pub coverage: AiInputCoverage,
}

pub enum InputPreparation {
    NeedsConfirmation {
        fingerprint: String,
        coverage: AiInputCoverage,
        sensitive_files: Vec<AiSensitiveFile>,
    },
    Ready(PreparedInput),
}

pub fn prepare_input(
    diffs: &[FileDiff],
    scope: AiInputScope,
    decision: &AiSensitiveDecision,
) -> Result<InputPreparation, String> {
    let sensitive_files = classify_sensitive(diffs);
    let fingerprint = fingerprint(diffs, scope);
    let base_coverage = coverage(scope, diffs.len(), 0);

    let confirmed_fingerprint = match decision {
        AiSensitiveDecision::Scan => None,
        AiSensitiveDecision::Exclude { fingerprint }
        | AiSensitiveDecision::Include { fingerprint } => Some(fingerprint),
    };
    if !sensitive_files.is_empty()
        && confirmed_fingerprint.is_none_or(|confirmed| confirmed != &fingerprint)
    {
        return Ok(InputPreparation::NeedsConfirmation {
            fingerprint,
            coverage: base_coverage,
            sensitive_files,
        });
    }

    let sensitive_paths: BTreeSet<&str> = sensitive_files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let filtered = match decision {
        AiSensitiveDecision::Exclude { .. } => diffs
            .iter()
            .filter(|diff| !sensitive_paths.contains(diff.path.as_str()))
            .cloned()
            .collect::<Vec<_>>(),
        AiSensitiveDecision::Scan | AiSensitiveDecision::Include { .. } => diffs.to_vec(),
    };
    if filtered.is_empty() {
        return Err("No non-sensitive changes remain to describe. Include the flagged files explicitly or cancel.".into());
    }
    let excluded = diffs.len().saturating_sub(filtered.len());
    Ok(InputPreparation::Ready(PreparedInput {
        coverage: coverage(scope, filtered.len(), excluded),
        diffs: filtered,
    }))
}

fn coverage(
    scope: AiInputScope,
    total_files: usize,
    sensitive_excluded_files: usize,
) -> AiInputCoverage {
    let patch_files = total_files.min(8);
    AiInputCoverage {
        scope,
        total_files: total_files + sensitive_excluded_files,
        manifest_files: patch_files,
        patch_files,
        omitted_patch_files: total_files.saturating_sub(patch_files),
        truncated_patch_files: 0,
        sensitive_excluded_files,
    }
}

fn fingerprint(diffs: &[FileDiff], scope: AiInputScope) -> String {
    let mut hasher = Sha256::new();
    hasher.update([scope as u8]);
    for diff in diffs {
        hasher.update(diff.path.as_bytes());
        hasher.update([0]);
        hasher.update(format!("{:?}:{}:{}", diff.status, diff.adds, diff.dels).as_bytes());
        hasher.update([0]);
        hasher.update(diff.patch.as_bytes());
        hasher.update([0xff]);
    }
    format!("{:x}", hasher.finalize())
}

fn classify_sensitive(diffs: &[FileDiff]) -> Vec<AiSensitiveFile> {
    diffs
        .iter()
        .filter_map(|diff| {
            let mut kinds = BTreeSet::new();
            classify_path(&diff.path, &mut kinds);
            classify_content(&diff.patch, &mut kinds);
            (!kinds.is_empty()).then(|| AiSensitiveFile {
                path: diff.path.clone(),
                kinds: kinds.into_iter().collect(),
            })
        })
        .collect()
}

fn classify_path(path: &str, kinds: &mut BTreeSet<AiSensitiveKind>) {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name == ".env" || name.starts_with(".env.") {
        kinds.insert(AiSensitiveKind::EnvironmentFile);
    }
    if matches!(
        name,
        "id_rsa"
            | "id_ed25519"
            | "credentials"
            | "credentials.json"
            | "credentials.yml"
            | "credentials.yaml"
            | ".netrc"
            | ".npmrc"
            | ".pypirc"
    ) {
        kinds.insert(AiSensitiveKind::CredentialFile);
    }
    if name.ends_with(".key") {
        kinds.insert(AiSensitiveKind::PrivateKey);
    }
    if [".pem", ".p12", ".pfx", ".crt", ".cer"]
        .iter()
        .any(|extension| name.ends_with(extension))
    {
        kinds.insert(AiSensitiveKind::Certificate);
    }
}

fn classify_content(patch: &str, kinds: &mut BTreeSet<AiSensitiveKind>) {
    let upper = patch.to_ascii_uppercase();
    if upper.contains("BEGIN PRIVATE KEY")
        || upper.contains("BEGIN RSA PRIVATE KEY")
        || upper.contains("BEGIN OPENSSH PRIVATE KEY")
    {
        kinds.insert(AiSensitiveKind::PrivateKey);
    }
    for line in patch.lines() {
        let lower = line.to_ascii_lowercase();
        if ![
            "api_key",
            "apikey",
            "access_token",
            "client_secret",
            "password",
        ]
        .iter()
        .any(|keyword| lower.contains(keyword))
        {
            continue;
        }
        let value = line
            .split_once('=')
            .or_else(|| line.split_once(':'))
            .map(|(_, value)| value.trim().trim_matches(['\'', '"']))
            .unwrap_or_default();
        let token_chars = value
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || "_./+=-".contains(*character))
            .count();
        if token_chars >= 16 {
            kinds.insert(AiSensitiveKind::CredentialPattern);
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use strand_core::diff::DiffStatus;

    fn diff(path: &str, patch: &str) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: DiffStatus::Modified,
            adds: 1,
            dels: 0,
            binary: false,
            patch: patch.into(),
        }
    }

    #[test]
    fn reports_only_sensitive_path_and_kind() {
        let secret = "super-secret-value-123456";
        let result = prepare_input(
            &[diff(".env.local", &format!("+API_KEY={secret}"))],
            AiInputScope::Unstaged,
            &AiSensitiveDecision::Scan,
        )
        .unwrap();
        let InputPreparation::NeedsConfirmation {
            sensitive_files, ..
        } = result
        else {
            panic!()
        };
        let encoded = serde_json::to_string(&sensitive_files).unwrap();
        assert!(encoded.contains(".env.local"));
        assert!(!encoded.contains(secret));
    }

    #[test]
    fn changed_input_requires_confirmation_again() {
        let first = vec![diff("secret.key", "+key")];
        let InputPreparation::NeedsConfirmation { fingerprint, .. } =
            prepare_input(&first, AiInputScope::Staged, &AiSensitiveDecision::Scan).unwrap()
        else {
            panic!()
        };
        let changed = vec![diff("secret.key", "+different")];
        assert!(matches!(
            prepare_input(
                &changed,
                AiInputScope::Staged,
                &AiSensitiveDecision::Include { fingerprint },
            )
            .unwrap(),
            InputPreparation::NeedsConfirmation { .. }
        ));
    }

    #[test]
    fn classifies_representative_sensitive_paths_and_markers() {
        let diffs = vec![
            diff(".aws/credentials", "+profile"),
            diff("certs/client.crt", "+certificate"),
            diff("config/app.txt", "+-----BEGIN OPENSSH PRIVATE KEY-----"),
        ];
        let InputPreparation::NeedsConfirmation {
            sensitive_files, ..
        } = prepare_input(&diffs, AiInputScope::Staged, &AiSensitiveDecision::Scan).unwrap()
        else {
            panic!()
        };
        assert_eq!(sensitive_files.len(), 3);
        assert!(sensitive_files[0]
            .kinds
            .contains(&AiSensitiveKind::CredentialFile));
        assert!(sensitive_files[1]
            .kinds
            .contains(&AiSensitiveKind::Certificate));
        assert!(sensitive_files[2]
            .kinds
            .contains(&AiSensitiveKind::PrivateKey));
    }

    #[test]
    fn exclusion_never_sends_flagged_files() {
        let diffs = vec![
            diff(".env", "+TOKEN=secret-value-123456"),
            diff("src/lib.rs", "+safe"),
        ];
        let InputPreparation::NeedsConfirmation { fingerprint, .. } =
            prepare_input(&diffs, AiInputScope::Staged, &AiSensitiveDecision::Scan).unwrap()
        else {
            panic!()
        };
        let InputPreparation::Ready(prepared) = prepare_input(
            &diffs,
            AiInputScope::Staged,
            &AiSensitiveDecision::Exclude { fingerprint },
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(prepared.diffs.len(), 1);
        assert_eq!(prepared.diffs[0].path, "src/lib.rs");
        assert_eq!(prepared.coverage.sensitive_excluded_files, 1);
    }
}
