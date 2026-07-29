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

use std::path::{Path, PathBuf};
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

impl Repo {
    /// Cherry-pick one or more commits onto HEAD, in the order given
    /// (`git cherry-pick <oid>…`). Each commit is any revspec git understands.
    ///
    /// Returns `Ok(true)` when the pick stopped on a **conflict** (the op is
    /// left in progress with unmerged files to resolve — an expected outcome,
    /// not a failure), `Ok(false)` when it applied cleanly, and `Err` only for
    /// a real failure (e.g. picking a merge commit without `-m`).
    pub fn cherry_pick(&self, commits: &[String], mainline: Option<u32>) -> Result<bool> {
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

    /// Rebase the current branch onto `onto` (`git rebase <onto>`). A dirty
    /// working tree makes git refuse — that surfaces as `Err`. `Ok(true)` when
    /// the rebase paused on a conflict.
    pub fn rebase(&self, onto: &str) -> Result<bool> {
        validate_ref(onto)?;
        self.run_sequencer(&["rebase", "--", onto])
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
    /// commit deterministically. `Ok(true)` when the rebase paused on a
    /// conflict (resolve, then [`continue_operation`](Repo::continue_operation)).
    pub fn interactive_rebase(
        &self,
        base: Option<&str>,
        steps: &[RebaseStep],
        preserve_merges: bool,
    ) -> Result<bool> {
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

        // Keep the todo + reword message files beside this worktree's git dir:
        // an edit/conflict pause can outlive this command, and later `exec`
        // lines still need their message files when the user continues.
        let work = rebase_work_dir(self)?;
        let mut todo = String::new();
        let mut mapping = String::new();
        let safe = crate::GIT_SAFE_CONFIG.join(" ");
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
            match s.action {
                // A missing line drops the commit; emit nothing.
                RebaseAction::Drop => {}
                RebaseAction::Pick => todo.push_str(&format!("pick {}\n", s.oid)),
                RebaseAction::Edit => todo.push_str(&format!("edit {}\n", s.oid)),
                RebaseAction::Squash => todo.push_str(&format!("squash {}\n", s.oid)),
                RebaseAction::Fixup => todo.push_str(&format!("fixup {}\n", s.oid)),
                RebaseAction::Reword => {
                    // `exec` runs via the shell; a forward-slashed, single-quoted
                    // path is safe on every platform git supports.
                    todo.push_str(&format!("pick {}\n", s.oid));
                    todo.push_str(&format!(
                        "exec git {safe} commit --amend --no-edit -F '{message_path}'\n"
                    ));
                }
            }
        }
        let todo_path = work.join("todo");
        std::fs::write(&todo_path, if preserve_merges { &mapping } else { &todo })
            .map_err(|e| Error::Other(format!("write rebase todo: {e}")))?;

        let mut args: Vec<&str> = vec!["rebase", "-i"];
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
        result
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
            "rebase" => "rebase",
            "cherry-pick" => "cherry-pick",
            "revert" => "revert",
            "merge" => "merge",
            other => return Err(Error::Other(format!("cannot continue `{other}`"))),
        };
        let result = self.run_sequencer_env(&[cmd, "--continue"], &[("GIT_EDITOR", "true")]);
        if self.operation_in_progress().is_none() {
            let _ = std::fs::remove_dir_all(self.git_dir().join("strand-rebase-plan"));
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
            Ok(_) => Ok(self.operation_in_progress().is_some()),
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
            "rebase" => "rebase",
            "cherry-pick" => "cherry-pick",
            "revert" => "revert",
            "merge" => "merge",
            other => return Err(Error::Other(format!("cannot abort `{other}`"))),
        };
        run_git(&self.path, &[cmd, "--abort"])?;
        let _ = std::fs::remove_dir_all(self.git_dir().join("strand-rebase-plan"));
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
            )
            .unwrap();
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
            &[step(RebaseAction::Pick, &c1), step(RebaseAction::Squash, &c2)],
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
            )
            .unwrap();
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
        assert!(repo.interactive_rebase(Some(&base), &steps, true).unwrap());
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
            )
            .unwrap();
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
}
