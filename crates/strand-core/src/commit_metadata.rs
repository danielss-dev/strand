//! Lazy commit-signature inspection and streaming patch export.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::{Error, Repo, Result};

const FS: char = '\u{1f}';
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitSignatureKind {
    Gpg,
    Ssh,
    X509,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitSignatureStatus {
    Unsigned,
    Verified,
    GoodUntrusted,
    Bad,
    ExpiredSignature,
    ExpiredKey,
    RevokedKey,
    CannotVerify,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitSignature {
    pub kind: Option<CommitSignatureKind>,
    pub status: CommitSignatureStatus,
    pub signer: Option<String>,
    pub key: Option<String>,
    pub fingerprint: Option<String>,
    pub primary_fingerprint: Option<String>,
    pub trust: Option<String>,
}

impl CommitSignature {
    fn unsigned() -> Self {
        Self {
            kind: None,
            status: CommitSignatureStatus::Unsigned,
            signer: None,
            key: None,
            fingerprint: None,
            primary_fingerprint: None,
            trust: None,
        }
    }
}

fn non_empty(value: Option<&&str>) -> Option<String> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn signature_kind(signature: &[u8]) -> CommitSignatureKind {
    let signature = String::from_utf8_lossy(signature);
    if signature.contains("BEGIN SSH SIGNATURE") {
        CommitSignatureKind::Ssh
    } else if signature.contains("BEGIN PGP SIGNATURE") {
        CommitSignatureKind::Gpg
    } else if signature.contains("BEGIN SIGNED MESSAGE")
        || signature.contains("BEGIN CERTIFICATE")
    {
        CommitSignatureKind::X509
    } else {
        CommitSignatureKind::Unknown
    }
}

fn signature_status(code: char) -> CommitSignatureStatus {
    match code {
        'G' => CommitSignatureStatus::Verified,
        'U' => CommitSignatureStatus::GoodUntrusted,
        'B' => CommitSignatureStatus::Bad,
        'X' => CommitSignatureStatus::ExpiredSignature,
        'Y' => CommitSignatureStatus::ExpiredKey,
        'R' => CommitSignatureStatus::RevokedKey,
        'E' | 'N' => CommitSignatureStatus::CannotVerify,
        _ => CommitSignatureStatus::Unknown,
    }
}

fn temp_patch_path(destination: &Path) -> Result<(PathBuf, std::fs::File)> {
    let parent = destination
        .parent()
        .ok_or_else(|| Error::Other("patch destination has no parent folder".into()))?;
    let stem = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("export.patch");
    for _ in 0..32 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{stem}.strand-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Other("could not allocate a temporary patch file".into()))
}

impl Repo {
    /// Verify one commit signature lazily. Signature verification is kept off
    /// the paged log hot path because `%G?` may invoke GPG/SSH for every row.
    pub fn commit_signature(&self, rev: &str) -> Result<CommitSignature> {
        let repo = self.git2()?;
        let commit = repo.revparse_single(rev)?.peel_to_commit()?;
        let signature = match repo.extract_signature(&commit.id(), None) {
            Ok((signature, _)) => signature,
            Err(error) if error.code() == git2::ErrorCode::NotFound => {
                return Ok(CommitSignature::unsigned());
            }
            Err(error) => return Err(error.into()),
        };
        let kind = signature_kind(signature.as_ref());
        let oid = commit.id().to_string();
        let format = format!("--format=%G?{FS}%GS{FS}%GK{FS}%GF{FS}%GP{FS}%GT");
        let output = crate::git_command()
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args(["show", "--no-patch", "--no-color", &format, &oid])
            .output()
            .map_err(|error| Error::Other(format!("spawn git failed: {error}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(Error::Other(if stderr.is_empty() {
                "git could not inspect the commit signature".into()
            } else {
                stderr
            }));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let fields: Vec<&str> = stdout.trim_end_matches(['\r', '\n']).split(FS).collect();
        let code = fields.first().and_then(|field| field.chars().next()).unwrap_or('?');
        Ok(CommitSignature {
            kind: Some(kind),
            status: signature_status(code),
            signer: non_empty(fields.get(1)),
            key: non_empty(fields.get(2)),
            fingerprint: non_empty(fields.get(3)),
            primary_fingerprint: non_empty(fields.get(4)),
            trust: non_empty(fields.get(5)),
        })
    }

    /// Export one or more exact commits as an mbox-compatible patch stream.
    /// Git writes to a sibling temporary file first, so a failed format step
    /// never truncates the user-selected destination.
    pub fn export_commit_patches(&self, revs: &[String], destination: &Path) -> Result<u64> {
        if revs.is_empty() {
            return Err(Error::Other("no commits selected for patch export".into()));
        }
        if !destination.is_absolute() {
            return Err(Error::Other("patch destination must be an absolute path".into()));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| Error::Other("patch destination has no parent folder".into()))?;
        if !parent.is_dir() {
            return Err(Error::Other("patch destination folder does not exist".into()));
        }
        if destination.is_dir() {
            return Err(Error::Other("patch destination is a folder".into()));
        }
        if std::fs::symlink_metadata(destination)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(Error::Other("patch destination cannot be a symbolic link".into()));
        }
        let file_name = destination
            .file_name()
            .ok_or_else(|| Error::Other("patch destination has no file name".into()))?;
        let resolved_destination = parent.canonicalize()?.join(file_name);
        let resolved_git_dir = self.git_dir().canonicalize()?;
        if resolved_destination.starts_with(&resolved_git_dir) {
            return Err(Error::Other("commit patches cannot be exported inside .git".into()));
        }

        let repo = self.git2()?;
        let mut commits = Vec::with_capacity(revs.len());
        for rev in revs {
            let oid = repo.revparse_single(rev)?.peel_to_commit()?.id().to_string();
            if !commits.contains(&oid) {
                commits.push(oid);
            }
        }

        let (temporary, file) = temp_patch_path(destination)?;
        let stdout = file.try_clone()?;
        let mut command = crate::git_command();
        command
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args([
                "format-patch",
                "--stdout",
                "--no-stat",
                "--binary",
                "--no-signature",
                "--no-walk=unsorted",
            ])
            // `format-patch --no-walk=unsorted` consumes explicit revision
            // arguments in reverse insertion order. Reverse here so the mbox
            // stream matches the caller's oldest-to-newest selection.
            .args(commits.iter().rev())
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::piped());
        let output = match command.output() {
            Ok(output) => output,
            Err(error) => {
                drop(file);
                let _ = std::fs::remove_file(&temporary);
                return Err(Error::Other(format!("spawn git failed: {error}")));
            }
        };
        drop(file);
        if !output.status.success() {
            let _ = std::fs::remove_file(&temporary);
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(Error::Other(if stderr.is_empty() {
                "git format-patch failed".into()
            } else {
                stderr
            }));
        }

        let bytes = std::fs::metadata(&temporary)?.len();
        let copy = std::fs::copy(&temporary, destination);
        let _ = std::fs::remove_file(&temporary);
        copy?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn scratch_repo() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-commit-metadata-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.name", "Verification"]);
        git(&dir, &["config", "user.email", "verification@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        (Repo::discover(&dir).unwrap(), dir)
    }

    #[test]
    fn reports_unsigned_commits_without_invoking_a_verifier() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("one.txt"), "one\n").unwrap();
        git(&dir, &["add", "one.txt"]);
        git(&dir, &["commit", "-qm", "unsigned"]);

        assert_eq!(
            repo.commit_signature("HEAD").unwrap(),
            CommitSignature::unsigned()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn recognizes_gpg_and_ssh_signature_headers() {
        assert_eq!(
            signature_kind(b"-----BEGIN PGP SIGNATURE-----"),
            CommitSignatureKind::Gpg
        );
        assert_eq!(
            signature_kind(b"-----BEGIN SSH SIGNATURE-----"),
            CommitSignatureKind::Ssh
        );
    }

    #[test]
    fn exports_selected_commits_in_requested_order_without_partial_destination() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("note.txt"), "one\n").unwrap();
        git(&dir, &["add", "note.txt"]);
        git(&dir, &["commit", "-qm", "first subject"]);
        let first = git(&dir, &["rev-parse", "HEAD"]);
        std::fs::write(dir.join("note.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "note.txt"]);
        git(&dir, &["commit", "-qm", "second subject"]);
        let second = git(&dir, &["rev-parse", "HEAD"]);
        let destination = dir.join("selected.patch");

        let bytes = repo
            .export_commit_patches(&[first.clone(), second.clone()], &destination)
            .unwrap();
        let patch = std::fs::read_to_string(&destination).unwrap();
        assert_eq!(bytes, patch.len() as u64);
        assert!(patch.contains(&format!("From {first}")));
        assert!(patch.contains(&format!("From {second}")));
        assert!(patch.find("first subject").unwrap() < patch.find("second subject").unwrap());

        std::fs::write(&destination, "keep me").unwrap();
        assert!(repo
            .export_commit_patches(&["not-a-commit".into()], &destination)
            .is_err());
        assert_eq!(std::fs::read_to_string(&destination).unwrap(), "keep me");
        let config = dir.join(".git/config");
        let config_before = std::fs::read(&config).unwrap();
        assert!(repo
            .export_commit_patches(&[first], &config)
            .is_err());
        assert_eq!(std::fs::read(&config).unwrap(), config_before);
        let _ = std::fs::remove_dir_all(dir);
    }
}
