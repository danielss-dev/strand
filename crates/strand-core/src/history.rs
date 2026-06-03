//! History-rewriting ops — cherry-pick, revert, merge, rebase, and abort.
//!
//! All five **shell out to `git`**, the same approach [`network`] and the
//! `stash apply`/`pop`/`snapshot` paths already take. The reasons are the same
//! ones that made stash give up on git2: real `git` resolves conflicts the way
//! the user expects (leaving conflict markers + the in-progress state on disk),
//! signs the resulting commits with the user's GPG/SSH config, and runs their
//! hooks — none of which git2's `merge`/`cherrypick`/`revert` primitives do for
//! free, and git2 has no rebase driver worth re-implementing. The cost is a
//! `git` subprocess per op, which is negligible next to the work itself.
//!
//! Conflicts are *not* an error we hide: when an op stops with conflicts `git`
//! exits non-zero and leaves the repo mid-operation, so we return its message
//! and let the UI surface it. The in-progress state is reported by
//! [`Repo::meta`](crate::repo::Repo::meta)'s `operation` field, and
//! [`abort_operation`](Repo::abort_operation) is the escape hatch.
//!
//! [`network`]: crate::network

use std::path::Path;
use std::process::Command;

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// How a merge should be performed. Mirrors the three choices the Merge dialog
/// offers; `FastForwardOnly`/other niche modes are intentionally omitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMode {
    /// Fast-forward when possible, otherwise create a merge commit (git's
    /// default — `git merge <ref>`).
    Auto,
    /// Always create a merge commit, even when a fast-forward was possible
    /// (`git merge --no-ff <ref>`).
    NoFastForward,
    /// Stage the merged result without committing or recording a second parent
    /// (`git merge --squash <ref>`). The user reviews + commits afterward.
    Squash,
}

impl MergeMode {
    /// Parse the wire string the IPC layer passes (`"auto"` / `"no_ff"` /
    /// `"squash"`).
    pub fn from_wire(s: &str) -> Result<Self> {
        match s {
            "auto" => Ok(Self::Auto),
            "no_ff" => Ok(Self::NoFastForward),
            "squash" => Ok(Self::Squash),
            other => Err(Error::Other(format!("unknown merge mode `{other}`"))),
        }
    }
}

impl Repo {
    /// Cherry-pick one or more commits onto HEAD, in the order given
    /// (`git cherry-pick <oid>…`). Each commit is any revspec git understands.
    ///
    /// Returns `Ok(true)` when the pick stopped on a **conflict** (the op is
    /// left in progress with unmerged files to resolve — an expected outcome,
    /// not a failure), `Ok(false)` when it applied cleanly, and `Err` only for
    /// a real failure (e.g. picking a merge commit without `-m`).
    pub fn cherry_pick(&self, commits: &[String]) -> Result<bool> {
        if commits.is_empty() {
            return Err(Error::Other("cherry-pick: no commits given".into()));
        }
        let mut args = vec!["cherry-pick"];
        push_revs(&mut args, commits)?;
        self.run_sequencer(&args)
    }

    /// Revert one or more commits, recording the inverse as new commits
    /// (`git revert --no-edit <oid>…`). `--no-edit` keeps git from opening an
    /// editor. `Ok(true)` on conflict, like [`cherry_pick`](Repo::cherry_pick).
    pub fn revert(&self, commits: &[String]) -> Result<bool> {
        if commits.is_empty() {
            return Err(Error::Other("revert: no commits given".into()));
        }
        let mut args = vec!["revert", "--no-edit"];
        push_revs(&mut args, commits)?;
        self.run_sequencer(&args)
    }

    /// Merge `refname` into the current branch.
    ///
    /// `--no-edit` avoids the merge-message editor for the merge-commit cases.
    /// `Squash` stages the result without committing (no `--no-edit` — nothing
    /// is committed). Returns `Ok(true)` when the merge stopped on conflicts
    /// (left in progress for resolution), `Ok(false)` on a clean merge, and
    /// `Err` for a real failure (dirty tree, unrelated histories, …).
    pub fn merge(&self, refname: &str, mode: MergeMode) -> Result<bool> {
        validate_ref(refname)?;
        let mut args = vec!["merge"];
        match mode {
            MergeMode::Auto => args.push("--no-edit"),
            MergeMode::NoFastForward => {
                args.push("--no-ff");
                args.push("--no-edit");
            }
            MergeMode::Squash => args.push("--squash"),
        }
        // End-of-options so a branch literally named like a flag can't be read
        // as one (paired with the leading-'-' rejection in `validate_ref`).
        args.push("--");
        args.push(refname);
        self.run_sequencer(&args)
    }

    /// Rebase the current branch onto `onto` (`git rebase <onto>`). A dirty
    /// working tree makes git refuse — that surfaces as `Err`. `Ok(true)` when
    /// the rebase paused on a conflict.
    pub fn rebase(&self, onto: &str) -> Result<bool> {
        validate_ref(onto)?;
        self.run_sequencer(&["rebase", "--", onto])
    }

