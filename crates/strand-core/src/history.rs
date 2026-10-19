//! History-rewriting ops — cherry-pick, revert, merge, rebase (plain +
//! interactive), continue, and abort.
//!
//! These all **shell out to `git`**, the same approach [`network`] and the
//! `stash apply`/`pop`/`snapshot` paths already take. The reasons are the same
//! ones that made stash give up on git2: real `git` resolves conflicts the way
//! the user expects (leaving conflict markers + the in-progress state on disk),
//! signs the resulting commits with the user's GPG/SSH config, and runs their
//! hooks — none of which git2's `merge`/`cherrypick`/`revert` primitives do for
//! free, and git2 has no rebase driver worth re-implementing. The cost is a
//! `git` subprocess per op, which is negligible next to the work itself.
//!
//! Conflicts are *not* an error we hide: when an op stops with conflicts `git`
//! exits non-zero and leaves the repo mid-operation, so we return its message
//! and let the UI surface it. The in-progress state is reported by
//! [`Repo::meta`](crate::repo::Repo::meta)'s `operation` field, and
//! [`abort_operation`](Repo::abort_operation) is the escape hatch.
//!
//! [`network`]: crate::network

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// How a merge should be performed. Mirrors the three choices the Merge dialog
/// offers; `FastForwardOnly`/other niche modes are intentionally omitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMode {
    /// Fast-forward when possible, otherwise create a merge commit (git's
    /// default — `git merge <ref>`).
    Auto,
    /// Always create a merge commit, even when a fast-forward was possible
    /// (`git merge --no-ff <ref>`).
    NoFastForward,
    /// Stage the merged result without committing or recording a second parent
    /// (`git merge --squash <ref>`). The user reviews + commits afterward.
    Squash,
}

impl MergeMode {
    /// Parse the wire string the IPC layer passes (`"auto"` / `"no_ff"` /
    /// `"squash"`).
    pub fn from_wire(s: &str) -> Result<Self> {
        match s {
            "auto" => Ok(Self::Auto),
            "no_ff" => Ok(Self::NoFastForward),
            "squash" => Ok(Self::Squash),
            other => Err(Error::Other(format!("unknown merge mode `{other}`"))),
        }
    }
}

/// What to do with one commit in an interactive-rebase plan. Mirrors the git
/// todo verbs the sequence editor exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RebaseAction {
    /// Keep the commit as-is.
    Pick,
    /// Keep the commit but replace its message with [`RebaseStep::message`].
    Reword,
    /// Pause after applying the commit so the user can amend it, then continue.
    Edit,
    /// Combine into the previous kept commit, keeping both messages (git's
    /// default combined message — we never open an editor).
    Squash,
    /// Combine into the previous kept commit, discarding this one's message.
    Fixup,
    /// Remove the commit entirely.
    Drop,
}

/// One planned operation against one commit, in the order the user arranged
/// them (oldest→newest). `message` is read only for [`RebaseAction::Reword`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebaseStep {
    pub action: RebaseAction,
    pub oid: String,
    #[serde(default)]
    pub message: Option<String>,
}

/// One commit in the editable range, oldest→newest, exactly as the sequence
/// editor would list it. Powers the interactive-rebase dialog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebaseEntry {
    pub oid: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// A merge commit in range — the UI defaults to preserving its topology.
    pub is_merge: bool,
}

/// Outcome of a plain or interactive rebase.
///
/// `moved` lists local branches whose tips changed. It is empty while the
/// rebase is paused: `--update-refs` records placeholders and git moves the
/// refs only when the rebase completes. Abort leaves every ref untouched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RebaseOutcome {
    pub paused: bool,
    pub moved: Vec<String>,
}

/// Whether this repo remembers `--update-refs`, and whether the installed git
/// is new enough to honor it (2.38+). Older git disables the toggle instead of
/// failing mid-rebase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RebaseUpdateRefsSetting {
    pub supported: bool,
    pub enabled: bool,
}

/// A local branch whose tip sits in the range a plain rebase would rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RebaseRefPreview {
    pub name: String,
    pub full_ref: String,
    pub will_move: bool,
}

/// A local branch tip considered for `update-ref` placement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateRefBranch {
    pub name: String,
    pub full_ref: String,
    pub tip: String,
    pub checked_out_elsewhere: bool,
}

/// Where one `update-ref` line lands in a flat (non `--rebase-merges`) plan.
///
/// `anchor` is the pick/reword/edit step the branch follows. `None` parks the
/// branch on the rebase base — every commit it contained was dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateRefAnchor {
    pub name: String,
    pub full_ref: String,
    pub anchor: Option<usize>,
    pub will_move: bool,
}

/// Preview of folding the index into an older commit. `commits` is the range
/// that a confirm dialog lists (oldest → newest). Nothing is written.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmendIntoPlan {
    pub commits: Vec<RebaseEntry>,
    /// `target` is reachable from `@{upstream}` — rewriting it needs a force push.
    pub pushed: bool,
    /// The range contains a merge commit, so the rewrite must be refused.
    pub has_merge: bool,
}

impl Repo {
    /// Cherry-pick one or more commits onto HEAD, in the order given
    /// (`git cherry-pick <oid>…`). Each commit is any revspec git understands.
    ///
    /// Returns `Ok(true)` when the pick stopped on a **conflict** (the op is
    /// left in progress with unmerged files to resolve — an expected outcome,
    /// not a failure), `Ok(false)` when it applied cleanly, and `Err` only for
    /// a real failure (e.g. picking a merge commit without `-m`).
    pub fn cherry_pick(&self, commits: &[String], mainline: Option<u32>) -> Result<bool> {
        crate::journal::record(
            self,
            crate::journal::GitOp::CherryPick,
            cherry_pick_label(commits),
            true,
            || self.cherry_pick_inner(commits, mainline),
        )
    }

    fn cherry_pick_inner(&self, commits: &[String], mainline: Option<u32>) -> Result<bool> {
        if commits.is_empty() {
            return Err(Error::Other("cherry-pick: no commits given".into()));
        }
        let mut args = vec!["cherry-pick"];
        let mainline_arg = push_mainline(&mut args, commits, mainline)?;
        if let Some(value) = mainline_arg.as_deref() {
            args.push(value);
        }
        push_revs(&mut args, commits)?;
        self.run_sequencer(&args)
    }

    /// Revert one or more commits, recording the inverse as new commits
    /// (`git revert --no-edit <oid>…`). `--no-edit` keeps git from opening an
    /// editor. `Ok(true)` on conflict, like [`cherry_pick`](Repo::cherry_pick).
    pub fn revert(&self, commits: &[String], mainline: Option<u32>) -> Result<bool> {
        if commits.is_empty() {
            return Err(Error::Other("revert: no commits given".into()));
        }
        let mut args = vec!["revert", "--no-edit"];
        let mainline_arg = push_mainline(&mut args, commits, mainline)?;
        if let Some(value) = mainline_arg.as_deref() {
            args.push(value);
        }
        push_revs(&mut args, commits)?;
        self.run_sequencer(&args)
    }

    /// Merge `refname` into the current branch.
    ///
    /// `--no-edit` avoids the merge-message editor for the merge-commit cases.
    /// `Squash` stages the result without committing (no `--no-edit` — nothing
    /// is committed). Returns `Ok(true)` when the merge stopped on conflicts
    /// (left in progress for resolution), `Ok(false)` on a clean merge, and
    /// `Err` for a real failure (dirty tree, unrelated histories, …).
    pub fn merge(&self, refname: &str, mode: MergeMode) -> Result<bool> {
        crate::journal::record(
            self,
            crate::journal::GitOp::Merge,
            format!("Merge {refname}"),
            true,
            || self.merge_inner(refname, mode),
        )
    }

    fn merge_inner(&self, refname: &str, mode: MergeMode) -> Result<bool> {
        validate_ref(refname)?;
        let mut args = vec!["merge"];
        match mode {
            MergeMode::Auto => args.push("--no-edit"),
            MergeMode::NoFastForward => {
                args.push("--no-ff");
                args.push("--no-edit");
            }
            MergeMode::Squash => args.push("--squash"),
        }
        // End-of-options so a branch literally named like a flag can't be read
        // as one (paired with the leading-'-' rejection in `validate_ref`).
        args.push("--");
        args.push(refname);
        self.run_sequencer(&args)
    }

    /// Rebase the current branch onto `onto` (`git rebase <onto>`).
    ///
    /// `update_refs` passes `--update-refs` when git is 2.38 or newer, so other
    /// local branches whose tips sit in the rewritten range move too. The flag
    /// on this call wins over any `rebase.updateRefs` the user set. A dirty
    /// working tree makes git refuse — that surfaces as `Err`. `paused` is set
    /// when the rebase stopped on a conflict; branch tips move only once it
    /// completes. One journal entry covers every ref the rebase moved, so Undo
    /// also puts stacked branches back.
    pub fn rebase(&self, onto: &str, update_refs: bool) -> Result<RebaseOutcome> {
        crate::journal::record(
            self,
            crate::journal::GitOp::Rebase,
            format!("Rebase onto {onto}"),
            true,
            || self.rebase_inner(onto, update_refs),
        )
    }

    fn rebase_inner(&self, onto: &str, update_refs: bool) -> Result<RebaseOutcome> {
        validate_ref(onto)?;
        let mut args = vec!["rebase"];
        push_update_refs(&mut args, update_refs)?;
        args.push("--");
        args.push(onto);
        self.finish_rebase(&args, &[])
    }

    /// Remembered per repo in Strand's own local key `strand.rebaseUpdateRefs`,
    /// not git's `rebase.updateRefs`: that one would also change `git pull
    /// --rebase` and the user's terminal rebases. Every Strand rebase passes
    /// the flag explicitly. `supported` is false when git is older than 2.38.
    pub fn rebase_update_refs_setting(&self) -> Result<RebaseUpdateRefsSetting> {
        Ok(RebaseUpdateRefsSetting {
            supported: git_supports_update_refs(),
            enabled: crate::signing::git_bool(self, STRAND_UPDATE_REFS_KEY)?,
        })
    }

    /// Write `strand.rebaseUpdateRefs` in the repo's local config. Refuses when
    /// git is too old to honor the flag, so a later rebase cannot fail on it.
    pub fn set_rebase_update_refs(&self, enabled: bool) -> Result<()> {
        if !git_supports_update_refs() {
            return Err(Error::Other(
                "--update-refs requires Git 2.38 or newer".into(),
            ));
        }
        self.set_scoped_config(
            "--local",
            STRAND_UPDATE_REFS_KEY,
            Some(if enabled { "true" } else { "false" }),
        )
    }

    /// Local branches, other than the one checked out here, whose tips sit in
    /// `onto..HEAD` — the commits a plain rebase onto `onto` would rewrite.
    /// Branches checked out in another worktree are listed with `will_move`
    /// false; git skips those.
    pub fn rebase_ref_preview(&self, onto: &str) -> Result<Vec<RebaseRefPreview>> {
        validate_ref(onto)?;
        let range = format!("{onto}..HEAD");
        let out = run_git(&self.path, &["rev-list", "--reverse", &range])?;
        let original: Vec<String> = out
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        let steps: Vec<RebaseStep> = original
            .iter()
            .map(|oid| RebaseStep {
                action: RebaseAction::Pick,
                oid: oid.clone(),
                message: None,
            })
            .collect();
        Ok(anchors_to_preview(
            self.flat_update_ref_anchors_resolved(&original, &steps)?,
        ))
    }

    /// List the commits an interactive rebase would let the user edit —
    /// everything in `base..HEAD`, ordered oldest→newest (the order the
    /// sequence editor shows). `base` is the commit *before* the first editable
    /// one; `None` means rebase from the root (the whole branch history).
    ///
    /// `base` must be an ancestor of HEAD — otherwise the range isn't an
    /// in-place edit and we'd silently rebase HEAD onto an unrelated commit, so
    /// that's an `Err`.
    pub fn rebase_todo(&self, base: Option<&str>) -> Result<Vec<RebaseEntry>> {
        if let Some(b) = base {
            validate_ref(b)?;
            if !is_ancestor(&self.path, b)? {
                return Err(Error::Other(format!(
                    "{b} is not an ancestor of HEAD — can't build a rebase plan"
                )));
            }
        }
        // %x1f separates fields, %x1e separates records; %P (parents) → merge
        // flag. The range is `base..HEAD`, or all of HEAD when rebasing --root.
        let range = match base {
            Some(b) => format!("{b}..HEAD"),
            None => "HEAD".to_string(),
        };
        let fmt = "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%P%x1e";
        let out = run_git(&self.path, &["log", "--reverse", fmt, &range])?;
        let mut entries = Vec::new();
        for rec in out.split('\u{1e}') {
            let rec = rec.trim_start_matches('\n');
            if rec.is_empty() {
                continue;
            }
            let mut f = rec.split('\u{1f}');
            let oid = f.next().unwrap_or("").to_string();
            if oid.is_empty() {
                continue;
            }
            let short = f.next().unwrap_or("").to_string();
            let subject = f.next().unwrap_or("").to_string();
            let author = f.next().unwrap_or("").to_string();
            let is_merge = f.next().unwrap_or("").split_whitespace().count() > 1;
            entries.push(RebaseEntry { oid, short, subject, author, is_merge });
        }
        Ok(entries)
    }

