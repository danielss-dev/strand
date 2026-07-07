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

/// The `--format` arg shared by [`Repo::log`] and [`Repo::search_log`], so both
/// produce records [`parse_log`] can read. One line per commit, fields split by
/// FS; with `-z` each record is NUL-terminated so a multi-line body can't be
/// mistaken for the next record. `%ct` is committer time (what git2's
/// `commit.time()` returned); `%P` is space-separated full parent hashes (empty
/// for a root commit); `%s`/`%b` are subject and body.
fn commit_format() -> String {
    format!("--format=%H{FS}%an{FS}%ae{FS}%ct{FS}%P{FS}%s{FS}%b")
}

/// Which field [`Repo::search_log`] matches against. Serialized lowercase
/// (`"message"` / `"author"` / `"content"`) over IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// The commit *message* (subject + body) — `git log --grep`.
    Message,
    /// The author name / email — `git log --author`.
    Author,
    /// The commit's *diff* content — `git log -G` (the "pickaxe"): commits
    /// whose change added or removed a line matching the query. This is the
    /// one search the client side can't do over the loaded log (it has no
    /// diffs), and the reason this command exists.
    Content,
}

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
        self.run_log(limit, false)
    }

    /// Like [`Repo::log`], but walk **HEAD's ancestry only** — no branch /
    /// remote / tag selectors. This is what a "this checkout's last commit"
    /// answer needs: worktrees share the family's refs, so the all-ref walk
    /// leads with the *newest commit anywhere in the family* regardless of
    /// which worktree's path you ask through (every worktree-overview row
    /// showed the same subject the moment one worktree committed).
    pub fn log_head(&self, limit: usize) -> Result<Vec<Commit>> {
        self.run_log(limit, true)
    }

    fn run_log(&self, limit: usize, head_only: bool) -> Result<Vec<Commit>> {
        let limit_arg = limit.to_string();
        let format = commit_format();
        let mut cmd = crate::git_command();
        cmd.current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args(["log", "--date-order", "--no-color", "-z", "-n", &limit_arg, &format, "HEAD"]);
        if !head_only {
            cmd.args(["--branches", "--remotes", "--tags"]);
        }
        let out = cmd
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

    /// Search commits across **all history** (every ref, not just the loaded
    /// window) by message, author, or diff content, newest first, up to
    /// `limit` matches.
    ///
    /// The in-graph search highlights matches over the already-loaded log
    /// client-side — instant, but blind to commits past the loaded window and
    /// unable to search file *contents* (it holds no diffs). This shells out to
    /// `git log` with the matching filter so both gaps close:
    /// `--grep` / `--author` reach the full history, and `-G` (the pickaxe)
    /// searches each commit's diff for an added/removed line matching the query.
    ///
    /// `--grep` / `--author` use `--fixed-strings` so a plain-text query is a
    /// literal substring match (mirroring the client side's `includes`); `-G`
    /// is always a regular expression (the pickaxe has no fixed-string form), so
    /// content queries are treated as regexes. `-i` makes all three
    /// case-insensitive. Note `--grep` matches the **whole** message (subject +
    /// body), unlike the client-side subject-only highlight — full-history
    /// search is an explicit, scannable result list, not a wash over the graph,
    /// so a body/trailer hit is acceptable here.
    ///
    /// A blank query returns an empty list rather than matching everything. The
    /// ref selectors and empty-repo handling mirror [`Repo::log`].
    pub fn search_log(&self, query: &str, mode: SearchMode, limit: usize) -> Result<Vec<Commit>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit_arg = limit.to_string();
        let format = commit_format();
        // Attached forms (`--grep=…`, `-G…`) so a query beginning with `-`
        // can't be re-read as an option.
        let filter = match mode {
            SearchMode::Message => format!("--grep={query}"),
            SearchMode::Author => format!("--author={query}"),
            SearchMode::Content => format!("-G{query}"),
        };
        let mut cmd = crate::git_command();
        cmd.current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args(["log", "--date-order", "--no-color", "-z", "-i", "-n", &limit_arg]);
        // Fixed-string match for message/author; `-G` stays a regex.
        if !matches!(mode, SearchMode::Content) {
            cmd.arg("--fixed-strings");
        }
        cmd.arg(&format)
            .arg(&filter)
            .args(["HEAD", "--branches", "--remotes", "--tags"]);

        let out = cmd
            .output()
            .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;

        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            // Same unborn-HEAD / empty-repo mapping as `log`.
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
                "git log search failed".to_string()
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

    #[test]
    fn log_head_walks_only_head_ancestry() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "base");
        // A newer commit on a side branch, then back to main: the all-ref walk
        // leads with the side tip; the HEAD-only walk must not see it.
        git(&dir, &["checkout", "-q", "-b", "side"]);
        commit(&dir, "b.txt", "side\n", "newer on side");
        git(&dir, &["checkout", "-q", "main"]);

        assert_eq!(repo.log(1).unwrap()[0].subject, "newer on side");
        let head = repo.log_head(100).unwrap();
        assert_eq!(head.len(), 1, "side's commit is not in HEAD's ancestry");
        assert_eq!(head[0].subject, "base");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_head_empty_repo_yields_no_commits() {
        let (repo, dir) = scratch();
        assert!(repo.log_head(100).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Run a search with a generous default limit, unwrapping the result.
    fn search(repo: &Repo, q: &str, mode: SearchMode) -> Vec<Commit> {
        repo.search_log(q, mode, 100).unwrap()
    }

    #[test]
    fn search_empty_query_returns_empty() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "x\n", "only commit");
        // Blank / whitespace-only must not match everything.
        assert!(search(&repo, "", SearchMode::Message).is_empty());
        assert!(search(&repo, "   ", SearchMode::Content).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_message_matches_subject_case_insensitive() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "fix the parser");
        commit(&dir, "b.txt", "2\n", "add a feature");

        // Substring, case-insensitive.
        let got = search(&repo, "PARSER", SearchMode::Message);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].subject, "fix the parser");
        // No match → empty (not an error).
        assert!(search(&repo, "nonexistent", SearchMode::Message).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_author_matches_name_or_email() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "by test");
        // A commit by a different author.
        std::fs::write(dir.join("b.txt"), "2\n").unwrap();
        git(&dir, &["add", "b.txt"]);
        git(&dir, &["commit", "-q", "-m", "by alice", "--author=Alice <alice@example.com>"]);

        let alice = search(&repo, "alice", SearchMode::Author);
        assert_eq!(alice.len(), 1, "only Alice's commit matches");
        assert_eq!(alice[0].subject, "by alice");
        // The default author (Test <test@example.com>) authored the other.
        let test = search(&repo, "test@example.com", SearchMode::Author);
        assert_eq!(test.len(), 1);
        assert_eq!(test[0].subject, "by test");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_content_pickaxe_finds_touching_commit_only() {
        let (repo, dir) = scratch();
        // Content tokens deliberately absent from the messages, so a hit can
        // only come from the diff — not the subject.
        commit(&dir, "f.txt", "needle_x\n", "first change");
        commit(&dir, "f.txt", "needle_x\nneedle_y\n", "second change");

        let yy = search(&repo, "needle_y", SearchMode::Content);
        assert_eq!(yy.len(), 1, "only the commit whose diff added needle_y");
        assert_eq!(yy[0].subject, "second change");

        // `-G needle_x` matches only the commit that added that line, not the
        // one where it's mere context — that's the pickaxe's whole point.
        let xx = search(&repo, "needle_x", SearchMode::Content);
        assert_eq!(xx.len(), 1);
        assert_eq!(xx[0].subject, "first change");

        // A message-mode search for the same token finds nothing (no message
        // contains it), proving content search reaches where message can't.
        assert!(search(&repo, "needle_y", SearchMode::Message).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_respects_limit_and_searches_all_branches() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "match one");
        commit(&dir, "b.txt", "2\n", "match two");
        // A commit on another branch must still be reachable (mirrors `log`'s
        // `--branches` ref set, so search isn't limited to the current branch).
        git(&dir, &["checkout", "-q", "-b", "side"]);
        commit(&dir, "c.txt", "3\n", "match three");
        git(&dir, &["checkout", "-q", "main"]);

        let all = search(&repo, "match", SearchMode::Message);
        let unique: std::collections::HashSet<_> = all.iter().map(|c| &c.hash).collect();
        assert_eq!(unique.len(), 3, "all three across both branches");

        // `limit` bounds the result count (newest first).
        let capped = repo.search_log("match", SearchMode::Message, 2).unwrap();
        assert_eq!(capped.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