    /// Run a sequencer op (`merge`/`cherry-pick`/`revert`/`rebase`) and map its
    /// exit to a conflict-aware result. A conflict makes git exit non-zero but
    /// is an *expected* outcome — the op ran and left unmerged entries — so we
    /// return `Ok(true)` instead of an error when the index has conflicts.
    /// Only a genuine failure (no conflicts left behind) is an `Err`.
    fn run_sequencer(&self, args: &[&str]) -> Result<bool> {
        match run_git(&self.path, args) {
            Ok(_) => Ok(false),
            Err(e) => {
                if self.has_conflicts().unwrap_or(false) {
                    Ok(true)
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Whether the index currently holds unmerged (conflicted) entries.
    fn has_conflicts(&self) -> Result<bool> {
        Ok(self.git2()?.index()?.has_conflicts())
    }

    /// Abort the sequencer/merge/rebase operation currently in progress,
    /// restoring HEAD and the working tree to their pre-op state. Detects which
    /// op is live from the on-disk markers (the same ones
    /// [`meta`](Repo::meta) reads) and runs the matching `--abort`. Errors when
    /// nothing is in progress.
    pub fn abort_operation(&self) -> Result<()> {
        let op = self
            .operation_in_progress()
            .ok_or_else(|| Error::Other("no operation in progress to abort".into()))?;
        let cmd = match op.as_str() {
            "rebase" => "rebase",
            "cherry-pick" => "cherry-pick",
            "revert" => "revert",
            "merge" => "merge",
            other => return Err(Error::Other(format!("cannot abort `{other}`"))),
        };
        run_git(&self.path, &[cmd, "--abort"])?;
        Ok(())
    }
}

/// Append validated revspecs after a `--` end-of-options separator.
fn push_revs<'a>(args: &mut Vec<&'a str>, commits: &'a [String]) -> Result<()> {
    for c in commits {
        validate_ref(c)?;
    }
    args.push("--");
    for c in commits {
        args.push(c.as_str());
    }
    Ok(())
}

/// Reject a revspec git would mis-read as an option. The call sites also pass
/// `--` so this is belt-and-suspenders, but it gives a clearer error than git's.
fn validate_ref(rev: &str) -> Result<()> {
    if rev.is_empty() {
        return Err(Error::Other("empty revision".into()));
    }
    if rev.starts_with('-') {
        return Err(Error::Other(format!("revision may not start with '-': {rev}")));
    }
    Ok(())
}

/// Run a blocking `git` subcommand in `cwd`, returning trimmed stdout and
/// mapping a non-zero exit to its combined stderr+stdout. Mirrors the
/// subprocess helpers in [`network`](crate::network) and `stash`;
/// `GIT_TERMINAL_PROMPT=0` keeps a stuck auth prompt from blocking. A free
/// function (not a `Repo` method) so it doesn't collide with `stash`'s
/// same-named helper on the same type.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Detach stdin so git can never block reading from a TTY/pipe we don't
        // have (the app isn't launched from a terminal) — it errors instead.
        .stdin(std::process::Stdio::null())
        .args(args)
        .output()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    if !out.status.success() {
        // On conflict git writes the useful part to stdout ("CONFLICT (content):
        // …") and a short summary to stderr — combine so the UI sees both.
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

    /// Build a throwaway repo, configured enough to commit, and return its
    /// `Repo` + working dir. Std-only (no `tempfile` dev-dep), like `tag.rs`.
    fn scratch_repo() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-history-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
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

    fn write_commit(dir: &Path, file: &str, contents: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), contents).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-q", "-m", msg]);
        git(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn merge_no_ff_creates_merge_commit_and_revert_undoes_a_commit() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "base");

        // Diverge: a feature branch adds a file, main adds another.
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feat.txt", "feature\n", "feat");
        git(&dir, &["checkout", "-q", "main"]);
        let main_c = write_commit(&dir, "main.txt", "main\n", "main");

        // No-ff merge of feature → a merge commit with two parents on main.
        repo.merge("feature", MergeMode::NoFastForward).unwrap();
        let head = git(&dir, &["rev-parse", "HEAD"]);
        let parents = git(&dir, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 3, "merge commit has 2 parents");
        assert!(parents.contains(&main_c), "first parent is the old main tip");
        assert!(dir.join("feat.txt").exists(), "feature file merged in");
        assert_ne!(head, main_c);

        // Revert the file-adding commit on main and confirm it's gone.
        repo.revert(&[main_c.clone()]).unwrap();
        assert!(!dir.join("main.txt").exists(), "revert removed main.txt");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cherry_pick_brings_a_commit_across_branches() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        let pick = write_commit(&dir, "only-feature.txt", "x\n", "add only-feature");
        git(&dir, &["checkout", "-q", "main"]);

        assert!(!dir.join("only-feature.txt").exists());
        repo.cherry_pick(&[pick]).unwrap();
        assert!(dir.join("only-feature.txt").exists(), "cherry-picked file present on main");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn conflict_is_reported_and_abortable() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "f.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "f.txt", "feature side\n", "feat edit");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "f.txt", "main side\n", "main edit");

        // Both branches edited the same line → merge conflicts. That's an
        // expected outcome (Ok(true)), not an error.
        let conflicted = repo.merge("feature", MergeMode::Auto).unwrap();
        assert!(conflicted, "divergent edits to the same line conflict");
        // meta reports the in-progress merge, and abort clears it.
        assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("merge"));
        repo.abort_operation().unwrap();
        assert_eq!(repo.meta().unwrap().operation, None);
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "main side\n");

        let _ = std::fs::remove_dir_all(dir);
    }
}
