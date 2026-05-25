use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// A handle to an opened repository.
///
/// Holds both a `gix::Repository` (used for reads) and a lazily-opened
/// `git2::Repository` (used for mutating operations). The two are kept in
/// sync by always opening them against the same on-disk path.
pub struct Repo {
    pub(crate) path: PathBuf,
    pub(crate) gix: gix::Repository,
}

impl Repo {
    /// Discover and open the repository containing `path`.
    pub fn discover(path: impl AsRef<Path>) -> Result<Self> {
        let gix = gix::discover(path.as_ref())?;
        let workdir = gix
            .work_dir()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| gix.git_dir().to_path_buf());
        Ok(Self {
            path: workdir,
            gix,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Lightweight metadata about the repo's HEAD, used by the topbar.
    pub fn meta(&self) -> Result<RepoMeta> {
        let head_name = self
            .gix
            .head_name()
            .ok()
            .flatten()
            .map(|n| n.shorten().to_string())
            .unwrap_or_else(|| "HEAD".to_string());

        let (ahead, behind) = self.compute_ahead_behind().unwrap_or((0, 0));

        Ok(RepoMeta {
            name: self
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("repo")
                .to_string(),
            path: self.path.to_string_lossy().into_owned(),
            branch: head_name,
            ahead,
            behind,
        })
    }

    /// Walk HEAD against its configured upstream and return (ahead, behind).
    /// Quietly returns `None` when HEAD has no upstream or is detached —
    /// callers fall back to (0, 0).
    fn compute_ahead_behind(&self) -> Option<(u32, u32)> {
        let repo = self.git2().ok()?;
        let head = repo.head().ok()?;
        let branch = head.shorthand()?.to_string();
        let local = repo.find_branch(&branch, git2::BranchType::Local).ok()?;
        let upstream = local.upstream().ok()?;
        let local_oid = local.get().target()?;
        let upstream_oid = upstream.get().target()?;
        let (ahead, behind) = repo.graph_ahead_behind(local_oid, upstream_oid).ok()?;
        Some((ahead as u32, behind as u32))
    }

    pub(crate) fn git2(&self) -> Result<git2::Repository> {
        Ok(git2::Repository::open(&self.path)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoMeta {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
}
