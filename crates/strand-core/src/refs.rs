//! Ref resolution — branches, remotes, tags.
//!
//! Returned as plain typed structs the frontend can render directly. All
//! lookups go through `git2` for now; gix's ref iteration is fine but
//! we already pay the cost of opening a `git2::Repository` for ahead/behind.

use serde::{Deserialize, Serialize};

use crate::{error::Result, repo::Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Branch {
    /// Short name, e.g. `main`.
    pub name: String,
    /// Full ref name, e.g. `refs/heads/main`.
    pub full_name: String,
    /// Commit OID this branch points to.
    pub target: String,
    /// True if HEAD is on this branch.
    pub is_head: bool,
    /// Tracking branch, if any (e.g. `origin/main`).
    pub upstream: Option<UpstreamRef>,
    /// Commits on this branch not in upstream.
    pub ahead: u32,
    /// Commits in upstream not on this branch.
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpstreamRef {
    /// Short name as git presents it, e.g. `origin/main`.
    pub name: String,
    /// Remote name, e.g. `origin`.
    pub remote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteBranch {
    /// Short name, e.g. `origin/main`.
    pub name: String,
    pub remote: String,
    /// Branch portion only, e.g. `main`.
    pub branch: String,
    /// Full ref name, e.g. `refs/remotes/origin/main`.
    pub full_name: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Remote {
    pub name: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub full_name: String,
    /// Peeled commit OID. For lightweight tags this is the tagged commit;
    /// for annotated tags this is the commit the tag object points at.
    pub target: String,
    pub annotated: bool,
    /// Annotated-tag message, if present.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Refs {
    pub branches: Vec<Branch>,
    pub remotes: Vec<Remote>,
    pub remote_branches: Vec<RemoteBranch>,
    pub tags: Vec<Tag>,
}

impl Repo {
    /// Best common ancestor of two commit-ishes (`git merge-base <a> <b>`).
    /// Powers "review a worktree against its base branch": pinning the review
    /// baseline at merge-base(worktree HEAD, base) shows only the branch's own
    /// work, even after the base branch has moved on.
    pub fn merge_base(&self, a: &str, b: &str) -> Result<String> {
        let repo = self.git2()?;
        let a = repo.revparse_single(a)?.peel_to_commit()?.id();
        let b = repo.revparse_single(b)?.peel_to_commit()?.id();
        Ok(repo.merge_base(a, b)?.to_string())
    }

    /// All resolvable refs, grouped for the sidebar + branch picker.
    pub fn refs(&self) -> Result<Refs> {
        let repo = self.git2()?;

        let branches = collect_branches(&repo);
        let remote_branches = collect_remote_branches(&repo);
        let remotes = collect_remotes(&repo);
        let tags = collect_tags(&repo);

        Ok(Refs {
            branches,
            remotes,
            remote_branches,
            tags,
        })
    }
}

fn collect_branches(repo: &git2::Repository) -> Vec<Branch> {
    let iter = match repo.branches(Some(git2::BranchType::Local)) {
        Ok(it) => it,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for entry in iter.flatten() {
        let (branch, _) = entry;
        let Some(target) = branch.get().target() else { continue };
        let name = match branch.name() {
            Ok(Some(n)) => n.to_string(),
            _ => continue,
        };
        let full_name = branch.get().name().unwrap_or("").to_string();
        let is_head = branch.is_head();

        let (upstream, ahead, behind) = match branch.upstream() {
            Ok(up) => {
                let up_name = up.name().ok().flatten().unwrap_or("").to_string();
                let remote = up_name.split_once('/').map(|(r, _)| r.to_string()).unwrap_or_default();
                let (ahead, behind) = up
                    .get()
                    .target()
                    .and_then(|up_oid| repo.graph_ahead_behind(target, up_oid).ok())
                    .map(|(a, b)| (a as u32, b as u32))
                    .unwrap_or((0, 0));
                (
                    Some(UpstreamRef {
                        name: up_name,
                        remote,
                    }),
                    ahead,
                    behind,
                )
            }
            Err(_) => (None, 0, 0),
        };

        out.push(Branch {
            name,
            full_name,
            target: target.to_string(),
            is_head,
            upstream,
            ahead,
            behind,
        });
    }

    out.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

fn collect_remote_branches(repo: &git2::Repository) -> Vec<RemoteBranch> {
    let iter = match repo.branches(Some(git2::BranchType::Remote)) {
        Ok(it) => it,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for entry in iter.flatten() {
        let (branch, _) = entry;
        let Some(target) = branch.get().target() else { continue };
        let name = match branch.name() {
            Ok(Some(n)) => n.to_string(),
            _ => continue,
        };
        // git2 returns `origin/HEAD` as a remote branch; skip the pointer.
        if name.ends_with("/HEAD") {
            continue;
        }
        let (remote, branch_part) = match name.split_once('/') {
            Some((r, b)) => (r.to_string(), b.to_string()),
            None => (String::new(), name.clone()),
        };
        let full_name = branch.get().name().unwrap_or("").to_string();

        out.push(RemoteBranch {
            name,
            remote,
            branch: branch_part,
            full_name,
            target: target.to_string(),
        });
    }

    out.sort_by(|a, b| {
        a.remote
            .cmp(&b.remote)
            .then_with(|| a.branch.to_lowercase().cmp(&b.branch.to_lowercase()))
    });
    out
}

fn collect_remotes(repo: &git2::Repository) -> Vec<Remote> {
    let names = match repo.remotes() {
        Ok(n) => n,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for name in names.iter().flatten() {
        let url = repo.find_remote(name).ok().and_then(|r| r.url().map(|s| s.to_string()));
        out.push(Remote {
            name: name.to_string(),
            url,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn collect_tags(repo: &git2::Repository) -> Vec<Tag> {
    let refs = match repo.references_glob("refs/tags/*") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for r in refs.flatten() {
        let full_name = r.name().unwrap_or("").to_string();
        let name = full_name
            .strip_prefix("refs/tags/")
            .unwrap_or(&full_name)
            .to_string();

        // Annotated tags resolve through a tag object; lightweight tags
        // point straight at a commit.
        let (target, annotated, message) = match r.peel(git2::ObjectType::Tag) {
            Ok(obj) => {
                let tag = obj.into_tag().ok();
                let msg = tag.as_ref().and_then(|t| t.message().map(|m| m.trim().to_string()));
                let commit_oid = r
                    .peel(git2::ObjectType::Commit)
                    .ok()
                    .map(|c| c.id().to_string())
                    .unwrap_or_default();
                (commit_oid, true, msg)
            }
            Err(_) => {
                let commit_oid = r
                    .peel(git2::ObjectType::Commit)
                    .ok()
                    .map(|c| c.id().to_string())
                    .or_else(|| r.target().map(|o| o.to_string()))
                    .unwrap_or_default();
                (commit_oid, false, None)
            }
        };

        if target.is_empty() {
            continue;
        }
        out.push(Tag {
            name,
            full_name,
            target,
            annotated,
            message,
        });
    }

    out.sort_by_key(|a| a.name.to_lowercase());
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

    #[test]
    fn merge_base_finds_the_fork_point() {
        let dir = std::env::temp_dir().join(format!(
            "strand-merge-base-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);

        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "fork point"]);
        let fork = git(&dir, &["rev-parse", "HEAD"]);

        // Diverge: one commit on feature, one on main.
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.join("f.txt"), "f\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        git(&dir, &["commit", "-q", "-m", "feature work"]);
        git(&dir, &["checkout", "-q", "main"]);
        std::fs::write(dir.join("m.txt"), "m\n").unwrap();
        git(&dir, &["add", "m.txt"]);
        git(&dir, &["commit", "-q", "-m", "main moved on"]);

        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();
        assert_eq!(repo.merge_base("feature", "main").unwrap(), fork);
        // Same-commit degenerate case: merge-base(X, X) = X.
        assert_eq!(repo.merge_base("main", "main").unwrap(), git(&dir, &["rev-parse", "main"]));
        // Unknown revspec surfaces as an error, not a panic.
        assert!(repo.merge_base("no-such-branch", "main").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
