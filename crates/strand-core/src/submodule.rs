//! Submodules — list + status (read) and `update --init` (write).
//!
//! Reads go through `git2` (`Repository::submodules` + `submodule_status`),
//! which gives us the recorded vs checked-out OIDs and a status bitset in one
//! pass. The `update` write **shells out** to the user's `git`, like the other
//! network ops in [`network`](crate::network): `git submodule update` clones /
//! fetches the submodule, which needs the user's credentials, SSH agent, and
//! progress reporting — all of which the shell-out gets for free.

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    network::{NetworkOutcome, Progress},
    repo::Repo,
};

/// A submodule's state relative to what the superproject records, reduced from
/// git2's `SubmoduleStatus` bitset to the single badge the UI shows.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubmoduleState {
    /// No working tree checked out (never `init`-ed / `update`-d).
    Uninitialized,
    /// Checked out at exactly the commit the superproject records.
    UpToDate,
    /// Checked out at a *different* commit than the superproject records
    /// (the pointer moved, or the submodule needs an `update`).
    OutOfDate,
    /// The submodule's own working tree has staged / unstaged / untracked
    /// changes.
    Modified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Submodule {
    /// Submodule name from `.gitmodules` (often equal to `path`).
    pub name: String,
    /// Path within the superproject working tree (forward-slashed).
    pub path: String,
    /// Configured URL, if any.
    pub url: Option<String>,
    /// Commit OID the superproject records for this submodule (`HEAD`/index).
    pub head_id: Option<String>,
    /// Commit OID actually checked out in the submodule's working tree;
    /// `None` when uninitialized.
    pub workdir_id: Option<String>,
    /// Whether the submodule has a checked-out working tree.
    pub initialized: bool,
    pub status: SubmoduleState,
}

impl Repo {
    /// List every submodule with its status. Best-effort per submodule — a
    /// status lookup that fails (e.g. a malformed `.gitmodules` entry) falls
    /// back to `Uninitialized` rather than failing the whole listing.
    pub fn submodules(&self) -> Result<Vec<Submodule>> {
        let repo = self.git2()?;
        let mut out = Vec::new();
        for sm in repo.submodules()? {
            let name = sm.name().unwrap_or_default().to_string();
            let path = sm.path().to_string_lossy().replace('\\', "/");
            let url = sm.url().map(|s| s.to_string());
            let head_id = sm.head_id().map(|o| o.to_string());
            let workdir_id = sm.workdir_id().map(|o| o.to_string());

            // `submodule_status` keys off the submodule name; ignore nothing so
            // dirty working trees and untracked files are reflected.
            let status = repo
                .submodule_status(sm.name().unwrap_or_default(), git2::SubmoduleIgnore::None)
                .ok();
            let (state, initialized) = classify(status, workdir_id.is_some());

            out.push(Submodule {
                name,
                path,
                url,
                head_id,
                workdir_id,
                initialized,
                status: state,
            });
        }
        out.sort_by_key(|a| a.path.to_lowercase());
        Ok(out)
    }

    /// Run `git submodule update` for `paths` (empty ⇒ all submodules),
    /// optionally `--init` (clone/register first) and `--recursive` (nested
    /// submodules). Shells out + streams progress like the other network ops.
    pub fn submodule_update(
        &self,
        paths: &[String],
        init: bool,
        recursive: bool,
        on_progress: impl FnMut(Progress),
    ) -> Result<NetworkOutcome> {
        for p in paths {
            if p.starts_with('-') {
                return Err(Error::Other(format!(
                    "submodule path may not start with '-': {p}"
                )));
            }
        }
        let mut args: Vec<&str> = vec!["submodule", "update", "--progress"];
        if init {
            args.push("--init");
        }
        if recursive {
            args.push("--recursive");
        }
        // End-of-options before the (caller-supplied) paths so a submodule path
        // can never be read as a flag.
        if !paths.is_empty() {
            args.push("--");
            for p in paths {
                args.push(p.as_str());
            }
        }
        crate::network::run_git_streaming(&self.path, &args, on_progress, None)
    }
}

/// Reduce git2's `SubmoduleStatus` to a single [`SubmoduleState`] plus an
/// `initialized` flag. Order: uninitialized first (no point reporting "modified"
/// on a submodule with no working tree), then local working-tree changes, then a
/// moved pointer, else up-to-date.
fn classify(status: Option<git2::SubmoduleStatus>, has_wd: bool) -> (SubmoduleState, bool) {
    use git2::SubmoduleStatus as S;
    let Some(s) = status else {
        return (SubmoduleState::Uninitialized, has_wd);
    };
    let initialized = s.contains(S::IN_WD) && !s.contains(S::WD_UNINITIALIZED);
    if !initialized {
        return (SubmoduleState::Uninitialized, false);
    }
    // The submodule's own index/worktree is dirty.
    if s.intersects(S::WD_INDEX_MODIFIED | S::WD_WD_MODIFIED | S::WD_UNTRACKED) {
        return (SubmoduleState::Modified, true);
    }
    // The checked-out HEAD differs from the commit the superproject records.
    if s.contains(S::WD_MODIFIED) {
        return (SubmoduleState::OutOfDate, true);
    }
    (SubmoduleState::UpToDate, true)
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

    #[test]
    fn lists_a_submodule_with_recorded_and_checked_out_oids() {
        let base = std::env::temp_dir().join(format!(
            "strand-submod-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let sub = base.join("sub");
        let sup = base.join("super");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&sup).unwrap();

        // A tiny upstream repo to be the submodule.
        git(&sub, &["init", "-q", "-b", "main"]);
        git(&sub, &["config", "user.name", "Test"]);
        git(&sub, &["config", "user.email", "test@example.com"]);
        git(&sub, &["config", "commit.gpgsign", "false"]);
        std::fs::write(sub.join("a.txt"), "a\n").unwrap();
        git(&sub, &["add", "a.txt"]);
        git(&sub, &["commit", "-q", "-m", "sub init"]);

        // The superproject embeds it. `-c protocol.file.allow=always` is needed
        // for a local-path submodule add on modern git.
        git(&sup, &["init", "-q", "-b", "main"]);
        git(&sup, &["config", "user.name", "Test"]);
        git(&sup, &["config", "user.email", "test@example.com"]);
        git(&sup, &["config", "commit.gpgsign", "false"]);
        let sub_url = sub.to_string_lossy().replace('\\', "/");
        git(
            &sup,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &sub_url,
                "sub",
            ],
        );
        git(&sup, &["commit", "-q", "-m", "add submodule"]);

        let repo = Repo::discover(sup.to_str().unwrap()).unwrap();
        let mods = repo.submodules().unwrap();
        assert_eq!(mods.len(), 1, "one submodule listed");
        let m = &mods[0];
        assert_eq!(m.path, "sub");
        assert!(m.initialized, "freshly added submodule has a working tree");
        assert!(m.head_id.is_some());
        assert_eq!(m.head_id, m.workdir_id, "checked out at the recorded commit");
        assert_eq!(m.status, SubmoduleState::UpToDate);

        let _ = std::fs::remove_dir_all(&base);
    }
}
