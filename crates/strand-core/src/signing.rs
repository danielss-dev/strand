//! Operation-level signing choices. Inherit leaves Git configuration intact.
use serde::{Deserialize, Serialize};
use crate::{Error, Repo, Result};
use crate::gitconfig::{ConfigValues, config_values};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningMode {
    #[default]
    Inherit,
    Sign,
    Unsigned,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningScope { Local, Worktree }

#[derive(Debug, Serialize)]
pub struct SigningSettings {
    pub effective: ConfigValues,
    pub local: ConfigValues,
    pub worktree: ConfigValues,
    pub worktree_enabled: bool,
    pub commit_sign: bool,
    pub tag_sign: bool,
    pub tag_force_annotated: bool,
}

const SETTINGS: &str = "^(commit\\.gpgsign|tag\\.(gpgsign|forcesignannotated)|user\\.signingkey|gpg\\.(format|ssh\\.allowedsignersfile))$";

pub(crate) fn git_bool(repo: &Repo, key: &str) -> Result<bool> {
    let out = crate::git_output::capture(crate::git_command().current_dir(&repo.path)
        .args(crate::GIT_SAFE_CONFIG).args(["config", "--type=bool", "--get", key]))?;
    if out.status.code() == Some(1) { return Ok(false); }
    if !out.status.success() {
        return Err(Error::Other(String::from_utf8_lossy(&out.stderr).trim().to_owned()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim() == "true")
}

impl Repo {
    /// On-demand settings only: no signing/config subprocesses in snapshots.
    pub fn signing_settings(&self) -> Result<SigningSettings> {
        let worktree_enabled = git_bool(self, "extensions.worktreeConfig")?;
        let effective = config_values(self, None, SETTINGS)?;
        let local = config_values(self, Some("--local"), SETTINGS)?;
        // Read the direct worktree file, without following any includes. Do
        // not enable worktreeConfig implicitly (that may require migration).
        let worktree = if worktree_enabled {
            config_values(self, Some("--worktree"), SETTINGS)?
        } else { ConfigValues::new() };
        Ok(SigningSettings {
            effective, local, worktree, worktree_enabled,
            commit_sign: git_bool(self, "commit.gpgsign")?,
            tag_sign: git_bool(self, "tag.gpgsign")?,
            tag_force_annotated: git_bool(self, "tag.forceSignAnnotated")?,
        })
    }

    pub fn set_signing_config(&self, scope: SigningScope, key: &str, value: Option<&str>) -> Result<()> {
        match key {
            "commit.gpgsign" | "tag.gpgsign" | "tag.forcesignannotated" => {
                if value.is_some_and(|v| v != "true" && v != "false") {
                    return Err(Error::Other("Signing state must be true, false, or inherited".into()));
                }
            }
            "gpg.format" => {
                if value.is_some_and(|v| !["openpgp", "ssh", "x509"].contains(&v)) {
                    return Err(Error::Other("Select OpenPGP, SSH, or X.509 signing".into()));
                }
            }
            "user.signingkey" | "gpg.ssh.allowedsignersfile" => {},
            _ => return Err(Error::Other("Unknown signing setting".into())),
        }
        if key == "user.signingkey" && value.is_some_and(|v| v.contains("-----BEGIN ") && v.contains("PRIVATE KEY-----")) {
            return Err(Error::Other("Enter a key ID, public key, or path; private key material is not stored by Strand".into()));
        }
        let arg = match scope {
            SigningScope::Local => "--local",
            SigningScope::Worktree => {
                if !git_bool(self, "extensions.worktreeConfig")? {
                    return Err(Error::Other("Enable extensions.worktreeConfig with Git before writing worktree settings".into()));
                }
                "--worktree"
            }
        };
        self.set_scoped_config(arg, key, value)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::{Path, PathBuf}, process::Command};
    use crate::tag::TagVerificationStatus;
    use crate::commit_metadata::CommitSignatureStatus;

    fn fixture(kind: &str) -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!("strand-signing-{kind}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let g2 = git2::Repository::init(&dir).unwrap();
        let mut config = g2.config().unwrap();
        for (key, value) in [("user.name", "Signer"), ("user.email", "signer@example.com"),
            ("commit.gpgsign", "false"), ("tag.gpgsign", "false"), ("tag.forcesignannotated", "false"), ("core.hooksPath", "hooks")] {
            config.set_str(key, value).unwrap();
        }
        std::fs::write(dir.join("file.txt"), "signed content\n").unwrap();
        let mut index = g2.index().unwrap(); index.add_path(Path::new("file.txt")).unwrap(); index.write().unwrap();
        (Repo::discover(&dir).unwrap(), dir)
    }
    fn command(program: &Path, args: &[&str]) -> String {
        let out = Command::new(program).args(args).output().unwrap();
        assert!(out.status.success(), "{:?}: {}", program, String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    fn executable(path: &Path, contents: &str) {
        std::fs::write(path, contents).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    fn sign_suite(repo: &Repo, dir: &Path) {
        std::fs::create_dir_all(dir.join("hooks")).unwrap();
        executable(&dir.join("hooks/commit-msg"), "#!/bin/sh\necho signed-hook-rewrite >> \"$1\"\necho signed-hook-output >&2\n");
        let initial = repo.commit_with_signing("signed subject", None, false, SigningMode::Sign).unwrap();
        assert!(initial.output.contains("signed-hook-output"));
        assert!(repo.git2().unwrap().head().unwrap().peel_to_commit().unwrap().message().unwrap().contains("signed-hook-rewrite"));
        assert_eq!(repo.commit_signature(&initial.oid).unwrap().status, CommitSignatureStatus::Verified);
        repo.set_signing_config(SigningScope::Local, "commit.gpgsign", Some("true")).unwrap();
        let amended = repo.commit("signed amend", None, true).unwrap();
        assert_ne!(initial.oid, amended.oid);
        assert_eq!(repo.commit_signature(&amended.oid).unwrap().status, CommitSignatureStatus::Verified);
        let unsigned = repo.commit_with_signing("unsigned amend", None, true, SigningMode::Unsigned).unwrap();
        assert_eq!(repo.commit_signature(&unsigned.oid).unwrap().status, CommitSignatureStatus::Unsigned);
        assert!(repo.signing_settings().unwrap().commit_sign, "operation override did not change config");
        repo.create_tag_with_signing("signed-tag", None, Some("signed annotation"), false, SigningMode::Sign).unwrap();
        assert!(matches!(repo.verify_tag("signed-tag").unwrap().status, TagVerificationStatus::Verified));
        {
            let g2 = repo.git2().unwrap();
            let odb = g2.odb().unwrap();
            let tag_oid = g2.refname_to_id("refs/tags/signed-tag").unwrap();
            let object = odb.read(tag_oid).unwrap();
            let changed = String::from_utf8_lossy(object.data()).replacen("signed annotation", "tampered annotation", 1);
            let changed_oid = odb.write(git2::ObjectType::Tag, changed.as_bytes()).unwrap();
            g2.reference("refs/tags/tampered-tag", changed_oid, false, "test tampered signature").unwrap();
            assert!(matches!(repo.verify_tag("tampered-tag").unwrap().status, TagVerificationStatus::Failed));
        }
        repo.set_signing_config(SigningScope::Local, "tag.gpgsign", Some("true")).unwrap();
        assert!(repo.create_tag("missing-annotation", None, None, false).is_err());
        repo.create_tag("inherited-tag", None, Some("inherited"), false).unwrap();
        assert!(matches!(repo.verify_tag("inherited-tag").unwrap().status, TagVerificationStatus::Verified));
        repo.set_signing_config(SigningScope::Local, "tag.gpgsign", Some("false")).unwrap();
        repo.set_signing_config(SigningScope::Local, "tag.forcesignannotated", Some("true")).unwrap();
        repo.create_tag("forced-annotation", None, Some("force signed"), false).unwrap();
        assert!(matches!(repo.verify_tag("forced-annotation").unwrap().status, TagVerificationStatus::Verified));
        repo.create_tag("inherited-light", None, None, false).unwrap();
        assert!(matches!(repo.verify_tag("inherited-light").unwrap().status, TagVerificationStatus::Unsigned));
        repo.set_signing_config(SigningScope::Local, "tag.gpgsign", Some("true")).unwrap();
        repo.create_tag_with_signing("unsigned-tag", None, Some("unsigned annotation"), false, SigningMode::Unsigned).unwrap();
        repo.create_tag_with_signing("light-tag", None, None, false, SigningMode::Unsigned).unwrap();
        assert!(matches!(repo.verify_tag("unsigned-tag").unwrap().status, TagVerificationStatus::Unsigned));
        assert!(matches!(repo.verify_tag("light-tag").unwrap().status, TagVerificationStatus::Unsigned));
        let linked = dir.join("linked-checkout");
        command(Path::new("git"), &["-C", dir.to_str().unwrap(), "worktree", "add", "-b", "linked", linked.to_str().unwrap()]);
        let worktree = Repo::discover(&linked).unwrap();
        let linked_commit = worktree.commit("linked signed amend", None, true).unwrap();
        assert_eq!(worktree.commit_signature(&linked_commit.oid).unwrap().status, CommitSignatureStatus::Verified);
        repo.git2().unwrap().config().unwrap().set_bool("extensions.worktreeConfig", true).unwrap();
        worktree.set_signing_config(SigningScope::Worktree, "commit.gpgsign", Some("false")).unwrap();
        assert!(!worktree.signing_settings().unwrap().commit_sign);
        assert!(repo.signing_settings().unwrap().commit_sign);
        let linked_unsigned = worktree.commit("linked unsigned amend", None, true).unwrap();
        assert_eq!(worktree.commit_signature(&linked_unsigned.oid).unwrap().status, CommitSignatureStatus::Unsigned);
        assert_eq!(repo.git2().unwrap().head().unwrap().target().unwrap().to_string(), unsigned.oid);
        executable(&dir.join("hooks/pre-commit"), "#!/bin/sh\necho signed-hook-rejected >&2\nexit 1\n");
        assert!(repo.commit("reject", None, true).unwrap_err().to_string().contains("signed-hook-rejected"));
        assert_eq!(repo.git2().unwrap().head().unwrap().target().unwrap().to_string(), unsigned.oid);
        std::fs::remove_file(dir.join("hooks/pre-commit")).unwrap();
        repo.set_signing_config(SigningScope::Local, "user.signingkey", Some("strand-no-such-key")).unwrap();
        assert!(repo.commit("bad signer", None, true).is_err());
        assert!(repo.create_tag_with_signing("failed-tag", None, Some("failed"), false, SigningMode::Sign).is_err());
        assert!(repo.git2().unwrap().find_reference("refs/tags/failed-tag").is_err());
        assert_eq!(repo.git2().unwrap().head().unwrap().target().unwrap().to_string(), unsigned.oid);
    }

    #[test]
    fn signing_settings_distinguish_valueless_and_empty_git_booleans() {
        let (repo, dir) = fixture("booleans");
        let config_path = dir.join(".git/config");
        let mut config = std::fs::read_to_string(&config_path).unwrap();
        config.push_str("\n[commit]\ngpgsign\n[tag]\ngpgsign =\nforcesignannotated = yes\n");
        std::fs::write(config_path, config).unwrap();
        let state = repo.signing_settings().unwrap();
        assert!(state.commit_sign);
        assert!(!state.tag_sign);
        assert!(state.tag_force_annotated);
        assert_eq!(state.local["commit.gpgsign"].value, "true");
        assert_eq!(state.local["tag.gpgsign"].value, "false");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn signing_settings_are_scoped_and_do_not_enable_worktree_config_implicitly() {
        let (repo, dir) = fixture("scope");
        let (other, other_dir) = fixture("other-scope");
        assert!(repo.set_signing_config(SigningScope::Worktree, "commit.gpgsign", Some("true")).is_err());
        repo.set_signing_config(SigningScope::Local, "commit.gpgsign", Some("true")).unwrap();
        assert!(repo.signing_settings().unwrap().commit_sign);
        assert!(!other.signing_settings().unwrap().commit_sign);
        let g2 = repo.git2().unwrap();
        g2.config().unwrap().set_bool("extensions.worktreeConfig", true).unwrap();
        repo.set_signing_config(SigningScope::Worktree, "commit.gpgsign", Some("false")).unwrap();
        let state = repo.signing_settings().unwrap();
        assert_eq!(state.local["commit.gpgsign"].value, "true");
        assert_eq!(state.worktree["commit.gpgsign"].value, "false");
        assert_eq!(state.effective["commit.gpgsign"].scope, "worktree");
        assert!(!state.commit_sign);
        repo.set_signing_config(SigningScope::Worktree, "commit.gpgsign", None).unwrap();
        assert!(repo.signing_settings().unwrap().commit_sign);
        assert!(repo.set_signing_config(SigningScope::Local, "core.hooksPath", Some("unrelated")).is_err());
        assert!(repo.set_signing_config(SigningScope::Local, "user.signingkey", Some("-----BEGIN OPENSSH PRIVATE KEY-----")).is_err());
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(other_dir);
    }

    #[test]
    #[ignore = "integration fixture requires ssh-keygen"]
    fn ssh_commit_amend_hooks_tags_and_failures() {
        let (repo, dir) = fixture("ssh");
        let key = dir.join("signing-key");
        command(Path::new("ssh-keygen"), &["-q", "-t", "ed25519", "-N", "", "-f", key.to_str().unwrap()]);
        let allowed = dir.join("allowed-signers");
        let public = std::fs::read_to_string(dir.join("signing-key.pub")).unwrap();
        std::fs::write(&allowed, format!("signer@example.com {public}")).unwrap();
        repo.set_signing_config(SigningScope::Local, "gpg.format", Some("ssh")).unwrap();
        repo.set_signing_config(SigningScope::Local, "user.signingkey", key.to_str()).unwrap();
        repo.set_signing_config(SigningScope::Local, "gpg.ssh.allowedsignersfile", allowed.to_str()).unwrap();
        sign_suite(&repo, &dir);
        // Missing allowed signers is visibly different from unsigned.
        repo.set_signing_config(SigningScope::Local, "gpg.ssh.allowedsignersfile", Some("missing-signers-file")).unwrap();
        assert!(matches!(repo.verify_tag("signed-tag").unwrap().status, TagVerificationStatus::Failed));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "integration fixture requires GPG (Git for Windows includes it)"]
    fn gpg_commit_amend_hooks_tags_and_failures() {
        let (repo, dir) = fixture("gpg");
        let gpg = if cfg!(windows) { PathBuf::from("C:/Program Files/Git/usr/bin/gpg.exe") } else { PathBuf::from("/usr/bin/gpg") };
        let home = dir.join("gnupg"); std::fs::create_dir_all(&home).unwrap();
        let native_home = home.to_string_lossy().replace('\\', "/");
        // Git for Windows ships MSYS GPG: its Unix socket path cannot contain
        // a drive colon. Native GPG elsewhere takes the original absolute path.
        let home_arg = if cfg!(windows) { format!("/{}{}", native_home[..1].to_lowercase(), &native_home[2..]) } else { native_home };
        command(&gpg, &["--homedir", &home_arg, "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "Signer <signer@example.com>", "ed25519", "sign", "0"]);
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\\', "/").replace('\'', "'\"'\"'"));
        let wrapper = dir.join("fixture-gpg");
        executable(&wrapper, &format!("#!/bin/sh\nexec {} --homedir {} \"$@\"\n", quote(&gpg), quote(Path::new(&home_arg))));
        repo.git2().unwrap().config().unwrap().set_str("gpg.program", wrapper.to_str().unwrap()).unwrap();
        repo.set_signing_config(SigningScope::Local, "gpg.format", Some("openpgp")).unwrap();
        repo.set_signing_config(SigningScope::Local, "user.signingkey", Some("signer@example.com")).unwrap();
        sign_suite(&repo, &dir);
        let gpgconf = gpg.with_file_name(if cfg!(windows) { "gpgconf.exe" } else { "gpgconf" });
        command(&gpgconf, &["--homedir", &home_arg, "--kill", "gpg-agent"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
