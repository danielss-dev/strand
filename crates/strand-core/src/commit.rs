use std::path::Path;
use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitOutcome {
    /// The new HEAD oid as a hex string.
    pub oid: String,
    /// Whether this commit was an amend of the previous HEAD.
    pub amended: bool,
}

/// Whether the repo's effective config asks for signed commits
/// (`commit.gpgSign = true`). Read through a snapshot for a consistent merged
/// view (system + global + local), like [`gitconfig`](crate::gitconfig); git2
/// config keys are case-insensitive, so the lowercase lookup matches any
/// spelling.
fn signing_enabled(repo: &git2::Repository) -> bool {
    repo.config()
        .and_then(|mut c| c.snapshot())
        .and_then(|s| s.get_bool("commit.gpgsign"))
        .unwrap_or(false)
}

/// Write the current index as a new commit on HEAD.
///
/// Two paths: when `commit.gpgSign` is off (the default) we commit in-process
/// via git2; when it's on we shell out to the user's `git` instead, because
/// git2 never signs — the shell-out picks up the user's gpg/ssh signing
/// config, `gpg.format`, and key lookup for free.
impl Repo {
    pub fn commit(&self, subject: &str, body: Option<&str>, amend: bool) -> Result<CommitOutcome> {
        let repo = self.git2()?;

        let message = match body.map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) => format!("{}\n\n{}\n", subject.trim(), b),
            None => format!("{}\n", subject.trim()),
        };

        let oid = if signing_enabled(repo) {
            self.commit_via_git(&message, amend)?;
            repo.head()?.peel_to_commit()?.id()
        } else {
            let sig = repo.signature()?;
            let mut index = repo.index()?;
            let tree_oid = index.write_tree()?;
            let tree = repo.find_tree(tree_oid)?;

            if amend {
                let head = repo.head()?;
                let head_commit = head.peel_to_commit()?;
                // Author `None` keeps the original author (git2 reuses the
                // existing field), matching real `git commit --amend` and the
                // shell-out path; only the committer is the current user.
                head_commit.amend(
                    Some("HEAD"),
                    None,
                    Some(&sig),
                    None,
                    Some(&message),
                    Some(&tree),
                )?
            } else {
                // Parent list: HEAD if it exists; empty for the initial commit.
                let parents: Vec<git2::Commit> = match repo.head() {
                    Ok(h) => vec![h.peel_to_commit()?],
                    Err(_) => Vec::new(),
                };
                let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
                repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)?
            }
        };

        Ok(CommitOutcome {
            oid: oid.to_string(),
            amended: amend,
        })
    }

    /// Commit the staged index by shelling out to the user's `git` — the
    /// signing path, since git2 cannot sign. The message goes through a temp
    /// file (`-F`, with `--cleanup=verbatim`: the file is built by us and
    /// already exact, so verbatim keeps `#` lines AND byte parity with the
    /// git2 path, which never cleans) to dodge platform quoting. Unlike the
    /// git2 path this runs the user's hooks (pre-commit / commit-msg) — that
    /// matches plain `git commit` and is the same accepted trust boundary the
    /// other shell-out ops have (PRD §10).
    fn commit_via_git(&self, message: &str, amend: bool) -> Result<()> {
        let file = temp_message_file(message)?;
        let file_arg = file.to_string_lossy().into_owned();
        let mut args = vec!["commit", "-F", file_arg.as_str(), "--cleanup=verbatim"];
        if amend {
            args.push("--amend");
        }
        let res = run_git(&self.path, &args);
        // Best effort, on the error path too — a leak here is only temp litter.
        let _ = std::fs::remove_file(&file);
        res.map(|_| ())
    }
}

/// A unique temp file holding the commit message for `git commit -F`. Keyed by
/// pid + a process-wide counter so concurrent commits (different repos) don't
/// collide; the caller deletes it after the commit returns. `create_new`
/// refuses to open a path that already exists — including a pre-planted
/// symlink in the shared temp dir (local TOCTOU) — so a collision just bumps
/// the counter and retries (bounded).
fn temp_message_file(message: &str) -> Result<std::path::PathBuf> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    for _ in 0..16 {
        let path = std::env::temp_dir().join(format!(
            "strand-commit-msg-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(message.as_bytes())
                    .map_err(|e| Error::Other(format!("write commit message: {e}")))?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::Other(format!("write commit message: {e}"))),
        }
    }
    Err(Error::Other(
        "write commit message: could not create a fresh temp file".into(),
    ))
}

