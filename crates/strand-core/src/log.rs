use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

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

impl Repo {
    /// Walk commits across **all refs** (`git log --all`-style), newest first,
    /// up to `limit`.
    ///
    /// We push every local branch, remote-tracking branch, and tag — plus HEAD
    /// for the detached case — so the graph shows the whole repository, not just
    /// the checked-out branch's ancestry. That's what makes commits on *other*
    /// branches visible (and so cherry-pick / merge targets reachable) when an
    /// old branch is checked out. `push_glob` peels annotated tags to their
    /// commit and skips non-committish refs, so tags are safe to include.
    /// Graph computation (lanes, ref chips) lives in the UI (`lib/graph.ts`).
    pub fn log(&self, limit: usize) -> Result<Vec<Commit>> {
        let repo = self.git2()?;
        let mut walk = repo.revwalk()?;
        // HEAD covers a detached checkout (no branch ref to glob); the globs
        // cover everything else. A commit reachable from several refs is still
        // yielded once. Each push is best-effort — an empty namespace just
        // matches nothing.
        walk.push_head().ok();
        walk.push_glob("refs/heads/*").ok();
        walk.push_glob("refs/remotes/*").ok();
        walk.push_glob("refs/tags/*").ok();
        walk.set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)?;

        let mut out = Vec::with_capacity(limit);
        for oid in walk.take(limit) {
            let oid = oid?;
            let c = repo.find_commit(oid)?;
            let hash = oid.to_string();
            let message = c.message().unwrap_or("");
            let subject = c.summary().unwrap_or("").to_string();
            // Body is whatever follows the first line; trim leading blank
            // line so the panel's monospace block doesn't start with a gap.
            let body = match message.split_once('\n') {
                Some((_, rest)) => rest.trim_start_matches('\n').trim_end().to_string(),
                None => String::new(),
            };
            out.push(Commit {
                short_hash: hash[..7.min(hash.len())].to_string(),
                hash,
                subject,
                body,
                author_name: c.author().name().unwrap_or("").to_string(),
                author_email: c.author().email().unwrap_or("").to_string(),
                time_unix: c.time().seconds(),
                parents: c.parent_ids().map(|p| p.to_string()).collect(),
            });
        }
        Ok(out)
    }
}
