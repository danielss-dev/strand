//! Manual bisect, driven by Git's worktree-local state (including external runs).
use crate::{Error, Repo, Result};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path, process::Stdio};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BisectState {
    pub active: bool,
    pub token: String,
    pub original: String,
    pub original_tip: String,
    pub current: String,
    pub subject: String,
    pub expected: String,
    pub good_term: String,
    pub bad_term: String,
    pub remaining: usize,
    pub remaining_truncated: bool,
    pub range_error: String,
    pub culprit: Option<String>,
    pub ambiguous: bool,
    pub no_checkout: bool,
    pub clean: bool,
    pub log: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BisectAction {
    Good,
    Bad,
    Skip,
    Reset,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BisectOutcome {
    pub success: bool,
    pub output: String,
    pub state: BisectState,
}

fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    Ok(crate::git_command()
        .current_dir(cwd)
        .args(crate::GIT_SAFE_CONFIG)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()?)
}
fn text(out: &std::process::Output) -> String {
    String::from_utf8_lossy(
        &out.stdout
            .iter()
            .chain(&out.stderr)
            .take(65536)
            .copied()
            .collect::<Vec<_>>(),
    )
    .trim()
    .to_owned()
}
fn checked(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = git(cwd, args)?;
    if !out.status.success() {
        return Err(Error::Other(text(&out)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
fn state_file(dir: &Path, name: &str) -> Result<String> {
    let file = match fs::File::open(dir.join(name)) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.into()),
    };
    let mut text = String::new();
    file.take(2 * 1024 * 1024 + 1).read_to_string(&mut text)?;
    if text.len() > 2 * 1024 * 1024 {
        return Err(Error::Other("bisect state is too large to inspect".into()));
    }
    Ok(text.trim().into())
}

impl Repo {
    pub fn bisect_state(&self) -> Result<BisectState> {
        let dir = self.git_dir();
        let active = dir.join("BISECT_START").exists();
        let original = state_file(dir, "BISECT_START")?;
        let log = state_file(dir, "BISECT_LOG")?;
        let expected = state_file(dir, "BISECT_EXPECTED_REV")?;
        let terms = state_file(dir, "BISECT_TERMS")?;
        let mut terms = terms.lines();
        let bad_term = terms.next().unwrap_or("bad").to_string();
        let good_term = terms.next().unwrap_or("good").to_string();
        let no_checkout = dir.join("BISECT_HEAD").exists();
        let fresh = self.git2_owned()?;
        let original_tip = fresh
            .find_reference(&format!("refs/heads/{original}"))
            .and_then(|r| r.peel_to_commit())
            .or_else(|_| fresh.revparse_single(&original)?.peel_to_commit())
            .map(|c| c.id().to_string())
            .unwrap_or_default();
        let revision = if no_checkout { "BISECT_HEAD" } else { "HEAD" };
        let commit = fresh.revparse_single(revision)?.peel_to_commit()?;
        let current = commit.id().to_string();
        let subject = commit.summary().unwrap_or("").to_owned();
        let status = checked(
            &self.path,
            &["status", "--porcelain", "--untracked-files=normal"],
        )?;
        let clean = status.is_empty();
        let candidates = if active {
            checked(
                &self.path,
                &[
                    "bisect",
                    "visualize",
                    "--format=%H",
                    "--no-patch",
                    "--max-count=10001",
                ],
            )
        } else {
            Ok(String::new())
        };
        let (candidates, range_error) = match candidates {
            Ok(value) => (value, String::new()),
            Err(e) => (String::new(), e.to_string()),
        };
        let remaining = candidates
            .lines()
            .filter(|l| l.len() == 40 || l.len() == 64)
            .count();
        let culprit = log.lines().rev().find_map(|line| {
            let prefix = format!("# first {bad_term} commit: [");
            line.strip_prefix(&prefix)
                .and_then(|s| s.split_once(']'))
                .map(|(oid, _)| oid.to_owned())
        });
        let ambiguous =
            active && culprit.is_none() && log.contains("# only skipped commits left to test");
        let refs = checked(
            &self.path,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/bisect/",
            ],
        )?;
        let stamp = format!("{active}:{original}:{original_tip}:{log}:{expected}:{current}:{refs}:{status}:{bad_term}:{good_term}:{}", state_file(dir, "HEAD")?);
        let token = git2::Oid::hash_object(git2::ObjectType::Blob, stamp.as_bytes())?.to_string();
        Ok(BisectState {
            active,
            token,
            original,
            original_tip,
            current,
            subject,
            expected,
            good_term,
            bad_term,
            remaining: remaining.min(10000),
            remaining_truncated: remaining > 10000,
            range_error,
            culprit,
            ambiguous,
            no_checkout,
            clean,
            log,
        })
    }

    pub fn bisect_start(&self, good: &str, bad: &str, token: &str) -> Result<BisectOutcome> {
        let before = self.bisect_state()?;
        if before.token != token {
            return Err(Error::Other(
                "repository changed; refresh the bisect review".into(),
            ));
        }
        if before.active || self.operation_in_progress().is_some() {
            return Err(Error::Other(
                "finish the current Git operation before starting bisect".into(),
            ));
        }
        if !before.clean {
            return Err(Error::Other(
                "commit or stash working-tree/index changes before bisect".into(),
            ));
        }
        let fresh = self.git2_owned()?;
        let good = fresh.revparse_single(good)?.peel_to_commit()?.id();
        let bad = fresh.revparse_single(bad)?.peel_to_commit()?.id();
        if good == bad || !fresh.graph_descendant_of(bad, good)? {
            return Err(Error::Other(
                "the good revision must be an earlier ancestor of the bad revision".into(),
            ));
        }
        let out = git(
            &self.path,
            &["bisect", "start", &bad.to_string(), &good.to_string(), "--"],
        )?;
        Ok(BisectOutcome {
            success: out.status.success(),
            output: text(&out),
            state: self.bisect_state()?,
        })
    }

    pub fn bisect_action(&self, action: BisectAction, token: &str) -> Result<BisectOutcome> {
        let before = self.bisect_state()?;
        if !before.active {
            return Err(Error::Other("no bisect session is active".into()));
        }
        if before.token != token {
            return Err(Error::Other(
                "bisect changed externally; refresh before rating a revision".into(),
            ));
        }
        if !before.clean {
            return Err(Error::Other(
                "commit or stash test edits before bisect changes the checkout".into(),
            ));
        }
        if self
            .operation_in_progress()
            .is_some_and(|op| op != "bisect")
        {
            return Err(Error::Other(
                "finish the other Git operation before continuing bisect".into(),
            ));
        }
        let out = if matches!(action, BisectAction::Reset) {
            // Never use checkout/reset --force. Git also protects the original
            // branch if another worktree has checked it out while we were testing.
            git(&self.path, &["bisect", "reset"])?
        } else {
            if before.culprit.is_some() || before.ambiguous {
                return Err(Error::Other(
                    "bisect has finished; review the result and reset".into(),
                ));
            }
            if !before.expected.is_empty() && before.current != before.expected {
                return Err(Error::Other("HEAD no longer matches Git's bisect selection; restore that checkout before rating".into()));
            }
            let term = match action {
                BisectAction::Good => &before.good_term,
                BisectAction::Bad => &before.bad_term,
                BisectAction::Skip => "skip",
                BisectAction::Reset => unreachable!(),
            };
            if term.starts_with('-')
                || !term
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return Err(Error::Other("unsupported external bisect term".into()));
            }
            git(&self.path, &["bisect", term, &before.current])?
        };
        Ok(BisectOutcome {
            success: out.status.success(),
            output: text(&out),
            state: self.bisect_state()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interchange::InterchangeScratch;
    fn fixture() -> (InterchangeScratch, Repo, Vec<String>) {
        let scratch = InterchangeScratch::new().unwrap();
        let repo = git2::Repository::init(&scratch.0).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Bisect Tester").unwrap();
        cfg.set_str("user.email", "bisect@example.test").unwrap();
        cfg.set_bool("commit.gpgsign", false).unwrap();
        cfg.set_str("core.hooksPath", "/dev/null").unwrap();
        let mut commits = vec![];
        for n in 0..8 {
            fs::write(scratch.0.join("number"), format!("{n}\n")).unwrap();
            checked(&scratch.0, &["add", "."]).unwrap();
            checked(&scratch.0, &["commit", "-m", &format!("step {n}")]).unwrap();
            commits.push(checked(&scratch.0, &["rev-parse", "HEAD"]).unwrap());
        }
        let handle = Repo::discover(&scratch.0).unwrap();
        (scratch, handle, commits)
    }
    #[test]
    fn finds_culprit_and_restores_original_branch() {
        let (_s, repo, commits) = fixture();
        let original = checked(&repo.path, &["symbolic-ref", "HEAD"]).unwrap();
        let mut state = repo
            .bisect_start(
                &commits[0],
                &commits[7],
                &repo.bisect_state().unwrap().token,
            )
            .unwrap()
            .state;
        assert!(state.active && state.remaining > 0);
        for _ in 0..10 {
            if state.culprit.is_some() {
                break;
            }
            let n = commits.iter().position(|c| c == &state.current).unwrap();
            state = repo
                .bisect_action(
                    if n >= 4 {
                        BisectAction::Bad
                    } else {
                        BisectAction::Good
                    },
                    &state.token,
                )
                .unwrap()
                .state;
        }
        assert_eq!(state.culprit, Some(commits[4].clone()), "{}", state.log);
        assert!(
            !repo
                .bisect_action(BisectAction::Reset, &state.token)
                .unwrap()
                .state
                .active
        );
        assert_eq!(
            checked(&repo.path, &["symbolic-ref", "HEAD"]).unwrap(),
            original
        );
        assert_eq!(
            checked(&repo.path, &["rev-parse", "HEAD"]).unwrap(),
            commits[7]
        );
    }
    #[test]
    fn external_session_stale_ratings_dirty_reset_and_skips() {
        let (_s, repo, commits) = fixture();
        checked(
            &repo.path,
            &["bisect", "start", &commits[7], &commits[0], "--"],
        )
        .unwrap();
        let state = repo.bisect_state().unwrap();
        assert!(state.active);
        checked(&repo.path, &["bisect", "good"]).unwrap();
        assert!(repo.bisect_action(BisectAction::Bad, &state.token).is_err());
        let fresh = repo.bisect_state().unwrap();
        fs::write(repo.path.join("number"), "test edits\n").unwrap();
        assert!(repo
            .bisect_action(BisectAction::Reset, &fresh.token)
            .is_err());
        assert_eq!(
            fs::read_to_string(repo.path.join("number")).unwrap(),
            "test edits\n"
        );
        checked(&repo.path, &["restore", "number"]).unwrap();
        let mut state = repo.bisect_state().unwrap();
        for _ in 0..10 {
            if state.ambiguous || state.culprit.is_some() {
                break;
            }
            state = repo
                .bisect_action(BisectAction::Skip, &state.token)
                .unwrap()
                .state;
        }
        assert!(state.ambiguous, "{}", state.log);
        assert!(
            repo.bisect_action(BisectAction::Reset, &state.token)
                .unwrap()
                .success
        );
    }
    #[test]
    fn linked_worktree_and_external_no_checkout_terms() {
        let (scratch, repo, commits) = fixture();
        let link = scratch.0.join("linked");
        checked(
            &repo.path,
            &["worktree", "add", "-b", "linked", link.to_str().unwrap()],
        )
        .unwrap();
        let linked = Repo::discover(&link).unwrap();
        checked(
            &link,
            &[
                "bisect",
                "start",
                "--no-checkout",
                "--term-good=old",
                "--term-bad=new",
                &commits[7],
                &commits[0],
                "--",
            ],
        )
        .unwrap();
        let state = linked.bisect_state().unwrap();
        assert!(state.active && state.no_checkout);
        assert!(!repo.bisect_state().unwrap().active);
        assert_eq!(state.good_term, "old");
        assert!(
            linked
                .bisect_action(BisectAction::Good, &state.token)
                .unwrap()
                .success
        );
        let state = linked.bisect_state().unwrap();
        assert!(
            linked
                .bisect_action(BisectAction::Reset, &state.token)
                .unwrap()
                .success
        );
    }
}
