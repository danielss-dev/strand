//! Network ops (`clone` / `fetch` / `pull` / `push`) by shelling out to the
//! user's `git` binary.
//!
//! Rationale: the user already has credentials configured (`credential.helper`,
//! SSH agent, GPG signing, etc.) for their `git`. Re-implementing that in
//! `git2` or `gix` adds a lot of surface for v1. Sublime Merge and Tower
//! both shell out for the same reason.
//!
//! Progress is streamed: `git` writes progress to stderr as
//! carriage-return-delimited fragments (e.g. "Receiving objects:  42%
//! (123/456)"). We split those out, parse a phase + percent, and hand each
//! fragment to a caller-supplied callback. The Tauri layer wires that
//! callback to an IPC `Channel` so the UI can show a live progress bar; the
//! core stays UI-agnostic.

use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::{error::Error, error::Result, repo::Repo};

/// Cooperative cancellation for a shelled-out git op. The streaming runner
/// parks the spawned child here; `cancel()` kills it, which EOFs the pipes
/// and unwinds the runner with [`Error::Cancelled`]. Cancelling before the
/// child spawns also works — the runner checks the flag at install time.
#[derive(Clone, Default)]
pub struct CancelHandle(Arc<Mutex<CancelInner>>);

#[derive(Default)]
struct CancelInner {
    cancelled: bool,
    child: Option<std::process::Child>,
}

impl CancelHandle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        let mut inner = self.0.lock().expect("cancel handle lock");
        inner.cancelled = true;
        if let Some(child) = inner.child.as_mut() {
            let _ = child.kill();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.lock().expect("cancel handle lock").cancelled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkOutcome {
    /// Combined stdout + stderr from `git`, trimmed. Surfaced to the UI so
    /// the user sees what git said — credential prompts, conflicts, etc.
    pub output: String,
}

/// Full subprocess transcript used by callers that need to retain both
/// successful and failed Git output instead of mapping a non-zero exit to an
/// error immediately.
pub(crate) struct GitRunTranscript {
    pub output: String,
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloneOutcome {
    /// Absolute path of the freshly-cloned working tree, so the caller can
    /// open it straight away.
    pub path: String,
    /// Combined git output, trimmed.
    pub output: String,
}

/// One progress update parsed from `git`'s stderr while a network op runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    /// Phase label, e.g. "Receiving objects". Empty when the fragment had no
    /// `phase:` prefix (plain status lines).
    pub phase: String,
    /// Parsed `NN%` if the fragment carried one.
    pub percent: Option<u8>,
    /// The raw fragment, trimmed — shown verbatim when there's no percent.
    pub raw: String,
}

/// How `git pull` should integrate the fetched upstream branch.
/// `Default` delegates to the user's git configuration; explicit modes
/// override it for one operation.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullMode {
    #[default]
    Default,
    /// Fast-forward when possible, otherwise create a merge commit.
    Merge,
    Rebase,
    FastForwardOnly,
}

/// How the current branch should be pushed. Plain `--force` is intentionally
/// absent; Strand only exposes the guarded force-with-lease variant.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PushMode {
    #[default]
    Default,
    /// Push reachable annotated tags along with the current branch.
    FollowTags,
    ForceWithLease,
}

impl Repo {
    /// Fetch provider-reported branch tips for a read-only comparison without
    /// updating FETCH_HEAD or any local/remote-tracking ref. Hosted PR views
    /// use this when a provider exposes commit IDs but not a unified patch.
    pub fn fetch_refs_for_read(&self, remote: &str, refs: &[&str]) -> Result<()> {
        validate_remote_arg(remote, "remote")?;
        if refs.is_empty() {
            return Ok(());
        }
        for reference in refs {
            validate_read_ref(reference)?;
        }
        // An empty refmap disables remote.<name>.fetch; the trailing `:` makes
        // each command-line refspec source-only. Both are required — without
        // --refmap= Git still updates refs/remotes/<name>/*.
        let refspecs = refs
            .iter()
            .map(|reference| format!("{reference}:"))
            .collect::<Vec<_>>();
        let mut args = vec![
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--refmap=",
            "--quiet",
            "--",
            remote,
        ];
        args.extend(refspecs.iter().map(String::as_str));
        run_git_streaming(&self.path, &args, |_| {}, None)?;
        Ok(())
    }