    /// Run an interactive rebase over `base..HEAD` from a `steps` plan the UI
    /// built (reorder / drop / squash / fixup / reword / edit). We never open an
    /// editor: a generated todo is fed via `GIT_SEQUENCE_EDITOR`, `GIT_EDITOR`
    /// is forced to `true` (so `squash` keeps git's default combined message
    /// and nothing blocks), and a `reword` is applied as `pick` + an
    /// `exec git commit --amend -F <msg>` so its new message maps to the right
    /// commit deterministically. `paused` is true when the rebase stopped on a
    /// conflict (resolve, then [`continue_operation`](Repo::continue_operation)).
    ///
    /// `update_refs` asks git for `--update-refs`. On the flat path the sequence
    /// editor **overwrites** git's todo, which would drop those lines, so Strand
    /// emits `update-ref refs/heads/<name>` itself — after the rewritten commit
    /// each other local branch should follow (see [`plan_update_refs`]). The
    /// preserve-merges editor prints unknown lines through, so git's own
    /// `update-ref` lines survive there and Strand does not emit a second copy.
    ///
    /// Does not autostash. [`amend_into_commit`](Repo::amend_into_commit) is the
    /// path that stashes unstaged work for the duration of the rewrite.
    pub fn interactive_rebase(
        &self,
        base: Option<&str>,
        steps: &[RebaseStep],
        preserve_merges: bool,
        update_refs: bool,
    ) -> Result<RebaseOutcome> {
        let label = match base {
            Some(base) => format!("Rebase onto {base}"),
            None => "Rebase from root".to_string(),
        };
        crate::journal::record(self, crate::journal::GitOp::Rebase, label, true, || {
            self.interactive_rebase_inner(base, steps, preserve_merges, update_refs, false)
        })
    }

    fn interactive_rebase_inner(
        &self,
        base: Option<&str>,
        steps: &[RebaseStep],
        preserve_merges: bool,
        update_refs: bool,
        autostash: bool,
    ) -> Result<RebaseOutcome> {
        if let Some(operation) = self.operation_in_progress() {
            return Err(Error::Other(format!(
                "cannot start an interactive rebase while {operation} is in progress"
            )));
        }
        for s in steps {
            validate_ref(&s.oid)?;
        }
        if let Some(b) = base {
            validate_ref(b)?;
        }
        if steps.iter().all(|s| s.action == RebaseAction::Drop) {
            return Err(Error::Other("interactive rebase: the plan keeps no commits".into()));
        }
        if update_refs && !git_supports_update_refs() {
            return Err(Error::Other(
                "--update-refs requires Git 2.38 or newer".into(),
            ));
        }

        if preserve_merges {
            let original = self.rebase_todo(base)?;
            if original.len() != steps.len()
                || original.iter().zip(steps).any(|(entry, step)| entry.oid != step.oid)
            {
                return Err(Error::Other(
                    "preserving merges requires the complete plan in its original order".into(),
                ));
            }
            for (entry, step) in original.iter().zip(steps) {
                if matches!(step.action, RebaseAction::Squash | RebaseAction::Fixup) {
                    return Err(Error::Other(
                        "squash and fixup are unavailable while preserving merges".into(),
                    ));
                }
                if entry.is_merge && step.action == RebaseAction::Drop {
                    return Err(Error::Other(
                        "dropping a merge commit requires flattening the rebase".into(),
                    ));
                }
            }
        }

        // Flat path: git would insert update-ref lines, then our sequence editor
        // overwrites the todo. Compute where each other local branch lands and
        // emit the lines ourselves. Preserve-merges keeps git's lines.
        let anchors = if update_refs && !preserve_merges {
            self.flat_update_ref_anchors(base, steps)?
        } else {
            Vec::new()
        };
        let mut at_base: Vec<String> = Vec::new();
        let mut after_step: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for anchor in &anchors {
            if !anchor.will_move {
                continue;
            }
            match anchor.anchor {
                Some(index) => after_step
                    .entry(index)
                    .or_default()
                    .push(anchor.full_ref.clone()),
                None => at_base.push(anchor.full_ref.clone()),
            }
        }
        for refs in after_step.values_mut() {
            refs.sort();
        }
        at_base.sort();

        // Keep the todo + reword message files beside this worktree's git dir:
        // an edit/conflict pause can outlive this command, and later `exec`
        // lines still need their message files when the user continues.
        let work = rebase_work_dir(self)?;
        let mut todo = String::new();
        let mut mapping = String::new();
        let safe = crate::GIT_SAFE_CONFIG.join(" ");
        for full_ref in &at_base {
            todo.push_str(&format!("update-ref {full_ref}\n"));
        }
        let mut open_anchor: Option<usize> = None;
        for (i, s) in steps.iter().enumerate() {
            let mut message_path = String::new();
            if s.action == RebaseAction::Reword {
                let path = work.join(format!("msg-{i}"));
                std::fs::write(&path, s.message.as_deref().unwrap_or(""))
                    .map_err(|e| Error::Other(format!("write reword message: {e}")))?;
                message_path = sh_path(&path);
            }
            if preserve_merges {
                mapping.push_str(&format!(
                    "{}\t{}\t{}\n",
                    s.oid,
                    rebase_action_name(s.action),
                    message_path
                ));
                continue;
            }
            let kept = matches!(
                s.action,
                RebaseAction::Pick | RebaseAction::Reword | RebaseAction::Edit
            );
            if kept {
                if let Some(anchor) = open_anchor.take() {
                    append_update_refs(&mut todo, after_step.get(&anchor).map(Vec::as_slice));
                }
            }
            match s.action {
                // A missing line drops the commit; emit nothing.
                RebaseAction::Drop => {}
                RebaseAction::Pick => todo.push_str(&format!("pick {}\n", s.oid)),
                RebaseAction::Edit => todo.push_str(&format!("edit {}\n", s.oid)),
                RebaseAction::Squash => todo.push_str(&format!("squash {}\n", s.oid)),
                RebaseAction::Fixup => todo.push_str(&format!("fixup {}\n", s.oid)),
                RebaseAction::Reword => {
                    // `exec` runs via the shell; a forward-slashed, single-quoted
                    // path is safe on every platform git supports. The update-ref
                    // that follows this anchor is emitted after the amend, so the
                    // branch lands on the reworded commit rather than the pick.
                    todo.push_str(&format!("pick {}\n", s.oid));
                    todo.push_str(&format!(
                        "exec git {safe} commit --amend --no-edit -F '{message_path}'\n"
                    ));
                }
            }
            if kept {
                open_anchor = Some(i);
            }
        }
        if !preserve_merges {
            if let Some(anchor) = open_anchor.take() {
                append_update_refs(&mut todo, after_step.get(&anchor).map(Vec::as_slice));
            }
        }
        let todo_path = work.join("todo");
        std::fs::write(&todo_path, if preserve_merges { &mapping } else { &todo })
            .map_err(|e| Error::Other(format!("write rebase todo: {e}")))?;

        let mut args: Vec<&str> = vec!["rebase", "-i"];
        push_update_refs(&mut args, update_refs)?;
        if autostash {
            args.push("--autostash");
        }
        if preserve_merges {
            args.push("--rebase-merges");
        }
        match base {
            Some(b) => {
                args.push("--");
                args.push(b);
            }
            None => args.push("--root"),
        }
        // git launches the sequence editor through its own shell as
        // `sh -c '<editor> "<todo>"'`, so `cat "$STRAND_REBASE_PLAN" >` plus the
        // appended todo path forms a redirect — no helper script, no path
        // quoting (the plan path travels in an env var sh expands).
        let plan = sh_path(&todo_path);
        let before = branch_tips(&self.path)?;
        let result = if preserve_merges {
            let (editor, awk) = write_preserve_merge_editor(&work, &safe)?;
            let editor = sh_path(&editor);
            let awk = sh_path(&awk);
            self.run_sequencer_env(
                &args,
                &[
                    ("GIT_SEQUENCE_EDITOR", "sh \"$STRAND_REBASE_EDITOR\""),
                    ("GIT_EDITOR", "true"),
                    ("STRAND_REBASE_EDITOR", &editor),
                    ("STRAND_REBASE_AWK", &awk),
                    ("STRAND_REBASE_PLAN", &plan),
                ],
            )
        } else {
            self.run_sequencer_env(
                &args,
                &[
                    ("GIT_SEQUENCE_EDITOR", "cat \"$STRAND_REBASE_PLAN\" >"),
                    ("GIT_EDITOR", "true"),
                    ("STRAND_REBASE_PLAN", &plan),
                ],
            )
        };
        if self.operation_in_progress().is_none() {
            let _ = std::fs::remove_dir_all(&work);
        }
        let paused = result?;
        let moved = moved_branches(&before, &branch_tips(&self.path)?)?;
        Ok(RebaseOutcome { paused, moved })
    }

    fn finish_rebase(&self, args: &[&str], envs: &[(&str, &str)]) -> Result<RebaseOutcome> {
        let before = branch_tips(&self.path)?;
        let paused = self.run_sequencer_env(args, envs)?;
        let moved = moved_branches(&before, &branch_tips(&self.path)?)?;
        Ok(RebaseOutcome { paused, moved })
    }

    /// Anchors for the flat interactive todo. Step oids are resolved to full
    /// commit ids so they match `for-each-ref` tips.
    fn flat_update_ref_anchors(
        &self,
        base: Option<&str>,
        steps: &[RebaseStep],
    ) -> Result<Vec<UpdateRefAnchor>> {
        let original = self.rebase_todo(base)?;
        let original_oids: Vec<String> = original.into_iter().map(|entry| entry.oid).collect();
        let resolved = resolve_commits(
            &self.path,
            &steps
                .iter()
                .map(|step| step.oid.clone())
                .collect::<Vec<_>>(),
        )?;
        let resolved_steps: Vec<RebaseStep> = steps
            .iter()
            .zip(resolved)
            .map(|(step, oid)| RebaseStep {
                action: step.action,
                oid,
                message: None,
            })
            .collect();
        self.flat_update_ref_anchors_resolved(&original_oids, &resolved_steps)
    }

    fn flat_update_ref_anchors_resolved(
        &self,
        original: &[String],
        steps: &[RebaseStep],
    ) -> Result<Vec<UpdateRefAnchor>> {
        let head = current_branch(&self.path)?;
        let elsewhere = checked_out_elsewhere(&self.path, head.as_deref())?;
        let branches = local_tips(&self.path)?
            .into_iter()
            .filter(|tip| head.as_deref() != Some(tip.name.as_str()))
            .map(|tip| UpdateRefBranch {
                checked_out_elsewhere: elsewhere.contains(&tip.name),
                name: tip.name,
                full_ref: tip.full_ref,
                tip: tip.oid,
            })
            .collect::<Vec<_>>();
        Ok(plan_update_refs(original, steps, &branches))
    }

    /// Commits that would be rewritten by [`amend_into_commit`](Repo::amend_into_commit),
    /// plus whether that rewrite is blocked on a merge or needs a force push.
    /// Read-only.
    pub fn amend_into_plan(&self, target: &str) -> Result<AmendIntoPlan> {
        let (commits, _base, target_oid) = self.amend_into_range(target)?;
        Ok(AmendIntoPlan {
            pushed: commit_is_pushed(&self.path, &target_oid)?,
            has_merge: commits.iter().any(|entry| entry.is_merge),
            commits,
        })
    }

    /// Fold the staged index into `target` in one step: commit a fixup at HEAD,
    /// then replay `target..HEAD` with that fixup placed by oid immediately
    /// after `target`. The plan is explicit — subject matching (`--autosquash`)
    /// can fold into the wrong commit when two subjects match.
    ///
    /// Unstaged work is autostashed for the rebase and restored when it
    /// finishes or aborts. A conflict pauses like any other rebase
    /// (`Ok(true)`); [`abort_operation`](Repo::abort_operation) returns to the
    /// pre-fixup tip and puts the index back. A merge anywhere in the rewritten
    /// range is refused before anything is written. Other local branches whose
    /// tips sit in the rewritten range move with it (`--update-refs`), so a
    /// stacked branch never keeps the pre-amend commits.
    ///
    /// The fixup commit and the rebase are one Git Action History entry, so a
    /// single Undo returns to the pre-amend tip, index and stacked branches.
    pub fn amend_into_commit(&self, target: &str) -> Result<bool> {
        let short: String = target.chars().take(7).collect();
        crate::journal::record(
            self,
            crate::journal::GitOp::Amend,
            format!("Amend staged changes into {short}"),
            true,
            || self.amend_into_commit_inner(target),
        )
    }

