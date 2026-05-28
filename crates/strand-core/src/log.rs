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
    /// Walk commits from HEAD, newest first, up to `limit`.
    ///
    /// Stub implementation — graph computation (lanes, refs) lives elsewhere.
    pub fn log(&self, limit: usize) -> Result<Vec<Commit>> {
        let repo = self.git2()?;
        let mut walk = repo.revwalk()?;
        walk.push_head().ok();
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
