//! Opt-in Git-flow AVH orchestration. No work is added to ordinary snapshots.
use crate::{Error, Repo, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::Path,
    process::Stdio,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlowConfig {
    pub production: String,
    pub develop: String,
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    pub version_tag: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowState {
    pub enabled: bool,
    pub config: FlowConfig,
    pub options: BTreeMap<String, String>,
    pub branches: BTreeMap<String, String>,
    pub current: String,
    pub head: String,
    pub operation: Option<String>,
    pub clean: bool,
    pub conflicts: bool,
    pub token: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlowKind {
    Feature,
    Release,
    Hotfix,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FlowAction {
    Start,
    Finish,
    ContinueMerge,
    AbortMerge,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowPlan {
    pub kind: FlowKind,
    pub action: FlowAction,
    pub name: String,
    pub token: String,
    pub args: Vec<String>,
    pub steps: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowTool {
    pub available: bool,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowOutcome {
    pub success: bool,
    pub output: String,
    pub state: FlowState,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interchange::InterchangeScratch;
    fn git(path: &Path, args: &[&str]) -> String {
        let (ok, output) = run(
            path,
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            |_| {},
        )
        .unwrap();
        assert!(ok, "{args:?}: {output}");
        output.trim().into()
    }
    fn fixture() -> (InterchangeScratch, Repo, FlowConfig) {
        let scratch = InterchangeScratch::new().unwrap();
        let raw = git2::Repository::init(&scratch.0).unwrap();
        let mut cfg = raw.config().unwrap();
        for (key, value) in [
            ("user.name", "Flow Tester"),
            ("user.email", "flow@example.test"),
            ("core.hooksPath", "/dev/null"),
            ("core.autocrlf", "false"),
        ] {
            cfg.set_str(key, value).unwrap();
        }
        cfg.set_bool("commit.gpgsign", false).unwrap();
        cfg.set_bool("tag.gpgsign", false).unwrap();
        fs::write(scratch.0.join("file"), "base\n").unwrap();
        git(&scratch.0, &["add", "."]);
        git(&scratch.0, &["commit", "-m", "base"]);
        git(&scratch.0, &["branch", "-M", "main"]);
        git(&scratch.0, &["branch", "develop"]);
        let repo = Repo::discover(&scratch.0).unwrap();
        let cfg = FlowConfig {
            production: "main".into(),
            develop: "develop".into(),
            feature: "feature/".into(),
            release: "release/".into(),
            hotfix: "hotfix/".into(),
            version_tag: "v".into(),
        };
        (scratch, repo, cfg)
    }
    fn enable(repo: &Repo, cfg: FlowConfig) {
        repo.configure_gitflow(cfg, true, &repo.gitflow_state().unwrap().token)
            .unwrap();
    }
    fn execute(repo: &Repo, kind: FlowKind, action: FlowAction, name: &str) -> FlowOutcome {
        repo.run_gitflow(repo.plan_gitflow(kind, action, name).unwrap(), |_| {})
            .unwrap()
    }
    #[test]
    fn config_is_opt_in_atomic_and_preserves_external_settings() {
        let (_s, repo, cfg) = fixture();
        assert!(!repo.gitflow_state().unwrap().enabled);
        assert!(repo
            .plan_gitflow(FlowKind::Feature, FlowAction::Start, "one")
            .is_err());
        let stale = repo.gitflow_state().unwrap();
        git(&repo.path, &["config", "gitflow.origin", "upstream"]);
        assert!(repo
            .configure_gitflow(cfg.clone(), true, &stale.token)
            .is_err());
        enable(&repo, cfg.clone());
        assert_eq!(git(&repo.path, &["config", "gitflow.origin"]), "upstream");
        assert_eq!(repo.gitflow_state().unwrap().config, cfg);
        let token = repo.gitflow_state().unwrap().token;
        let lock = repo.git_dir().join("config.lock");
        fs::write(&lock, "external lock").unwrap();
        assert!(repo.configure_gitflow(cfg.clone(), false, &token).is_err());
        assert_eq!(fs::read_to_string(&lock).unwrap(), "external lock");
        fs::remove_file(lock).unwrap();
        repo.configure_gitflow(cfg, false, &token).unwrap();
        assert!(!repo.gitflow_state().unwrap().enabled);
        assert_eq!(
            git(&repo.path, &["config", "gitflow.branch.master"]),
            "main"
        );
    }
    #[test]
    #[ignore = "requires installed Git-flow AVH; run with --include-ignored"]
    fn starts_and_finishes_all_three_kinds_without_publication_or_branch_deletion() {
        assert!(detect().unwrap().available);
        let (_s, repo, cfg) = fixture();
        enable(&repo, cfg);
        // Even existing push/fetch preferences must not make the reviewed local
        // workflow publish, fetch, or delete branches.
        for kind in ["feature", "release", "hotfix"] {
            for flag in ["push", "fetch"] {
                git(
                    &repo.path,
                    &["config", &format!("gitflow.{kind}.finish.{flag}"), "true"],
                );
            }
        }
        for flag in ["pushproduction", "pushdevelop", "pushtag"] {
            git(
                &repo.path,
                &["config", &format!("gitflow.release.finish.{flag}"), "true"],
            );
        }
        for (kind, label) in [
            (FlowKind::Feature, "feature"),
            (FlowKind::Release, "release"),
            (FlowKind::Hotfix, "hotfix"),
        ] {
            let started = execute(&repo, kind, FlowAction::Start, label);
            assert!(started.success, "{}", started.output);
            fs::write(repo.path.join(label), "work\n").unwrap();
            git(&repo.path, &["add", label]);
            git(&repo.path, &["commit", "-m", label]);
            let tip = git(&repo.path, &["rev-parse", "HEAD"]);
            let finished = execute(&repo, kind, FlowAction::Finish, label);
            assert!(finished.success, "{}", finished.output);
            assert!(finished.state.clean && finished.state.operation.is_none());
            assert_eq!(
                git(&repo.path, &["rev-parse", &format!("{label}/{label}")]),
                tip
            );
            git(
                &repo.path,
                &["merge-base", "--is-ancestor", &tip, "develop"],
            );
            if kind != FlowKind::Feature {
                git(&repo.path, &["merge-base", "--is-ancestor", &tip, "main"]);
                assert_eq!(
                    git(&repo.path, &["cat-file", "-t", &format!("v{label}")]),
                    "tag"
                );
            }
        }
    }
    #[test]
    #[ignore = "requires installed Git-flow AVH; run with --include-ignored"]
    fn external_start_stale_review_and_conflict_continue_or_abort() {
        let (_s, repo, cfg) = fixture();
        enable(&repo, cfg);
        git(&repo.path, &["flow", "feature", "start", "external"]);
        fs::write(repo.path.join("file"), "feature\n").unwrap();
        git(&repo.path, &["commit", "-am", "feature edit"]);
        let stale = repo
            .plan_gitflow(FlowKind::Feature, FlowAction::Finish, "external")
            .unwrap();
        git(&repo.path, &["checkout", "develop"]);
        fs::write(repo.path.join("file"), "develop\n").unwrap();
        git(&repo.path, &["commit", "-am", "develop edit"]);
        assert!(repo.run_gitflow(stale, |_| {}).is_err());
        let paused = execute(&repo, FlowKind::Feature, FlowAction::Finish, "external");
        assert!(!paused.success && paused.state.conflicts);
        assert!(repo
            .plan_gitflow(FlowKind::Feature, FlowAction::ContinueMerge, "external")
            .is_err());
        let aborted = execute(&repo, FlowKind::Feature, FlowAction::AbortMerge, "external");
        assert!(aborted.success && aborted.state.clean);
        let paused = execute(&repo, FlowKind::Feature, FlowAction::Finish, "external");
        assert!(!paused.success);
        fs::write(repo.path.join("file"), "resolved\n").unwrap();
        git(&repo.path, &["add", "file"]);
        assert!(
            execute(
                &repo,
                FlowKind::Feature,
                FlowAction::ContinueMerge,
                "external"
            )
            .success
        );
        let done = execute(&repo, FlowKind::Feature, FlowAction::Finish, "external");
        assert!(done.success, "{}", done.output);
        assert_eq!(
            fs::read_to_string(repo.path.join("file")).unwrap(),
            "resolved\n"
        );
        assert!(repo
            .plan_gitflow(
                FlowKind::Feature,
                FlowAction::Start,
                "bad'$(touch injected)"
            )
            .is_err());
        assert!(repo
            .plan_gitflow(FlowKind::Feature, FlowAction::Finish, "exter")
            .is_err());
    }

    #[test]
    #[ignore = "requires installed Git-flow AVH; run with --include-ignored"]
    fn release_recovery_preserves_completed_production_merge_and_tag() {
        let (_s, repo, cfg) = fixture();
        enable(&repo, cfg);
        assert!(execute(&repo, FlowKind::Release, FlowAction::Start, "partial").success);
        fs::write(repo.path.join("file"), "release\n").unwrap();
        git(&repo.path, &["commit", "-am", "release edit"]);
        git(&repo.path, &["checkout", "develop"]);
        fs::write(repo.path.join("file"), "develop\n").unwrap();
        git(&repo.path, &["commit", "-am", "develop edit"]);
        let paused = execute(&repo, FlowKind::Release, FlowAction::Finish, "partial");
        assert!(
            !paused.success && paused.state.conflicts,
            "{}",
            paused.output
        );
        let tag = git(&repo.path, &["rev-parse", "vpartial"]);
        let main = git(&repo.path, &["rev-parse", "main"]);
        let abort = repo
            .plan_gitflow(FlowKind::Release, FlowAction::AbortMerge, "partial")
            .unwrap();
        fs::write(
            repo.path.join("file"),
            "new external resolution with different length\n",
        )
        .unwrap();
        assert!(repo.run_gitflow(abort, |_| {}).is_err());
        assert!(execute(&repo, FlowKind::Release, FlowAction::AbortMerge, "partial").success);
        assert_eq!(git(&repo.path, &["rev-parse", "main"]), main);
        assert_eq!(git(&repo.path, &["rev-parse", "vpartial"]), tag);
        assert!(!execute(&repo, FlowKind::Release, FlowAction::Finish, "partial").success);
        fs::write(repo.path.join("file"), "resolved\n").unwrap();
        git(&repo.path, &["add", "file"]);
        assert!(
            execute(
                &repo,
                FlowKind::Release,
                FlowAction::ContinueMerge,
                "partial"
            )
            .success
        );
        let done = execute(&repo, FlowKind::Release, FlowAction::Finish, "partial");
        assert!(done.success, "{}", done.output);
        assert_eq!(git(&repo.path, &["rev-parse", "vpartial"]), tag);
    }
}

// Drain both pipes with bounded queues and transcripts. Git-flow writes normal
// progress to stdout as well as stderr. Updates are coalesced before IPC.
fn run(cwd: &Path, args: &[String], mut progress: impl FnMut(String)) -> Result<(bool, String)> {
    let mut child = crate::git_command()
        .current_dir(cwd)
        .args(crate::GIT_SAFE_CONFIG)
        .args(args)
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(16);
    let pipes: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ];
    for mut pipe in pipes {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0; 4096];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    drop(tx);
    let mut output = String::new();
    let mut last = std::time::Instant::now();
    while let Ok(chunk) = rx.recv() {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.len() > 65536 {
            let mut cut = output.len() - 65536;
            while !output.is_char_boundary(cut) {
                cut += 1;
            }
            output.drain(..cut);
        }
        if last.elapsed().as_millis() >= 100 {
            progress(output.clone());
            last = std::time::Instant::now();
        }
    }
    let success = child.wait()?.success();
    progress(output.clone());
    Ok((success, output))
}

pub fn detect() -> Result<FlowTool> {
    // A repository-local alias must never be used for discovery. Actual Git-flow
    // executables take precedence over aliases once the extension is installed.
    let scratch = crate::interchange::InterchangeScratch::new()?;
    let (success, version) = run(&scratch.0, &["flow".into(), "version".into()], |_| {})?;
    Ok(FlowTool {
        available: success && version.contains("AVH Edition"),
        version: version.trim().into(),
    })
}
fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(['-', '.'])
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._/".contains(&c))
        && git2::Reference::is_valid_name(&format!("refs/heads/{value}"))
}
fn validate_config(config: &FlowConfig, state: &FlowState) -> Result<()> {
    if config.production == config.develop
        || [&config.production, &config.develop]
            .iter()
            .any(|n| !safe_name(n) || !state.branches.contains_key(*n))
    {
        return Err(Error::Other(
            "select distinct, existing production and develop branches".into(),
        ));
    }
    let prefixes = [&config.feature, &config.release, &config.hotfix];
    for (i, prefix) in prefixes.iter().enumerate() {
        if !prefix.ends_with('/')
            || !safe_name(&format!("{prefix}example"))
            || prefixes
                .iter()
                .enumerate()
                .any(|(j, p)| i != j && prefix.starts_with(p.as_str()))
        {
            return Err(Error::Other(
                "use distinct, non-overlapping branch prefixes ending in /".into(),
            ));
        }
        if [&config.production, &config.develop]
            .iter()
            .any(|b| b.starts_with(prefix.as_str()))
        {
            return Err(Error::Other(
                "base branches cannot use a workflow prefix".into(),
            ));
        }
    }
    if !safe_name(&format!("{}example", config.version_tag)) {
        return Err(Error::Other("invalid version tag prefix".into()));
    }
    Ok(())
}

impl Repo {
    pub fn gitflow_state(&self) -> Result<FlowState> {
        let repo = self.git2_owned()?;
        let cfg = repo.config()?.snapshot()?;
        let get =
            |key: &str, fallback: &str| cfg.get_string(key).unwrap_or_else(|_| fallback.into());
        let config = FlowConfig {
            production: get("gitflow.branch.master", ""),
            develop: get("gitflow.branch.develop", ""),
            feature: get("gitflow.prefix.feature", "feature/"),
            release: get("gitflow.prefix.release", "release/"),
            hotfix: get("gitflow.prefix.hotfix", "hotfix/"),
            version_tag: get("gitflow.prefix.versiontag", ""),
        };
        let mut options = BTreeMap::new();
        let mut entries = cfg.entries(Some("^gitflow\\."))?;
        while let Some(entry) = entries.next() {
            let entry = entry?;
            if options.len() >= 1000 || entry.value_bytes().len() > 16384 {
                return Err(Error::Other(
                    "Git-flow configuration is too large to inspect".into(),
                ));
            }
            options.insert(
                entry
                    .name()
                    .ok_or_else(|| Error::Other("Git-flow key is not UTF-8".into()))?
                    .into(),
                entry
                    .value()
                    .ok_or_else(|| Error::Other("Git-flow value is not UTF-8".into()))?
                    .into(),
            );
        }
        let mut branches = BTreeMap::new();
        let mut refs = BTreeMap::new();
        for r in repo.references()? {
            let r = r?;
            if refs.len() >= 20000 {
                return Err(Error::Other("too many refs for Git-flow review".into()));
            }
            if let (Some(name), Some(oid)) = (r.name(), r.target()) {
                refs.insert(name.to_owned(), oid.to_string());
                if let Some(name) = name.strip_prefix("refs/heads/") {
                    branches.insert(name.into(), oid.to_string());
                }
            }
        }
        let head_ref = repo.head()?;
        let head = head_ref.peel_to_commit()?.id().to_string();
        let current = if head_ref.is_branch() {
            head_ref.shorthand().unwrap_or("").to_owned()
        } else {
            String::new()
        };
        let statuses = repo.statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        for status in &statuses {
            status.path_bytes().hash(&mut hash);
            status.status().bits().hash(&mut hash);
            if let Some(path) = status.path() {
                if let Ok(meta) = fs::symlink_metadata(self.path.join(path)) {
                    meta.len().hash(&mut hash);
                    meta.modified().ok().hash(&mut hash);
                }
            }
        }
        for marker in ["HEAD", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD", "index"] {
            let path = self.git_dir().join(marker);
            if let Ok(meta) = fs::metadata(&path) {
                meta.len().hash(&mut hash);
                meta.modified().ok().hash(&mut hash);
            }
        }
        let enabled = cfg.get_bool("strand.gitflow.enabled").unwrap_or(false);
        enabled.hash(&mut hash);
        refs.hash(&mut hash);
        options.hash(&mut hash);
        current.hash(&mut hash);
        head.hash(&mut hash);
        let operation = self.operation_in_progress();
        operation.hash(&mut hash);
        Ok(FlowState {
            enabled,
            config,
            options,
            branches,
            current,
            head,
            operation,
            clean: statuses.is_empty(),
            conflicts: repo.index()?.has_conflicts(),
            token: format!("{:016x}", hash.finish()),
        })
    }

    pub fn configure_gitflow(
        &self,
        config: FlowConfig,
        enabled: bool,
        token: &str,
    ) -> Result<FlowState> {
        let before = self.gitflow_state()?;
        if before.token != token {
            return Err(Error::Other(
                "repository/config changed externally; refresh before saving".into(),
            ));
        }
        if before.operation.is_some() {
            return Err(Error::Other(
                "finish the active Git operation before changing Git-flow settings".into(),
            ));
        }
        if enabled {
            validate_config(&config, &before)?;
        }
        let repo = self.git2_owned()?;
        if repo
            .config()?
            .get_bool("extensions.worktreeConfig")
            .unwrap_or(false)
        {
            return Err(Error::Other(
                "manage per-worktree Git-flow configuration externally".into(),
            ));
        }
        let config_path = self.gix.common_dir().join("config");
        if fs::symlink_metadata(&config_path)?.file_type().is_symlink() {
            return Err(Error::Other(
                "manage symlinked Git config externally".into(),
            ));
        }
        let lock_path = config_path.with_extension("lock");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)?;
        struct Lock(std::path::PathBuf);
        impl Drop for Lock {
            fn drop(&mut self) {
                let _ = fs::remove_file(&self.0);
            }
        }
        let _lock = Lock(lock_path.clone());
        if self.gitflow_state()?.token != token {
            return Err(Error::Other(
                "repository/config changed externally; refresh before saving".into(),
            ));
        }
        if fs::metadata(&config_path)?.len() > 4 * 1024 * 1024 {
            return Err(Error::Other(
                "Git config exceeds the 4 MiB editing limit".into(),
            ));
        }
        let bytes = fs::read(&config_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::set_permissions(&lock_path, fs::metadata(&config_path)?.permissions())?;
        let mut local = git2::Config::open(&lock_path)?;
        local.set_bool("strand.gitflow.enabled", enabled)?;
        if enabled {
            for (key, value) in [
                ("gitflow.branch.master", &config.production),
                ("gitflow.branch.develop", &config.develop),
                ("gitflow.prefix.feature", &config.feature),
                ("gitflow.prefix.release", &config.release),
                ("gitflow.prefix.hotfix", &config.hotfix),
                ("gitflow.prefix.versiontag", &config.version_tag),
            ] {
                local.set_str(key, value)?;
            }
            for (key, value) in [
                ("gitflow.prefix.support", "support/"),
                ("gitflow.prefix.bugfix", "bugfix/"),
            ] {
                if repo.config()?.get_string(key).is_err() {
                    local.set_str(key, value)?;
                }
            }
        }
        drop(local);
        fs::rename(&lock_path, &config_path)?;
        self.gitflow_state()
    }

    pub fn plan_gitflow(&self, kind: FlowKind, action: FlowAction, name: &str) -> Result<FlowPlan> {
        let state = self.gitflow_state()?;
        if !state.enabled {
            return Err(Error::Other(
                "enable Git-flow for this repository first".into(),
            ));
        }
        let mut steps = vec![format!(
            "Current checkout: {} ({})",
            state.current, state.head
        )];
        let mut args = vec![];
        match action {
            FlowAction::ContinueMerge | FlowAction::AbortMerge => {
                if state.operation.as_deref() != Some("merge") {
                    return Err(Error::Other(
                        "no merge is active; refresh and review the next workflow step".into(),
                    ));
                }
                if action == FlowAction::ContinueMerge && state.conflicts {
                    return Err(Error::Other(
                        "resolve and stage every conflict before continuing the merge".into(),
                    ));
                }
                args.extend([
                    "merge".into(),
                    if action == FlowAction::ContinueMerge {
                        "--continue"
                    } else {
                        "--abort"
                    }
                    .into(),
                ]);
                steps.push(if action == FlowAction::ContinueMerge { "Commit the staged merge resolution, then review Finish again to complete any remaining Git-flow stages." } else { "Abort only the current merge. Earlier completed merges/tags remain; this is not a rollback of the entire workflow." }.into());
            }
            FlowAction::Start | FlowAction::Finish => {
                validate_config(&state.config, &state)?;
                if !state.clean || state.operation.is_some() || state.current.is_empty() {
                    return Err(Error::Other(
                        "start/finish requires a clean branch checkout and no active Git operation"
                            .into(),
                    ));
                }
                if !safe_name(name) {
                    return Err(Error::Other(
                        "use an exact workflow name containing letters, digits, /, -, _ or ."
                            .into(),
                    ));
                }
                if self.git_dir().join("gitflow_config").exists() {
                    return Err(Error::Other(
                        "migrate legacy gitflow_config with Git-flow before using this dialog"
                            .into(),
                    ));
                }
                let (kind_name, prefix, base) = match kind {
                    FlowKind::Feature => ("feature", &state.config.feature, &state.config.develop),
                    FlowKind::Release => ("release", &state.config.release, &state.config.develop),
                    FlowKind::Hotfix => ("hotfix", &state.config.hotfix, &state.config.production),
                };
                let branch = format!("{prefix}{name}");
                if state
                    .options
                    .get(&format!("gitflow.branch.{branch}.base"))
                    .is_some_and(|b| b != base)
                {
                    return Err(Error::Other("this workflow has a custom base; finish it with the external Git-flow tool".into()));
                }
                // AVH uses eval for tag message/key arguments; never let arbitrary
                // message text cross that shell boundary. Generated copy is reviewed.
                if state.options.iter().any(|(k, v)| {
                    k.ends_with(".signingkey")
                        && (v.starts_with('-') || v.contains(['\'', '\r', '\n']))
                }) {
                    return Err(Error::Other(
                        "unsupported Git-flow signing key; configure it externally".into(),
                    ));
                }
                args.extend([
                    "flow".into(),
                    kind_name.into(),
                    if action == FlowAction::Start {
                        "start"
                    } else {
                        "finish"
                    }
                    .into(),
                    "--nofetch".into(),
                ]);
                if action == FlowAction::Start {
                    if state.branches.contains_key(&branch) {
                        return Err(Error::Other(
                            "workflow branch already exists; select Finish or a new name".into(),
                        ));
                    }
                    steps.push(format!(
                        "Create and check out {branch} from {base} ({})",
                        state.branches[base]
                    ));
                    args.extend([name.into(), base.clone()]);
                } else {
                    let tip = state.branches.get(&branch).ok_or_else(|| {
                        Error::Other("exact workflow branch does not exist".into())
                    })?;
                    args.extend(["--nopush".into(), "--keep".into(), "--nosquash".into()]);
                    if kind == FlowKind::Feature {
                        args.push("--norebase".into());
                    } else {
                        args.extend([
                            "--nonotag".into(),
                            "--nonobackmerge".into(),
                            format!("--message=Finish {kind_name} {name}"),
                            "--messagefile=".into(),
                            format!("--tagname={name}"),
                        ]);
                        if kind == FlowKind::Release {
                            args.extend([
                                "--nopushproduction".into(),
                                "--nopushdevelop".into(),
                                "--nopushtag".into(),
                                "--nonodevelopmerge".into(),
                                "--noff-master".into(),
                            ]);
                        }
                    }
                    args.push(name.into());
                    let repo = self.git2_owned()?;
                    let destinations = if kind == FlowKind::Feature {
                        vec![&state.config.develop]
                    } else {
                        vec![&state.config.production]
                    };
                    for dest in destinations {
                        let dest_tip = &state.branches[dest];
                        let source = git2::Oid::from_str(tip)?;
                        let destination = git2::Oid::from_str(dest_tip)?;
                        let merged = source == destination
                            || repo.graph_descendant_of(destination, source)?;
                        steps.push(format!(
                            "{branch} ({tip}) → {dest} ({dest_tip}){}",
                            if merged {
                                " — source already merged; AVH skips completed stages"
                            } else {
                                ""
                            }
                        ));
                    }
                    if kind != FlowKind::Feature {
                        let tag = format!("{}{name}", state.config.version_tag);
                        let existing = repo
                            .find_reference(&format!("refs/tags/{tag}"))
                            .ok()
                            .and_then(|r| r.target())
                            .map(|o| o.to_string());
                        steps.push(format!("Tag {tag}: {}. Annotation: Finish {kind_name} {name}. Configured signing is honored.", existing.map(|oid| format!("already exists at {oid}; Git-flow validates it before resuming")).unwrap_or_else(|| "create on production merge".into())));
                        steps.push(format!("Back-merge the resulting production tag {tag} into {} (currently {}). Already completed merges are skipped.", state.config.develop, state.branches[&state.config.develop]));
                    }
                    steps.push(format!("Retain {branch} locally and remotely. No fetch or push. Git and Git-flow hooks still run."));
                }
            }
        }
        Ok(FlowPlan {
            kind,
            action,
            name: name.into(),
            token: state.token,
            args,
            steps,
        })
    }

    pub fn run_gitflow(&self, plan: FlowPlan, progress: impl FnMut(String)) -> Result<FlowOutcome> {
        let current = self.plan_gitflow(plan.kind, plan.action, &plan.name)?;
        if current.token != plan.token || current.args != plan.args || current.steps != plan.steps {
            return Err(Error::Other(
                "Git refs, checkout or configuration changed; review the operation again".into(),
            ));
        }
        if matches!(plan.action, FlowAction::Start | FlowAction::Finish) {
            let tool = detect()?;
            if !tool.available {
                return Err(Error::Other(format!(
                    "Git-flow AVH is required: {}",
                    tool.version
                )));
            }
            if self.gitflow_state()?.token != plan.token {
                return Err(Error::Other(
                    "repository changed during tool detection; review again".into(),
                ));
            }
        }
        let (success, output) = run(&self.path, &current.args, progress)?;
        Ok(FlowOutcome {
            success,
            output,
            state: self.gitflow_state()?,
        })
    }
}