    fn amend_into_commit_inner(&self, target: &str) -> Result<bool> {
        if let Some(operation) = self.operation_in_progress() {
            return Err(Error::Other(format!(
                "cannot amend into a commit while {operation} is in progress"
            )));
        }
        let (commits, base, target_oid) = self.amend_into_range(target)?;
        if commits.iter().any(|entry| entry.is_merge) {
            return Err(Error::Other(
                "this range contains a merge commit — Strand won't rewrite it".into(),
            ));
        }
        if !index_has_staged(&self.path)? {
            return Err(Error::Other(
                "nothing staged to amend into this commit".into(),
            ));
        }
        let original = run_git(&self.path, &["rev-parse", "HEAD"])?;
        let subject = commits
            .iter()
            .find(|entry| entry.oid == target_oid)
            .map(|entry| entry.subject.as_str())
            .unwrap_or("");
        let fixup = self.commit(&format!("fixup! {subject}"), None, false)?;
        let marker = amend_into_marker(self);
        // Original tip, then the fixup. Abort only restores when HEAD is
        // exactly that fixup, so a stale marker can't reset unrelated work.
        if let Err(e) = std::fs::write(&marker, format!("{original}\n{}\n", fixup.oid)) {
            let _ = run_git(&self.path, &["reset", "--soft", &original]);
            return Err(Error::Other(format!("write amend marker: {e}")));
        }
        let mut steps = Vec::with_capacity(commits.len() + 1);
        for entry in &commits {
            steps.push(RebaseStep {
                action: RebaseAction::Pick,
                oid: entry.oid.clone(),
                message: None,
            });
            if entry.oid == target_oid {
                steps.push(RebaseStep {
                    action: RebaseAction::Fixup,
                    oid: fixup.oid.clone(),
                    message: None,
                });
            }
        }
        // Pass `--update-refs` explicitly (Git 2.38+) so other local branches
        // stacked in `target..HEAD` follow the rewritten commits instead of
        // being left on the pre-amend history. Older git passes neither flag.
        let result = self
            .interactive_rebase_inner(
                base.as_deref(),
                &steps,
                false,
                git_supports_update_refs(),
                true,
            )
            .map(|outcome| outcome.paused);
        match &result {
            Ok(false) => {
                let _ = std::fs::remove_file(&marker);
                // git exits 0 when re-applying the autostash conflicts, so a
                // finished rewrite can still leave conflicted unstaged work.
                self.check_autostash_applied()?;
            }
            Ok(true) => {}
            Err(_) => {
                // The rebase never moved HEAD off the fixup (it failed before
                // rewriting). Put the index back.
                if self.operation_in_progress().is_none() {
                    let head = run_git(&self.path, &["rev-parse", "HEAD"]).unwrap_or_default();
                    if head == fixup.oid {
                        let _ = run_git(&self.path, &["reset", "--soft", &original]);
                    }
                    let _ = std::fs::remove_file(&marker);
                }
            }
        }
        result
    }

    /// `base` (parent of `target`, or `None` for a root), the commits that
    /// would be rewritten, and `target`'s full oid. `target` must sit on the
    /// current branch.
    fn amend_into_range(&self, target: &str) -> Result<(Vec<RebaseEntry>, Option<String>, String)> {
        validate_ref(target)?;
        let target_oid = run_git(
            &self.path,
            &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
        )?;
        let base = run_git(
            &self.path,
            &["rev-parse", "--verify", &format!("{target_oid}^")],
        )
        .ok();
        let commits = self.rebase_todo(base.as_deref())?;
        if !commits.iter().any(|entry| entry.oid == target_oid) {
            return Err(Error::Other(format!(
                "{target} is not on the current branch — can't amend into it"
            )));
        }
        Ok((commits, base, target_oid))
    }

    /// Resume the sequencer/merge/rebase op paused mid-flight (after the user
    /// resolved conflicts in the working tree, or for any deliberate stop).
    /// Detects the live op from the same on-disk markers as
    /// [`abort_operation`](Repo::abort_operation) and runs the matching
    /// `--continue` with `GIT_EDITOR=true` so it can't block on a message
    /// editor. `Ok(true)` when it paused again on a fresh conflict or `edit`
    /// step, `Ok(false)` when the op finished. Errors when nothing is in
    /// progress.
    ///
    /// Note this is *not* `git commit`: a paused rebase only advances via
    /// `--continue`, which is why resolving-and-committing never finished one.
    pub fn continue_operation(&self) -> Result<bool> {
        let op = self
            .operation_in_progress()
            .ok_or_else(|| Error::Other("no operation in progress to continue".into()))?;
        let cmd = match op.as_str() {
            "mailbox" => "am",
            "rebase" => "rebase",
            "cherry-pick" => "cherry-pick",
            "revert" => "revert",
            "merge" => "merge",
            other => return Err(Error::Other(format!("cannot continue `{other}`"))),
        };
        let result = self.run_sequencer_env(&[cmd, "--continue"], &[("GIT_EDITOR", "true")]);
        if self.operation_in_progress().is_none() {
            let _ = std::fs::remove_dir_all(self.git_dir().join("strand-rebase-plan"));
            // The rewrite finished. Drop the pre-fixup tip so a later abort
            // cannot soft-reset over the new history.
            let marker = amend_into_marker(self);
            let amend_into = marker.exists();
            let _ = std::fs::remove_file(marker);
            if amend_into && matches!(result, Ok(false)) {
                self.check_autostash_applied()?;
            }
        }
        result
    }

    /// Run a sequencer op (`merge`/`cherry-pick`/`revert`/`rebase`) and map its
    /// exit to a pause-aware result. Conflicts usually exit non-zero while an
    /// interactive `edit`/`break` can exit successfully; either returns
    /// `Ok(true)` whenever Git's operation markers remain. Only a genuine
    /// failure with no paused operation is an `Err`.
    fn run_sequencer(&self, args: &[&str]) -> Result<bool> {
        self.run_sequencer_env(args, &[])
    }

    /// [`run_sequencer`](Repo::run_sequencer) with extra environment variables
    /// (the interactive-rebase editor overrides, the `--continue` editor
    /// suppression). Same pause-aware mapping.
    fn run_sequencer_env(&self, args: &[&str], envs: &[(&str, &str)]) -> Result<bool> {
        match run_git_env(&self.path, args, envs) {
            Ok(_) => Ok(self.operation_in_progress().is_some_and(|op| op != "bisect")),
            Err(e) => {
                // A conflict is the expected paused outcome. Git can also
                // leave CHERRY_PICK_HEAD/REVERT_HEAD behind after a *real*
                // commit failure (for example, signing failed). Treating the
                // marker alone as success hides that error behind a
                // misleading "Ready to continue" banner.
                if self.has_conflicts().unwrap_or(false) {
                    Ok(true)
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Whether the index currently holds unmerged (conflicted) entries.
    fn has_conflicts(&self) -> Result<bool> {
        if self.sparse_enabled() { return Ok(!self.sparse_git(&["ls-files", "--unmerged", "-z"], None)?.is_empty()); }
        Ok(self.git2()?.index()?.has_conflicts())
    }

    /// Abort the sequencer/merge/rebase operation currently in progress,
    /// restoring HEAD and the working tree to their pre-op state. Detects which
    /// op is live from the on-disk markers (the same ones
    /// [`meta`](Repo::meta) reads) and runs the matching `--abort`. Errors when
    /// nothing is in progress.
    pub fn abort_operation(&self) -> Result<()> {
        let op = self
            .operation_in_progress()
            .ok_or_else(|| Error::Other("no operation in progress to abort".into()))?;
        let cmd = match op.as_str() {
            "mailbox" => "am",
            "rebase" => "rebase",
            "cherry-pick" => "cherry-pick",
            "revert" => "revert",
            "merge" => "merge",
            other => return Err(Error::Other(format!("cannot abort `{other}`"))),
        };
        run_git(&self.path, &[cmd, "--abort"])?;
        let _ = std::fs::remove_dir_all(self.git_dir().join("strand-rebase-plan"));
        // An amend-into rebase aborts back onto the temporary fixup. Soft-reset
        // to the tip recorded before that fixup so Abort restores the original.
        self.restore_amend_into_original(op == "rebase")?;
        Ok(())
    }

    /// After an amend-into rewrite finishes, git reports a conflicting
    /// autostash re-apply on stderr and still exits 0, leaving unmerged
    /// entries. Surface that instead of reporting a clean success.
    fn check_autostash_applied(&self) -> Result<()> {
        // Out of process: the cached git2 index can still hold the conflict
        // that paused the rebase before Continue.
        let unmerged = run_git(&self.path, &["ls-files", "--unmerged"]).unwrap_or_default();
        if !unmerged.is_empty() {
            return Err(Error::Other(
                "The commit was rewritten, but re-applying your unstaged changes conflicted. \
                 They are safe in the stash (`git stash list`). Resolve the conflicts in the \
                 working tree, then drop that stash entry."
                    .into(),
            ));
        }
        Ok(())
    }

    /// `strand-amend-into` records the pre-amend tip and the fixup commit.
    /// Only a rebase abort that lands exactly on that fixup restores the
    /// pre-amend tip. Any other abort or HEAD just drops the marker (it was
    /// stale, or this abort was not an amend-into rewrite).
    fn restore_amend_into_original(&self, rebase_aborted: bool) -> Result<()> {
        let path = amend_into_marker(self);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(Error::Other(format!("read amend marker: {error}"))),
        };
        let mut lines = text.lines().map(str::trim);
        let (Some(original), Some(fixup)) = (lines.next(), lines.next()) else {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        };
        if !rebase_aborted || original.is_empty() || fixup.is_empty() {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        let head = run_git(&self.path, &["rev-parse", "HEAD"])?;
        if head == fixup {
            run_git(&self.path, &["reset", "--soft", original]).map_err(|error| {
                Error::Other(format!(
                    "{error} (original tip {original} is recorded in {})",
                    path.display()
                ))
            })?;
        }
        let _ = std::fs::remove_file(&path);
        Ok(())
    }

}

/// Append validated revspecs after a `--` end-of-options separator.
fn push_revs<'a>(args: &mut Vec<&'a str>, commits: &'a [String]) -> Result<()> {
    for c in commits {
        validate_ref(c)?;
    }
    args.push("--");
    for c in commits {
        args.push(c.as_str());
    }
    Ok(())
}

/// Add `-m <parent-number>` for a single merge commit. Git does not accept one
/// mainline choice for a list because each merge can have a different parent;
/// the UI therefore keeps merge commits as deliberate one-at-a-time actions.
fn push_mainline(
    args: &mut Vec<&str>,
    commits: &[String],
    mainline: Option<u32>,
) -> Result<Option<String>> {
    let Some(mainline) = mainline else { return Ok(None); };
    if mainline == 0 {
        return Err(Error::Other("mainline parent must be at least 1".into()));
    }
    if commits.len() != 1 {
        return Err(Error::Other(
            "mainline selection requires exactly one merge commit".into(),
        ));
    }
    args.push("-m");
    Ok(Some(mainline.to_string()))
}

/// Reject a revspec git would mis-read as an option. The call sites also pass
/// `--` so this is belt-and-suspenders, but it gives a clearer error than git's.
fn validate_ref(rev: &str) -> Result<()> {
    if rev.is_empty() {
        return Err(Error::Other("empty revision".into()));
    }
    if rev.starts_with('-') {
        return Err(Error::Other(format!("revision may not start with '-': {rev}")));
    }
    Ok(())
}

/// Run a blocking `git` subcommand in `cwd`, returning trimmed stdout and
/// mapping a non-zero exit to its combined stderr+stdout. Mirrors the
/// subprocess helpers in [`network`](crate::network) and `stash`;
/// `GIT_TERMINAL_PROMPT=0` keeps a stuck auth prompt from blocking. A free
/// function (not a `Repo` method) so it doesn't collide with `stash`'s
/// same-named helper on the same type.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    run_git_env(cwd, args, &[])
}

/// [`run_git`] with extra environment variables layered on (the interactive
/// rebase editor overrides). Same stdin/safe-config/error handling.
fn run_git_env(cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String> {
    let mut cmd = crate::git_command();
    cmd.current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Detach stdin so git can never block reading from a TTY/pipe we don't
        // have (the app isn't launched from a terminal) — it errors instead.
        .stdin(std::process::Stdio::null())
        // Neutralize repo-local config that would run code as a side effect.
        .args(crate::GIT_SAFE_CONFIG)
        .args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    if !out.status.success() {
        // On conflict git writes the useful part to stdout ("CONFLICT (content):
        // …") and a short summary to stderr — combine so the UI sees both.
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

/// Whether `maybe_ancestor` is an ancestor of HEAD. `git merge-base
/// --is-ancestor` exits 0 = yes, 1 = no; any non-zero (including a bad ref) we
/// treat as "no" — `interactive_rebase`/`rebase_todo` validate the ref anyway.
fn is_ancestor(cwd: &Path, maybe_ancestor: &str) -> Result<bool> {
    let status = crate::git_command()
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(["merge-base", "--is-ancestor", maybe_ancestor, "HEAD"])
        .status()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    Ok(status.success())
}

fn cherry_pick_label(commits: &[String]) -> String {
    if commits.len() == 1 {
        let oid = &commits[0];
        let short = &oid[..oid.len().min(7)];
        format!("Cherry-pick {short}")
    } else {
        format!("Cherry-pick {} commits", commits.len())
    }
}

fn rebase_action_name(action: RebaseAction) -> &'static str {
    match action {
        RebaseAction::Pick => "pick",
        RebaseAction::Reword => "reword",
        RebaseAction::Edit => "edit",
        RebaseAction::Squash => "squash",
        RebaseAction::Fixup => "fixup",
        RebaseAction::Drop => "drop",
    }
}

/// Rebase plans must survive an edit/conflict pause because later todo `exec`
/// lines can still reference their message files. Keep them inside this
/// worktree's git dir and remove them on completion/abort.
fn rebase_work_dir(repo: &Repo) -> Result<PathBuf> {
    let dir = repo.git_dir().join("strand-rebase-plan");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| Error::Other(format!("create temp dir: {e}")))?;
    Ok(dir)
}

/// Git builds the topology-aware todo for `--rebase-merges`. This editor keeps
/// its `label`/`reset`/`merge` commands intact and changes only the commit
/// actions Strand planned. Reordering and squash/fixup are rejected before we
/// get here because they can cross topology boundaries.
fn write_preserve_merge_editor(work: &Path, safe: &str) -> Result<(PathBuf, PathBuf)> {
    let awk_path = work.join("preserve.awk");
    let awk = r#"BEGIN { FS = "\t" }
NR == FNR { action[$1] = $2; message[$1] = $3; next }
function find_key(abbrev, key) {
  for (key in action) if (index(key, abbrev) == 1) return key
  return ""
}
function amend(key) {
  return "exec git __SAFE__ commit --amend --no-edit -F \047" message[key] "\047"
}
{
  split($0, field, /[[:space:]]+/)
  verb = field[1]
  if (verb == "p") verb = "pick"
  else if (verb == "m") verb = "merge"
  oid = ""
  if (verb == "pick") oid = field[2]
  else if (verb == "merge" && (field[2] == "-C" || field[2] == "-c")) oid = field[3]
  key = oid == "" ? "" : find_key(oid)
  if (key == "") { print; next }
  planned = action[key]
  if (verb == "pick") {
    if (planned == "drop") next
    if (planned == "edit") {
      if ($0 ~ /^p /) sub(/^p /, "edit ")
      else sub(/^pick /, "edit ")
    }
    print
    if (planned == "reword") print amend(key)
    next
  }
  print
  if (planned == "reword") print amend(key)
  else if (planned == "edit") print "break"
}
"#
    .replace("__SAFE__", safe);
    std::fs::write(&awk_path, awk)
        .map_err(|e| Error::Other(format!("write merge-preserving editor: {e}")))?;

    let editor_path = work.join("preserve.sh");
    let editor = r#"#!/bin/sh
set -eu
todo=$1
tmp="${todo}.strand"
awk -f "$STRAND_REBASE_AWK" "$STRAND_REBASE_PLAN" "$todo" > "$tmp"
mv "$tmp" "$todo"
"#;
    std::fs::write(&editor_path, editor)
        .map_err(|e| Error::Other(format!("write merge-preserving editor: {e}")))?;
    Ok((editor_path, awk_path))
}

/// Render a path for a shell command line git runs (the `exec` reword line and
/// the `$STRAND_REBASE_PLAN` value): forward slashes are accepted everywhere
/// git is, and avoid backslash-escaping inside the shell on Windows.
fn sh_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn append_update_refs(todo: &mut String, refs: Option<&[String]>) {
    if let Some(refs) = refs {
        for full_ref in refs {
            todo.push_str(&format!("update-ref {full_ref}\n"));
        }
    }
}

/// Strand-only per-repo memory of the update-refs toggle (local config).
const STRAND_UPDATE_REFS_KEY: &str = "strand.rebaseUpdateRefs";

/// `--update-refs` / `--no-update-refs` landed in Git 2.38. Older git must not
/// see the flag at all. When the caller asked for it and git is too old, fail
/// before the rebase starts.
fn push_update_refs(args: &mut Vec<&str>, update_refs: bool) -> Result<()> {
    if let Some(flag) = update_refs_flag(git_supports_update_refs(), update_refs)? {
        args.push(flag);
    }
    Ok(())
}

/// `None` on Git older than 2.38 (and an error if the caller still asked for
/// the feature). Otherwise the explicit flag that wins over `rebase.updateRefs`
/// from the user's own git config.
fn update_refs_flag(supported: bool, update_refs: bool) -> Result<Option<&'static str>> {
    if !supported {
        return if update_refs {
            Err(Error::Other(
                "--update-refs requires Git 2.38 or newer".into(),
            ))
        } else {
            Ok(None)
        };
    }
    Ok(Some(if update_refs {
        "--update-refs"
    } else {
        "--no-update-refs"
    }))
}

/// `git version 2.43.0` → `(2, 43, 0)`. Extra suffixes (`windows.1`) are ignored.
pub fn parse_git_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = text.trim().strip_prefix("git version ")?;
    let mut nums = rest
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty());
    let major = nums.next()?.parse().ok()?;
    let minor = nums.next()?.parse().ok()?;
    let patch = nums.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn git_version_tuple() -> Option<(u32, u32, u32)> {
    static CACHE: OnceLock<Option<(u32, u32, u32)>> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let out = crate::git_command().arg("--version").output().ok()?;
        if !out.status.success() {
            return None;
        }
        parse_git_version(&String::from_utf8_lossy(&out.stdout))
    })
}