/// Run a blocking `git` subcommand in `cwd`, returning trimmed stdout and
/// mapping a non-zero exit to its combined stderr+stdout. Mirrors the helpers
/// in [`history`](crate::history) and `stash`; `GIT_TERMINAL_PROMPT=0` keeps a
/// stuck prompt (e.g. gpg pinentry fallback) from blocking. A free function
/// (not a `Repo` method) so it doesn't collide with `stash`'s same-named
/// helper on the same type.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = crate::git_command()
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Detach stdin so git can never block reading from a TTY/pipe we don't
        // have (the app isn't launched from a terminal) — it errors instead.
        .stdin(std::process::Stdio::null())
        // Neutralize repo-local config that would run code as a side effect.
        .args(crate::GIT_SAFE_CONFIG)
        .args(args)
        .output()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let combined = format!("{stdout}{stderr}").trim().to_string();
        return Err(Error::Other(if combined.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            combined
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// Throwaway repo via shell git, std-only temp dir like `history.rs`.
    /// Deliberately does NOT force `commit.gpgsign = false` — these tests set
    /// it per case to exercise both commit paths.
    fn scratch_repo() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-commit-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn stage(dir: &Path, file: &str, contents: &str) {
        std::fs::write(dir.join(file), contents).unwrap();
        git(dir, &["add", file]);
    }

    #[test]
    fn signing_enabled_defaults_off_and_follows_config() {
        let (repo, dir) = scratch_repo();
        let g2 = repo.git2().unwrap();
        assert!(!signing_enabled(&g2), "unset ⇒ off");

        git(&dir, &["config", "commit.gpgsign", "true"]);
        assert!(signing_enabled(&repo.git2().unwrap()));

        git(&dir, &["config", "commit.gpgsign", "false"]);
        assert!(!signing_enabled(&repo.git2().unwrap()));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unsigned_path_commits_subject_and_body() {
        let (repo, dir) = scratch_repo();
        git(&dir, &["config", "commit.gpgsign", "false"]);
        stage(&dir, "a.txt", "a\n");

        let out = repo.commit("subject", Some("body line"), false).unwrap();
        assert!(!out.amended);
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), out.oid);
        assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "subject\n\nbody line");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_via_git_writes_message_and_amend_replaces() {
        // gpgsign deliberately unset: commit_via_git itself doesn't read the
        // config (its caller routes), so it just makes a normal commit here.
        let (repo, dir) = scratch_repo();
        stage(&dir, "base.txt", "base\n");
        git(&dir, &["commit", "-q", "-m", "base"]);

        stage(&dir, "a.txt", "a\n");
        repo.commit_via_git("subject\n\nbody line\n", false).unwrap();
        assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "subject\n\nbody line");
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]), "2");

        // Amend as a *different* configured user: real git keeps the original
        // author and only updates the committer — assert that parity here.
        git(&dir, &["config", "user.name", "Other"]);
        git(&dir, &["config", "user.email", "other@example.com"]);
        repo.commit_via_git("amended subject\n", true).unwrap();
        assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "amended subject");
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]), "2", "amend replaces, not adds");
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%an <%ae>"]),
            "Test <test@example.com>",
            "amend preserves the original author"
        );
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%cn <%ce>"]),
            "Other <other@example.com>"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unsigned_amend_preserves_original_author() {
        let (repo, dir) = scratch_repo();
        git(&dir, &["config", "commit.gpgsign", "false"]);
        stage(&dir, "a.txt", "a\n");
        repo.commit("original", None, false).unwrap();

        // Same parity check for the git2 path: a different configured user
        // amends, the original author survives, the committer updates.
        git(&dir, &["config", "user.name", "Other"]);
        git(&dir, &["config", "user.email", "other@example.com"]);
        stage(&dir, "a.txt", "a2\n");
        let out = repo.commit("amended", None, true).unwrap();
        assert!(out.amended);
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]), "1", "amend replaces, not adds");
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%an <%ae>"]),
            "Test <test@example.com>",
            "amend preserves the original author"
        );
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%cn <%ce>"]),
            "Other <other@example.com>"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn gpgsign_true_routes_through_real_git_and_surfaces_failure() {
        // No real key in CI, so prove the routing instead: with signing on and
        // a key that can't exist, `Repo::commit` must fail (a silent unsigned
        // commit would be the bug this module exists to prevent).
        let (repo, dir) = scratch_repo();
        stage(&dir, "base.txt", "base\n");
        git(&dir, &["commit", "-q", "-m", "base"]);

        git(&dir, &["config", "commit.gpgsign", "true"]);
        git(&dir, &["config", "gpg.format", "ssh"]);
        let missing = dir.join("no-such-key").to_string_lossy().into_owned();
        git(&dir, &["config", "user.signingkey", &missing]);

        stage(&dir, "a.txt", "a\n");
        assert!(repo.commit("subject", None, false).is_err());
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]), "1", "failed commit left HEAD alone");

        let _ = std::fs::remove_dir_all(dir);
    }
}
