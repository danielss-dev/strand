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
    /// True when this branch's tip is reachable from the repository's primary
    /// branch. The primary and checked-out branches are never marked merged.
    pub merged: bool,
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
    /// Primary branch used to determine merged local branches.
    pub primary_branch: Option<String>,
    pub remotes: Vec<Remote>,
    pub remote_branches: Vec<RemoteBranch>,
    pub tags: Vec<Tag>,
}

/// The branch a ref was most likely forked from, plus the fork point to
/// review against. Produced by [`Repo::detect_base_branch`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseBranch {
    /// Short name of the detected base branch, e.g. `portal30`.
    pub name: String,
    /// merge-base(target, base) — pin the review baseline here.
    pub merge_base: String,
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

    /// Detect the local branch `target` was most likely forked from, and the
    /// fork point to review against.
    ///
    /// Two passes. The branch's reflog creation entry (`branch: Created from
    /// <ref>`) names the parent exactly when git recorded one, and survives
    /// graph shapes the scan can't disambiguate (e.g. the parent was merged
    /// back into `target` after forking). Otherwise fall back to the local
    /// branch whose merge-base with `target` is nearest — fewest commits
    /// between `target` and the fork point. A worktree cut from `portal30`
    /// must review against `portal30`, not the repo's main branch: main's
    /// merge-base is the *older* fork point, so the diff would swallow all of
    /// `portal30`'s own work (DAN-14).
    pub fn detect_base_branch(&self, target: &str) -> Result<Option<BaseBranch>> {
        let repo = self.git2()?;
        let target_id = repo.revparse_single(target)?.peel_to_commit()?.id();

        // Pass 1: the reflog's oldest entry records what the branch was
        // created from. Only trust it when it names a local branch that still
        // exists — "HEAD", raw OIDs, and deleted branches fall through.
        let created_from = repo
            .reflog(&format!("refs/heads/{target}"))
            .ok()
            .and_then(|log| {
                let oldest = log.get(log.len().checked_sub(1)?)?;
                let from = oldest.message()?.strip_prefix("branch: Created from ")?;
                (from != target && from != "HEAD").then(|| from.to_string())
            });
        if let Some(from) = created_from {
            let hit = repo
                .find_branch(&from, git2::BranchType::Local)
                .ok()
                .and_then(|b| b.get().target())
                .and_then(|tip| repo.merge_base(target_id, tip).ok())
                .map(|mb| BaseBranch { name: from, merge_base: mb.to_string() });
            if hit.is_some() {
                return Ok(hit);
            }
        }

        // Pass 2: nearest-fork-point scan. Rank candidates by commits on
        // `target` since the merge-base (fewer = forked later = closer
        // parent), tie-break on commits the candidate has since the
        // merge-base (a branch still sitting at the fork point beats a
        // sibling that moved on), then name for determinism. Candidates that
        // *contain* target (merge-base = target tip, i.e. children or
        // already-merged integration branches) rank last — pinning the
        // baseline at target's own tip would review nothing.
        let mut best: Option<((bool, usize, usize), BaseBranch)> = None;
        if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
            for (branch, _) in branches.flatten() {
                let name = match branch.name() {
                    Ok(Some(n)) if n != target => n.to_string(),
                    _ => continue,
                };
                let Some(tip) = branch.get().target() else { continue };
                let Ok(mb) = repo.merge_base(target_id, tip) else { continue };
                let Ok((ahead, _)) = repo.graph_ahead_behind(target_id, mb) else { continue };
                let Ok((base_ahead, _)) = repo.graph_ahead_behind(tip, mb) else { continue };
                let rank = (ahead == 0, ahead, base_ahead);
                let better = match &best {
                    None => true,
                    Some((r, c)) => (rank, name.as_str()) < (*r, c.name.as_str()),
                };
                if better {
                    best = Some((rank, BaseBranch { name, merge_base: mb.to_string() }));
                }
            }
        }
        Ok(best.map(|(_, hit)| hit))
    }

    /// All resolvable refs, grouped for the sidebar + branch picker.
    pub fn refs(&self) -> Result<Refs> {
        let repo = self.git2()?;

        let primary_branch = primary_branch(repo);
        let branches = collect_branches(repo, primary_branch.as_ref());
        let remote_branches = collect_remote_branches(repo);
        let remotes = collect_remotes(repo);
        let tags = collect_tags(repo);

        Ok(Refs {
            branches,
            primary_branch: primary_branch.map(|(name, _)| name),
            remotes,
            remote_branches,
            tags,
        })
    }
}