    pub fn fetch(
        &self,
        remote: Option<&str>,
        prune: bool,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        let mut args = vec![
            "fetch",
            if prune { "--prune" } else { "--no-prune" },
            "--progress",
        ];
        if let Some(r) = remote {
            validate_remote_arg(r, "remote")?;
            // End-of-options before the (caller-supplied) remote so it can't
            // be read as a git option.
            args.push("--");
            args.push(r);
        }
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    pub fn pull(
        &self,
        mode: PullMode,
        autostash: bool,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        let args = pull_args(mode, autostash);
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    /// Fetch and integrate one explicitly selected branch from `remote` into
    /// the currently checked-out branch. The refspec also refreshes the
    /// corresponding remote-tracking ref, so the sidebar cannot remain stale
    /// after a successful pull.
    pub fn pull_branch(
        &self,
        remote: &str,
        branch: &str,
        mode: PullMode,
        autostash: bool,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        self.ensure_remote(remote)?;
        let source = validate_branch_ref(branch, "remote branch")?;
        let destination = validate_tracking_ref(remote, branch)?;
        let refspec = format!("+{source}:{destination}");
        let mut args = pull_args(mode, autostash);
        args.extend(["--", remote, refspec.as_str()]);
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    /// Push the current branch. Plain `--force` is never exposed from the UI.
    pub fn push(
        &self,
        mode: PushMode,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        let mut args = push_args(mode);
        if self.should_set_origin_upstream() {
            args.extend(["--set-upstream", "--", "origin", "HEAD"]);
        }
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    /// Push the current branch to an explicit remote. This is used by hosted
    /// PR creation when the source branch does not exist on that remote yet.
    /// Existing upstream configuration is preserved unless `set_upstream` is
    /// requested explicitly.
    pub fn push_current_to_remote(
        &self,
        remote: &str,
        set_upstream: bool,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        validate_remote_arg(remote, "remote")?;
        let mut args = vec!["push", "--progress"];
        if set_upstream {
            args.push("--set-upstream");
        }
        args.extend(["--", remote, "HEAD"]);
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    /// Push any local branch without checking it out first. The source and
    /// destination are fully qualified so Git never guesses which namespace
    /// is intended. `set_upstream` deliberately applies to `branch`, not HEAD.
    #[allow(clippy::too_many_arguments)]
    pub fn push_branch(
        &self,
        branch: &str,
        remote: &str,
        remote_branch: &str,
        mode: PushMode,
        set_upstream: bool,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        self.ensure_remote(remote)?;
        let source = validate_branch_ref(branch, "local branch")?;
        self.git2()?.find_branch(branch, git2::BranchType::Local)?;
        let destination = validate_branch_ref(remote_branch, "remote branch")?;
        let refspec = format!("{source}:{destination}");
        let mut args = push_args(mode);
        if set_upstream {
            args.push("--set-upstream");
        }
        args.extend(["--", remote, refspec.as_str()]);
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    /// Refresh one remote-tracking branch without fetching every ref on the
    /// remote. The leading `+` matches normal remote fetch refspecs: a remote
    /// force-push is reflected locally instead of leaving a stale tip.
    pub fn fetch_branch(
        &self,
        remote: &str,
        branch: &str,
        on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        self.ensure_remote(remote)?;
        let source = validate_branch_ref(branch, "remote branch")?;
        let destination = validate_tracking_ref(remote, branch)?;
        let refspec = format!("+{source}:{destination}");
        let args = ["fetch", "--progress", "--", remote, refspec.as_str()];
        run_git_streaming(&self.path, &args, on_progress, cancel)
    }

    fn ensure_remote(&self, remote: &str) -> Result<()> {
        validate_remote_arg(remote, "remote")?;
        self.git2()?.find_remote(remote)?;
        Ok(())
    }

    /// A freshly-created local branch has no push destination under Git's
    /// default `push.default=simple`. Establish `origin/<branch>` on its first
    /// push, but leave every configured push route (upstream, pushRemote, or
    /// remote.pushDefault) to Git so existing workflows keep their semantics.
    fn should_set_origin_upstream(&self) -> bool {
        let Ok(repo) = self.git2() else { return false };
        let Ok(head) = repo.head() else { return false };
        if !head.is_branch() {
            return false;
        }
        let Some(full_name) = head.name() else {
            return false;
        };
        if repo.branch_upstream_name(full_name).is_ok() || repo.find_remote("origin").is_err() {
            return false;
        }

        let Some(branch) = head.shorthand() else {
            return false;
        };
        let Ok(config) = repo.config() else {
            return false;
        };
        config
            .get_string(&format!("branch.{branch}.pushRemote"))
            .is_err()
            && config.get_string("remote.pushDefault").is_err()
            && config
                .get_string(&format!("branch.{branch}.remote"))
                .is_err()
    }

    /// Delete `branch` on `remote` (`git push <remote> --delete refs/heads/<branch>`).
    /// The push also drops the local `refs/remotes/<remote>/<branch>` tracking
    /// ref, so a refs refresh afterward reflects the deletion on both sides. The
    /// ref is fully-qualified to `refs/heads/` (plus a `--` separator) so a stray
    /// branch name can never be read as a git option.
    pub fn delete_remote_branch(
        &self,
        remote: &str,
        branch: &str,
        on_progress: impl FnMut(Progress),
    ) -> Result<NetworkOutcome> {
        validate_remote_arg(remote, "remote")?;
        let refspec = format!("refs/heads/{branch}");
        let args = vec!["push", "--progress", "--delete", "--", remote, refspec.as_str()];
        run_git_streaming(&self.path, &args, on_progress, None)
    }

    /// Push a single tag to `remote`, or delete it there when `delete` is set
    /// (`git push <remote> [--delete] refs/tags/<tag>`). Tags are local until
    /// pushed, and a tag deleted locally stays on the remote until deleted
    /// there too — this covers both halves.
    pub fn push_tag(
        &self,
        tag: &str,
        remote: &str,
        delete: bool,
        on_progress: impl FnMut(Progress),
    ) -> Result<NetworkOutcome> {
        validate_remote_arg(remote, "remote")?;
        // Fully-qualify the ref so git never guesses (and a `--` separator
        // keeps both the remote and refspec out of option parsing).
        let refspec = format!("refs/tags/{tag}");
        let mut args = vec!["push", "--progress"];
        if delete {
            args.push("--delete");
        }
        args.push("--");
        args.push(remote);
        args.push(refspec.as_str());
        run_git_streaming(&self.path, &args, on_progress, None)
    }

    /// Push every local tag to `remote` (`git push <remote> --tags`).
    pub fn push_all_tags(
        &self,
        remote: &str,
        on_progress: impl FnMut(Progress),
    ) -> Result<NetworkOutcome> {
        validate_remote_arg(remote, "remote")?;
        let args = vec!["push", "--progress", "--tags", "--", remote];
        run_git_streaming(&self.path, &args, on_progress, None)
    }

    /// Short names of the tags that exist on `remote` (`git ls-remote --tags`).
    ///
    /// Fetched tags land in the shared `refs/tags/` namespace with no marker of
    /// origin, so this is the only reliable way to know which tags a remote
    /// already has — used to gray out "delete on remote" for tags that aren't
    /// there. A network call, so callers run it off the hot path.
    pub fn remote_tags(&self, remote: &str) -> Result<Vec<String>> {
        validate_remote_arg(remote, "remote")?;
        let out = crate::git_command()
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args(["ls-remote", "--tags", "--", remote])
            .output()
            .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(Error::Other(if err.is_empty() {
                "git ls-remote failed".to_string()
            } else {
                err
            }));
        }
        // Each line is `<oid>\trefs/tags/<name>`, with a second `<name>^{}`
        // line for annotated tags (the peeled commit). A BTreeSet folds those
        // duplicates and sorts.
        let text = String::from_utf8_lossy(&out.stdout);
        let mut names = std::collections::BTreeSet::new();
        for line in text.lines() {
            if let Some((_, refname)) = line.split_once('\t') {
                if let Some(name) = refname.strip_prefix("refs/tags/") {
                    names.insert(name.strip_suffix("^{}").unwrap_or(name).to_string());
                }
            }
        }
        Ok(names.into_iter().collect())
    }
}

fn pull_args(mode: PullMode, autostash: bool) -> Vec<&'static str> {
    let mut args = vec![
        "pull",
        "--progress",
        if autostash { "--autostash" } else { "--no-autostash" },
    ];
    match mode {
        PullMode::Default => {}
        PullMode::Merge => args.extend(["--no-rebase", "--ff"]),
        PullMode::Rebase => args.push("--rebase"),
        PullMode::FastForwardOnly => args.push("--ff-only"),
    }
    args
}

fn push_args(mode: PushMode) -> Vec<&'static str> {
    let mut args = vec!["push", "--progress"];
    match mode {
        PushMode::Default => {}
        PushMode::FollowTags => args.push("--follow-tags"),
        PushMode::ForceWithLease => args.push("--force-with-lease"),
    }
    args
}

fn validate_branch_ref(branch: &str, what: &str) -> Result<String> {
    let branch = branch.trim();
    let full = format!("refs/heads/{branch}");
    if branch.is_empty() || !git2::Reference::is_valid_name(&full) {
        return Err(Error::Other(format!("invalid {what} name: {branch}")));
    }
    Ok(full)
}

fn validate_tracking_ref(remote: &str, branch: &str) -> Result<String> {
    let full = format!("refs/remotes/{remote}/{}", branch.trim());
    if !git2::Reference::is_valid_name(&full) {
        return Err(Error::Other(format!("invalid remote-tracking ref: {remote}/{branch}")));
    }
    Ok(full)
}

/// Clone `url` into `dest` (the full target directory — git creates it).
/// Streams progress via `on_progress`; returns `dest` on success so the
/// caller can open the new repo. This is a free function, not a [`Repo`]
/// method, because there is no repo to open yet.
pub fn clone(
    url: &str,
    dest: &str,
    on_progress: impl FnMut(Progress),
    cancel: Option<&CancelHandle>,
) -> Result<CloneOutcome> {
    // The URL is pasted by the user. Make sure git can't read it as an option
    // (`--upload-pack=…`, `-c …`) or as a command-executing transport
    // (`ext::`, `fd::`). The `--` end-of-options separator below is the belt
    // to this validation's suspenders; both are needed (a `--` alone won't
    // stop `ext::sh -c …`, which is a value, not an option).
    validate_remote_arg(url, "clone URL")?;

    let dest_path = Path::new(dest);
    // Run from the destination's parent so a relative `dest` still lands in
    // the right place; an absolute `dest` ignores the cwd anyway.
    let cwd = dest_path.parent().filter(|p| !p.as_os_str().is_empty());
    let args = ["clone", "--progress", "--", url, dest];
    let outcome = match cwd {
        Some(parent) => run_git_streaming(parent, &args, on_progress, cancel),
        None => run_git_streaming(Path::new("."), &args, on_progress, cancel),
    }?;
    Ok(CloneOutcome {
        path: dest.to_string(),
        output: outcome.output,
    })
}

/// Reject a user-supplied remote/URL that git would mis-read as an option or
/// a command-executing transport. Paired with an explicit `--` separator at
/// the call site, this closes the "paste a malicious clone URL" vector.
/// `pub(crate)` so `remote.rs` applies the same gate when a URL is *stored*
/// (add / set-url) — a saved `ext::` URL would execute on the next fetch.
pub(crate) fn validate_remote_arg(arg: &str, what: &str) -> Result<()> {
    if arg.starts_with('-') {
        return Err(Error::Other(format!("{what} may not start with '-': {arg}")));
    }
    let lower = arg.to_ascii_lowercase();
    // `ext::` / `fd::` transports let a remote string run arbitrary commands;
    // we never want them from a pasted URL.
    if lower.starts_with("ext::") || lower.starts_with("fd::") {
        return Err(Error::Other(format!("unsupported transport in {what}: {arg}")));
    }
    Ok(())
}

fn validate_read_ref(reference: &str) -> Result<()> {
    let github_pull_head = reference
        .strip_prefix("refs/pull/")
        .and_then(|tail| tail.strip_suffix("/head"))
        .is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        });
    if !(reference.starts_with("refs/heads/") || github_pull_head)
        || reference.contains(':')
        || reference.contains("..")
        || reference.contains(['\n', '\r'])
    {
        return Err(Error::Other(format!(
            "unsupported ref for hosted comparison: {reference}"
        )));
    }
    Ok(())
}

/// Spawn `git` with the given args in `cwd`, streaming stderr fragments to
/// `on_progress` while collecting the full combined output.
///
/// `GIT_TERMINAL_PROMPT=0` suppresses git's *own* built-in terminal prompt so
/// it errors instead of blocking on a TTY we can't show. Note this does *not*
/// disable a configured `credential.helper` (e.g. Git Credential Manager's GUI
/// dialog), `GIT_ASKPASS`/`SSH_ASKPASS`, or an SSH key passphrase prompt —
/// those are intentionally left working so the user can still authenticate.
///
/// When `cancel` is given, the spawned child is parked in it so the caller
/// can kill a hung op; cancellation surfaces as [`Error::Cancelled`].
pub(crate) fn run_git_streaming(
    cwd: &Path,
    args: &[&str],
    on_progress: impl FnMut(Progress),
    cancel: Option<&CancelHandle>,
) -> Result<NetworkOutcome> {
    let transcript = run_git_streaming_transcript(cwd, args, on_progress, cancel)?;
    if !transcript.success {
        return Err(Error::Other(error_summary(&transcript.output, args)));
    }
    Ok(NetworkOutcome {
        output: transcript.output,
    })
}

pub(crate) fn run_git_streaming_transcript(
    cwd: &Path,
    args: &[&str],
    mut on_progress: impl FnMut(Progress),
    cancel: Option<&CancelHandle>,
) -> Result<GitRunTranscript> {
    let mut child = crate::git_command()
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Neutralize repo-local config that would run code as a side effect.
        .args(crate::GIT_SAFE_CONFIG)
        // Force progress reporting even though stderr isn't a TTY.
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;

    // Drain stdout on a separate thread so a large stdout can't deadlock us
    // while we're blocked reading stderr (and vice-versa).
    let stdout_handle = child.stdout.take().map(|mut out| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        })
    });
    let stderr = child.stderr.take();

    // Park the child in the cancel handle (pipes already taken) so a
    // concurrent `cancel()` can kill it. A cancel that raced the spawn is
    // honored here, before we start reading.
    let handle = cancel.cloned().unwrap_or_default();
    {
        let mut inner = handle.0.lock().expect("cancel handle lock");
        if inner.cancelled {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Cancelled);
        }
        inner.child = Some(child);
    }

    let mut collected = String::new();
    if let Some(stderr) = stderr {
        // `git` delimits progress updates with '\r' and ends phases with
        // '\n', so we split on either. BufRead::lines would coalesce all the
        // '\r' updates into one line — we want each fragment.
        for_each_fragment(stderr, |frag| {
            collected.push_str(frag);
            collected.push('\n');
            let p = parse_progress(frag);
            if !p.raw.is_empty() {
                on_progress(p);
            }
        });
    }

    let stdout_str = stdout_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    // Stderr hit EOF, so the process is done (or killed) — take the child
    // back out and reap it. After this point a late `cancel()` is a no-op.
    let status = {
        let mut taken = handle.0.lock().expect("cancel handle lock").child.take();
        taken
            .as_mut()
            .expect("child parked above")
            .wait()
            .map_err(|e| Error::Other(format!("git wait failed: {e}")))?
    };
    if handle.is_cancelled() {
        return Err(Error::Cancelled);
    }

    let combined = format!("{stdout_str}{collected}").trim().to_string();
    Ok(GitRunTranscript {
        output: combined,
        success: status.success(),
    })
}

