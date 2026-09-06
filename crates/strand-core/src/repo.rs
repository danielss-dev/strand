use std::cell::OnceCell;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// A handle to an opened repository.
///
/// Holds both a `gix::Repository` (used for reads) and a lazily-opened
/// `git2::Repository` (used for mutating operations). The two are kept in
/// sync by always opening them against the same on-disk path. The git2
/// handle opens once per `Repo` and is reused by every subsequent
/// [`git2()`](Repo::git2) call — `snapshot` alone used to re-open it four
/// times (directly, then via `meta`/`refs`/`submodules`).
pub struct Repo {
    pub(crate) path: PathBuf,
    pub(crate) gix: gix::Repository,
    git2: OnceCell<git2::Repository>,
}

impl Repo {
    /// Discover and open the repository containing `path`.
    pub fn discover(path: impl AsRef<Path>) -> Result<Self> {
        if path.as_ref().to_str().is_some_and(|path| path.starts_with("ssh://")) {
            return Err(crate::Error::Other("SSH repository addresses require the remote transport; they are not local filesystem paths.".into()));
        }
        let gix = gix::discover(path.as_ref())?;
        let workdir = gix
            .work_dir()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| gix.git_dir().to_path_buf());
        Ok(Self {
            path: workdir,
            gix,
            git2: OnceCell::new(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The `.git` directory — needed by the file watcher to tell repo-state
    /// writes apart from working-tree writes.
    pub fn git_dir(&self) -> &Path {
        self.gix.git_dir()
    }

    /// Lightweight metadata about the repo's HEAD, used by the topbar.
    pub fn meta(&self) -> Result<RepoMeta> {
        // Detect detached HEAD via git2 (gix's `head_name()` returns None for
        // both detached HEAD *and* an unborn branch, so it can't tell them
        // apart on its own).
        let g2 = self.git2().ok();
        let detached = g2.and_then(|r| r.head_detached().ok()).unwrap_or(false);

        let branch = if detached {
            // Show the short OID we're parked on, matching `git status`.
            g2.and_then(|r| r.head().ok())
                .and_then(|h| h.target())
                .map(|oid| oid.to_string()[..7].to_string())
                .unwrap_or_else(|| "HEAD".to_string())
        } else {
            self.gix
                .head_name()
                .ok()
                .flatten()
                .map(|n| n.shorten().to_string())
                .unwrap_or_else(|| "HEAD".to_string())
        };

        // Reuse the git2 handle already opened above instead of opening a
        // third time — `meta` is on the post-every-op refresh path.
        let (ahead, behind) = g2
            .and_then(Self::compute_ahead_behind)
            .unwrap_or((0, 0));

        // The shared git dir is identical across every worktree of one repo, so
        // the UI groups worktree tabs on it. `is_worktree` marks a linked
        // worktree (vs the main one). Both come from the git2 handle opened
        // above; fall back to gix's git dir when git2 didn't open.
        let common_dir = self.gix.common_dir().to_path_buf();
        let common_dir = common_dir
            .canonicalize()
            .unwrap_or(common_dir)
            .to_string_lossy()
            .into_owned();
        let is_linked_worktree = g2.map(|r| r.is_worktree()).unwrap_or(false);

        let head_oid = g2
            .and_then(|r| r.head().ok())
            .and_then(|h| h.target())
            .map(|oid| oid.to_string());

        Ok(RepoMeta {
            name: self
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("repo")
                .to_string(),
            path: self.path.to_string_lossy().into_owned(),
            branch,
            head_oid,
            ahead,
            behind,
            detached,
            operation: self.operation_in_progress(),
            common_dir,
            is_linked_worktree,
        })
    }

    /// Which multi-step history op (if any) is paused mid-flight, detected from
    /// the on-disk markers git leaves in `.git/`. Returns one of `"rebase"`,
    /// `"cherry-pick"`, `"revert"`, `"merge"`, `"mailbox"`, or `None`. Order matters: a
    /// rebase can leave a `MERGE_HEAD` while resolving, so rebase is checked
    /// first. Used by [`meta`](Repo::meta) (UI banner) and
    /// [`abort_operation`](crate::repo::Repo::abort_operation).
    pub(crate) fn operation_in_progress(&self) -> Option<String> {
        let git_dir = self.gix.git_dir();
        let has = |name: &str| git_dir.join(name).exists();
        if has("rebase-apply/applying") {
            Some("mailbox".into())
        } else if has("rebase-merge") || has("rebase-apply") {
            Some("rebase".into())
        } else if has("CHERRY_PICK_HEAD") {
            Some("cherry-pick".into())
        } else if has("REVERT_HEAD") {
            Some("revert".into())
        } else if has("MERGE_HEAD") {
            Some("merge".into())
        } else if has("BISECT_START") {
            Some("bisect".into())
        } else {
            None
        }
    }

    /// Walk HEAD against its configured upstream and return (ahead, behind).
    /// Quietly returns `None` when HEAD has no upstream or is detached —
    /// callers fall back to (0, 0). Takes an already-open `git2::Repository`
    /// so the caller (`meta`) doesn't re-open the repo just for this.
    fn compute_ahead_behind(repo: &git2::Repository) -> Option<(u32, u32)> {
        let head = repo.head().ok()?;
        let branch = head.shorthand()?.to_string();
        let local = repo.find_branch(&branch, git2::BranchType::Local).ok()?;
        let upstream = local.upstream().ok()?;
        let local_oid = local.get().target()?;
        let upstream_oid = upstream.get().target()?;
        let (ahead, behind) = repo.graph_ahead_behind(local_oid, upstream_oid).ok()?;
        Some((ahead as u32, behind as u32))
    }

    pub(crate) fn git2(&self) -> Result<&git2::Repository> {
        // Not `get_or_try_init` (unstable); `Repo` is `!Sync`, so this
        // check-then-set can't race.
        if self.git2.get().is_none() {
            let opened = git2::Repository::open(&self.path)?;
            if self.sparse_enabled() && opened.index().is_err() {
                self.sparse_read_index(&opened)?;
            }
            let _ = self.git2.set(opened);
        }
        Ok(self.git2.get().expect("git2 handle set above"))
    }

    /// A freshly-opened, owned git2 handle for the few APIs that need
    /// `&mut git2::Repository` (the stash ops). Everything else should use
    /// the cached [`git2()`](Repo::git2).
    pub(crate) fn git2_owned(&self) -> Result<git2::Repository> {
        Ok(git2::Repository::open(&self.path)?)
    }

    pub(crate) fn is_partial_clone(&self) -> bool {
        self.gix.config_snapshot().sections_by_name("remote").is_some_and(|mut sections| {
            sections.any(|section| section.value("promisor").is_some_and(|value| value.eq_ignore_ascii_case(b"true")))
        })
    }

    /// libgit2 does not fetch promised objects. Ask Git for this exact object
    /// only after a missing-object read in a partial clone, then retry locally.
    pub(crate) fn find_blob(&self, oid: git2::Oid) -> Result<git2::Blob<'_>> {
        let repo = self.git2()?;
        match repo.find_blob(oid) {
            Ok(blob) => Ok(blob),
            Err(error) if error.code() == git2::ErrorCode::NotFound && self.is_partial_clone() => {
                crate::network::run_git_streaming(&self.path, &["cat-file", "-e", &oid.to_string()], |_| {}, None)?;
                repo.odb()?.refresh()?;
                Ok(repo.find_blob(oid)?)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Resolve `rel_path` against the working directory, rejecting absolute
    /// paths, `..` traversal, and in-tree symlinks that escape the working
    /// tree. Mirrors the guard in [`conflict`](crate::conflict); used by the
    /// file-content reader. `canonicalize` needs an existing path, so for a
    /// not-yet-created file we canonicalize the parent directory instead.
    pub(crate) fn safe_workdir_path(&self, rel_path: &str) -> Result<PathBuf> {
        let p = Path::new(rel_path);
        if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(crate::Error::Other(format!("invalid path: {rel_path}")));
        }
        let full = self.path.join(p);

        let root = self
            .path
            .canonicalize()
            .map_err(|e| crate::Error::Other(format!("cannot resolve working tree: {e}")))?;
        let probe = if full.exists() {
            full.as_path()
        } else {
            full.parent().unwrap_or(full.as_path())
        };
        let resolved = probe
            .canonicalize()
            .map_err(|e| crate::Error::Other(format!("invalid path: {rel_path} ({e})")))?;
        if !resolved.starts_with(&root) {
            return Err(crate::Error::Other(format!(
                "path escapes working tree: {rel_path}"
            )));
        }
        Ok(full)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RepoMeta {
    pub name: String,
    pub path: String,
    pub branch: String,
    /// Full OID HEAD currently resolves to; `None` on an unborn branch.
    /// Used by the frontend to pin a review baseline.
    pub head_oid: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// True when HEAD is detached (parked on a commit, not a branch). The
    /// `branch` field then holds the short OID.
    pub detached: bool,
    /// Multi-step history op paused mid-flight (`"rebase"` / `"cherry-pick"` /
    /// `"revert"` / `"merge"`), or `None` when the repo is in a normal state.
    /// Drives the in-progress banner + Abort affordance.
    pub operation: Option<String>,
    /// The shared git dir (`commondir`), identical for every worktree of the
    /// same repository. The tab strip groups worktree tabs on this value.
    pub common_dir: String,
    /// True when this is a *linked* worktree rather than the main one.
    pub is_linked_worktree: bool,
}
