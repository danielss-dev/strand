//! Linked worktrees — list (read) and add / remove / prune (write).
//!
//! Every op **shells out** to the user's `git`, like [`history`](crate::history)
//! and the `stash` apply/pop paths. `git worktree add` checks out a fresh
//! working tree (and may run the user's `post-checkout` hook); `list
//! --porcelain` is the one robust, stable source for path / HEAD / branch /
//! bare / detached / locked / prunable in a single parse. git2's worktree
//! support exists but is thinner and wouldn't run hooks, so the shell-out is the
//! better fit (same reasoning as the other shell-out modules).
//!
//! Why worktrees matter to Strand: AI agents commonly spin up one worktree per
//! feature in the same repo, and a linked worktree's directory is itself a valid
//! repo path — so the UI opens one as its own tab via the normal open flow, and
//! per-worktree stats reuse the existing status/meta/log commands. This module
//! only owns the worktree *registry* (list + lifecycle).

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// One entry in the repository's worktree registry. Mirrors a record from
/// `git worktree list --porcelain`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    /// Absolute worktree directory, forward-slashed.
    pub path: String,
    /// Short branch name (`refs/heads/` stripped); `None` when detached/bare.
    pub branch: Option<String>,
    /// Checked-out HEAD oid; `None` for a bare entry.
    pub head: Option<String>,
    pub is_bare: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    /// Lock reason, when locked and a reason was recorded.
    pub lock_reason: Option<String>,
    /// `git` considers this worktree's directory missing/removable.
    pub is_prunable: bool,
    /// Why git considers it prunable, when a reason was given
    /// (e.g. `gitdir file points to non-existent location`).
    pub prune_reason: Option<String>,
    /// The primary worktree (the one holding the repo's own `.git` dir).
    pub is_main: bool,
    /// Matches the currently-open repo path (`self.path`).
    pub is_current: bool,
}

/// Ref-level health of a worktree's branch relative to its detected base —
/// powers the overview's merged/unpushed badges and the merge dialog's mode
/// choices. Purely read-only graph walks on the shared object DB.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeHealth {
    /// The branch this one forked from, per
    /// [`detect_base_branch`](Repo::detect_base_branch); `None` when nothing
    /// resolvable was found.
    pub base_branch: Option<String>,
    /// Every commit of this branch lives in some other local branch — the
    /// cleanup-safety question. Not derived from `base_branch` alone:
    /// [`detect_base_branch`](Repo::detect_base_branch) deliberately ranks
    /// containing branches last (reviewing against them shows nothing), so a
    /// branch merged into main would otherwise detect a sibling as base and
    /// read as unmerged. (Also true for a fresh branch that never diverged;
    /// the UI copy stays honest about that: "no commits of its own".)
    pub merged: bool,
    /// The branch `merged` refers to — the detected base when everything is
    /// in it, otherwise the first other local branch containing the tip.
    pub merged_into: Option<String>,
    /// Commits on the branch that are not in the base.
    pub ahead_of_base: usize,
    /// The base tip *is* the fork point, so integrating is a pure
    /// fast-forward of the base ref.
    pub can_fast_forward: bool,
    pub has_upstream: bool,
    /// Commits not on the upstream; 0 when `has_upstream` is false.
    pub unpushed: usize,
}

/// Workdir-level stats for one worktree — the fleet dashboard's "is anything
/// happening here, and what does it cost?" row data. One filesystem walk
/// yields both size and freshness; the line counts come from one
/// `diff --shortstat`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeStats {
    /// Total size of the working directory, `.git` excluded.
    pub disk_bytes: u64,
    /// Newest file mtime outside `.git` (Unix seconds) — a decent proxy for
    /// "an agent touched this N minutes ago" without process spying.
    pub last_activity_unix: Option<i64>,
    /// Inserted lines across staged + unstaged tracked changes.
    pub insertions: usize,
    /// Deleted lines across staged + unstaged tracked changes.
    pub deletions: usize,
}

/// Namespace for worktree snapshot refs. Kept out of `refs/heads`/`refs/tags`
/// so archives never show up as branches, but still reachable — a snapshot
/// protects its objects from gc.
const ARCHIVE_NS: &str = "refs/strand/archive/";

/// Auto-prune policy for archive snapshots: keep the newest per slug…
const ARCHIVE_KEEP_PER_SLUG: usize = 10;
/// …and drop anything older than this regardless (safety nets go stale).
const ARCHIVE_MAX_AGE_SECS: i64 = 60 * 60 * 24 * 60; // 60 days

/// One archived worktree snapshot under [`ARCHIVE_NS`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeArchive {
    /// Full ref name, e.g. `refs/strand/archive/feature-x/1751871234`.
    pub ref_name: String,
    /// Slug segment — the branch (or `detached`) at archive time.
    pub name: String,
    /// Snapshot commit oid.
    pub oid: String,
    /// Creation time (Unix seconds), from the ref path segment.
    pub time_unix: i64,
    pub subject: String,
}

/// Where [`restore_worktree_archive`](Repo::restore_worktree_archive) put the
/// worktree and whether it could re-attach the original branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoredWorktree {
    pub path: String,
    /// The re-attached branch; `None` when the restore stayed detached (the
    /// original branch is checked out elsewhere or has moved on).
    pub branch: Option<String>,
}

