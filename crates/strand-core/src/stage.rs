use std::path::Path;

use crate::{error::Result, repo::Repo};

impl Repo {
    /// Stage `path` — adds new/modified files, records deletions. Mirrors
    /// `git add <path>` for one path at a time.
    pub fn stage_path(&self, path: &str) -> Result<()> {
        let repo = self.git2()?;
        let mut index = repo.index()?;

        let on_disk = repo.workdir().map(|w| w.join(path));
        let exists = on_disk.as_deref().map(Path::exists).unwrap_or(false);

        if exists {
            index.add_path(Path::new(path))?;
        } else {
            // File was deleted in the working tree. Mirror that in the index.
            index.remove_path(Path::new(path))?;
        }
        index.write()?;
        Ok(())
    }

    /// Unstage `path` — reset the index entry for that path back to HEAD,
    /// without touching the working tree. Equivalent to
    /// `git restore --staged <path>`.
    pub fn unstage_path(&self, path: &str) -> Result<()> {
        let repo = self.git2()?;
        match repo.head().ok().map(|h| h.peel_to_commit()) {
            // No HEAD yet (unborn branch): just drop the index entry.
            None => {
                let mut index = repo.index()?;
                let _ = index.remove_path(Path::new(path));
                index.write()?;
            }
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(commit)) => {
                repo.reset_default(Some(commit.as_object()), [path])?;
            }
        }
        Ok(())
    }

    /// Discard working-tree changes for `path` — restore the file from the
    /// index. Mirrors `git checkout -- <path>`.
    ///
    /// **Destructive.** The UI is responsible for offering an undo affordance
    /// (we don't snapshot here; the toast undo path is a frontend concern).
    pub fn discard_path(&self, path: &str) -> Result<()> {
        let repo = self.git2()?;
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force().path(path);
        repo.checkout_index(None, Some(&mut opts))?;
        Ok(())
    }
}