/// Pull the meaningful failure out of a git transcript. git streams progress to
/// stderr too, so the full combined output is mostly "Resolving deltas: NN%"
/// noise with the actual `fatal:` / `error:` line buried at the very end —
/// returning the whole thing makes the UI show the *start* ("Cloning into…"),
/// not the cause. Surface git's error lines (or, lacking any, the tail).
fn error_summary(combined: &str, args: &[&str]) -> String {
    let errs: Vec<&str> = combined
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .collect();
    if !errs.is_empty() {
        return errs.join("\n");
    }
    let lines: Vec<&str> = combined.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return format!("git {} failed", args.join(" "));
    }
    // No explicit error line — show the last few lines, where the conclusion is.
    lines[lines.len().saturating_sub(4)..].join("\n")
}

/// Read `reader` and call `sink` with each fragment delimited by '\r' or
/// '\n' (empty fragments skipped). Buffered internally, so the byte-wise
/// read loop stays cheap.
fn for_each_fragment(reader: impl Read, mut sink: impl FnMut(&str)) {
    let mut reader = std::io::BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                let b = byte[0];
                if b == b'\r' || b == b'\n' {
                    if !buf.is_empty() {
                        sink(&String::from_utf8_lossy(&buf));
                        buf.clear();
                    }
                } else {
                    buf.push(b);
                }
            }
            Err(_) => break,
        }
    }
    if !buf.is_empty() {
        sink(&String::from_utf8_lossy(&buf));
    }
}

