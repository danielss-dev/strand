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
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::{error::Error, error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkOutcome {
    /// Combined stdout + stderr from `git`, trimmed. Surfaced to the UI so
    /// the user sees what git said — credential prompts, conflicts, etc.
    pub output: String,
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

impl Repo {
    pub fn fetch(
        &self,
        remote: Option<&str>,
        on_progress: impl FnMut(Progress),
    ) -> Result<NetworkOutcome> {
        let mut args = vec!["fetch", "--prune", "--progress"];
        if let Some(r) = remote {
            validate_remote_arg(r, "remote")?;
            // End-of-options before the (caller-supplied) remote so it can't
            // be read as a git option.
            args.push("--");
            args.push(r);
        }
        run_git_streaming(&self.path, &args, on_progress)
    }

    pub fn pull(&self, rebase: bool, on_progress: impl FnMut(Progress)) -> Result<NetworkOutcome> {
        let mut args = vec!["pull", "--progress"];
        if rebase {
            args.push("--rebase");
        }
        run_git_streaming(&self.path, &args, on_progress)
    }

    /// Push the current branch. If `force_with_lease` is set, uses the safer
    /// force variant — plain `--force` is never exposed from the UI.
    pub fn push(
        &self,
        force_with_lease: bool,
        on_progress: impl FnMut(Progress),
    ) -> Result<NetworkOutcome> {
        let mut args = vec!["push", "--progress"];
        if force_with_lease {
            args.push("--force-with-lease");
        }
        run_git_streaming(&self.path, &args, on_progress)
    }
}

/// Clone `url` into `dest` (the full target directory — git creates it).
/// Streams progress via `on_progress`; returns `dest` on success so the
/// caller can open the new repo. This is a free function, not a [`Repo`]
/// method, because there is no repo to open yet.
pub fn clone(
    url: &str,
    dest: &str,
    on_progress: impl FnMut(Progress),
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
        Some(parent) => run_git_streaming(parent, &args, on_progress),
        None => run_git_streaming(Path::new("."), &args, on_progress),
    }?;
    Ok(CloneOutcome {
        path: dest.to_string(),
        output: outcome.output,
    })
}

/// Reject a user-supplied remote/URL that git would mis-read as an option or
/// a command-executing transport. Paired with an explicit `--` separator at
/// the call site, this closes the "paste a malicious clone URL" vector.
fn validate_remote_arg(arg: &str, what: &str) -> Result<()> {
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

/// Spawn `git` with the given args in `cwd`, streaming stderr fragments to
/// `on_progress` while collecting the full combined output.
///
/// `GIT_TERMINAL_PROMPT=0` suppresses git's *own* built-in terminal prompt so
/// it errors instead of blocking on a TTY we can't show. Note this does *not*
/// disable a configured `credential.helper` (e.g. Git Credential Manager's GUI
/// dialog), `GIT_ASKPASS`/`SSH_ASKPASS`, or an SSH key passphrase prompt —
/// those are intentionally left working so the user can still authenticate.
/// A wall-clock timeout / cancel path for a genuinely stuck op is future work.
fn run_git_streaming(
    cwd: &Path,
    args: &[&str],
    mut on_progress: impl FnMut(Progress),
) -> Result<NetworkOutcome> {
    let mut child = Command::new("git")
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
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

    let mut collected = String::new();
    if let Some(stderr) = child.stderr.take() {
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
    let status = child
        .wait()
        .map_err(|e| Error::Other(format!("git wait failed: {e}")))?;

    let combined = format!("{stdout_str}{collected}").trim().to_string();
    if !status.success() {
        return Err(Error::Other(if combined.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            combined
        }));
    }
    Ok(NetworkOutcome { output: combined })
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
}