impl Repo {
    /// List every worktree (main + linked) via `git worktree list --porcelain`.
    /// The first record is always the main worktree.
    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let raw = run_git(&self.path, &["worktree", "list", "--porcelain"])?;
        // Resolve self.path once so `is_current` survives symlinked temp dirs.
        let current = self.path.canonicalize().ok();
        let mut out = Vec::new();
        // Records are separated by a blank line; split and skip empties.
        for (idx, record) in raw.split("\n\n").filter(|r| !r.trim().is_empty()).enumerate() {
            if let Some(wt) = parse_record(record, idx == 0, current.as_deref()) {
                out.push(wt);
            }
        }
        Ok(out)
    }

    /// Add a worktree at `dest`. When `new_branch` is set, create branch
    /// `branch` at `start_point` (any branch / tag / commit; HEAD when `None`)
    /// and check it out (`git worktree add [--track] -b <branch> <dest>
    /// [<start>]`); `track` sets the new branch's upstream to a remote
    /// `start_point`. Otherwise check out the existing `branch`
    /// (`git worktree add <dest> <branch>`). git refuses if the branch is
    /// already checked out in another worktree — that error is surfaced as-is.
    pub fn add_worktree(
        &self,
        dest: &str,
        branch: &str,
        new_branch: bool,
        start_point: Option<&str>,
        track: bool,
    ) -> Result<()> {
        reject_dash("worktree path", dest)?;
        reject_dash("branch", branch)?;
        if let Some(sp) = start_point {
            reject_dash("start point", sp)?;
        }
        let mut args: Vec<&str> = vec!["worktree", "add"];
        if new_branch {
            if track {
                args.push("--track");
            }
            args.extend(["-b", branch, dest]);
            if let Some(sp) = start_point {
                args.push(sp);
            }
        } else {
            args.extend([dest, branch]);
        }
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Lock the worktree at `dest` against removal/pruning
    /// (`git worktree lock [--reason <r>] <dest>`) — e.g. while an agent is
    /// mid-task there.
    pub fn lock_worktree(&self, dest: &str, reason: Option<&str>) -> Result<()> {
        reject_dash("worktree path", dest)?;
        let mut args = vec!["worktree", "lock"];
        if let Some(r) = reason.filter(|r| !r.trim().is_empty()) {
            args.extend(["--reason", r]);
        }
        args.push(dest);
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Unlock the worktree at `dest` (`git worktree unlock <dest>`).
    pub fn unlock_worktree(&self, dest: &str) -> Result<()> {
        reject_dash("worktree path", dest)?;
        run_git(&self.path, &["worktree", "unlock", dest])?;
        Ok(())
    }

    /// Remove the worktree rooted at `dest` (`git worktree remove [--force
    /// --force] <dest>`). Without `force`, git refuses when the worktree has
    /// local changes — that guard is intentional, so the UI confirms before
    /// forcing. `force` passes the flag twice: git wants `-f -f` for locked
    /// worktrees, and a single `--force` already implies discarding changes,
    /// so there is no useful middle step to expose.
    pub fn remove_worktree(&self, dest: &str, force: bool) -> Result<()> {
        reject_dash("worktree path", dest)?;
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
            args.push("--force");
        }
        args.push(dest);
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Move a linked worktree's directory (`git worktree move [--force]
    /// <dest> <new_path>`), keeping the registry consistent — unlike a manual
    /// rename, which leaves a stale entry that needs
    /// [`repair_worktrees`](Repo::repair_worktrees). git refuses to move the
    /// main worktree or one containing submodules, and a locked worktree
    /// needs `force`; those errors surface as-is.
    pub fn move_worktree(&self, dest: &str, new_path: &str, force: bool) -> Result<()> {
        reject_dash("worktree path", dest)?;
        reject_dash("destination path", new_path)?;
        let mut args = vec!["worktree", "move"];
        if force {
            args.push("--force");
        }
        args.extend([dest, new_path]);
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Prune registry entries whose working trees are gone
    /// (`git worktree prune --expire now`). The explicit expiry matters for
    /// freshly-deleted directories: the UI already confirmed they are stale,
    /// so Git's normal grace period would only make the action appear broken.
    pub fn prune_worktrees(&self) -> Result<()> {
        run_git(&self.path, &["worktree", "prune", "--expire", "now"])?;
        Ok(())
    }

    /// Repair worktree administrative links (`git worktree repair [<path>…]`).
    /// With no `paths` it fixes the worktree→repo pointers after the *repo*
    /// moved; pass the new directories of manually-moved worktrees to fix the
    /// repo→worktree side (the case a stale `is_prunable` entry usually means).
    pub fn repair_worktrees(&self, paths: &[String]) -> Result<()> {
        let mut args: Vec<&str> = vec!["worktree", "repair"];
        for p in paths {
            reject_dash("worktree path", p)?;
            args.push(p);
        }
        run_git(&self.path, &args)?;
        Ok(())
    }

    /// Compute [`WorktreeStats`] for *this* repo's working directory. Must be
    /// called on a `Repo` opened at the worktree of interest. The walk skips
    /// `.git` (dir, or the linked-worktree pointer file) and doesn't follow
    /// symlinks; it can take a moment on huge trees (node_modules), so the UI
    /// fetches it in the background and caches per path.
    pub fn worktree_stats(&self) -> Result<WorktreeStats> {
        let (disk_bytes, last_activity_unix) = scan_workdir(&self.path);
        // Staged + unstaged tracked changes in one number; an unborn HEAD
        // (or any diff failure) just reads as no line changes.
        let shortstat =
            run_git(&self.path, &["diff", "HEAD", "--shortstat"]).unwrap_or_default();
        let (insertions, deletions) = parse_shortstat(&shortstat);
        Ok(WorktreeStats { disk_bytes, last_activity_unix, insertions, deletions })
    }

    /// Patterns from `.worktreeinclude` at the workdir root — the convention
    /// (shared with Claude Code) naming gitignored files a fresh worktree
    /// needs copied over (`.env`, local settings). Missing file ⇒ empty list.
    pub fn worktree_include_patterns(&self) -> Result<Vec<String>> {
        let Ok(text) = std::fs::read_to_string(self.path.join(".worktreeinclude")) else {
            return Ok(Vec::new());
        };
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect())
    }

    /// Copy gitignored files matching `.worktreeinclude` from this worktree
    /// into `dest` (a freshly created worktree). Only *ignored* files are
    /// candidates — tracked content arrives via checkout, and non-ignored
    /// untracked files are someone's uncommitted work, not setup. Returns the
    /// copied paths (workdir-relative).
    pub fn copy_worktree_include(&self, dest: &str) -> Result<Vec<String>> {
        reject_dash("worktree path", dest)?;
        let patterns = self.worktree_include_patterns()?;
        if patterns.is_empty() {
            return Ok(Vec::new());
        }
        let raw = run_git(
            &self.path,
            &["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
        )?;
        let mut copied = Vec::new();
        for rel in raw.split('\0').map(str::trim).filter(|s| !s.is_empty()) {
            if !patterns.iter().any(|p| include_match(p, rel)) {
                continue;
            }
            let to = Path::new(dest).join(rel);
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::copy(self.path.join(rel), &to).is_ok() {
                copied.push(rel.to_string());
            }
        }
        Ok(copied)
    }

    /// Compute [`WorktreeHealth`] for the branch `target` (a worktree's
    /// checked-out branch). Callable from any worktree of the family — refs
    /// and objects are shared.
    pub fn worktree_health(&self, target: &str) -> Result<WorktreeHealth> {
        let repo = self.git2()?;
        let target_tip = repo.revparse_single(target)?.peel_to_commit()?.id();

        let base = self.detect_base_branch(target)?;
        let (base_branch, ahead_of_base, can_fast_forward) = match &base {
            Some(hit) => {
                let base_tip = repo
                    .revparse_single(&format!("refs/heads/{}", hit.name))?
                    .peel_to_commit()?
                    .id();
                let (ahead, _) = repo.graph_ahead_behind(target_tip, base_tip)?;
                (Some(hit.name.clone()), ahead, hit.merge_base == base_tip.to_string())
            }
            None => (None, 0, false),
        };

        // Merged = contained in *some* other local branch, not just the
        // detected base: with several sibling worktrees cut from one commit
        // (the canonical parallel-agent setup), detect_base_branch names a
        // sibling after the branch lands in main — the containment scan is
        // what answers "is this safe to retire".
        let mut merged_into = match (&base_branch, ahead_of_base) {
            (Some(b), 0) => Some(b.clone()),
            _ => None,
        };
        if merged_into.is_none() {
            let mut containing: Vec<String> = Vec::new();
            if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
                for (b, _) in branches.flatten() {
                    let name = match b.name() {
                        Ok(Some(n)) if n != target => n.to_string(),
                        _ => continue,
                    };
                    let Some(tip) = b.get().target() else { continue };
                    let contains = tip == target_tip
                        || repo
                            .graph_ahead_behind(target_tip, tip)
                            .map(|(ahead, _)| ahead == 0)
                            .unwrap_or(false);
                    if contains {
                        containing.push(name);
                    }
                }
            }
            containing.sort();
            merged_into = containing.into_iter().next();
        }

        let (has_upstream, unpushed) = repo
            .find_branch(target, git2::BranchType::Local)
            .ok()
            .and_then(|b| b.upstream().ok())
            .and_then(|up| up.get().target())
            .and_then(|up_tip| repo.graph_ahead_behind(target_tip, up_tip).ok())
            .map(|(ahead, _)| (true, ahead))
            .unwrap_or((false, 0));

        Ok(WorktreeHealth {
            base_branch,
            merged: merged_into.is_some(),
            merged_into,
            ahead_of_base,
            can_fast_forward,
            has_upstream,
            unpushed,
        })
    }

    /// Integrate a worktree's `branch` into `base` — the "merge & clean up"
    /// core. `mode` is `"ff"`, `"merge"`, or `"squash"`.
    ///
    /// When some worktree has `base` checked out, the merge runs *in that
    /// directory* (its workdir must be clean; a failed merge is aborted so no
    /// half-merged state is left behind). When no worktree holds `base`, only
    /// `"ff"` is possible, done as a pure ref move after verifying the base
    /// tip is an ancestor of the branch tip — moving a checked-out branch's
    /// ref without updating its workdir would desync that worktree.
    pub fn integrate_worktree_branch(&self, branch: &str, base: &str, mode: &str) -> Result<String> {
        reject_dash("branch", branch)?;
        reject_dash("base branch", base)?;

        let holder = self
            .worktrees()?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(base));

        let Some(holder) = holder else {
            if mode != "ff" {
                return Err(Error::Other(format!(
                    "'{base}' is not checked out in any worktree — a {mode} merge needs a working tree. Check out '{base}' first, or fast-forward instead."
                )));
            }
            let repo = self.git2()?;
            let branch_tip = repo.revparse_single(branch)?.peel_to_commit()?.id();
            let base_ref = format!("refs/heads/{base}");
            let base_tip = repo.revparse_single(&base_ref)?.peel_to_commit()?.id();
            if repo.merge_base(branch_tip, base_tip)? != base_tip {
                return Err(Error::Other(format!(
                    "'{base}' has moved since '{branch}' forked — fast-forward is not possible. Check out '{base}' to merge."
                )));
            }
            repo.reference(
                &base_ref,
                branch_tip,
                true,
                &format!("strand: fast-forward {base} to {branch}"),
            )?;
            return Ok(format!("Fast-forwarded {base} to {branch}"));
        };

        // Tracked changes only (`-uno`): staged work would silently fold into
        // a squash commit and unstaged edits confuse the merge result, but
        // untracked files are safe — git itself refuses a merge that would
        // clobber one, and neither `merge` nor the squash `commit` touches
        // them otherwise.
        let dir = Path::new(&holder.path);
        let dirty = run_git(dir, &["status", "--porcelain", "-uno"])?;
        if !dirty.is_empty() {
            return Err(Error::Other(format!(
                "'{base}' is checked out at {} with uncommitted changes to tracked files — commit or stash them first",
                holder.path
            )));
        }

        match mode {
            "ff" => run_git(dir, &["merge", "--ff-only", branch]),
            "merge" => run_git(dir, &["merge", "--no-ff", "--no-edit", branch]).inspect_err(|_| {
                // A conflicted merge leaves MERGE_HEAD; abort so the base
                // worktree comes back clean instead of stranded mid-merge.
                let _ = run_git(dir, &["merge", "--abort"]);
            }),
            "squash" => {
                run_git(dir, &["merge", "--squash", branch]).inspect_err(|_| {
                    // --squash conflicts have no MERGE_HEAD; reset --merge
                    // restores the pre-merge state.
                    let _ = run_git(dir, &["reset", "--merge"]);
                })?;
                // git wrote SQUASH_MSG; --no-edit commits it without an editor.
                run_git(dir, &["commit", "--no-edit"]).inspect_err(|_| {
                    let _ = run_git(dir, &["reset", "--merge"]);
                })
            }
            other => Err(Error::Other(format!("unknown merge mode: {other}"))),
        }
    }

    /// Snapshot this worktree's full state — HEAD, staged, unstaged, and
    /// untracked (ignore rules respected) — into a ref under
    /// `refs/strand/archive/`, without touching the working tree or index.
    /// The safety net behind every worktree removal: the snapshot commit's
    /// tree is the working directory as-is, parented on HEAD, so nothing is
    /// lost when the directory goes away. Returns the created ref name.
    ///
    /// Must be called on a `Repo` opened *at the worktree being archived*
    /// (the tree is read from `self.path`).
    pub fn archive_worktree_state(&self) -> Result<String> {
        let head = run_git(&self.path, &["rev-parse", "HEAD"])?;
        // Branch label for the ref slug + subject; detached HEAD has none.
        let label = run_git(&self.path, &["symbolic-ref", "--short", "-q", "HEAD"])
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "detached".to_string());

        // Build the workdir tree in a throwaway index so the real one is
        // never touched. Seed it from the live index when possible — `add -A`
        // then reuses the stat cache instead of re-hashing every file.
        let tmp = std::env::temp_dir().join(format!(
            "strand-archive-index-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
        ));
        let _ = std::fs::copy(self.git_dir().join("index"), &tmp);
        let tmp_str = tmp.to_string_lossy().to_string();

        let result = (|| {
            let env: &[(&str, &str)] = &[("GIT_INDEX_FILE", &tmp_str)];
            run_git_env(&self.path, env, &["add", "-A"])?;
            let tree = run_git_env(&self.path, env, &["write-tree"])?;
            // Always a synthetic commit, even for a clean tree — restore can
            // then uniformly unwrap one commit (`reset --mixed HEAD^`). The
            // subject names the exact branch and the body the original
            // directory, so restore can put both back.
            let subject = format!("Worktree archive: {label}");
            let path_note = format!("Path: {}", self.path.to_string_lossy().replace('\\', "/"));
            let commit = run_git(
                &self.path,
                &["commit-tree", &tree, "-p", &head, "-m", &subject, "-m", &path_note],
            )?;
            let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let ref_name = format!("{ARCHIVE_NS}{}/{secs}", slug(&label));
            run_git(&self.path, &["update-ref", &ref_name, &commit])?;
            Ok(ref_name)
        })();
        let _ = std::fs::remove_file(&tmp);
        // Best-effort housekeeping: snapshots are a safety net, not history —
        // cap them per slug and by age so they can't pile up forever.
        if result.is_ok() {
            let _ = self.auto_prune_archives();
        }
        result
    }

    /// Drop archive snapshots beyond [`ARCHIVE_KEEP_PER_SLUG`] per slug or
    /// older than [`ARCHIVE_MAX_AGE_SECS`]. Runs after every new archive.
    fn auto_prune_archives(&self) -> Result<()> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let mut per_slug: HashMap<String, usize> = HashMap::new();
        // `worktree_archives` is newest-first, so counting down the list
        // keeps the newest N per slug.
        for a in self.worktree_archives()? {
            let seen = per_slug.entry(a.name.clone()).or_insert(0);
            *seen += 1;
            if *seen > ARCHIVE_KEEP_PER_SLUG || now.saturating_sub(a.time_unix) > ARCHIVE_MAX_AGE_SECS {
                let _ = self.delete_worktree_archive(&a.ref_name);
            }
        }
        Ok(())
    }

    /// List archived worktree snapshots, newest first.
    pub fn worktree_archives(&self) -> Result<Vec<WorktreeArchive>> {
        let raw = run_git(
            &self.path,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)%00%(subject)",
                &ARCHIVE_NS[..ARCHIVE_NS.len() - 1],
            ],
        )?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let mut parts = line.split('\0');
            let (Some(ref_name), Some(oid), subject) =
                (parts.next(), parts.next(), parts.next().unwrap_or(""))
            else {
                continue;
            };
            let tail = ref_name.strip_prefix(ARCHIVE_NS).unwrap_or(ref_name);
            // `<slug>/<unix-secs>`; tolerate slugs that contain '/' themselves.
            let (name, secs) = tail.rsplit_once('/').unwrap_or((tail, "0"));
            out.push(WorktreeArchive {
                ref_name: ref_name.to_string(),
                name: name.to_string(),
                oid: oid.to_string(),
                time_unix: secs.parse().unwrap_or(0),
                subject: subject.to_string(),
            });
        }
        out.sort_by(|a, b| b.time_unix.cmp(&a.time_unix).then(b.ref_name.cmp(&a.ref_name)));
        Ok(out)
    }

    /// Restore an archived snapshot as a worktree that looks like the one
    /// that was removed: check out the snapshot commit detached, unwrap it
    /// (`reset --mixed HEAD^`) so the working directory holds the archived
    /// state as uncommitted changes on the original HEAD, then put the
    /// original identity back where that's unambiguous —
    ///
    /// - **directory**: the recorded original path when it's free, else the
    ///   caller's `fallback_dest`, else `<fallback_dest>-restored`;
    /// - **branch**: recreated at the original commit when it was deleted,
    ///   re-attached when it still exists, isn't held by another worktree,
    ///   and still points at the archived commit; detached otherwise.
    ///
    /// The staged/unstaged split is the one thing a snapshot can't preserve.
    pub fn restore_worktree_archive(
        &self,
        ref_name: &str,
        fallback_dest: &str,
    ) -> Result<RestoredWorktree> {
        reject_dash("worktree path", fallback_dest)?;
        if !ref_name.starts_with(ARCHIVE_NS) {
            return Err(Error::Other(format!("not an archive ref: {ref_name}")));
        }

        // Recorded identity: subject names the branch, body the original path
        // (older archives lack the path line — they fall through to the
        // caller's destination).
        let meta = run_git(&self.path, &["show", "-s", "--format=%s%n%b", ref_name])?;
        let mut lines = meta.lines();
        let label = lines
            .next()
            .and_then(|s| s.strip_prefix("Worktree archive: "))
            .map(str::to_string);
        let source = lines.find_map(|l| l.strip_prefix("Path: ")).map(str::to_string);

        let suffixed = format!("{fallback_dest}-restored");
        let dest = [source.as_deref(), Some(fallback_dest), Some(suffixed.as_str())]
            .into_iter()
            .flatten()
            .find(|p| !Path::new(p).exists())
            .ok_or_else(|| Error::Other(format!("destination already exists: {fallback_dest}")))?
            .to_string();

        run_git(&self.path, &["worktree", "add", "--detach", &dest, ref_name])?;
        let dest_dir = Path::new(&dest);
        run_git(dest_dir, &["reset", "--mixed", "HEAD^"])?;

        // Best-effort branch re-attach; any failure just leaves the restore
        // detached, which is always a valid state.
        let mut attached = None;
        if let Some(branch) = label.filter(|l| l != "detached" && !l.starts_with('-')) {
            let branch_ref = format!("refs/heads/{branch}");
            let exists =
                run_git(&self.path, &["show-ref", "--verify", "--quiet", &branch_ref]).is_ok();
            let ok = if exists {
                let held = self
                    .worktrees()?
                    .into_iter()
                    .any(|w| w.branch.as_deref() == Some(branch.as_str()));
                let tip = run_git(&self.path, &["rev-parse", &branch_ref]).unwrap_or_default();
                let head = run_git(dest_dir, &["rev-parse", "HEAD"]).unwrap_or_default();
                // Same-commit checkout attaches HEAD without touching the
                // restored (dirty) working tree.
                !held && !tip.is_empty() && tip == head
                    && run_git(dest_dir, &["checkout", "-q", &branch]).is_ok()
            } else {
                run_git(dest_dir, &["checkout", "-q", "-b", &branch]).is_ok()
            };
            if ok {
                attached = Some(branch);
            }
        }

        Ok(RestoredWorktree { path: dest, branch: attached })
    }

    /// Delete an archived snapshot ref. The snapshot commit becomes
    /// unreachable and is eventually gc'd.
    pub fn delete_worktree_archive(&self, ref_name: &str) -> Result<()> {
        if !ref_name.starts_with(ARCHIVE_NS) {
            return Err(Error::Other(format!("not an archive ref: {ref_name}")));
        }
        run_git(&self.path, &["update-ref", "-d", ref_name])?;
        Ok(())
    }
}

