//! Remote management — add, remove, rename, set-url.
//!
//! Remote *reads* live in `refs.rs` (`collect_remotes`); this is the mutating
//! side. All ops go through `git2`, which keeps the config section and the
//! remote-tracking refs in sync in one call (delete drops `refs/remotes/<name>/*`,
//! rename moves them).

use crate::{error::Result, network::validate_remote_arg, repo::Repo, Error};

fn require(value: &str, what: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(Error::Other(format!("{what} is required")));
    }
    Ok(())
}

/// Reject an option-like remote name at creation time. The name later lands
/// in `git fetch` argv positions — `network.rs` validates again at fetch time,
/// but failing here gives the user a clear message instead of a stored remote
/// that can never be fetched.
fn require_plain_name(name: &str) -> Result<()> {
    if name.starts_with('-') {
        return Err(Error::Other(format!(
            "remote name may not start with '-': {name}"
        )));
    }
    Ok(())
}

impl Repo {
    /// Add a remote (`git remote add <name> <url>`).
    pub fn add_remote(&self, name: &str, url: &str) -> Result<()> {
        require(name, "remote name")?;
        require(url, "remote URL")?;
        require_plain_name(name)?;
        // Same gate as the clone path: a stored `ext::`/`fd::` URL would run
        // arbitrary commands on the next fetch.
        validate_remote_arg(url, "remote URL")?;
        match self.git2()?.remote(name, url) {
            Ok(_) => Ok(()),
            // git2's duplicate error reads "remote 'x' already exists" wrapped
            // in config noise — surface the short, actionable form.
            Err(e) if e.code() == git2::ErrorCode::Exists => {
                Err(Error::Other(format!("remote {name} already exists")))
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Remove a remote (`git remote remove`) — also drops its remote-tracking
    /// refs and config section.
    pub fn remove_remote(&self, name: &str) -> Result<()> {
        require(name, "remote name")?;
        self.git2()?.remote_delete(name)?;
        Ok(())
    }

    /// Rename a remote (`git remote rename`). git2 reports refspecs it could
    /// not rewrite (non-default ones, e.g. a single-branch clone's) as
    /// "problems" — by the time they are reported the rename HAS happened
    /// (config section + remote-tracking refs moved), so they are returned
    /// for the caller to surface as a warning, never as an error. Empty means
    /// a clean rename.
    pub fn rename_remote(&self, old: &str, new: &str) -> Result<Vec<String>> {
        require(old, "remote name")?;
        require(new, "remote name")?;
        require_plain_name(new)?;
        let problems = self.git2()?.remote_rename(old, new)?;
        Ok(problems.iter().flatten().map(str::to_string).collect())
    }

    /// Change a remote's fetch URL (`git remote set-url`).
    pub fn set_remote_url(&self, name: &str, url: &str) -> Result<()> {
        require(name, "remote name")?;
        require(url, "remote URL")?;
        validate_remote_arg(url, "remote URL")?;
        self.git2()?.remote_set_url(name, url)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a throwaway repo with a single commit and return its `Repo`.
    /// Std-only unique temp dir, same fixture as `tag.rs`.
    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-remote-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let repo = git2::Repository::init(&dir).unwrap();
        {
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            let tree_oid = {
                let mut idx = repo.index().unwrap();
                let tree = idx.write_tree().unwrap();
                repo.find_tree(tree).unwrap().id()
            };
            let tree = repo.find_tree(tree_oid).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn add_set_url_rename_remove_round_trip() {
        let (repo, dir) = scratch_repo();

        repo.add_remote("origin", "https://example.com/a.git").unwrap();
        let remotes = repo.refs().unwrap().remotes;
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url.as_deref(), Some("https://example.com/a.git"));

        // Duplicate name maps to the clear message, not raw config noise.
        let err = repo.add_remote("origin", "https://example.com/b.git").unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");

        // Blank name / URL are rejected before touching git config.
        assert!(repo.add_remote("  ", "https://example.com/c.git").is_err());
        assert!(repo.add_remote("upstream", "").is_err());
        assert!(repo.set_remote_url("origin", " ").is_err());

        repo.set_remote_url("origin", "https://example.com/b.git").unwrap();
        let g = git2::Repository::open(&dir).unwrap();
        assert_eq!(
            g.find_remote("origin").unwrap().url(),
            Some("https://example.com/b.git")
        );

        let problems = repo.rename_remote("origin", "upstream").unwrap();
        assert!(problems.is_empty(), "default refspec renames cleanly: {problems:?}");
        let g = git2::Repository::open(&dir).unwrap();
        assert!(g.find_remote("origin").is_err(), "old name gone after rename");
        assert_eq!(
            g.find_remote("upstream").unwrap().url(),
            Some("https://example.com/b.git")
        );

        repo.remove_remote("upstream").unwrap();
        assert!(repo.refs().unwrap().remotes.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rename_with_custom_refspec_succeeds_and_reports_problems() {
        let (repo, dir) = scratch_repo();
        repo.add_remote("origin", "https://example.com/a.git").unwrap();
        // A non-default fetch refspec (single-branch clone style) — git2 can't
        // rewrite it on rename and reports it as a "problem", but the rename
        // itself has already landed by then.
        {
            let g = git2::Repository::open(&dir).unwrap();
            let mut cfg = g.config().unwrap();
            cfg.set_str(
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            )
            .unwrap();
        }

        let problems = repo.rename_remote("origin", "upstream").unwrap();
        assert_eq!(problems.len(), 1, "the custom refspec is reported: {problems:?}");
        assert!(problems[0].contains("refs/heads/main"), "{problems:?}");
        let g = git2::Repository::open(&dir).unwrap();
        assert!(g.find_remote("origin").is_err(), "rename happened despite problems");
        assert!(g.find_remote("upstream").is_ok());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_dangerous_urls_and_option_like_names() {
        let (repo, dir) = scratch_repo();

        // `ext::` transports run arbitrary commands on the next fetch — the
        // clone-path gate applies to stored remotes too, on add and set-url.
        let err = repo.add_remote("evil", "ext::sh -c 'touch /tmp/x'").unwrap_err();
        assert!(err.to_string().contains("unsupported transport"), "{err}");
        repo.add_remote("origin", "https://example.com/a.git").unwrap();
        assert!(repo.set_remote_url("origin", "ext::sh -c 'touch /tmp/x'").is_err());

        // Option-like names later land in `git fetch` argv positions — reject
        // at creation, on add and rename.
        let err = repo.add_remote("-evil", "https://example.com/a.git").unwrap_err();
        assert!(err.to_string().contains("may not start with '-'"), "{err}");
        assert!(repo.rename_remote("origin", "-evil").is_err());
        let g = git2::Repository::open(&dir).unwrap();
        assert!(g.find_remote("origin").is_ok(), "rejected rename left the remote alone");

        let _ = std::fs::remove_dir_all(dir);
    }
}
