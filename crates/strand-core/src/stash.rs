//! Stash operations — save, snapshot, list, apply, pop, drop.
//!
//! `list`/`save`/`drop` use git2's stash entry points (`stash_save2`,
//! `stash_drop`, `stash_foreach`), each on a freshly-opened owned
//! `git2::Repository` bound `mut` locally — same as every other write module.
//!
//! `apply`/`pop`/`snapshot` instead **shell out to `git`** (the same
//! subprocess approach [`network`] already uses). git2's `stash_apply` refuses
//! whenever the index holds unrelated staged changes ("uncommitted changes
//! exist in the index"), where real `git stash pop` merges cleanly; and git2
//! has no `stash create`/`store`, which is the disruption-free way to snapshot.
//! Matching git's actual behaviour matters more here than staying pure-git2.
//!
//! [`network`]: crate::network

use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stash {
    /// Stash index; 0 is the most recent, matching git's `stash@{0}`.
    pub index: usize,
    /// OID of the stash commit.
    pub oid: String,
    /// Full stash message as git stores it, e.g.
    /// `WIP on main: 1a2b3c4 Subject`.
    pub message: String,
    /// Branch the stash was taken on, parsed from the message when git's
    /// default format is recognisable.
    pub branch: Option<String>,
    /// First parent of the stash commit — the commit the stash was taken on.
    /// The graph attaches the stash node here. `None` only if the commit can't
    /// be read, which shouldn't happen for a valid stash.
    pub base: Option<String>,
    /// Committer time of the stash commit (Unix seconds), for the graph row's
    /// relative-date column.
    pub time_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashOutcome {
    /// OID of the created stash commit, or `None` when there was nothing to
    /// stash (a clean working tree). Surfacing the no-op as success lets the
    /// UI say "nothing to stash" without treating it as an error.
    pub oid: Option<String>,
}

impl Repo {
    /// List all stashes, most-recent first — the order `git stash list` uses.
    pub fn stash_list(&self) -> Result<Vec<Stash>> {
        let mut repo = self.git2()?;
        let mut out = Vec::new();
        repo.stash_foreach(|index, message, oid| {
            out.push(Stash {
                index,
                oid: oid.to_string(),
                message: message.to_string(),
                branch: parse_stash_branch(message),
                base: None,
                time_unix: 0,
            });
            true
        })?;
        // Enrich each entry with its base (first parent) + commit time. Done
        // after the walk because `stash_foreach` holds a `&mut` borrow of repo,
        // so we can't look up commits inside the closure.
        for s in &mut out {
            if let Ok(oid) = git2::Oid::from_str(&s.oid) {
                if let Ok(commit) = repo.find_commit(oid) {
                    s.time_unix = commit.time().seconds();
                    s.base = commit.parent_ids().next().map(|p| p.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Save the working-tree + index changes onto the stash stack.
    ///
    /// - `message` is an optional label; when `None` git writes its default
    ///   `WIP on <branch>: <oid> <subject>`.
    /// - `include_untracked` mirrors `git stash -u`.
    /// - `keep_index` mirrors `git stash --keep-index` (staged changes are
    ///   left in the working tree after stashing).
    ///
    /// A clean working tree makes git2 return [`NotFound`]; we map that to
    /// `StashOutcome { oid: None }` so "nothing to stash" reads as a no-op,
    /// not a failure.
    ///
    /// [`NotFound`]: git2::ErrorCode::NotFound
    pub fn stash_save(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
    ) -> Result<StashOutcome> {
        let mut repo = self.git2()?;
        let sig = repo.signature()?;

        let mut flags = git2::StashFlags::DEFAULT;
        if include_untracked {
            flags |= git2::StashFlags::INCLUDE_UNTRACKED;
        }
        if keep_index {
            flags |= git2::StashFlags::KEEP_INDEX;
        }

        match repo.stash_save2(&sig, message, Some(flags)) {
            Ok(oid) => Ok(StashOutcome {
                oid: Some(oid.to_string()),
            }),
            // libgit2 returns GIT_ENOTFOUND ("there is nothing to stash").
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(StashOutcome { oid: None }),
            Err(e) => Err(e.into()),
        }
    }

    /// Save a snapshot: record the current changes onto the stash stack *but
    /// leave them in the working tree* (Fork's "Save snapshot").
    ///
    /// Without untracked files we use `git stash create` + `git stash store`,
    /// which builds the stash commit straight from the current state and never
    /// touches the working tree or index — staged/unstaged splits are preserved
    /// exactly, with no flicker. `create` ignores untracked files, so when
    /// `include_untracked` is set we instead `push --include-untracked` and
    /// re-`apply --index`: the working tree is clean right after the push, so
    /// the re-apply reinstates everything (untracked included) without conflict.
    ///
    /// A clean working tree is the no-op `StashOutcome { oid: None }`, as in
    /// [`stash_save`](Repo::stash_save).
    pub fn stash_snapshot(
        &self,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<StashOutcome> {
        // NOTE: the user `message` is always passed as the value bound to `-m`,
        // never as a bare positional, so git can't read a leading-'-' message
        // as an option (unlike the remote/ref args in network/history, which
        // need an explicit `--`). Keep the `-m <msg>` form if you touch this.
        if include_untracked {
            let mut push: Vec<&str> = vec!["stash", "push", "--include-untracked"];
            if let Some(m) = message {
                push.push("-m");
                push.push(m);
            }
            let out = self.run_git(&push)?;
            // git prints this (and stashes nothing) for a clean tree.
            if out.contains("No local changes to save") {
                return Ok(StashOutcome { oid: None });
            }
            self.run_git(&["stash", "apply", "--index"])?;
            let oid = self.run_git(&["rev-parse", "stash@{0}"])?;
            Ok(StashOutcome { oid: Some(oid) })
        } else {
            let oid = self.run_git(&["stash", "create"])?;
            // An empty stdout from `stash create` means there was nothing to stash.
            if oid.is_empty() {
                return Ok(StashOutcome { oid: None });
            }
            let mut store: Vec<&str> = vec!["stash", "store"];
            if let Some(m) = message {
                store.push("-m");
                store.push(m);
            }
            store.push(&oid);
            self.run_git(&store)?;
            Ok(StashOutcome { oid: Some(oid) })
        }
    }

    /// Apply a stash by index, leaving it on the stack (`git stash apply`).
    /// Shells out so a dirty index merges as git does, rather than git2's
    /// blanket refusal. A genuine conflict leaves markers and errors.
    pub fn stash_apply(&self, index: usize) -> Result<()> {
        self.run_git(&["stash", "apply", &format!("stash@{{{index}}}")])?;
        Ok(())
    }

    /// Apply a stash by index and drop it on success (`git stash pop`). If the
    /// apply conflicts the stash is left intact, matching git.
    pub fn stash_pop(&self, index: usize) -> Result<()> {
        self.run_git(&["stash", "pop", &format!("stash@{{{index}}}")])?;
        Ok(())
    }

    /// Run a blocking `git` subcommand in the repo's working directory and
    /// return trimmed stdout, mapping a non-zero exit to its stderr. Mirrors
    /// the `git`-subprocess approach in [`network`](crate::network);
    /// `GIT_TERMINAL_PROMPT=0` stops a stuck auth prompt from blocking.
    fn run_git(&self, args: &[&str]) -> Result<String> {
        let out = Command::new("git")
            .current_dir(self.path())
            .env("GIT_TERMINAL_PROMPT", "0")
            // Neutralize repo-local config that would run code as a side effect.
            .args(crate::GIT_SAFE_CONFIG)
            .args(args)
            .output()
            .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(Error::Other(if stderr.is_empty() {
                format!("git {} failed", args.join(" "))
            } else {
                stderr
            }));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Drop a stash by index without applying it (`git stash drop`).
    ///
    /// **Destructive** — the discarded changes are unrecoverable through the
    /// app. The UI confirms before calling.
    pub fn stash_drop(&self, index: usize) -> Result<()> {
        let mut repo = self.git2()?;
        repo.stash_drop(index)?;
        Ok(())
    }
}

/// Parse the branch a stash was taken on out of its message. git formats the
/// default as `WIP on <branch>: <oid> <subject>`, and `git stash push -m msg`
/// as `On <branch>: <msg>`, so we read the segment between the leading
/// `WIP on `/`On ` and the first `:`. Returns `None` for any other shape.
fn parse_stash_branch(message: &str) -> Option<String> {
    let rest = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))?;
    let branch = rest.split(':').next()?.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

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

    #[test]
    fn stash_list_reports_base_and_time() {
        let dir = std::env::temp_dir().join(format!("strand-stash-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "base"]);
        let base = git(&dir, &["rev-parse", "HEAD"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        git(&dir, &["stash", "push", "-q", "-m", "wip"]);

        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();
        let stashes = repo.stash_list().unwrap();
        assert_eq!(stashes.len(), 1);
        // The stash node attaches to the commit it was taken on.
        assert_eq!(stashes[0].base.as_deref(), Some(base.as_str()));
        assert!(stashes[0].time_unix > 0, "commit time populated");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_default_wip_message() {
        assert_eq!(
            parse_stash_branch("WIP on main: 1a2b3c4 Add the thing"),
            Some("main".to_string())
        );
    }

    #[test]
    fn parses_custom_push_message() {
        assert_eq!(
            parse_stash_branch("On feature/login: half-finished form"),
            Some("feature/login".to_string())
        );
    }

    #[test]
    fn handles_branch_names_without_a_colon_body() {
        // Defensive: a message that starts right but has no `:` segment.
        assert_eq!(parse_stash_branch("WIP on main"), Some("main".to_string()));
    }

    #[test]
    fn returns_none_for_unrecognised_shape() {
        assert_eq!(parse_stash_branch("something else entirely"), None);
        assert_eq!(parse_stash_branch(""), None);
    }
}