/// One-pass walk of a working directory: total file bytes + newest mtime,
/// skipping anything named `.git` and never following symlinks. Errors are
/// swallowed per entry — stats are advisory, not a source of truth.
fn scan_workdir(root: &Path) -> (u64, Option<i64>) {
    let mut bytes = 0u64;
    let mut newest: Option<i64> = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name() == ".git" {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                bytes += meta.len();
                if let Ok(mtime) = meta.modified() {
                    let secs = mtime
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    if newest.is_none_or(|n| secs > n) {
                        newest = Some(secs);
                    }
                }
            }
        }
    }
    (bytes, newest)
}

/// Pull the two counters out of `git diff --shortstat` output, e.g.
/// `" 3 files changed, 41 insertions(+), 5 deletions(-)"`. Either counter may
/// be absent (pure adds / pure deletes).
fn parse_shortstat(line: &str) -> (usize, usize) {
    let mut ins = 0;
    let mut del = 0;
    for part in line.split(',') {
        let part = part.trim();
        let Some(n) = part.split_whitespace().next().and_then(|n| n.parse::<usize>().ok()) else {
            continue;
        };
        if part.contains("insertion") {
            ins = n;
        } else if part.contains("deletion") {
            del = n;
        }
    }
    (ins, del)
}

/// Does one `.worktreeinclude` pattern match a workdir-relative path?
/// A pragmatic gitignore subset: leading `/` anchors to the root, a trailing
/// `/` means "everything under this directory", `**` crosses directories,
/// `*`/`?` stay within one segment, and a slash-less pattern matches the file
/// name at any depth (`.env*` finds `sub/dir/.env.local`).
fn include_match(pattern: &str, rel: &str) -> bool {
    let mut pat = pattern.trim();
    let anchored = pat.starts_with('/');
    if anchored {
        pat = &pat[1..];
    }
    let dir_pat;
    if pat.ends_with('/') {
        dir_pat = format!("{pat}**");
        pat = &dir_pat;
    }
    if anchored || pat.contains('/') {
        glob_match(pat, rel)
    } else {
        rel.rsplit('/').next().map(|base| glob_match(pat, base)).unwrap_or(false)
    }
}

