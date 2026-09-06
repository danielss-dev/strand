use std::path::Path;
use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
    signing::SigningMode,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitOutcome {
    /// The new HEAD oid as a hex string.
    pub oid: String,
    /// Whether this commit was an amend of the previous HEAD.
    pub amended: bool,
    /// Bounded stdout and stderr, including successful hook diagnostics.
    pub output: String,
}

/// Commit/amend always use system Git: it owns hooks (including hooksPath),
/// identity, merge parents, signing and message rewrites. Index edits stay on
/// git2. This deliberately supersedes the old unsigned git2 fast path.
impl Repo {
    pub fn commit(&self, subject: &str, body: Option<&str>, amend: bool) -> Result<CommitOutcome> {
        self.commit_with_signing(subject, body, amend, SigningMode::Inherit)
    }

    pub fn commit_with_signing(&self, subject: &str, body: Option<&str>, amend: bool, signing: SigningMode) -> Result<CommitOutcome> {
        let message = match body.map(str::trim).filter(|b| !b.is_empty()) {
            Some(b) => format!("{}\n\n{}\n", subject.trim(), b),
            None => format!("{}\n", subject.trim()),
        };
        let output = self.commit_via_git(&message, amend, signing)?;
        let oid = self.git2()?.head()?.peel_to_commit()?.id().to_string();
        Ok(CommitOutcome { oid, amended: amend, output })
    }

    fn commit_via_git(&self, message: &str, amend: bool, signing: SigningMode) -> Result<String> {
        let file = temp_message_file(message)?;
        let file_arg = file.to_string_lossy().into_owned();
        let mut args = vec!["commit", "-F", file_arg.as_str(), "--cleanup=verbatim"];
        if amend { args.push("--amend"); }
        match signing {
            SigningMode::Inherit => {},
            SigningMode::Sign => args.push("--gpg-sign"),
            SigningMode::Unsigned => args.push("--no-gpg-sign"),
        }
        let res = run_git(&self.path, &args);
        let _ = std::fs::remove_file(&file);
        res
    }
}

/// A unique temp file holding the commit message for `git commit -F`. Keyed by
/// pid + a process-wide counter so concurrent commits (different repos) don't
/// collide; the caller deletes it after the commit returns. `create_new`
/// refuses to open a path that already exists — including a pre-planted
/// symlink in the shared temp dir (local TOCTOU) — so a collision just bumps
/// the counter and retries (bounded).
pub(crate) fn temp_message_file(message: &str) -> Result<std::path::PathBuf> {
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
    let out = crate::git_output::capture(crate::git_command()
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Detach stdin so git can never block reading from a TTY/pipe we don't
        // have (the app isn't launched from a terminal) — it errors instead.
        .stdin(std::process::Stdio::null())
        // Neutralize repo-local config that would run code as a side effect.
        .args(crate::GIT_SAFE_CONFIG)
        .env("GIT_EDITOR", ":")
        .args(args))
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
    Ok(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string())
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
        git(&dir, &["config", "commit.gpgsign", "false"]);
        git(&dir, &["config", "core.hooksPath", ".git/hooks"]);
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

    fn hook(dir: &Path, name: &str, script: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn hooks_reject_rewrite_and_run_after_commit_and_amend() {
        let (repo, dir) = scratch_repo();
        stage(&dir, "a.txt", "a\n");
        let hooks = dir.join("custom hooks");
        git(&dir, &["config", "core.hooksPath", "custom hooks"]);
        hook(&hooks, "pre-commit", "echo policy-rejected >&2; exit 1");
        let error = repo.commit("draft", Some("body"), false).unwrap_err().to_string();
        assert!(error.contains("policy-rejected"));
        assert!(repo.git2().unwrap().head().is_err());
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]), "a.txt");
        hook(&hooks, "pre-commit", "echo pre-commit-ok");
        hook(&hooks, "prepare-commit-msg", "echo prepared >> \"$1\"");
        hook(&hooks, "commit-msg", "echo rewritten >> \"$1\"");
        hook(&hooks, "post-commit", "echo post-commit-ok >&2");
        hook(&hooks, "post-rewrite", "read old new; echo post-rewrite-$1-$old-$new >&2");
        let outcome = repo.commit("draft", Some("body"), false).unwrap();
        assert!(outcome.output.contains("pre-commit-ok"));
        assert!(outcome.output.contains("post-commit-ok"));
        assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "draft\n\nbody\nprepared\nrewritten");
        hook(&hooks, "commit-msg", "echo message-rejected >&2; exit 1");
        assert!(repo.commit("amend draft", None, true).unwrap_err().to_string().contains("message-rejected"));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), outcome.oid);
        hook(&hooks, "commit-msg", "echo amended >> \"$1\"");
        let amended = repo.commit("amend draft", None, true).unwrap();
        assert!(amended.output.contains(&format!("post-rewrite-amend-{}-{}", outcome.oid, amended.oid)));
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]), "1");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hook_output_is_bounded_and_preserves_final_failure() {
        let (repo, dir) = scratch_repo();
        stage(&dir, "a.txt", "a\n");
        hook(&dir.join(".git/hooks"), "pre-commit", "i=0; while [ $i -lt 3000 ]; do echo verbose-hook-output; echo verbose-stderr >&2; i=$((i+1)); done; echo final-rejection >&2; exit 1");
        let error = repo.commit("draft", None, false).unwrap_err().to_string();
        assert!(error.len() < 34 * 1024);
        assert!(error.contains("output truncated"));
        assert!(error.ends_with("final-rejection"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "manual no-hook latency measurement"]
    fn measure_no_hook_commit_path() {
        let (repo, dir) = scratch_repo();
        let mut samples = Vec::new();
        for i in 0..25 {
            stage(&dir, "a.txt", &format!("{i}\n"));
            let start = std::time::Instant::now();
            repo.commit("measurement", None, false).unwrap();
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let mut previous = Vec::new();
        for i in 0..25 {
            stage(&dir, "a.txt", &format!("old-{i}\n"));
            let start = std::time::Instant::now();
            let g2 = repo.git2().unwrap();
            let sig = g2.signature().unwrap();
            let tree_oid = g2.index().unwrap().write_tree().unwrap();
            let tree = g2.find_tree(tree_oid).unwrap();
            let parent = g2.head().unwrap().peel_to_commit().unwrap();
            g2.commit(Some("HEAD"), &sig, &sig, "measurement", &tree, &[&parent]).unwrap();
            previous.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        previous.sort_by(f64::total_cmp);
        println!("previous git2 path: median {:.2}ms, p95 {:.2}ms (25 iterations)", previous[12], previous[23]);
        samples.sort_by(f64::total_cmp);
        println!("no-hook Git commit: median {:.2}ms, p95 {:.2}ms (25 iterations)", samples[12], samples[23]);
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
        repo.commit_via_git("subject\n\nbody line\n", false, SigningMode::Inherit).unwrap();
        assert_eq!(git(&dir, &["log", "-1", "--format=%B"]), "subject\n\nbody line");
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]), "2");

        // Amend as a *different* configured user: real git keeps the original
        // author and only updates the committer — assert that parity here.
        git(&dir, &["config", "user.name", "Other"]);
        git(&dir, &["config", "user.email", "other@example.com"]);
        repo.commit_via_git("amended subject\n", true, SigningMode::Inherit).unwrap();
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

        // A different configured user
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