/// Pull a `phase:` label and a trailing `NN%` out of a raw git progress
/// fragment. Both are best-effort — a fragment without a colon has an empty
/// phase, one without a percent has `None`.
fn parse_progress(raw: &str) -> Progress {
    let raw = raw.trim();
    let phase = match raw.split_once(':') {
        Some((p, _)) => p.trim().to_string(),
        None => String::new(),
    };
    let percent = raw
        .split_whitespace()
        .find_map(|tok| tok.strip_suffix('%').and_then(|n| n.parse::<u8>().ok()));
    Progress {
        phase,
        percent,
        raw: raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn git_succeeds(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .current_dir(dir)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    fn push_fixture() -> (Repo, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "strand-push-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let local = base.join("local");
        let remote = base.join("remote.git");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&local).unwrap();
        git(&local, &["init", "-q", "-b", "topic"]);
        git(&local, &["config", "user.name", "Test"]);
        git(&local, &["config", "user.email", "test@example.com"]);
        git(&local, &["config", "commit.gpgsign", "false"]);
        git(&local, &["config", "push.default", "simple"]);
        std::fs::write(local.join("a.txt"), "one\n").unwrap();
        git(&local, &["add", "a.txt"]);
        git(&local, &["commit", "-q", "-m", "first"]);
        git(&base, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(
            &local,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let repo = Repo::discover(&local).unwrap();
        (repo, local, base)
    }

    #[test]
    fn parses_phase_and_percent() {
        let p = parse_progress("Receiving objects:  42% (123/456), 1.50 MiB | 3.00 MiB/s");
        assert_eq!(p.phase, "Receiving objects");
        assert_eq!(p.percent, Some(42));
    }

    #[test]
    fn parses_completed_phase() {
        let p = parse_progress("Resolving deltas: 100% (50/50), done.");
        assert_eq!(p.phase, "Resolving deltas");
        assert_eq!(p.percent, Some(100));
    }

    #[test]
    fn handles_no_colon_and_no_percent() {
        let p = parse_progress("remote: Enumerating objects");
        // The first colon belongs to the "remote" prefix git emits.
        assert_eq!(p.phase, "remote");
        assert_eq!(p.percent, None);
        assert_eq!(p.raw, "remote: Enumerating objects");
    }

    #[test]
    fn splits_cr_and_lf_fragments() {
        let input = "Counting: 10%\rCounting: 100%\nDone\n";
        let mut frags = Vec::new();
        for_each_fragment(input.as_bytes(), |f| frags.push(f.to_string()));
        assert_eq!(frags, vec!["Counting: 10%", "Counting: 100%", "Done"]);
    }

    #[test]
    fn rejects_option_like_and_command_transports() {
        assert!(validate_remote_arg("--upload-pack=touch /tmp/x", "clone URL").is_err());
        assert!(validate_remote_arg("-c protocol.ext.allow=always", "clone URL").is_err());
        assert!(validate_remote_arg("ext::sh -c 'touch /tmp/x'", "clone URL").is_err());
        assert!(validate_remote_arg("EXT::sh -c x", "clone URL").is_err());
        // Legitimate URLs pass.
        assert!(validate_remote_arg("https://github.com/org/repo.git", "clone URL").is_ok());
        assert!(validate_remote_arg("git@github.com:org/repo.git", "clone URL").is_ok());
        assert!(validate_remote_arg("ssh://git@host/path.git", "clone URL").is_ok());
    }

    #[test]
    fn hosted_comparison_accepts_only_full_branch_or_github_pull_refs() {
        assert!(validate_read_ref("refs/heads/main").is_ok());
        assert!(validate_read_ref("refs/heads/feature/nested").is_ok());
        assert!(validate_read_ref("refs/pull/42/head").is_ok());
        assert!(validate_read_ref("refs/pull/nope/head").is_err());
        assert!(validate_read_ref("refs/pull/42/merge").is_err());
        assert!(validate_read_ref("main").is_err());
        assert!(validate_read_ref("refs/tags/v1").is_err());
        assert!(validate_read_ref("refs/heads/../../oops").is_err());
        assert!(validate_read_ref("refs/heads/a:b").is_err());
    }

    #[test]
    fn hosted_comparison_fetch_does_not_update_repository_refs() {
        let (publisher, publisher_path, base) = push_fixture();
        publisher.push(PushMode::Default, |_| {}, None).unwrap();
        let topic = git(&publisher_path, &["rev-parse", "HEAD"]);

        let consumer_path = base.join("consumer");
        std::fs::create_dir_all(&consumer_path).unwrap();
        git(&consumer_path, &["init", "-q", "-b", "main"]);
        let remote = base.join("remote.git");
        git(
            &consumer_path,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let consumer = Repo::discover(&consumer_path).unwrap();

        consumer
            .fetch_refs_for_read("origin", &["refs/heads/topic"])
            .unwrap();

        assert_eq!(git(&consumer_path, &["cat-file", "-t", &topic]), "commit");
        assert!(!consumer_path.join(".git/FETCH_HEAD").exists());
        let remote_ref = Command::new("git")
            .current_dir(&consumer_path)
            .args(["show-ref", "--verify", "refs/remotes/origin/topic"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!remote_ref.success());

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn error_summary_extracts_fatal_lines() {
        // A real out-of-disk clone transcript: the cause is the trailing fatals,
        // not the "Cloning into…" preamble or the resolve-deltas progress noise.
        let transcript = "Cloning into '/x/linux'...\n\
            remote: Enumerating objects: 11556596, done.\n\
            Resolving deltas: 100% (9348480/9348480), done.\n\
            fatal: sha1 file '/x/linux/.git/objects/pack/tmp_idx' write error. Out of diskspace\n\
            fatal: fetch-pack: invalid index-pack output";
        let s = error_summary(transcript, &["clone", "--progress", "--", "url", "/x/linux"]);
        assert_eq!(
            s,
            "fatal: sha1 file '/x/linux/.git/objects/pack/tmp_idx' write error. Out of diskspace\n\
             fatal: fetch-pack: invalid index-pack output",
        );
    }

    #[test]
    fn error_summary_falls_back_to_tail() {
        let transcript = "line1\nline2\nremote: some context\nfetch-pack: protocol error\nconnection reset by peer";
        let s = error_summary(transcript, &["fetch"]);
        assert!(s.contains("connection reset by peer"));
        assert!(!s.contains("line1")); // only the last 4 lines are kept
    }

    #[test]
    fn error_summary_empty_names_the_command() {
        assert_eq!(error_summary("", &["push"]), "git push failed");
    }

    #[test]
    fn first_push_creates_origin_branch_and_upstream() {
        let (repo, local, base) = push_fixture();

        repo.push(PushMode::Default, |_| {}, None).unwrap();
        assert_eq!(
            git(&local, &["config", "--get", "branch.topic.remote"]),
            "origin"
        );
        assert_eq!(
            git(&local, &["config", "--get", "branch.topic.merge"]),
            "refs/heads/topic"
        );
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]),
            git(&local, &["rev-parse", "refs/remotes/origin/topic"])
        );

        std::fs::write(local.join("a.txt"), "two\n").unwrap();
        git(&local, &["commit", "-qam", "second"]);
        repo.push(PushMode::Default, |_| {}, None).unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]),
            git(&local, &["rev-parse", "refs/remotes/origin/topic"])
        );

        drop(repo);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn explicit_remote_push_preserves_an_existing_upstream() {
        let (repo, local, base) = push_fixture();
        let other = base.join("other.git");
        git(&base, &["init", "--bare", other.to_str().unwrap()]);
        git(&local, &["remote", "add", "other", other.to_str().unwrap()]);
        git(&local, &["config", "branch.topic.remote", "other"]);
        git(&local, &["config", "branch.topic.merge", "refs/heads/topic"]);

        repo.push_current_to_remote("origin", false, |_| {}, None)
            .unwrap();

        assert_eq!(
            git(&local, &["config", "--get", "branch.topic.remote"]),
            "other"
        );
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]),
            git(&local, &["rev-parse", "refs/remotes/origin/topic"])
        );

        drop(repo);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn pushes_a_non_current_branch_to_an_explicit_destination_and_tracks_it() {
        let (repo, local, base) = push_fixture();
        git(&local, &["branch", "feature"]);
        git(&local, &["switch", "feature"]);
        std::fs::write(local.join("a.txt"), "feature\n").unwrap();
        git(&local, &["commit", "-qam", "feature"]);
        git(&local, &["switch", "topic"]);

        repo.push_branch(
            "feature",
            "origin",
            "published-feature",
            PushMode::Default,
            true,
            |_| {},
            None,
        )
        .unwrap();

        assert_eq!(git(&local, &["branch", "--show-current"]), "topic");
        assert_eq!(
            git(&local, &["rev-parse", "refs/heads/feature"]),
            git(&local, &["rev-parse", "refs/remotes/origin/published-feature"])
        );
        assert_eq!(git(&local, &["config", "branch.feature.remote"]), "origin");
        assert_eq!(
            git(&local, &["config", "branch.feature.merge"]),
            "refs/heads/published-feature"
        );

        drop(repo);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn fetches_then_pulls_one_selected_remote_branch() {
        let (publisher, publisher_path, base) = push_fixture();
        publisher.push(PushMode::Default, |_| {}, None).unwrap();
        let first = git(&publisher_path, &["rev-parse", "HEAD"]);
        let remote = base.join("remote.git");
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/topic"]);

        let consumer_path = base.join("consumer");
        git(&base, &["clone", "-q", remote.to_str().unwrap(), consumer_path.to_str().unwrap()]);
        git(&consumer_path, &["config", "commit.gpgsign", "false"]);

        std::fs::write(publisher_path.join("a.txt"), "two\n").unwrap();
        git(&publisher_path, &["commit", "-qam", "second"]);
        publisher.push(PushMode::Default, |_| {}, None).unwrap();
        let second = git(&publisher_path, &["rev-parse", "HEAD"]);

        let consumer = Repo::discover(&consumer_path).unwrap();
        consumer.fetch_branch("origin", "topic", |_| {}, None).unwrap();
        assert_eq!(git(&consumer_path, &["rev-parse", "HEAD"]), first);
        assert_eq!(
            git(&consumer_path, &["rev-parse", "refs/remotes/origin/topic"]),
            second
        );

        consumer
            .pull_branch(
                "origin",
                "topic",
                PullMode::FastForwardOnly,
                false,
                |_| {},
                None,
            )
            .unwrap();
        assert_eq!(git(&consumer_path, &["rev-parse", "HEAD"]), second);
        assert_eq!(git(&consumer_path, &["branch", "--show-current"]), "topic");

        drop(consumer);
        drop(publisher);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn explicit_pull_modes_override_git_config() {
        assert_eq!(
            pull_args(PullMode::Default, false),
            ["pull", "--progress", "--no-autostash"]
        );
        assert_eq!(
            pull_args(PullMode::Merge, false),
            ["pull", "--progress", "--no-autostash", "--no-rebase", "--ff"]
        );
        assert_eq!(
            pull_args(PullMode::Rebase, true),
            ["pull", "--progress", "--autostash", "--rebase"]
        );
        assert_eq!(
            pull_args(PullMode::FastForwardOnly, true),
            ["pull", "--progress", "--autostash", "--ff-only"]
        );
    }

    #[test]
    fn fetch_prune_is_an_explicit_per_operation_choice() {
        let (publisher, publisher_path, base) = push_fixture();
        publisher.push(PushMode::Default, |_| {}, None).unwrap();
        git(&publisher_path, &["branch", "stale"]);
        git(&publisher_path, &["push", "-q", "origin", "stale"]);

        let remote = base.join("remote.git");
        let consumer_path = base.join("consumer");
        git(
            &base,
            &["clone", "-q", remote.to_str().unwrap(), consumer_path.to_str().unwrap()],
        );
        let consumer = Repo::discover(&consumer_path).unwrap();
        assert!(git_succeeds(
            &consumer_path,
            &["show-ref", "--verify", "refs/remotes/origin/stale"]
        ));

        git(&publisher_path, &["push", "-q", "origin", "--delete", "stale"]);
        consumer.fetch(Some("origin"), false, |_| {}, None).unwrap();
        assert!(git_succeeds(
            &consumer_path,
            &["show-ref", "--verify", "refs/remotes/origin/stale"]
        ));
        consumer.fetch(Some("origin"), true, |_| {}, None).unwrap();
        assert!(!git_succeeds(
            &consumer_path,
            &["show-ref", "--verify", "refs/remotes/origin/stale"]
        ));

        drop(consumer);
        drop(publisher);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn pull_autostash_restores_dirty_tracked_changes() {
        let (publisher, publisher_path, base) = push_fixture();
        let original = (1..=20).map(|n| format!("line {n}\n")).collect::<String>();
        std::fs::write(publisher_path.join("b.txt"), &original).unwrap();
        git(&publisher_path, &["add", "b.txt"]);
        git(&publisher_path, &["commit", "-q", "-m", "add b"]);
        publisher.push(PushMode::Default, |_| {}, None).unwrap();

        let remote = base.join("remote.git");
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/topic"]);
        let consumer_path = base.join("consumer");
        git(
            &base,
            &["clone", "-q", remote.to_str().unwrap(), consumer_path.to_str().unwrap()],
        );
        git(&consumer_path, &["config", "pull.ff", "only"]);

        let upstream = original.replace("line 20\n", "upstream line 20\n");
        std::fs::write(publisher_path.join("b.txt"), upstream).unwrap();
        git(&publisher_path, &["commit", "-qam", "upstream edit"]);
        publisher.push(PushMode::Default, |_| {}, None).unwrap();

        let local = original.replace("line 1\n", "local line 1\n");
        std::fs::write(consumer_path.join("b.txt"), local).unwrap();
        let consumer = Repo::discover(&consumer_path).unwrap();
        assert!(consumer
            .pull(PullMode::FastForwardOnly, false, |_| {}, None)
            .is_err());
        consumer
            .pull(PullMode::FastForwardOnly, true, |_| {}, None)
            .unwrap();

        let restored = std::fs::read_to_string(consumer_path.join("b.txt")).unwrap();
        assert!(restored.contains("local line 1"));
        assert!(restored.contains("upstream line 20"));
        assert!(git_succeeds(
            &consumer_path,
            &["diff", "--quiet", "--", "a.txt"]
        ));
        assert!(!git_succeeds(
            &consumer_path,
            &["diff", "--quiet", "--", "b.txt"]
        ));

        drop(consumer);
        drop(publisher);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn guarded_push_modes_never_use_plain_force() {
        assert_eq!(push_args(PushMode::Default), ["push", "--progress"]);
        assert_eq!(push_args(PushMode::FollowTags), ["push", "--progress", "--follow-tags"]);
        let forced = push_args(PushMode::ForceWithLease);
        assert_eq!(forced, ["push", "--progress", "--force-with-lease"]);
        assert!(!forced.contains(&"--force"));
    }

    #[test]
    fn explicit_branch_refs_reject_invalid_names() {
        assert_eq!(validate_branch_ref("feature/nested", "branch").unwrap(), "refs/heads/feature/nested");
        assert!(validate_branch_ref("", "branch").is_err());
        // Dash-leading short names are safe because the generated full ref is
        // passed after `--`; validity, not option-like spelling, is the gate.
        assert_eq!(validate_branch_ref("--force", "branch").unwrap(), "refs/heads/--force");
        assert!(validate_branch_ref("../escape", "branch").is_err());
        assert!(validate_tracking_ref("origin", "bad..name").is_err());
    }
}