/// Minimal glob matcher: `**` matches anything (including `/`), `*` and `?`
/// never cross a `/`, everything else is literal.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn rec(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => {
                // Collapse `**` (and an optional following `/`): match any
                // suffix of the text, slashes included.
                let rest = if p.get(2) == Some(&'/') { &p[3..] } else { &p[2..] };
                (0..=t.len()).any(|i| rec(rest, &t[i..]))
            }
            Some('*') => (0..=t.len())
                .take_while(|&i| i == 0 || t[i - 1] != '/')
                .any(|i| rec(&p[1..], &t[i..])),
            Some('?') => t.first().is_some_and(|c| *c != '/') && rec(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && rec(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    rec(&p, &t)
}

/// Reduce a branch label to a safe ref-name segment: anything outside
/// `[A-Za-z0-9._/-]` becomes `-`, and leading dots/dashes are trimmed so the
/// segment can't start a `..`/option-looking component.
fn slug(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/') { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '.' || c == '-' || c == '/');
    if trimmed.is_empty() { "worktree".to_string() } else { trimmed.to_string() }
}

/// Parse one porcelain record into a [`Worktree`]. Lines seen:
/// `worktree <path>`, `HEAD <oid>`, `branch <ref>`, `bare`, `detached`,
/// `locked [reason]`, `prunable [reason]`. Returns `None` if the record has no
/// `worktree` line (shouldn't happen, but stays defensive).
fn parse_record(record: &str, is_main: bool, current: Option<&Path>) -> Option<Worktree> {
    let mut path: Option<String> = None;
    let mut head = None;
    let mut branch = None;
    let mut is_bare = false;
    let mut is_detached = false;
    let mut is_locked = false;
    let mut lock_reason = None;
    let mut is_prunable = false;
    let mut prune_reason = None;

    for line in record.lines() {
        let line = line.trim_end();
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.replace('\\', "/"));
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = Some(h.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            // Porcelain gives the full ref; show the short name.
            branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" {
            is_bare = true;
        } else if line == "detached" {
            is_detached = true;
        } else if line == "locked" || line.starts_with("locked ") {
            is_locked = true;
            lock_reason = line.strip_prefix("locked ").map(|r| r.to_string());
        } else if line == "prunable" || line.starts_with("prunable ") {
            is_prunable = true;
            prune_reason = line.strip_prefix("prunable ").map(|r| r.to_string());
        }
    }

    let path = path?;
    let is_current = current
        .and_then(|c| Path::new(&path).canonicalize().ok().map(|p| p == c))
        .unwrap_or(false);

    Some(Worktree {
        path,
        branch,
        head,
        is_bare,
        is_detached,
        is_locked,
        lock_reason,
        is_prunable,
        prune_reason,
        is_main,
        is_current,
    })
}