fn collect_branches(
    repo: &git2::Repository,
    primary_branch: Option<&(String, git2::Oid)>,
) -> Vec<Branch> {
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
        let merged = !is_head
            && primary_branch
                .map(|(primary_name, primary_target)| {
                    name != *primary_name
                        && (*primary_target == target
                            || repo
                                .graph_descendant_of(*primary_target, target)
                                .unwrap_or(false))
                })
                .unwrap_or(false);

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
            merged,
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

/// Resolve the repository's integration branch. A remote's symbolic HEAD is
/// authoritative; local conventional names cover repositories without one.
/// Falling back to HEAD preserves useful behavior for custom local-only repos.
fn primary_branch(repo: &git2::Repository) -> Option<(String, git2::Oid)> {
    let mut remotes = repo
        .remotes()
        .ok()
        .map(|names| {
            names
                .iter()
                .flatten()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    remotes.sort_by(|a, b| (a != "origin").cmp(&(b != "origin")).then_with(|| a.cmp(b)));

    for remote in remotes {
        let prefix = format!("refs/remotes/{remote}/");
        let Ok(reference) = repo.find_reference(&format!("{prefix}HEAD")) else {
            continue;
        };
        let Some(name) = reference
            .symbolic_target()
            .and_then(|target| target.strip_prefix(&prefix))
        else {
            continue;
        };
        let Some(target) = reference
            .resolve()
            .ok()
            .and_then(|resolved| resolved.target())
        else {
            continue;
        };
        return Some((name.to_string(), target));
    }

    for name in ["main", "master"] {
        if let Some(target) = repo
            .find_branch(name, git2::BranchType::Local)
            .ok()
            .and_then(|branch| branch.get().target())
        {
            return Some((name.to_string(), target));
        }
    }

    let head = repo.head().ok()?;
    Some((head.shorthand()?.to_string(), head.target()?))
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

    #[test]
    fn detect_base_branch_prefers_the_actual_parent_over_main() {
        let dir = std::env::temp_dir().join(format!(
            "strand-detect-base-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        git(&dir, &["config", "core.logAllRefUpdates", "true"]);

        let commit = |name: &str, msg: &str| {
            std::fs::write(dir.join(name), msg).unwrap();
            git(&dir, &["add", name]);
            git(&dir, &["commit", "-q", "-m", msg]);
        };

        // main ── portal30 (2 commits) ── feature (1 commit); main moves on.
        commit("a.txt", "root");
        git(&dir, &["checkout", "-q", "-b", "portal30"]);
        commit("p1.txt", "portal work 1");
        commit("p2.txt", "portal work 2");
        let portal_tip = git(&dir, &["rev-parse", "portal30"]);
        git(&dir, &["checkout", "-q", "-b", "feature", "portal30"]);
        commit("f.txt", "feature work");
        git(&dir, &["checkout", "-q", "main"]);
        commit("m.txt", "main moved on");
        git(&dir, &["checkout", "-q", "feature"]);

        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();
        let hit = repo.detect_base_branch("feature").unwrap().unwrap();
        assert_eq!(hit.name, "portal30");
        assert_eq!(hit.merge_base, portal_tip);

        // The reflog names the parent even after merging main into feature,
        // where the nearest-merge-base scan alone would pick main.
        git(&dir, &["merge", "-q", "--no-edit", "main"]);
        let hit = repo.detect_base_branch("feature").unwrap().unwrap();
        assert_eq!(hit.name, "portal30");
        assert_eq!(hit.merge_base, portal_tip);

        // A fresh branch with no commits of its own still detects its parent
        // (fork point = its own tip), not main.
        git(&dir, &["checkout", "-q", "-b", "fresh", "portal30"]);
        let hit = repo.detect_base_branch("fresh").unwrap().unwrap();
        assert_eq!(hit.name, "portal30");
        assert_eq!(hit.merge_base, portal_tip);

        // portal30 itself forked from main.
        let hit = repo.detect_base_branch("portal30").unwrap().unwrap();
        assert_eq!(hit.name, "main");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refs_marks_only_branches_merged_into_primary_branch() {
        let dir = std::env::temp_dir().join(format!(
            "strand-merged-refs-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);

        std::fs::write(dir.join("root.txt"), "root\n").unwrap();
        git(&dir, &["add", "root.txt"]);
        git(&dir, &["commit", "-q", "-m", "root"]);
        git(&dir, &["remote", "add", "origin", "."]);
        git(&dir, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(
            &dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        git(&dir, &["branch", "same-tip"]);

        git(&dir, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        git(&dir, &["add", "feature.txt"]);
        git(&dir, &["commit", "-q", "-m", "feature"]);
        git(&dir, &["checkout", "-q", "main"]);
        git(&dir, &["merge", "-q", "--no-ff", "--no-edit", "feature"]);
        git(&dir, &["update-ref", "refs/remotes/origin/main", "main"]);

        git(&dir, &["checkout", "-q", "-b", "unmerged"]);
        std::fs::write(dir.join("unmerged.txt"), "unmerged\n").unwrap();
        git(&dir, &["add", "unmerged.txt"]);
        git(&dir, &["commit", "-q", "-m", "unmerged"]);
        // Re-checking out an already merged feature must not make either the
        // feature itself or its primary branch look safe to delete.
        git(&dir, &["checkout", "-q", "feature"]);

        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();
        let refs = repo.refs().unwrap();
        assert_eq!(refs.primary_branch.as_deref(), Some("main"));
        let branches = refs.branches;
        let merged = |name: &str| branches.iter().find(|b| b.name == name).unwrap().merged;

        assert!(!merged("feature"));
        assert!(merged("same-tip"));
        assert!(!merged("unmerged"));
        assert!(!merged("main"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