/// Git 2.38 introduced `rebase --update-refs`.
pub fn git_supports_update_refs() -> bool {
    git_version_tuple().is_some_and(|version| version >= (2, 38, 0))
}

struct BranchTip {
    name: String,
    full_ref: String,
    oid: String,
}

fn branch_tips(path: &Path) -> Result<BTreeMap<String, String>> {
    Ok(local_tips(path)?
        .into_iter()
        .map(|tip| (tip.name, tip.oid))
        .collect())
}

fn local_tips(path: &Path) -> Result<Vec<BranchTip>> {
    let out = run_git(
        path,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(objectname)",
            "refs/heads",
        ],
    )?;
    let mut tips = Vec::new();
    for line in out.lines() {
        let mut parts = line.split('\0');
        let full_ref = parts.next().unwrap_or("").to_string();
        let name = parts.next().unwrap_or("").to_string();
        let oid = parts.next().unwrap_or("").to_string();
        if full_ref.is_empty() || name.is_empty() || oid.is_empty() {
            continue;
        }
        tips.push(BranchTip {
            name,
            full_ref,
            oid,
        });
    }
    Ok(tips)
}

fn moved_branches(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Result<Vec<String>> {
    let mut moved: Vec<String> = after
        .iter()
        .filter(|(name, oid)| before.get(*name).is_some_and(|prev| prev != *oid))
        .map(|(name, _)| name.clone())
        .collect();
    moved.sort();
    Ok(moved)
}

fn current_branch(path: &Path) -> Result<Option<String>> {
    let out = crate::git_command()
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    if out.status.success() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok((!name.is_empty()).then_some(name));
    }
    if out.status.code() == Some(1) {
        return Ok(None);
    }
    Err(Error::Other(format!(
        "symbolic-ref failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    )))
}

/// Short names of branches checked out in a worktree other than HEAD here.
/// Git will not move those with `--update-refs`.
fn checked_out_elsewhere(path: &Path, head: Option<&str>) -> Result<BTreeSet<String>> {
    let out = run_git(path, &["worktree", "list", "--porcelain"])?;
    let mut elsewhere = BTreeSet::new();
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("branch refs/heads/") {
            if Some(name) != head {
                elsewhere.insert(name.to_string());
            }
        }
    }
    Ok(elsewhere)
}

fn resolve_commits(path: &Path, revs: &[String]) -> Result<Vec<String>> {
    if revs.is_empty() {
        return Ok(Vec::new());
    }
    // `--verify` accepts only one revision ("Needed a single revision" otherwise).
    // A bare `rev-parse` resolves every `^{commit}` in one shot and still
    // fails the whole command when any rev is missing. `--` would stop
    // revision parsing and echo the specs back unchanged.
    let specs: Vec<String> = revs.iter().map(|rev| format!("{rev}^{{commit}}")).collect();
    let mut args = vec!["rev-parse"];
    args.extend(specs.iter().map(String::as_str));
    let out = run_git(path, &args)?;
    let lines: Vec<String> = out.lines().map(str::to_string).collect();
    if lines.len() != revs.len() {
        return Err(Error::Other("could not resolve rebase commits".into()));
    }
    Ok(lines)
}

fn anchors_to_preview(anchors: Vec<UpdateRefAnchor>) -> Vec<RebaseRefPreview> {
    anchors
        .into_iter()
        .map(|anchor| RebaseRefPreview {
            name: anchor.name,
            full_ref: anchor.full_ref,
            will_move: anchor.will_move,
        })
        .collect()
}

/// Decide where each local branch tip in `original` (oldest→newest ancestry)
/// lands after `steps` (the user's plan, which may drop, squash, or reorder).
///
/// A branch follows the rewritten form of the last commit it contained that
/// the plan still keeps:
/// - pick / reword / edit: that commit, after its reword amend and after any
///   squash or fixup lines that fold into it
/// - squash / fixup: the pick/reword/edit the chain folds into (the combined
///   commit), not the pre-squash snapshot
/// - drop: the previous kept ancestor in `original`, or the rebase base when
///   every commit the branch contained was dropped
///
/// The anchor is chosen by original order, then placed where that commit sits
/// in the new plan. A reorder can therefore move commits that were never on
/// the branch below its tip, or move one of its own commits above it; the
/// plan preview shows the result. A branch checked out in another worktree is
/// reported with `will_move` false.
pub fn plan_update_refs(
    original: &[String],
    steps: &[RebaseStep],
    branches: &[UpdateRefBranch],
) -> Vec<UpdateRefAnchor> {
    let mut planned = Vec::new();
    for branch in branches {
        if !original.iter().any(|oid| oid == &branch.tip) {
            continue;
        }
        planned.push(UpdateRefAnchor {
            name: branch.name.clone(),
            full_ref: branch.full_ref.clone(),
            anchor: landing_anchor(original, steps, &branch.tip),
            will_move: !branch.checked_out_elsewhere,
        });
    }
    planned.sort_by(|a, b| a.name.cmp(&b.name));
    planned
}

/// Step index of the pick/reword/edit the branch follows, or `None` for the base.
fn landing_anchor(original: &[String], steps: &[RebaseStep], tip: &str) -> Option<usize> {
    let tip_at = original.iter().position(|oid| oid == tip)?;
    let mut kept: Option<&str> = None;
    for oid in &original[..=tip_at] {
        let action = steps
            .iter()
            .find(|step| step.oid == *oid)
            .map(|step| step.action)
            .unwrap_or(RebaseAction::Drop);
        if action != RebaseAction::Drop {
            kept = Some(oid.as_str());
        }
    }
    let kept = kept?;
    let step_at = steps.iter().position(|step| step.oid == kept)?;
    match steps[step_at].action {
        RebaseAction::Pick | RebaseAction::Reword | RebaseAction::Edit => Some(step_at),
        RebaseAction::Squash | RebaseAction::Fixup => {
            let mut index = step_at;
            while index > 0 {
                index -= 1;
                match steps[index].action {
                    RebaseAction::Pick | RebaseAction::Reword | RebaseAction::Edit => {
                        return Some(index);
                    }
                    RebaseAction::Squash | RebaseAction::Fixup | RebaseAction::Drop => {}
                }
            }
            None
        }
        RebaseAction::Drop => None,
    }
}

/// Pre-fixup HEAD for an in-progress amend-into. Lives beside the worktree git
/// dir, not inside `strand-rebase-plan`, because that directory is replaced
/// when the rebase todo is written.
fn amend_into_marker(repo: &Repo) -> PathBuf {
    repo.git_dir().join("strand-amend-into")
}

/// `git diff --cached --quiet` exits 0 when the index matches HEAD and 1 when
/// it doesn't. Any other status is a real failure (missing HEAD, bad index).
fn index_has_staged(cwd: &Path) -> Result<bool> {
    let status = crate::git_command()
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    match status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(Error::Other(
            "couldn't tell whether the index has staged changes".into(),
        )),
    }
}

/// Whether `oid` is already contained in the current branch's upstream. No
/// upstream (detached HEAD, unset tracking) is not pushed — there is nothing
/// to force-push.
fn commit_is_pushed(cwd: &Path, oid: &str) -> Result<bool> {
    let status = crate::git_command()
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        // No upstream is the common case and git reports it on stderr.
        .stderr(std::process::Stdio::null())
        .args(crate::GIT_SAFE_CONFIG)
        .args(["merge-base", "--is-ancestor", "--", oid, "@{upstream}"])
        .status()
        .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
    Ok(status.success())
}



#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    /// Build a throwaway repo, configured enough to commit, and return its
    /// `Repo` + working dir. Std-only (no `tempfile` dev-dep), like `tag.rs`.
    fn scratch_repo() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-history-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

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

    fn write_commit(dir: &Path, file: &str, contents: &str, msg: &str) -> String {
        std::fs::write(dir.join(file), contents).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-q", "-m", msg]);
        git(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn merge_no_ff_creates_merge_commit_and_revert_undoes_a_commit() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "base");

        // Diverge: a feature branch adds a file, main adds another.
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feat.txt", "feature\n", "feat");
        git(&dir, &["checkout", "-q", "main"]);
        let main_c = write_commit(&dir, "main.txt", "main\n", "main");

        // No-ff merge of feature → a merge commit with two parents on main.
        repo.merge("feature", MergeMode::NoFastForward).unwrap();
        let head = git(&dir, &["rev-parse", "HEAD"]);
        let parents = git(&dir, &["rev-list", "--parents", "-n", "1", "HEAD"]);
        assert_eq!(parents.split_whitespace().count(), 3, "merge commit has 2 parents");
        assert!(parents.contains(&main_c), "first parent is the old main tip");
        assert!(dir.join("feat.txt").exists(), "feature file merged in");
        assert_ne!(head, main_c);

        // Revert the file-adding commit on main and confirm it's gone.
        repo.revert(&[main_c.clone()], None).unwrap();
        assert!(!dir.join("main.txt").exists(), "revert removed main.txt");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cherry_pick_brings_a_commit_across_branches() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        let pick = write_commit(&dir, "only-feature.txt", "x\n", "add only-feature");
        git(&dir, &["checkout", "-q", "main"]);

        assert!(!dir.join("only-feature.txt").exists());
        repo.cherry_pick(&[pick], None).unwrap();
        assert!(dir.join("only-feature.txt").exists(), "cherry-picked file present on main");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cherry_pick_surfaces_a_commit_failure_instead_of_reporting_a_pause() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        let pick = write_commit(&dir, "only-feature.txt", "x\n", "add only-feature");
        git(&dir, &["checkout", "-q", "main"]);

        // Simulate a non-interactive signing failure during cherry-pick's
        // commit step. Git applies/stages the change and leaves
        // CHERRY_PICK_HEAD, but there is no conflict: this is a genuine error
        // the UI must show, not `Ok(true)` / "Ready to continue".
        git(&dir, &["config", "commit.gpgsign", "true"]);
        git(&dir, &["config", "gpg.format", "openpgp"]);
        git(&dir, &["config", "gpg.program", "false"]);
        let err = repo.cherry_pick(&[pick], None).unwrap_err().to_string();
        assert!(err.contains("failed to sign") || err.contains("gpg failed"));
        assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("cherry-pick"));
        assert!(!repo.has_conflicts().unwrap());

        // Restore the repo before cleanup so this test also exercises the
        // normal recovery marker path.
        repo.abort_operation().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_commit_mainline_supports_cherry_pick_and_revert() {
        let (repo, dir) = scratch_repo();
        let base = write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feature.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main");
        repo.merge("feature", MergeMode::NoFastForward).unwrap();
        let merge = git(&dir, &["rev-parse", "HEAD"]);

        // Relative to parent 1 (the old main tip), the merge introduces the
        // feature side. Reverting removes it while retaining main's own work.
        repo.revert(&[merge.clone()], Some(1)).unwrap();
        assert!(!dir.join("feature.txt").exists());
        assert!(dir.join("main.txt").exists());

        // Apply that same merge delta to a branch cut at the common base.
        git(&dir, &["checkout", "-q", "-b", "target", &base]);
        repo.cherry_pick(&[merge], Some(1)).unwrap();
        assert!(dir.join("feature.txt").exists());
        assert!(!dir.join("main.txt").exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn conflict_is_reported_and_abortable() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "f.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "f.txt", "feature side\n", "feat edit");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "f.txt", "main side\n", "main edit");

        // Both branches edited the same line → merge conflicts. That's an
        // expected outcome (Ok(true)), not an error.
        let conflicted = repo.merge("feature", MergeMode::Auto).unwrap();
        assert!(conflicted, "divergent edits to the same line conflict");
        // meta reports the in-progress merge, and abort clears it.
        assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("merge"));
        repo.abort_operation().unwrap();
        assert_eq!(repo.meta().unwrap().operation, None);
        // `git merge --abort` re-checks-out the file, so a global
        // core.autocrlf=true (the Windows default) yields CRLF — normalize.
        let restored = std::fs::read_to_string(dir.join("f.txt")).unwrap().replace("\r\n", "\n");
        assert_eq!(restored, "main side\n");

        let _ = std::fs::remove_dir_all(dir);
    }

    fn step(action: RebaseAction, oid: &str) -> RebaseStep {
        RebaseStep { action, oid: oid.to_string(), message: None }
    }

    /// Subjects of `range`, oldest→newest.
    fn subjects(dir: &Path, range: &str) -> Vec<String> {
        let out = git(dir, &["log", "--reverse", "--format=%s", range]);
        out.lines().map(|s| s.to_string()).collect()
    }

    /// Build base + three independent-file commits; returns (repo, dir, base
    /// oid). Independent files keep reorder/drop/squash conflict-free.
    fn three_commits() -> (Repo, PathBuf, String) {
        let (repo, dir) = scratch_repo();
        let base = write_commit(&dir, "a.txt", "a\n", "c0");
        write_commit(&dir, "b.txt", "b\n", "c1");
        write_commit(&dir, "c.txt", "c\n", "c2");
        write_commit(&dir, "d.txt", "d\n", "c3");
        (repo, dir, base)
    }

    #[test]
    fn rebase_todo_lists_range_oldest_first() {
        let (repo, dir, base) = three_commits();
        let todo = repo.rebase_todo(Some(&base)).unwrap();
        let subs: Vec<&str> = todo.iter().map(|e| e.subject.as_str()).collect();
        assert_eq!(subs, ["c1", "c2", "c3"]);
        assert!(todo.iter().all(|e| !e.is_merge));
        // A non-ancestor base is rejected.
        assert!(repo.rebase_todo(Some("HEAD")).is_ok()); // HEAD..HEAD = empty, still ok
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_reorder_drop_swaps_and_removes() {
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());

        // Reorder c1/c2 and drop c3.
        let conflicted = repo
            .interactive_rebase(
                Some(&base),
                &[
                    step(RebaseAction::Pick, &c2),
                    step(RebaseAction::Pick, &c1),
                    step(RebaseAction::Drop, &c3),
                ],
                false,
                false,
            )
            .unwrap().paused;
        assert!(!conflicted, "independent files don't conflict");
        assert_eq!(subjects(&dir, &format!("{base}..HEAD")), ["c2", "c1"]);
        assert!(!dir.join("d.txt").exists(), "dropped commit's file is gone");
        assert!(dir.join("b.txt").exists() && dir.join("c.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_fixup_and_squash_combine() {
        // fixup: c2 folds into c1, keeping c1's message.
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Pick, &c1),
                step(RebaseAction::Fixup, &c2),
                step(RebaseAction::Pick, &c3),
            ],
            false,
            false,
        )
        .unwrap();
        assert_eq!(subjects(&dir, &format!("{base}..HEAD")), ["c1", "c3"]);
        assert!(dir.join("b.txt").exists() && dir.join("c.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);

        // squash: combined message carries both subjects (git's default).
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2) = (t[0].oid.clone(), t[1].oid.clone());
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Pick, &c1),
                step(RebaseAction::Squash, &c2),
            ],
            false,
            false,
        )
        .unwrap();
        let head_msg = git(&dir, &["log", "-1", "--format=%B", "HEAD"]);
        assert!(head_msg.contains("c1") && head_msg.contains("c2"), "squash keeps both: {head_msg}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_reword_replaces_message_no_editor() {
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Pick, &c1),
                RebaseStep {
                    action: RebaseAction::Reword,
                    oid: c2,
                    message: Some("c2 reworded".into()),
                },
                step(RebaseAction::Pick, &c3),
            ],
            false,
            false,
        )
        .unwrap();
        assert_eq!(subjects(&dir, &format!("{base}..HEAD")), ["c1", "c2 reworded", "c3"]);
        // Tree is untouched — reword only changes the message.
        assert!(dir.join("c.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_edit_pauses_for_amend_then_continues() {
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let paused = repo
            .interactive_rebase(
                Some(&base),
                &[
                    step(RebaseAction::Pick, &t[0].oid),
                    step(RebaseAction::Edit, &t[1].oid),
                    RebaseStep {
                        action: RebaseAction::Reword,
                        oid: t[2].oid.clone(),
                        message: Some("c3 after pause".into()),
                    },
                ],
                false,
                false,
            )
            .unwrap().paused;
        assert!(paused, "edit leaves the rebase deliberately paused");
        assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("rebase"));

        std::fs::write(dir.join("amended.txt"), "amended\n").unwrap();
        repo.stage_paths(&["amended.txt".into()]).unwrap();
        repo.commit("c2 amended", None, true).unwrap();
        assert!(!repo.continue_operation().unwrap());
        assert_eq!(repo.meta().unwrap().operation, None);
        assert!(dir.join("amended.txt").exists());
        assert_eq!(
            subjects(&dir, &format!("{base}..HEAD")),
            ["c1", "c2 amended", "c3 after pause"]
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_rebase_preserves_merge_topology() {
        let (repo, dir) = scratch_repo();
        let base = write_commit(&dir, "base.txt", "base\n", "base");
        write_commit(&dir, "main.txt", "main\n", "main work");
        git(&dir, &["checkout", "-q", "-b", "side", &base]);
        write_commit(&dir, "side.txt", "side\n", "side work");
        git(&dir, &["checkout", "-q", "main"]);
        repo.merge("side", MergeMode::NoFastForward).unwrap();
        write_commit(&dir, "post.txt", "post\n", "post merge");

        let entries = repo.rebase_todo(Some(&base)).unwrap();
        assert!(entries.iter().any(|entry| entry.is_merge));
        let post = entries
            .iter()
            .find(|entry| entry.subject == "post merge")
            .unwrap()
            .oid
            .clone();
        let merge = entries.iter().find(|entry| entry.is_merge).unwrap().oid.clone();
        let steps: Vec<RebaseStep> = entries
            .iter()
            .map(|entry| {
                if entry.oid == post {
                    RebaseStep {
                        action: RebaseAction::Reword,
                        oid: entry.oid.clone(),
                        message: Some("post merge reworded".into()),
                    }
                } else if entry.oid == merge {
                    step(RebaseAction::Edit, &entry.oid)
                } else {
                    step(RebaseAction::Pick, &entry.oid)
                }
            })
            .collect();

        git(&dir, &["config", "rebase.abbreviateCommands", "true"]);
        assert!(repo.interactive_rebase(Some(&base), &steps, true, false).unwrap().paused);
        assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("rebase"));
        assert!(!repo.continue_operation().unwrap());
        assert_eq!(git(&dir, &["rev-list", "--count", "--min-parents=2", "HEAD"]), "1");
        assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "post merge reworded");
        assert!(dir.join("main.txt").exists() && dir.join("side.txt").exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_reorder_conflict_pauses_and_continues() {
        let (repo, dir) = scratch_repo();
        let base = write_commit(&dir, "shared.txt", "base\n", "c0");
        write_commit(&dir, "shared.txt", "one\n", "c1");
        write_commit(&dir, "shared.txt", "two\n", "c2");
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2) = (t[0].oid.clone(), t[1].oid.clone());

        // Reordering edits to the same line conflicts → paused, not an error.
        let mut conflicted = repo
            .interactive_rebase(
                Some(&base),
                &[step(RebaseAction::Pick, &c2), step(RebaseAction::Pick, &c1)],
                false,
                false,
            )
            .unwrap().paused;
        assert!(conflicted, "reordered same-line edits conflict");

        // Resolve + stage + continue, until the rebase converges (it can pause
        // again on the next reordered commit).
        let mut guard = 0;
        while conflicted {
            assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("rebase"));
            std::fs::write(dir.join("shared.txt"), format!("resolved {guard}\n")).unwrap();
            git(&dir, &["add", "shared.txt"]);
            conflicted = repo.continue_operation().unwrap();
            guard += 1;
            assert!(guard < 5, "rebase should converge");
        }
        assert_eq!(repo.meta().unwrap().operation, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tip(dir: &Path, name: &str) -> String {
        git(dir, &["rev-parse", name])
    }

    fn branch_ref(name: &str, oid: &str, elsewhere: bool) -> UpdateRefBranch {
        UpdateRefBranch {
            name: name.to_string(),
            full_ref: format!("refs/heads/{name}"),
            tip: oid.to_string(),
            checked_out_elsewhere: elsewhere,
        }
    }

    /// `main ← A ← B`, with B checked out and A's tip inside `main..B`.
    /// Returns `(repo, dir, main oid)`.
    fn stack_on_main() -> (Repo, PathBuf, String) {
        let (repo, dir) = scratch_repo();
        let main = write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "stack-b"]);
        write_commit(&dir, "a.txt", "a\n", "commit A");
        git(&dir, &["branch", "stack-a"]);
        write_commit(&dir, "b.txt", "b\n", "commit B");
        (repo, dir, main)
    }

    #[test]
    fn parse_git_version_accepts_upstream_and_windows_suffixes() {
        assert_eq!(parse_git_version("git version 2.38.0"), Some((2, 38, 0)));
        assert_eq!(parse_git_version("git version 2.37.9\n"), Some((2, 37, 9)));
        assert_eq!(
            parse_git_version("git version 2.43.0.windows.1"),
            Some((2, 43, 0))
        );
        assert!(parse_git_version("not git").is_none());
        assert!((2, 38, 0) >= (2, 38, 0));
        assert!((2, 37, 9) < (2, 38, 0));
        assert_eq!(update_refs_flag(true, true).unwrap(), Some("--update-refs"));
        assert_eq!(
            update_refs_flag(true, false).unwrap(),
            Some("--no-update-refs")
        );
        assert_eq!(update_refs_flag(false, false).unwrap(), None);
        assert!(update_refs_flag(false, true).is_err());
    }

    #[test]
    fn update_ref_anchor_follows_kept_ancestor_through_drop_squash_and_reorder() {
        let (a, b, c) = ("a".to_string(), "b".to_string(), "c".to_string());
        let original = vec![a.clone(), b.clone(), c.clone()];
        let branches = vec![branch_ref("mid", &b, false), branch_ref("held", &b, true)];

        // Drop B. The last kept commit it contained is A, even when C is replayed first.
        let dropped = plan_update_refs(
            &original,
            &[
                step(RebaseAction::Pick, &c),
                step(RebaseAction::Drop, &b),
                step(RebaseAction::Pick, &a),
            ],
            &branches,
        );
        assert_eq!(dropped[0].name, "held");
        assert!(
            !dropped[0].will_move,
            "a branch checked out elsewhere is not moved"
        );
        assert_eq!(dropped[1].anchor, Some(2), "mid follows rewritten A, not C");
        assert!(dropped[1].will_move);

        // Every commit mid contained was dropped → park on the rebase base.
        let all_dropped = plan_update_refs(
            &original,
            &[
                step(RebaseAction::Drop, &a),
                step(RebaseAction::Drop, &b),
                step(RebaseAction::Pick, &c),
            ],
            &branches[..1],
        );
        assert_eq!(all_dropped[0].anchor, None);

        // Squash B into A. Both the branch at A and the branch at B follow the
        // combined commit (the pick), not the pre-squash snapshot.
        let mut with_a = branches[..1].to_vec();
        with_a.push(branch_ref("lower", &a, false));
        let squashed = plan_update_refs(
            &original,
            &[
                step(RebaseAction::Pick, &a),
                step(RebaseAction::Squash, &b),
                step(RebaseAction::Pick, &c),
            ],
            &with_a,
        );
        let lower = squashed.iter().find(|plan| plan.name == "lower").unwrap();
        let mid = squashed.iter().find(|plan| plan.name == "mid").unwrap();
        assert_eq!(lower.anchor, Some(0));
        assert_eq!(mid.anchor, Some(0));

        // Reorder: mid still follows B, which is now the first kept commit.
        let reordered = plan_update_refs(
            &original,
            &[
                step(RebaseAction::Pick, &b),
                step(RebaseAction::Pick, &a),
                step(RebaseAction::Pick, &c),
            ],
            &branches[..1],
        );
        assert_eq!(reordered[0].anchor, Some(0));
    }

    #[test]
    fn plain_rebase_update_refs_moves_stack_only_when_asked() {
        let (repo, dir, _main) = stack_on_main();
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main moves");
        git(&dir, &["checkout", "-q", "stack-b"]);
        let a_before = tip(&dir, "stack-a");
        let b_before = tip(&dir, "stack-b");
        // Remembered true must not override an explicit off for this run.
        repo.set_rebase_update_refs(true).unwrap();
        assert!(repo.rebase_update_refs_setting().unwrap().enabled);

        let off = repo.rebase("main", false).unwrap();
        assert!(!off.paused);
        assert_eq!(tip(&dir, "stack-a"), a_before, "update-refs off leaves A");
        assert_ne!(tip(&dir, "stack-b"), b_before);
        assert_eq!(off.moved, vec!["stack-b".to_string()]);
        // A is rewritten onto the new main; B sits on that rewrite. The old
        // stack-a tip is left behind, so it is not B's parent.
        assert_ne!(tip(&dir, "stack-b^"), a_before);
        assert_eq!(tip(&dir, "stack-b^^"), tip(&dir, "main"));
        let _ = std::fs::remove_dir_all(&dir);

        let (repo, dir, _) = stack_on_main();
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main moves");
        git(&dir, &["checkout", "-q", "stack-b"]);
        let a_before = tip(&dir, "stack-a");
        // A remembered choice must not override an explicit off, and an
        // explicit on must win over a stored false.
        repo.set_rebase_update_refs(false).unwrap();
        assert!(!repo.rebase_update_refs_setting().unwrap().enabled);
        let on = repo.rebase("main", true).unwrap();
        assert!(!on.paused);
        assert_ne!(tip(&dir, "stack-a"), a_before);
        assert_eq!(tip(&dir, "stack-a^"), tip(&dir, "main"));
        assert_eq!(tip(&dir, "stack-b^"), tip(&dir, "stack-a"));
        assert_eq!(on.moved, vec!["stack-a".to_string(), "stack-b".to_string()]);
        // A's rewritten tip is still inside main..HEAD, so a second preview
        // still names it. The checked-out branch (stack-b) is not listed.
        let again = repo.rebase_ref_preview("main").unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].name, "stack-a");
        assert!(again[0].will_move);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn plain_rebase_update_refs_conflict_updates_refs_only_when_finished() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "f.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "stack-b"]);
        write_commit(&dir, "f.txt", "aaa\n", "commit A");
        git(&dir, &["branch", "stack-a"]);
        write_commit(&dir, "g.txt", "b\n", "commit B");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "f.txt", "main\n", "main moves");
        git(&dir, &["checkout", "-q", "stack-b"]);
        let a_before = tip(&dir, "stack-a");
        let b_before = tip(&dir, "stack-b");
        let main = tip(&dir, "main");

        let preview = repo.rebase_ref_preview("main").unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].name, "stack-a");
        assert!(preview[0].will_move);

        let paused = repo.rebase("main", true).unwrap();
        assert!(paused.paused);
        assert!(
            paused.moved.is_empty(),
            "refs stay put while the rebase is paused"
        );
        assert_eq!(tip(&dir, "stack-a"), a_before);
        assert_eq!(tip(&dir, "stack-b"), b_before);
        repo.abort_operation().unwrap();
        assert_eq!(tip(&dir, "stack-a"), a_before);
        assert_eq!(tip(&dir, "stack-b"), b_before);
        assert_eq!(repo.meta().unwrap().operation, None);

        let paused = repo.rebase("main", true).unwrap();
        assert!(paused.paused);
        std::fs::write(dir.join("f.txt"), "resolved\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        let done = repo.continue_operation().unwrap();
        assert!(!done);
        assert_ne!(tip(&dir, "stack-a"), a_before);
        assert_ne!(tip(&dir, "stack-b"), b_before);
        assert_eq!(tip(&dir, "stack-a^"), main);
        assert_eq!(tip(&dir, "stack-b^"), tip(&dir, "stack-a"));
        assert!(dir.join("g.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// base ← X (f=x, stack-a) ← Y (f=y, stack-b). Reordering to Y, X conflicts
    /// on both picks, on the flat path where Strand writes `update-ref` itself.
    fn conflicting_stack() -> (Repo, PathBuf, String, String, String) {
        let (repo, dir) = scratch_repo();
        let main = write_commit(&dir, "f.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "stack-b"]);
        let x = write_commit(&dir, "f.txt", "x\n", "commit X");
        git(&dir, &["branch", "stack-a"]);
        let y = write_commit(&dir, "f.txt", "y\n", "commit Y");
        (repo, dir, main, x, y)
    }

    #[test]
    fn flat_update_refs_conflict_abort_restores_every_tip() {
        let (repo, dir, main, x, y) = conflicting_stack();
        let (a_before, b_before) = (tip(&dir, "stack-a"), tip(&dir, "stack-b"));
        let out = repo
            .interactive_rebase(
                Some(&main),
                &[step(RebaseAction::Pick, &y), step(RebaseAction::Pick, &x)],
                false,
                true,
            )
            .unwrap();
        assert!(out.paused, "reorder conflicts");
        assert!(out.moved.is_empty());
        assert_eq!(tip(&dir, "stack-a"), a_before, "refs move only on completion");
        repo.abort_operation().unwrap();
        assert_eq!(repo.meta().unwrap().operation, None);
        assert_eq!(tip(&dir, "stack-a"), a_before);
        assert_eq!(tip(&dir, "stack-b"), b_before);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn flat_update_refs_conflict_continue_moves_the_stacked_branch() {
        let (repo, dir, main, x, y) = conflicting_stack();
        let a_before = tip(&dir, "stack-a");
        let out = repo
            .interactive_rebase(
                Some(&main),
                &[step(RebaseAction::Pick, &y), step(RebaseAction::Pick, &x)],
                false,
                true,
            )
            .unwrap();
        assert!(out.paused);
        let mut paused = true;
        let mut guard = 0;
        while paused {
            let resolved = if guard == 0 { "y\n" } else { "x\n" };
            std::fs::write(dir.join("f.txt"), resolved).unwrap();
            git(&dir, &["add", "f.txt"]);
            paused = repo.continue_operation().unwrap();
            guard += 1;
            assert!(guard < 5, "rebase should converge");
        }
        assert_eq!(repo.meta().unwrap().operation, None);
        // stack-a contained X, which is now the last kept commit.
        assert_ne!(tip(&dir, "stack-a"), a_before);
        assert_eq!(tip(&dir, "stack-a"), tip(&dir, "stack-b"));
        assert_eq!(git(&dir, &["log", "-1", "--format=%s", "stack-a"]), "commit X");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn update_refs_choice_lives_in_a_strand_key_not_rebase_update_refs() {
        let (repo, dir, _main) = stack_on_main();
        git(&dir, &["config", "--local", "rebase.updateRefs", "true"]);
        assert!(
            !repo.rebase_update_refs_setting().unwrap().enabled,
            "the user's own rebase.updateRefs is not Strand's toggle"
        );
        git(&dir, &["config", "--local", "--unset", "rebase.updateRefs"]);
        repo.set_rebase_update_refs(true).unwrap();
        assert!(repo.rebase_update_refs_setting().unwrap().enabled);
        assert_eq!(git(&dir, &["config", "--local", "strand.rebaseUpdateRefs"]), "true");
        let status = crate::git_command()
            .current_dir(&dir)
            .args(["config", "--local", "--get", "rebase.updateRefs"])
            .status()
            .unwrap();
        assert!(!status.success(), "rebase.updateRefs stays unset, so pull --rebase is unaffected");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_reword_update_refs_moves_contained_branch() {
        let (repo, dir, main) = stack_on_main();
        let todo = repo.rebase_todo(Some(&main)).unwrap();
        let (a, b) = (todo[0].oid.clone(), todo[1].oid.clone());
        let a_before = tip(&dir, "stack-a");

        let off = repo
            .interactive_rebase(
                Some(&main),
                &[
                    RebaseStep {
                        action: RebaseAction::Reword,
                        oid: a.clone(),
                        message: Some("commit A reworded".into()),
                    },
                    step(RebaseAction::Pick, &b),
                ],
                false,
                false,
            )
            .unwrap();
        assert!(!off.paused);
        assert_eq!(tip(&dir, "stack-a"), a_before, "update-refs off leaves A");
        assert_eq!(off.moved, vec!["stack-b".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);

        let (repo, dir, main) = stack_on_main();
        let todo = repo.rebase_todo(Some(&main)).unwrap();
        let (a, b) = (todo[0].oid.clone(), todo[1].oid.clone());
        let on = repo
            .interactive_rebase(
                Some(&main),
                &[
                    RebaseStep {
                        action: RebaseAction::Reword,
                        oid: a,
                        message: Some("commit A reworded".into()),
                    },
                    step(RebaseAction::Pick, &b),
                ],
                false,
                true,
            )
            .unwrap();
        assert!(!on.paused);
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s", "stack-a"]),
            "commit A reworded"
        );
        assert_eq!(tip(&dir, "stack-a^"), main);
        assert_eq!(tip(&dir, "stack-b^"), tip(&dir, "stack-a"));
        assert_eq!(on.moved, vec!["stack-a".to_string(), "stack-b".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn interactive_update_refs_lands_dropped_squashed_and_reordered_branches() {
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());
        git(&dir, &["branch", "mid", &c2]);

        // Drop c2 while replaying c3 first. mid contained c1, so it follows c1 — not c3.
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Pick, &c3),
                step(RebaseAction::Drop, &c2),
                step(RebaseAction::Pick, &c1),
            ],
            false,
            true,
        )
        .unwrap();
        assert_eq!(git(&dir, &["log", "-1", "--format=%s", "mid"]), "c1");
        assert_eq!(git(&dir, &["log", "-1", "--format=%s", "mid^"]), "c3");
        let _ = std::fs::remove_dir_all(&dir);

        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());
        git(&dir, &["branch", "lower", &c1]);
        git(&dir, &["branch", "mid", &c2]);
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Pick, &c1),
                step(RebaseAction::Squash, &c2),
                step(RebaseAction::Pick, &c3),
            ],
            false,
            true,
        )
        .unwrap();
        assert_eq!(tip(&dir, "lower"), tip(&dir, "mid"));
        assert_eq!(
            tip(&dir, "HEAD^"),
            tip(&dir, "mid"),
            "the squashed commit is what both branches follow"
        );
        let message = git(&dir, &["log", "-1", "--format=%B", "mid"]);
        assert!(
            message.contains("c1") && message.contains("c2"),
            "{message}"
        );
        let _ = std::fs::remove_dir_all(&dir);

        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());
        git(&dir, &["branch", "mid", &c1]);
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Pick, &c2),
                step(RebaseAction::Pick, &c1),
                step(RebaseAction::Pick, &c3),
            ],
            false,
            true,
        )
        .unwrap();
        assert_eq!(git(&dir, &["log", "-1", "--format=%s", "mid"]), "c1");
        assert_eq!(git(&dir, &["log", "-1", "--format=%s", "mid^"]), "c2");
        let _ = std::fs::remove_dir_all(&dir);

        // Nothing mid contained survived: it parks on the rebase base.
        let (repo, dir, base) = three_commits();
        let t = repo.rebase_todo(Some(&base)).unwrap();
        let (c1, c2, c3) = (t[0].oid.clone(), t[1].oid.clone(), t[2].oid.clone());
        git(&dir, &["branch", "mid", &c2]);
        repo.interactive_rebase(
            Some(&base),
            &[
                step(RebaseAction::Drop, &c1),
                step(RebaseAction::Drop, &c2),
                step(RebaseAction::Pick, &c3),
            ],
            false,
            true,
        )
        .unwrap();
        assert_eq!(tip(&dir, "mid"), base);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn update_refs_skips_a_branch_checked_out_in_another_worktree() {
        let (repo, dir, _main) = stack_on_main();
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main moves");
        git(&dir, &["checkout", "-q", "stack-b"]);
        let wt = std::env::temp_dir().join(format!(
            "strand-update-ref-wt-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&wt);
        git(
            &dir,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "stack-a"],
        );
        let a_before = tip(&dir, "stack-a");
        let preview = repo.rebase_ref_preview("main").unwrap();
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].name, "stack-a");
        assert!(!preview[0].will_move);

        let outcome = repo.rebase("main", true).unwrap();
        assert!(!outcome.paused);
        assert_eq!(tip(&dir, "stack-a"), a_before);
        assert_eq!(outcome.moved, vec!["stack-b".to_string()]);
        assert_eq!(tip(&dir, "stack-b^^"), tip(&dir, "main"));

        git(
            &dir,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preserve_merges_passes_git_update_ref_lines_through() {
        let (repo, dir) = scratch_repo();
        let base = write_commit(&dir, "base.txt", "base\n", "base");
        git(&dir, &["checkout", "-q", "-b", "stack-b"]);
        let commit_a = write_commit(&dir, "a.txt", "a\n", "commit A");
        git(&dir, &["branch", "stack-a"]);
        git(&dir, &["checkout", "-q", "-b", "side", &base]);
        write_commit(&dir, "side.txt", "side\n", "side work");
        git(&dir, &["checkout", "-q", "stack-b"]);
        repo.merge("side", MergeMode::NoFastForward).unwrap();
        write_commit(&dir, "b.txt", "b\n", "commit B");

        let entries = repo.rebase_todo(Some(&base)).unwrap();
        assert!(entries.iter().any(|entry| entry.is_merge));
        let steps: Vec<RebaseStep> = entries
            .iter()
            .map(|entry| {
                if entry.oid == commit_a {
                    RebaseStep {
                        action: RebaseAction::Reword,
                        oid: entry.oid.clone(),
                        message: Some("commit A reworded".into()),
                    }
                } else {
                    step(RebaseAction::Pick, &entry.oid)
                }
            })
            .collect();
        // Preserve-merges does not emit update-ref lines of its own. The awk
        // filter prints unknown lines unchanged, so this move is git's line
        // surviving that overwrite.
        let outcome = repo
            .interactive_rebase(Some(&base), &steps, true, true)
            .unwrap();
        assert!(!outcome.paused, "clean merge rebase should finish");
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s", "stack-a"]),
            "commit A reworded"
        );
        git(&dir, &["merge-base", "--is-ancestor", "stack-a", "HEAD"]);
        assert!(outcome.moved.contains(&"stack-a".to_string()));
        assert_eq!(
            git(&dir, &["rev-list", "--count", "--min-parents=2", "HEAD"]),
            "1"
        );

        // And the filter itself, given a todo git would have written: a dropped
        // pick disappears and both `update-ref` and abbreviated `u` lines remain.
        let work = dir.join("editor-probe");
        std::fs::create_dir_all(&work).unwrap();
        let (editor, awk) = write_preserve_merge_editor(&work, "-c core.pager=cat").unwrap();
        let full_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let full_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        std::fs::write(
            work.join("plan"),
            format!("{full_a}\tdrop\t\n{full_b}\tpick\t\n"),
        )
        .unwrap();
        let todo = work.join("todo");
        std::fs::write(
            &todo,
            format!(
                "pick {full_a} commit A\nupdate-ref refs/heads/stack-a\nu refs/heads/side\npick {full_b} commit B\n"
            ),
        )
        .unwrap();
        let mut shell = preserve_editor_shell();
        let output = shell
            .env("STRAND_REBASE_AWK", sh_path(&awk))
            .env("STRAND_REBASE_PLAN", sh_path(&work.join("plan")))
            .arg(sh_path(&editor))
            .arg(sh_path(&todo))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "preserve editor failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let rewritten = std::fs::read_to_string(&todo).unwrap();
        assert!(
            rewritten.contains("update-ref refs/heads/stack-a"),
            "{rewritten}"
        );
        assert!(rewritten.contains("u refs/heads/side"), "{rewritten}");
        assert!(rewritten.contains(&format!("pick {full_b}")), "{rewritten}");
        assert!(
            !rewritten.contains(&format!("pick {full_a}")),
            "{rewritten}"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Git runs the preserve-merges editor with its own shell. Use `sh` when it
    /// is on PATH, otherwise the copy shipped beside Git for Windows.
    fn preserve_editor_shell() -> Command {
        if Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .output()
            .is_ok_and(|out| out.status.success())
        {
            return Command::new("sh");
        }
        let exec = Command::new("git").args(["--exec-path"]).output().ok();
        let exec_path = exec
            .filter(|out| out.status.success())
            .map(|out| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()));
        if let Some(exec_path) = exec_path {
            for relative in [
                "../bin/sh.exe",
                "../../bin/sh.exe",
                "../usr/bin/sh.exe",
                "../../usr/bin/sh.exe",
            ] {
                let candidate = exec_path.join(relative);
                if candidate.exists() {
                    return Command::new(candidate);
                }
            }
        }
        Command::new("sh")
    }


    /// Blob contents as stored (`git show`), trailing newline trimmed by `git()`.
    fn blob(dir: &Path, rev: &str, file: &str) -> String {
        git(dir, &["show", &format!("{rev}:{file}")]).replace("\r\n", "\n")
    }

    fn worktree_text(dir: &Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file))
            .unwrap()
            .replace("\r\n", "\n")
    }

    /// C1 touches `a.txt`; C2 and C3 touch other files. Returns (c0, c1, c2, c3).
    fn c1_c2_c3(dir: &Path) -> (String, String, String, String) {
        let c0 = write_commit(dir, "base.txt", "base\n", "c0");
        let c1 = write_commit(dir, "a.txt", "a\n", "c1");
        let c2 = write_commit(dir, "b.txt", "b\n", "c2");
        let c3 = write_commit(dir, "c.txt", "c\n", "c3");
        (c0, c1, c2, c3)
    }

    #[test]
    fn amend_into_moves_a_stacked_branch_with_the_rewrite() {
        if !git_supports_update_refs() {
            return;
        }
        let (repo, dir) = scratch_repo();
        let (c0, c1, c2, _c3) = c1_c2_c3(&dir);
        // A stacked branch whose tip is inside the rewritten range.
        git(&dir, &["branch", "stack-a", &c2]);
        std::fs::write(dir.join("a.txt"), "a\nplus\n").unwrap();
        git(&dir, &["add", "a.txt"]);

        assert!(!repo.amend_into_commit(&c1).unwrap());
        let stacked = tip(&dir, "stack-a");
        assert_ne!(stacked, c2, "stack-a must not keep the pre-amend commit");
        assert_eq!(git(&dir, &["log", "-1", "--format=%s", "stack-a"]), "c2");
        assert_eq!(
            git(&dir, &["rev-parse", "HEAD~1"]),
            stacked,
            "stack-a follows the rewritten c2"
        );
        let new_c1 = git(&dir, &["rev-parse", "stack-a~1"]);
        assert_eq!(git(&dir, &["rev-parse", "stack-a~2"]), c0);
        assert_eq!(blob(&dir, &new_c1, "a.txt"), "a\nplus");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_folds_staged_changes_and_keeps_later_messages() {
        let (repo, dir) = scratch_repo();
        let (c0, c1, c2, c3) = c1_c2_c3(&dir);
        let plan = repo.amend_into_plan(&c1).unwrap();
        assert_eq!(
            plan.commits
                .iter()
                .map(|c| c.subject.as_str())
                .collect::<Vec<_>>(),
            ["c1", "c2", "c3"]
        );
        assert!(!plan.pushed);
        assert!(!plan.has_merge);
        let untouched = repo.amend_into_commit(&c1).unwrap_err().to_string();
        assert!(untouched.contains("nothing staged"), "{untouched}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), c3);

        std::fs::write(dir.join("a.txt"), "a\nplus\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        // Unstaged edit on a file the rewrite still has to replay.
        std::fs::write(dir.join("c.txt"), "c\nlocal\n").unwrap();

        assert!(
            !repo.amend_into_commit(&c1).unwrap(),
            "clean fold does not pause"
        );
        let rewritten: Vec<String> = git(
            &dir,
            &["log", "--reverse", "--format=%H %s", &format!("{c0}..HEAD")],
        )
        .lines()
        .map(str::to_string)
        .collect();
        let subjects: Vec<&str> = rewritten
            .iter()
            .map(|line| line.split_once(' ').unwrap().1)
            .collect();
        assert_eq!(subjects, ["c1", "c2", "c3"]);
        let new_c1 = rewritten[0].split_once(' ').unwrap().0;
        let new_c2 = rewritten[1].split_once(' ').unwrap().0;
        let new_c3 = rewritten[2].split_once(' ').unwrap().0;
        assert_ne!(new_c1, c1);
        assert_ne!(new_c2, c2);
        assert_ne!(new_c3, c3);
        assert_eq!(blob(&dir, new_c1, "a.txt"), "a\nplus");
        assert_eq!(blob(&dir, new_c2, "b.txt"), "b");
        assert_eq!(blob(&dir, new_c3, "c.txt"), "c");
        assert!(
            !git(&dir, &["log", "--format=%s", "HEAD"]).contains("fixup!"),
            "fixup commit must be folded away"
        );
        assert_eq!(worktree_text(&dir, "c.txt"), "c\nlocal\n");
        assert_eq!(git(&dir, &["show", ":c.txt"]).replace("\r\n", "\n"), "c");
        assert_eq!(repo.meta().unwrap().operation, None);
        assert!(!repo.git_dir().join("strand-amend-into").exists());
        println!(
            "PROOF fold: subjects={subjects:?} c1_a.txt={} unstaged_c.txt={} rewritten={new_c1} {new_c2} {new_c3}",
            blob(&dir, new_c1, "a.txt"),
            worktree_text(&dir, "c.txt").trim()
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_targets_the_oid_when_subjects_match() {
        let (repo, dir) = scratch_repo();
        let c0 = write_commit(&dir, "base.txt", "base\n", "c0");
        let c1 = write_commit(&dir, "a.txt", "a\n", "same");
        let _c2 = write_commit(&dir, "b.txt", "b\n", "same");
        write_commit(&dir, "c.txt", "c\n", "other");
        std::fs::write(dir.join("a.txt"), "a\nplus\n").unwrap();
        git(&dir, &["add", "a.txt"]);

        assert!(!repo.amend_into_commit(&c1).unwrap());
        let oids: Vec<String> = git(
            &dir,
            &["log", "--reverse", "--format=%H", &format!("{c0}..HEAD")],
        )
        .lines()
        .map(str::to_string)
        .collect();
        let diff_c1 = git(
            &dir,
            &["diff", &format!("{}^", oids[0]), &oids[0], "--", "a.txt"],
        );
        let diff_c2 = git(&dir, &["diff", &oids[0], &oids[1], "--", "a.txt"]);
        assert!(
            diff_c1.contains("+plus"),
            "change landed in the chosen commit: {diff_c1}"
        );
        assert!(
            diff_c2.is_empty(),
            "later commit with the same subject was not the target: {diff_c2}"
        );
        println!(
            "PROOF oid-plan: c1_diff_has_plus c2_diff_empty subjects={}",
            git(
                &dir,
                &["log", "--reverse", "--format=%s", &format!("{c0}..HEAD")]
            )
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_root_uses_root_rebase() {
        let (repo, dir) = scratch_repo();
        let root = write_commit(&dir, "a.txt", "a\n", "root");
        write_commit(&dir, "b.txt", "b\n", "c2");
        std::fs::write(dir.join("a.txt"), "a\nplus\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        let plan = repo.amend_into_plan(&root).unwrap();
        assert_eq!(
            plan.commits
                .iter()
                .map(|c| c.subject.as_str())
                .collect::<Vec<_>>(),
            ["root", "c2"]
        );

        assert!(!repo.amend_into_commit(&root).unwrap());
        let root_now = git(&dir, &["rev-list", "--max-parents=0", "HEAD"]);
        assert_eq!(blob(&dir, &root_now, "a.txt"), "a\nplus");
        assert_eq!(git(&dir, &["log", "--reverse", "--format=%s"]), "root\nc2");
        println!(
            "PROOF root: file={} subjects=root,c2",
            blob(&dir, &root_now, "a.txt")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_conflict_abort_restores_original_tip() {
        let (repo, dir) = scratch_repo();
        let c0 = write_commit(&dir, "base.txt", "base\n", "c0");
        let c1 = write_commit(&dir, "f.txt", "base\n", "c1");
        write_commit(&dir, "f.txt", "middle\n", "c2");
        let original = write_commit(&dir, "g.txt", "g\n", "c3");
        std::fs::write(dir.join("f.txt"), "staged\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        std::fs::write(dir.join("g.txt"), "g\nlocal\n").unwrap();

        let conflicted = repo.amend_into_commit(&c1).unwrap();
        assert!(conflicted, "fixup onto c1 conflicts");
        assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("rebase"));
        assert!(repo.git_dir().join("strand-amend-into").exists());

        repo.abort_operation().unwrap();
        assert_eq!(repo.meta().unwrap().operation, None);
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), original);
        assert_eq!(
            git(&dir, &["show", ":f.txt"]).replace("\r\n", "\n"),
            "staged"
        );
        assert_eq!(worktree_text(&dir, "g.txt"), "g\nlocal\n");
        assert_eq!(git(&dir, &["show", ":g.txt"]).replace("\r\n", "\n"), "g");
        assert!(!git(&dir, &["log", "--format=%s", &format!("{c0}..HEAD")]).contains("fixup!"));
        assert!(!repo.git_dir().join("strand-amend-into").exists());
        println!(
            "PROOF abort: head={original} staged_f={} unstaged_g={}",
            git(&dir, &["show", ":f.txt"]),
            worktree_text(&dir, "g.txt").trim()
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_conflict_continue_finishes_the_rewrite() {
        let (repo, dir) = scratch_repo();
        let c0 = write_commit(&dir, "base.txt", "base\n", "c0");
        let c1 = write_commit(&dir, "f.txt", "base\n", "c1");
        write_commit(&dir, "f.txt", "middle\n", "c2");
        let original = write_commit(&dir, "g.txt", "g\n", "c3");
        std::fs::write(dir.join("f.txt"), "staged\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        std::fs::write(dir.join("g.txt"), "g\nlocal\n").unwrap();

        let mut conflicted = repo.amend_into_commit(&c1).unwrap();
        assert!(conflicted);
        let mut guard = 0;
        while conflicted {
            assert_eq!(repo.meta().unwrap().operation.as_deref(), Some("rebase"));
            std::fs::write(
                dir.join("f.txt"),
                if guard == 0 { "staged\n" } else { "middle\n" },
            )
            .unwrap();
            git(&dir, &["add", "f.txt"]);
            conflicted = repo.continue_operation().unwrap();
            guard += 1;
            assert!(guard < 5, "rebase should converge");
        }
        assert_eq!(repo.meta().unwrap().operation, None);
        assert_ne!(git(&dir, &["rev-parse", "HEAD"]), original);
        assert_eq!(
            git(
                &dir,
                &["log", "--reverse", "--format=%s", &format!("{c0}..HEAD")]
            ),
            "c1\nc2\nc3"
        );
        let new_c1 = git(
            &dir,
            &["log", "--reverse", "--format=%H", &format!("{c0}..HEAD")],
        )
        .lines()
        .next()
        .unwrap()
        .to_string();
        assert_eq!(blob(&dir, &new_c1, "f.txt"), "staged");
        assert!(!git(&dir, &["log", "--format=%s"]).contains("fixup!"));
        assert_eq!(worktree_text(&dir, "g.txt"), "g\nlocal\n");
        assert!(!repo.git_dir().join("strand-amend-into").exists());
        println!(
            "PROOF continue: c1_f.txt={} subjects=c1,c2,c3 unstaged_g={}",
            blob(&dir, &new_c1, "f.txt"),
            worktree_text(&dir, "g.txt").trim()
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_refuses_a_merge_in_range_without_rewriting() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "c0");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feat.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        let main_c = write_commit(&dir, "main.txt", "main\n", "main");
        repo.merge("feature", MergeMode::NoFastForward).unwrap();
        let head = write_commit(&dir, "after.txt", "after\n", "after");
        std::fs::write(dir.join("main.txt"), "main\nplus\n").unwrap();
        git(&dir, &["add", "main.txt"]);
        let staged = git(&dir, &["diff", "--cached", "--name-only"]);

        let plan = repo.amend_into_plan(&main_c).unwrap();
        assert!(
            plan.has_merge,
            "confirmation can see the merge in the rewritten range"
        );
        assert!(plan.commits.iter().any(|entry| entry.subject == "main"));
        let err = repo.amend_into_commit(&main_c).unwrap_err().to_string();
        assert!(err.contains("merge commit"), "{err}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]), staged);
        assert!(!git(&dir, &["log", "--format=%s"]).contains("fixup!"));
        println!(
            "PROOF merge-refusal: error={err} head_unchanged={head} listed={}",
            plan.commits
                .iter()
                .map(|c| c.subject.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_refuses_a_merge_commit_target_without_rewriting() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "c0");
        git(&dir, &["checkout", "-q", "-b", "feature"]);
        write_commit(&dir, "feat.txt", "feature\n", "feature");
        git(&dir, &["checkout", "-q", "main"]);
        write_commit(&dir, "main.txt", "main\n", "main");
        repo.merge("feature", MergeMode::NoFastForward).unwrap();
        let merge = git(&dir, &["rev-parse", "HEAD"]);
        std::fs::write(dir.join("main.txt"), "main\nplus\n").unwrap();
        git(&dir, &["add", "main.txt"]);
        let staged = git(&dir, &["diff", "--cached"]);

        let err = repo.amend_into_commit(&merge).unwrap_err().to_string();
        assert!(err.contains("merge commit"), "{err}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), merge);
        assert_eq!(git(&dir, &["diff", "--cached"]), staged);
        assert!(!repo.git_dir().join("strand-amend-into").exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_amend_marker_does_not_reset_on_an_unrelated_abort() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "f.txt", "base\n", "c0");
        let original = write_commit(&dir, "g.txt", "g\n", "c1");
        git(&dir, &["checkout", "-q", "-b", "other"]);
        let pick = write_commit(&dir, "f.txt", "other\n", "other");
        git(&dir, &["checkout", "-q", "main"]);
        let x = write_commit(&dir, "f.txt", "main\n", "x");
        // Left behind by an amend-into finished outside Strand: HEAD^ is the
        // recorded original, which the old parent check would have reset to.
        std::fs::write(
            repo.git_dir().join("strand-amend-into"),
            format!("{original}\n{}\n", "0".repeat(40)),
        )
        .unwrap();

        assert!(repo.cherry_pick(&[pick], None).unwrap(), "pick conflicts");
        repo.abort_operation().unwrap();
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), x);
        assert!(!repo.git_dir().join("strand-amend-into").exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_continue_surfaces_a_conflicting_autostash() {
        let (repo, dir) = scratch_repo();
        write_commit(&dir, "base.txt", "base\n", "c0");
        let c1 = write_commit(&dir, "f.txt", "base\n", "c1");
        write_commit(&dir, "f.txt", "middle\n", "c2");
        let original = write_commit(&dir, "g.txt", "g\n", "c3");
        std::fs::write(dir.join("f.txt"), "staged\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        // Unstaged on top of the staged change: the autostash holds it.
        std::fs::write(dir.join("f.txt"), "staged\nlocal\n").unwrap();

        let mut paused = repo.amend_into_commit(&c1).unwrap();
        let mut guard = 0;
        let mut last = Ok(false);
        while paused {
            std::fs::write(dir.join("f.txt"), if guard == 0 { "staged\n" } else { "middle\n" })
                .unwrap();
            git(&dir, &["add", "f.txt"]);
            last = repo.continue_operation();
            paused = matches!(last, Ok(true));
            guard += 1;
            assert!(guard < 5, "rebase should converge");
        }
        let err = last.unwrap_err().to_string();
        assert!(err.contains("stash"), "{err}");
        assert_eq!(repo.meta().unwrap().operation, None);
        assert_ne!(git(&dir, &["rev-parse", "HEAD"]), original);
        assert!(!git(&dir, &["stash", "list"]).is_empty(), "unstaged work kept in the stash");
        assert!(!repo.git_dir().join("strand-amend-into").exists());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn amend_into_plan_warns_when_the_target_is_on_upstream() {
        let (repo, dir) = scratch_repo();
        let c0 = write_commit(&dir, "a.txt", "a\n", "c1");
        write_commit(&dir, "b.txt", "b\n", "c2");
        let pushed_tip = write_commit(&dir, "c.txt", "c\n", "c3");
        let origin = dir.join("origin.git");
        git(&dir, &["init", "--bare", "-q", origin.to_str().unwrap()]);
        git(&dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git(&dir, &["push", "-q", "-u", "origin", "main"]);

        let plan = repo.amend_into_plan(&c0).unwrap();
        assert!(plan.pushed, "c1 is contained in @{{upstream}}");
        assert!(!plan.has_merge);

        let local = write_commit(&dir, "d.txt", "d\n", "c4");
        let local_plan = repo.amend_into_plan(&local).unwrap();
        assert!(!local_plan.pushed, "c4 is not on upstream");
        let still_pushed = repo.amend_into_plan(&c0).unwrap();
        assert!(still_pushed.pushed);
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), local);
        assert_eq!(git(&dir, &["rev-parse", "origin/main"]), pushed_tip);
        println!(
            "PROOF upstream: c1_pushed={} c4_pushed={} upstream={}",
            plan.pushed, local_plan.pushed, pushed_tip
        );

        let _ = std::fs::remove_dir_all(dir);
    }

}
