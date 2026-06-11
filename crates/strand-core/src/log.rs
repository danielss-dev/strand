use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub time_unix: i64,
    pub parents: Vec<String>,
}

/// Field separator inside one commit's format line (ASCII unit separator).
const FS: char = '\u{1f}';

impl Repo {
    /// Walk commits across **all refs** (`git log --all`-style), newest first,
    /// up to `limit`.
    ///
    /// We list HEAD (for the detached case) plus every local branch, remote-
    /// tracking branch, and tag, so the graph shows the whole repository, not
    /// just the checked-out branch's ancestry. That's what makes commits on
    /// *other* branches visible (and so cherry-pick / merge targets reachable)
    /// when an old branch is checked out. Annotated tags are peeled to their
    /// commit and non-committish refs are skipped, so tags are safe to include.
    /// Graph computation (lanes, ref chips) lives in the UI (`lib/graph.ts`).
    ///
    /// Implemented by shelling out to the user's `git` rather than a git2
    /// revwalk: git2's `Sort::TOPOLOGICAL` buffers the entire reachable DAG
    /// before yielding the first row, so `limit` doesn't bound the work (~0.5s
    /// floor on a 100k-commit repo, O(reachable) — it breaks the 2.0s open
    /// target at ~1M commits). `git` does an incremental, commit-graph-backed
    /// walk that stops once `limit` rows are produced (~12× faster for the
    /// first page; see `docs/perf-baseline.md`). `--date-order` reproduces the
    /// exact ordering git2's `Sort::TIME | Sort::TOPOLOGICAL` gave — a
    /// topological order (every parent after its children, which the lane algo
    /// relies on) broken ties by commit time — so the graph layout is
    /// unchanged. The ref selectors `HEAD --branches --remotes --tags` mirror
    /// the previous `push_head` + `push_glob` set exactly (not `--all`, which
    /// would also pull in `refs/stash` and notes).
    pub fn log(&self, limit: usize) -> Result<Vec<Commit>> {
        let limit_arg = limit.to_string();
        // One line per commit, fields split by FS; `-z` terminates each commit
        // record with NUL, so a multi-line body can't be mistaken for the next
        // record. `%ct` is committer time (what git2's `commit.time()` returned);
        // `%P` is space-separated full parent hashes (empty for a root commit).
        let format = format!("--format=%H{FS}%an{FS}%ae{FS}%ct{FS}%P{FS}%s{FS}%b");
        let out = crate::git_command()
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args([
                "log",
                "--date-order",
                "--no-color",
                "-z",
                "-n",
                &limit_arg,
                &format,
                "HEAD",
                "--branches",
                "--remotes",
                "--tags",
            ])
            .output()
            .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // An unborn HEAD / empty repo has no commits to walk; git errors on
            // the `HEAD` selector rather than printing nothing. git2's revwalk
            // returned an empty list there, so match that instead of surfacing
            // a "bad revision" error to the UI.
            let e = err.to_lowercase();
            if e.contains("does not have any commits")
                || e.contains("bad revision")
                || e.contains("unknown revision")
                || e.contains("bad default revision")
            {
                return Ok(Vec::new());
            }
            let err = err.trim().to_string();
            return Err(Error::Other(if err.is_empty() {
                "git log failed".to_string()
            } else {
                err
            }));
        }

        Ok(parse_log(&String::from_utf8_lossy(&out.stdout), limit))
    }
}

/// Parse `git log -z --format=…` output. Records are NUL-terminated; within a
/// record, fields are FS-separated in the order emitted by [`Repo::log`].
fn parse_log(stdout: &str, limit: usize) -> Vec<Commit> {
    let mut out = Vec::with_capacity(limit);
    for record in stdout.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut f = record.split(FS);
        let hash = f.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        let author_name = f.next().unwrap_or("").to_string();
        let author_email = f.next().unwrap_or("").to_string();
        let time_unix = f.next().unwrap_or("0").trim().parse().unwrap_or(0);
        let parents = f
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(|p| p.to_string())
            .collect();
        let subject = f.next().unwrap_or("").to_string();
        // Body is the remaining field; `%b` already drops the subject and the
        // blank line after it. Trim the trailing newline `%b` leaves so the
        // detail panel's monospace block doesn't end on a gap.
        let body = f.next().unwrap_or("").trim_end().to_string();
        out.push(Commit {
            short_hash: hash[..7.min(hash.len())].to_string(),
            hash,
            subject,
            body,
            author_name,
            author_email,
            time_unix,
            parents,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

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

    fn scratch() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-log-test-{}-{:?}",
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

    fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    #[test]
    fn empty_repo_yields_no_commits() {
        let (repo, dir) = scratch();
        // Unborn HEAD: git errors on the `HEAD` selector; we map it to empty.
        assert!(repo.log(100).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_subject_body_and_parents() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "one\n", "first commit");
        // A multi-line body with a blank-line gap from the subject.
        git(&dir, &["commit", "-q", "--allow-empty", "-m", "second", "-m", "body line 1\nbody line 2"]);

        let log = repo.log(100).unwrap();
        assert_eq!(log.len(), 2, "both commits returned, newest first");
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[0].body, "body line 1\nbody line 2");
        assert!(log[1].body.is_empty(), "first commit has no body");
        assert_eq!(log[0].short_hash, &log[0].hash[..7]);
        // Newest-first: the second commit's parent is the first.
        assert_eq!(log[0].parents, vec![log[1].hash.clone()]);
        assert!(log[1].parents.is_empty(), "root commit has no parents");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn includes_other_branches_and_holds_topo_invariant() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "base");
        // Branch off, commit on the side branch, then merge back — exercises
        // the multi-ref walk (`--branches`) and a 2-parent merge commit.
        git(&dir, &["checkout", "-q", "-b", "side"]);
        commit(&dir, "b.txt", "side\n", "on side");
        git(&dir, &["checkout", "-q", "main"]);
        commit(&dir, "a.txt", "2\n", "on main");
        git(&dir, &["merge", "-q", "--no-ff", "side", "-m", "merge side"]);

        let log = repo.log(100).unwrap();
        // base + on side + on main + merge = 4, all reachable from main's tip
        // and from `side` via --branches.
        assert_eq!(log.len(), 4);
        let merge = log.iter().find(|c| c.subject == "merge side").unwrap();
        assert_eq!(merge.parents.len(), 2, "merge has two parents");

        // Topological invariant the lane algo depends on: every parent that is
        // present in the page appears *after* (higher index than) its child.
        let pos: std::collections::HashMap<&str, usize> =
            log.iter().enumerate().map(|(i, c)| (c.hash.as_str(), i)).collect();
        for (i, c) in log.iter().enumerate() {
            for p in &c.parents {
                if let Some(&pi) = pos.get(p.as_str()) {
                    assert!(pi > i, "parent {p} must come after its child");
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