/// Reject an argument git would mis-read as an option flag. Mirrors the
/// submodule-path / revspec guards elsewhere in the crate.
fn reject_dash(what: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(Error::Other(format!("empty {what}")));
    }
    if value.starts_with('-') {
        return Err(Error::Other(format!("{what} may not start with '-': {value}")));
    }
    Ok(())
}

/// Blocking `git` subcommand in `cwd`, trimmed stdout / combined error on
/// failure. A module-local free fn (not a `Repo` method) so it doesn't collide
/// with `stash`'s same-named inherent helper — the shape matches `history`'s.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    run_git_env(cwd, &[], args)
}

/// [`run_git`] with extra environment variables — the archive path uses a
/// throwaway `GIT_INDEX_FILE` to build a tree without touching the real index.
fn run_git_env(cwd: &Path, envs: &[(&str, &str)], args: &[&str]) -> Result<String> {
    let mut cmd = crate::git_command();
    cmd.current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let combined = format!("{stdout}{stderr}").trim().to_string();
        return Err(Error::Other(if combined.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            combined
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
    fn lists_adds_and_removes_a_worktree() {
        let base = std::env::temp_dir().join(format!(
            "strand-worktree-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();

        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.name", "Test"]);
        git(&main, &["config", "user.email", "test@example.com"]);
        git(&main, &["config", "commit.gpgsign", "false"]);
        std::fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "a.txt"]);
        git(&main, &["commit", "-q", "-m", "init"]);

        let repo = Repo::discover(main.to_str().unwrap()).unwrap();

        // Only the main worktree to start.
        let wts = repo.worktrees().unwrap();
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        assert!(wts[0].is_current);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));

        // Add a linked worktree on a new branch.
        let linked = base.join("feature");
        repo.add_worktree(linked.to_str().unwrap(), "feature", true, None, false).unwrap();
        let wts = repo.worktrees().unwrap();
        assert_eq!(wts.len(), 2, "main + linked");
        let feat = wts.iter().find(|w| w.branch.as_deref() == Some("feature")).unwrap();
        assert!(!feat.is_main);
        assert!(!feat.is_current);
        assert!(feat.head.is_some());

        // Remove it again.
        repo.remove_worktree(linked.to_str().unwrap(), false).unwrap();
        let wts = repo.worktrees().unwrap();
        assert_eq!(wts.len(), 1, "back to just main");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prunes_a_freshly_missing_worktree_immediately() {
        let main = setup("prune");
        let base = main.parent().unwrap();
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let linked = base.join("feature");
        repo.add_worktree(linked.to_str().unwrap(), "feature", true, None, false)
            .unwrap();

        std::fs::remove_dir_all(&linked).unwrap();
        let stale = repo
            .worktrees()
            .unwrap()
            .into_iter()
            .find(|w| w.branch.as_deref() == Some("feature"))
            .expect("stale worktree remains registered");
        assert!(stale.is_prunable);

        repo.prune_worktrees().unwrap();
        assert!(
            repo.worktrees()
                .unwrap()
                .into_iter()
                .all(|w| w.branch.as_deref() != Some("feature")),
            "fresh stale entry was pruned without waiting for Git's grace period"
        );

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn moves_a_worktree() {
        let main = setup("move");
        let base = main.parent().unwrap();
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let src = base.join("feature");
        repo.add_worktree(src.to_str().unwrap(), "feature", true, None, false).unwrap();

        let moved = base.join("moved");
        repo.move_worktree(src.to_str().unwrap(), moved.to_str().unwrap(), false).unwrap();

        assert!(!src.exists(), "old directory is gone");
        assert!(moved.join("a.txt").exists(), "tree content moved");
        let wts = repo.worktrees().unwrap();
        let feat = wts.iter().find(|w| w.branch.as_deref() == Some("feature")).unwrap();
        assert!(
            Path::new(&feat.path).ends_with("moved"),
            "registry follows the move: {}",
            feat.path
        );
        assert!(!feat.is_prunable);

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn repairs_a_manually_moved_worktree() {
        let main = setup("repair");
        let base = main.parent().unwrap();
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let src = base.join("feature");
        repo.add_worktree(src.to_str().unwrap(), "feature", true, None, false).unwrap();

        // A plain fs rename (what a user or agent does outside git) breaks
        // both link directions; the registry then reports the entry prunable.
        let moved = base.join("relocated");
        std::fs::rename(&src, &moved).unwrap();
        let wts = repo.worktrees().unwrap();
        let feat = wts.iter().find(|w| !w.is_main).unwrap();
        assert!(feat.is_prunable, "manual move leaves a dangling registry entry");

        repo.repair_worktrees(&[moved.to_str().unwrap().to_string()]).unwrap();
        let wts = repo.worktrees().unwrap();
        let feat = wts.iter().find(|w| w.branch.as_deref() == Some("feature")).unwrap();
        assert!(!feat.is_prunable, "repair relinks the moved worktree");
        assert!(
            Path::new(&feat.path).ends_with("relocated"),
            "registry points at the new directory: {}",
            feat.path
        );

        let _ = std::fs::remove_dir_all(base);
    }

    /// Fresh repo on `main` with one commit; returns the repo dir.
    fn setup(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "strand-wt-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["config", "user.name", "Test"]);
        git(&main, &["config", "user.email", "test@example.com"]);
        git(&main, &["config", "commit.gpgsign", "false"]);
        std::fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "a.txt"]);
        git(&main, &["commit", "-q", "-m", "init"]);
        main
    }

    fn commit_file(dir: &Path, name: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(name), content).unwrap();
        git(dir, &["add", name]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    #[test]
    fn health_reports_merged_ahead_and_can_ff() {
        let main = setup("health");
        let feature = main.parent().unwrap().join("feature");
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        repo.add_worktree(feature.to_str().unwrap(), "feature", true, None, false).unwrap();
        commit_file(&feature, "f.txt", "f\n", "feature work");

        let h = repo.worktree_health("feature").unwrap();
        assert_eq!(h.base_branch.as_deref(), Some("main"));
        assert!(!h.merged);
        assert_eq!(h.ahead_of_base, 1);
        assert!(h.can_fast_forward, "base has not moved");
        assert!(!h.has_upstream);

        // Base moves on → still unmerged, but no longer a pure fast-forward.
        commit_file(&main, "m.txt", "m\n", "main moved on");
        let h = repo.worktree_health("feature").unwrap();
        assert!(!h.merged);
        assert!(!h.can_fast_forward);

        // Merge the branch into the base → merged. Sibling branches sitting
        // at the fork point (the canonical parallel-agent setup) must not
        // hide it: detect_base_branch will name a sibling as base, but the
        // containment scan still finds the branch fully in main.
        git(&main, &["branch", "sibling-a", "HEAD^"]);
        git(&main, &["branch", "sibling-b", "HEAD^"]);
        git(&main, &["merge", "-q", "--no-edit", "feature"]);
        let h = repo.worktree_health("feature").unwrap();
        assert!(h.merged, "merged despite sibling branches at the fork");
        assert_eq!(h.merged_into.as_deref(), Some("main"));

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn integrate_fast_forwards_an_unheld_base() {
        let main = setup("ff");
        git(&main, &["branch", "release"]);
        let feature = main.parent().unwrap().join("feature");
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        repo.add_worktree(feature.to_str().unwrap(), "feature", true, None, false).unwrap();
        commit_file(&feature, "f.txt", "f\n", "feature work");
        let feature_tip = git(&feature, &["rev-parse", "HEAD"]);

        // `release` isn't checked out anywhere: a merge needs a worktree…
        let err = repo.integrate_worktree_branch("feature", "release", "squash").unwrap_err();
        assert!(err.to_string().contains("not checked out"), "{err}");
        // …but a fast-forward is a pure ref move.
        repo.integrate_worktree_branch("feature", "release", "ff").unwrap();
        assert_eq!(git(&main, &["rev-parse", "release"]), feature_tip);

        // A diverged base refuses the ref-move fast-forward.
        commit_file(&main, "m.txt", "m\n", "main moved on");
        git(&main, &["branch", "-f", "release2", "main"]);
        let err = repo.integrate_worktree_branch("feature", "release2", "ff").unwrap_err();
        assert!(err.to_string().contains("has moved"), "{err}");

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn integrate_merges_and_squashes_in_the_base_worktree() {
        let main = setup("merge");
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();

        // Diverge: two commits on feature, one on main (disjoint files).
        let feature = main.parent().unwrap().join("feature");
        repo.add_worktree(feature.to_str().unwrap(), "feature", true, None, false).unwrap();
        commit_file(&feature, "f1.txt", "1\n", "feature 1");
        commit_file(&feature, "f2.txt", "2\n", "feature 2");
        commit_file(&main, "m.txt", "m\n", "main moved on");
        let main_tip = git(&main, &["rev-parse", "HEAD"]);

        // Tracked changes in the base worktree refuse the merge…
        std::fs::write(main.join("a.txt"), "edited\n").unwrap();
        let err = repo.integrate_worktree_branch("feature", "main", "squash").unwrap_err();
        assert!(err.to_string().contains("uncommitted"), "{err}");
        git(&main, &["checkout", "--", "a.txt"]);
        // …but untracked files don't block it (git guards clobbering itself).
        std::fs::write(main.join("note.txt"), "keep\n").unwrap();

        // Squash: exactly one new commit on main, feature's files present.
        repo.integrate_worktree_branch("feature", "main", "squash").unwrap();
        assert_eq!(git(&main, &["rev-parse", "HEAD^"]), main_tip, "one commit on top");
        assert!(main.join("f1.txt").exists() && main.join("f2.txt").exists());
        assert!(main.join("note.txt").exists(), "untracked bystander untouched");
        assert_eq!(git(&main, &["status", "--porcelain", "-uno"]), "");

        // Merge (no-ff): the new HEAD is a real merge commit.
        let feature2 = main.parent().unwrap().join("feature2");
        repo.add_worktree(feature2.to_str().unwrap(), "feature2", true, None, false).unwrap();
        commit_file(&feature2, "g.txt", "g\n", "feature2 work");
        repo.integrate_worktree_branch("feature2", "main", "merge").unwrap();
        assert!(!git(&main, &["rev-parse", "HEAD^2"]).is_empty(), "merge commit has two parents");

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn archive_snapshots_and_restores_a_worktree() {
        let main = setup("archive");
        // Ignore rules must hold in the snapshot too.
        std::fs::write(main.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&main, &["add", ".gitignore"]);
        git(&main, &["commit", "-q", "-m", "ignore rules"]);

        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let feature = main.parent().unwrap().join("feature");
        repo.add_worktree(feature.to_str().unwrap(), "feature", true, None, false).unwrap();
        commit_file(&feature, "f.txt", "committed\n", "feature work");
        let feature_tip = git(&feature, &["rev-parse", "HEAD"]);

        // Dirty state: modified tracked + untracked + ignored.
        std::fs::write(feature.join("f.txt"), "modified\n").unwrap();
        std::fs::write(feature.join("new.txt"), "untracked\n").unwrap();
        std::fs::write(feature.join("ignored.txt"), "noise\n").unwrap();

        let wt_repo = Repo::discover(feature.to_str().unwrap()).unwrap();
        let ref_name = wt_repo.archive_worktree_state().unwrap();
        assert!(ref_name.starts_with("refs/strand/archive/feature/"), "{ref_name}");

        // The worktree itself was not disturbed by archiving.
        let porcelain = git(&feature, &["status", "--porcelain"]);
        assert!(porcelain.contains("f.txt") && porcelain.contains("new.txt"), "{porcelain}");

        let archives = repo.worktree_archives().unwrap();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0].name, "feature");
        assert_eq!(archives[0].ref_name, ref_name);
        assert!(archives[0].subject.contains("feature"));

        // Blow the worktree away, then restore the snapshot. The original
        // directory is free again and the branch still points at the
        // archived commit, so the restore puts both identities back.
        repo.remove_worktree(feature.to_str().unwrap(), true).unwrap();
        let fallback = main.parent().unwrap().join("restored");
        let res = repo.restore_worktree_archive(&ref_name, fallback.to_str().unwrap()).unwrap();
        let restored = Path::new(&res.path).to_path_buf();
        assert_eq!(
            restored.canonicalize().unwrap(),
            feature.canonicalize().unwrap(),
            "restored into the original directory"
        );
        assert_eq!(res.branch.as_deref(), Some("feature"));
        assert_eq!(git(&restored, &["symbolic-ref", "--short", "HEAD"]), "feature");
        assert_eq!(git(&restored, &["rev-parse", "HEAD"]), feature_tip, "back on the original commit");
        // trim: checkout may rewrite line endings (core.autocrlf on Windows).
        assert_eq!(std::fs::read_to_string(restored.join("f.txt")).unwrap().trim(), "modified");
        assert_eq!(std::fs::read_to_string(restored.join("new.txt")).unwrap().trim(), "untracked");
        assert!(!restored.join("ignored.txt").exists(), "ignored files stay out of snapshots");
        let porcelain = git(&restored, &["status", "--porcelain"]);
        assert!(porcelain.contains("f.txt") && porcelain.contains("new.txt"), "{porcelain}");

        // A second restore of the same snapshot: the original directory and
        // branch are taken now, so it lands at the fallback, detached.
        let res2 = repo.restore_worktree_archive(&ref_name, fallback.to_str().unwrap()).unwrap();
        assert_eq!(
            Path::new(&res2.path).canonicalize().unwrap(),
            fallback.canonicalize().unwrap(),
            "fell back to the caller's destination"
        );
        assert!(res2.branch.is_none(), "branch is held by the first restore");

        // Guarded deletion: only archive refs may be deleted.
        assert!(repo.delete_worktree_archive("refs/heads/main").is_err());
        repo.delete_worktree_archive(&ref_name).unwrap();
        assert!(repo.worktree_archives().unwrap().is_empty());

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn include_match_covers_the_gitignore_subset() {
        // Slash-less patterns match the basename at any depth.
        assert!(include_match(".env*", ".env"));
        assert!(include_match(".env*", "sub/dir/.env.local"));
        assert!(!include_match(".env*", "environment.txt"));
        // A slash makes the pattern path-relative; `*` stays in one segment.
        assert!(include_match("config/*.local", "config/settings.local"));
        assert!(!include_match("config/*.local", "config/deep/settings.local"));
        // `**` crosses directories.
        assert!(include_match("**/secrets.json", "a/b/secrets.json"));
        assert!(include_match("data/**", "data/x/y.bin"));
        // Trailing slash = everything under the directory.
        assert!(include_match(".venv/", ".venv/bin/python"));
        // Leading slash anchors to the root.
        assert!(include_match("/.env", ".env"));
        assert!(!include_match("/.env", "sub/.env"));
        assert!(include_match("file?.txt", "file1.txt"));
        assert!(!include_match("file?.txt", "file10.txt"));
    }

    #[test]
    fn parse_shortstat_reads_both_counters() {
        assert_eq!(parse_shortstat(" 3 files changed, 41 insertions(+), 5 deletions(-)"), (41, 5));
        assert_eq!(parse_shortstat(" 1 file changed, 2 insertions(+)"), (2, 0));
        assert_eq!(parse_shortstat(" 1 file changed, 7 deletions(-)"), (0, 7));
        assert_eq!(parse_shortstat(""), (0, 0));
    }

    #[test]
    fn adds_a_worktree_from_a_start_point() {
        let main = setup("startpoint");
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let first = git(&main, &["rev-parse", "HEAD"]);
        commit_file(&main, "b.txt", "b\n", "second");

        // New branch cut from the *first* commit, not HEAD.
        let wt = main.parent().unwrap().join("from-first");
        repo.add_worktree(wt.to_str().unwrap(), "from-first", true, Some(&first), false)
            .unwrap();
        assert_eq!(git(&wt, &["rev-parse", "HEAD"]), first);
        assert_eq!(git(&wt, &["symbolic-ref", "--short", "HEAD"]), "from-first");
        assert!(!wt.join("b.txt").exists(), "checked out at the start point");

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn copies_worktree_include_files_into_a_new_worktree() {
        let main = setup("include");
        std::fs::write(main.join(".gitignore"), ".env*\nsecret.key\nnoise.log\n").unwrap();
        std::fs::write(main.join(".worktreeinclude"), "# setup files\n.env*\nsecret.key\n")
            .unwrap();
        git(&main, &["add", ".gitignore", ".worktreeinclude"]);
        git(&main, &["commit", "-q", "-m", "ignore rules"]);
        // Ignored files: two matching the include list, one not.
        std::fs::write(main.join(".env"), "A=1\n").unwrap();
        std::fs::write(main.join("secret.key"), "k\n").unwrap();
        std::fs::write(main.join("noise.log"), "log\n").unwrap();

        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        assert_eq!(repo.worktree_include_patterns().unwrap(), vec![".env*", "secret.key"]);

        let wt = main.parent().unwrap().join("agent");
        repo.add_worktree(wt.to_str().unwrap(), "agent", true, None, false).unwrap();
        let mut copied = repo.copy_worktree_include(wt.to_str().unwrap()).unwrap();
        copied.sort();
        assert_eq!(copied, vec![".env", "secret.key"]);
        assert_eq!(std::fs::read_to_string(wt.join(".env")).unwrap(), "A=1\n");
        assert!(wt.join("secret.key").exists());
        assert!(!wt.join("noise.log").exists(), "unlisted ignored files stay put");

        // No `.worktreeinclude` ⇒ quiet no-op.
        let bare = setup("include-none");
        let repo2 = Repo::discover(bare.to_str().unwrap()).unwrap();
        assert!(repo2.worktree_include_patterns().unwrap().is_empty());
        assert!(repo2.copy_worktree_include(bare.to_str().unwrap()).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
        let _ = std::fs::remove_dir_all(bare.parent().unwrap());
    }

    #[test]
    fn stats_report_size_activity_and_line_counts() {
        let main = setup("stats");
        std::fs::write(main.join("a.txt"), "a\nchanged\n").unwrap();
        std::fs::write(main.join("big.bin"), vec![0u8; 2048]).unwrap();

        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let stats = repo.worktree_stats().unwrap();
        assert!(stats.disk_bytes >= 2048, "walk counted the payload: {}", stats.disk_bytes);
        assert!(stats.last_activity_unix.is_some());
        assert!(stats.insertions >= 1, "a.txt gained a line: {}", stats.insertions);

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn locks_and_unlocks_a_worktree() {
        let main = setup("lock");
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let wt = main.parent().unwrap().join("locked");
        repo.add_worktree(wt.to_str().unwrap(), "locked", true, None, false).unwrap();

        repo.lock_worktree(wt.to_str().unwrap(), Some("agent running")).unwrap();
        let listed = repo.worktrees().unwrap();
        let entry = listed.iter().find(|w| w.branch.as_deref() == Some("locked")).unwrap();
        assert!(entry.is_locked);
        assert_eq!(entry.lock_reason.as_deref(), Some("agent running"));

        repo.unlock_worktree(wt.to_str().unwrap()).unwrap();
        let listed = repo.worktrees().unwrap();
        let entry = listed.iter().find(|w| w.branch.as_deref() == Some("locked")).unwrap();
        assert!(!entry.is_locked);

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn archiving_auto_prunes_old_snapshots() {
        let main = setup("autoprune");
        let repo = Repo::discover(main.to_str().unwrap()).unwrap();
        let head = git(&main, &["rev-parse", "HEAD"]);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;

        // Seed synthetic archive refs: 12 recent ones for this slug (over the
        // per-slug cap) + 1 ancient one for another slug (over the age cap).
        for i in 0..12i64 {
            let r = format!("{ARCHIVE_NS}main/{}", now - 100 - i);
            git(&main, &["update-ref", &r, &head]);
        }
        let old = format!("{ARCHIVE_NS}other/{}", now - ARCHIVE_MAX_AGE_SECS - 1000);
        git(&main, &["update-ref", &old, &head]);

        // A real archive triggers the prune pass.
        repo.archive_worktree_state().unwrap();

        let archives = repo.worktree_archives().unwrap();
        let main_slug = archives.iter().filter(|a| a.name == "main").count();
        assert_eq!(main_slug, ARCHIVE_KEEP_PER_SLUG, "capped per slug");
        assert!(!archives.iter().any(|a| a.name == "other"), "aged out");

        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[test]
    fn rejects_dash_leading_args() {
        let base = std::env::temp_dir().join(format!(
            "strand-worktree-dash-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        git(&base, &["init", "-q", "-b", "main"]);
        let repo = Repo::discover(base.to_str().unwrap()).unwrap();
        assert!(repo.add_worktree("--force", "x", false, None, false).is_err());
        assert!(repo.remove_worktree("-rf", true).is_err());
        assert!(repo.move_worktree("-x", "y", false).is_err());
        assert!(repo.move_worktree("x", "--force", false).is_err());
        assert!(repo.repair_worktrees(&["--dry-run".into()]).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
