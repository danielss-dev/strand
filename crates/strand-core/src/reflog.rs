//! Reflog — the local record of where a ref has pointed over time.
//!
//! `git reflog` is the safety net for "I lost a commit": every time HEAD (or a
//! branch) moves — commit, checkout, reset, rebase, merge — git appends an entry
//! recording the old → new OID, who moved it, and a message. Unlike the commit
//! graph, the reflog is *local* and *chronological* (newest first), so it
//! surfaces commits that are no longer reachable from any ref (e.g. after a hard
//! reset or an abandoned rebase) — the only UI path back to them.
//!
//! Read via `git2::Repository::reflog`, which parses `.git/logs/<ref>`. This is a
//! pure local read (no network, no hooks), so git2 is the right tool — no need to
//! shell out. An unborn HEAD has no reflog file yet; we map that to an empty list
//! rather than an error, matching how [`log`](crate::log) treats an empty repo.

use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReflogEntry {
    /// Position in the reflog. 0 is the most recent move (`HEAD@{0}`).
    pub index: usize,
    /// OID the ref points at *after* this move (full hex). This is the commit
    /// the UI jumps to when the row is clicked.
    pub new_oid: String,
    /// Short form of `new_oid` for display.
    pub new_short: String,
    /// OID the ref pointed at *before* this move (full hex). All-zero for the
    /// very first entry (ref creation).
    pub old_oid: String,
    pub committer_name: String,
    pub committer_email: String,
    /// Committer time of the move (unix seconds).
    pub time_unix: i64,
    /// The reflog message, e.g. `commit: fix typo`, `checkout: moving from main
    /// to feature`, `reset: moving to HEAD~2`. The leading `<op>:` is parsed
    /// UI-side into a badge.
    pub message: String,
}

impl Repo {
    /// Read the reflog for `selector` (`"HEAD"`, or a full ref name like
    /// `"refs/heads/main"`), newest first, up to `limit` entries.
    ///
    /// Returns an empty list when the ref has no reflog yet (an unborn HEAD in a
    /// freshly-initialized repo), rather than surfacing a "not found" error.
    pub fn reflog(&self, selector: &str, limit: usize) -> Result<Vec<ReflogEntry>> {
        let repo = self.git2()?;
        let name = if selector.is_empty() { "HEAD" } else { selector };

        let reflog = match repo.reflog(name) {
            Ok(r) => r,
            // No reflog file yet (unborn HEAD / never-moved ref) ⇒ nothing to show.
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };

        let mut out = Vec::with_capacity(reflog.len().min(limit));
        for (index, entry) in reflog.iter().take(limit).enumerate() {
            let new = entry.id_new();
            let committer = entry.committer();
            let new_oid = new.to_string();
            out.push(ReflogEntry {
                index,
                new_short: new_oid[..7.min(new_oid.len())].to_string(),
                new_oid,
                old_oid: entry.id_old().to_string(),
                committer_name: committer.name().unwrap_or("").to_string(),
                committer_email: committer.email().unwrap_or("").to_string(),
                time_unix: committer.when().seconds(),
                message: entry.message().unwrap_or("").to_string(),
            });
        }
        Ok(out)
    }
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
            "strand-reflog-test-{}-{:?}",
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
    fn unborn_head_yields_no_entries() {
        let (repo, dir) = scratch();
        // No commits yet ⇒ no HEAD reflog file ⇒ empty, not an error.
        assert!(repo.reflog("HEAD", 100).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_moves_newest_first_with_messages() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "first");
        let first = git(&dir, &["rev-parse", "HEAD"]);
        // A checkout move (branch off) then another commit, so the reflog has a
        // commit entry, a checkout entry, and the original commit entry.
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        commit(&dir, "a.txt", "2\n", "second");
        let second = git(&dir, &["rev-parse", "HEAD"]);

        let log = repo.reflog("HEAD", 100).unwrap();
        assert!(log.len() >= 3, "commit + checkout + commit recorded, got {}", log.len());

        // Newest first: index 0 is the latest commit; its new OID is HEAD.
        assert_eq!(log[0].index, 0);
        assert_eq!(log[0].new_oid, second);
        assert_eq!(log[0].new_short, &second[..7]);
        assert!(log[0].message.starts_with("commit:"), "got {:?}", log[0].message);
        assert_eq!(log[0].committer_name, "Test");

        // A checkout move is recorded between the two commits.
        assert!(
            log.iter().any(|e| e.message.starts_with("checkout:")),
            "a checkout move should be in the reflog"
        );

        // The oldest entry is the root commit's creation: new OID is the first
        // commit, old OID is the all-zero null OID (nothing before it).
        let root = log.last().unwrap();
        assert_eq!(root.new_oid, first);
        assert_eq!(root.old_oid, "0".repeat(40));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn limit_bounds_the_result() {
        let (repo, dir) = scratch();
        commit(&dir, "a.txt", "1\n", "first");
        commit(&dir, "a.txt", "2\n", "second");
        commit(&dir, "a.txt", "3\n", "third");

        let two = repo.reflog("HEAD", 2).unwrap();
        assert_eq!(two.len(), 2, "limit caps the entries returned");
        // Still newest-first within the limited window.
        assert_eq!(two[0].message, "commit: third");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
