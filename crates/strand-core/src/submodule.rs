//! Submodules — status, lazy nested inspection, and guarded Git lifecycle actions.
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
    network::{run_git_streaming, CancelHandle, NetworkOutcome, Progress},
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum SubmoduleAction {
    Add { url: String, path: String },
    Remove { path: String },
    Deinit { path: String },
    Sync { path: String, recursive: bool },
    SetUrl { path: String, url: String },
    Update { path: String, recursive: bool },
    Inspect { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmodulePage {
    pub modules: Vec<Submodule>,
    pub next_offset: Option<usize>,
}

impl Repo {
    /// Children are requested a level/page at a time. No recursive dirty walk
    /// is added to the repository snapshot or the sidebar refresh.
    pub fn submodule_children(&self, parent: &str, offset: usize) -> Result<SubmodulePage> {
        let nested;
        let owner = if parent.is_empty() {
            self
        } else {
            nested = self.open_nested_submodule(parent)?;
            &nested
        };
        let repo = owner.git2()?;
        let mut modules = repo.submodules()?;
        modules.sort_by_key(|sm| sm.path().to_path_buf());
        let total = modules.len();
        let mut out = Vec::new();
        for sm in modules.into_iter().skip(offset).take(100) {
            let workdir_id = sm.workdir_id().map(|id| id.to_string());
            let head_id = sm.index_id().map(|id| id.to_string());
            let initialized = workdir_id.is_some();
            out.push(Submodule {
                name: sm.name().unwrap_or_default().into(),
                path: sm.path().to_string_lossy().replace('\\', "/"),
                url: sm.url().map(str::to_owned),
                status: if !initialized {
                    SubmoduleState::Uninitialized
                } else if head_id != workdir_id {
                    SubmoduleState::OutOfDate
                } else {
                    SubmoduleState::UpToDate
                },
                head_id,
                workdir_id,
                initialized,
            });
        }
        Ok(SubmodulePage {
            modules: out,
            next_offset: (offset.saturating_add(100) < total).then_some(offset.saturating_add(100)),
        })
    }

    fn open_nested_submodule(&self, path: &str) -> Result<Repo> {
        validate_module_path(self, path)?;
        // Resolve only registered module edges, never arbitrary nested repos.
        let mut owner = Repo::discover(&self.path)?;
        let mut remaining = path;
        for _ in 0..32 {
            let next = owner
                .git2()?
                .submodules()?
                .into_iter()
                .find_map(|sm| {
                    let child = sm.path().to_string_lossy().replace('\\', "/");
                    (remaining == child || remaining.starts_with(&format!("{child}/")))
                        .then_some(child)
                })
                .ok_or_else(|| Error::Other(format!("Not a registered submodule: {path}")))?;
            let target = owner.path.join(&next);
            let opened = Repo::discover(&target)?;
            if opened.path.canonicalize()? != target.canonicalize()? {
                return Err(Error::Other(format!(
                    "Initialize {path} before inspecting its children."
                )));
            }
            if remaining == next {
                return Ok(opened);
            }
            remaining = &remaining[next.len() + 1..];
            owner = opened;
        }
        Err(Error::Other(
            "Nested submodule depth exceeds 32; open the module as a repository to continue."
                .into(),
        ))
    }

    pub fn submodule_action(
        &self,
        action: SubmoduleAction,
        mut progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        let (path, changes_modules, needs_clean) = match &action {
            SubmoduleAction::Add { path, .. } => (path, true, false),
            SubmoduleAction::Remove { path } => (path, true, true),
            SubmoduleAction::Deinit { path } => (path, false, true),
            SubmoduleAction::SetUrl { path, .. } => (path, true, false),
            SubmoduleAction::Update { path, .. } => (path, false, true),
            SubmoduleAction::Sync { path, .. } | SubmoduleAction::Inspect { path } => {
                (path, false, false)
            }
        };
        validate_module_path(self, path)?;
        let repo = self.git2()?;
        let registered = repo
            .submodules()?
            .into_iter()
            .any(|sm| sm.path() == std::path::Path::new(path));
        if !matches!(action, SubmoduleAction::Add { .. }) && !registered {
            return Err(Error::Other(format!("Not a registered submodule: {path}")));
        }
        let modules_clean = match repo.status_file(std::path::Path::new(".gitmodules")) {
            Ok(status) => status.is_empty(),
            Err(error) => error.code() == git2::ErrorCode::NotFound,
        };
        if changes_modules && !modules_clean {
            return Err(Error::Other("Commit or restore .gitmodules before changing submodule registration; its staged and unstaged edits are preserved.".into()));
        }
        if needs_clean {
            self.ensure_submodule_clean(
                path,
                matches!(
                    action,
                    SubmoduleAction::Remove { .. } | SubmoduleAction::Deinit { .. }
                ),
                &mut progress,
                cancel,
            )?;
        }
        if let SubmoduleAction::Inspect { path } = &action {
            let child = self.open_nested_submodule(path)?;
            return run_git_streaming(
                &child.path,
                &[
                    "status",
                    "--short",
                    "--branch",
                    "--untracked-files=normal",
                    "--ignore-submodules=none",
                ],
                progress,
                cancel,
            );
        }
        let mut args = vec!["--literal-pathspecs".to_string()];
        match action {
            SubmoduleAction::Add { url, path } => {
                crate::network::validate_remote_arg(&url, "submodule URL")?;
                if self.path.join(&path).exists() {
                    return Err(Error::Other(
                        "Choose a new, empty submodule path; existing directories are preserved."
                            .into(),
                    ));
                }
                args.extend([
                    "submodule".into(),
                    "add".into(),
                    "--progress".into(),
                    "--".into(),
                    url,
                    path,
                ]);
            }
            SubmoduleAction::Remove { path } => args.extend(["rm".into(), "--".into(), path]),
            SubmoduleAction::Deinit { path } => {
                args.extend(["submodule".into(), "deinit".into(), "--".into(), path])
            }
            SubmoduleAction::SetUrl { path, url } => {
                crate::network::validate_remote_arg(&url, "submodule URL")?;
                args.extend(["submodule".into(), "set-url".into(), "--".into(), path, url]);
            }
            SubmoduleAction::Sync { path, recursive } => {
                args.extend(["submodule".into(), "sync".into()]);
                if recursive {
                    args.push("--recursive".into());
                }
                args.extend(["--".into(), path]);
            }
            SubmoduleAction::Update { path, recursive } => {
                args.extend([
                    "submodule".into(),
                    "update".into(),
                    "--init".into(),
                    "--progress".into(),
                ]);
                if recursive {
                    args.push("--recursive".into());
                }
                args.extend(["--".into(), path]);
            }
            SubmoduleAction::Inspect { .. } => unreachable!(),
        }
        run_git_streaming(
            &self.path,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            progress,
            cancel,
        )
    }

    fn ensure_submodule_clean(
        &self,
        path: &str,
        require_recorded_commit: bool,
        progress: &mut dyn FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<()> {
        let workdir = self.path.join(path);
        if !workdir.join(".git").exists() {
            if workdir.exists() && std::fs::read_dir(workdir)?.next().is_some() {
                return Err(Error::Other(format!("Uninitialized module {path} contains files. Move or preserve them before retrying.")));
            }
            return Ok(());
        }
        let child = self.open_nested_submodule(path)?;
        let status = run_git_streaming(
            &child.path,
            &[
                "status",
                "--porcelain",
                "--untracked-files=normal",
                "--ignore-submodules=none",
                if require_recorded_commit {
                    "--ignored=matching"
                } else {
                    "--ignored=no"
                },
            ],
            &mut *progress,
            cancel,
        )?;
        if !status.output.is_empty() {
            return Err(Error::Other(format!(
                "{path} has local or nested changes. Commit or stash them before retrying.\n{}",
                status.output
            )));
        }
        if require_recorded_commit {
            let expected = self
                .git2()?
                .index()?
                .get_path(std::path::Path::new(path), 0)
                .map(|e| e.id);
            if child.git2()?.head()?.target() != expected {
                return Err(Error::Other(format!("{path} is checked out at a different commit than the index. Preserve that commit and stage/commit the gitlink before retrying.")));
            }
            // Git's parent status omits ignored files inside nested modules.
            // Before deleting directories, check every initialized child too.
            for nested in child.git2()?.submodules()? {
                let nested_path = nested.path().to_string_lossy().replace('\\', "/");
                child.ensure_submodule_clean(&nested_path, true, progress, cancel)?;
            }
        }
        Ok(())
    }
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
        mut on_progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        let modules = self.git2()?.submodules()?;
        let selected: Vec<String> = if paths.is_empty() {
            modules
                .iter()
                .map(|sm| sm.path().to_string_lossy().replace('\\', "/"))
                .collect()
        } else {
            paths.to_vec()
        };
        for p in &selected {
            validate_module_path(self, p)?;
            if !modules
                .iter()
                .any(|sm| sm.path() == std::path::Path::new(p))
            {
                return Err(Error::Other(format!("Not a registered submodule: {p}")));
            }
            self.ensure_submodule_clean(p, false, &mut on_progress, cancel)?;
        }
        let mut args: Vec<&str> = vec!["--literal-pathspecs", "submodule", "update", "--progress"];
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
        crate::network::run_git_streaming(&self.path, &args, on_progress, cancel)
    }
}

fn validate_module_path(repo: &Repo, path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('-')
        || path.contains(['\0', '\n', '\r', '\\', ':'])
        || path.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
        })
    {
        return Err(Error::Other("Use a repository-relative submodule path with forward slashes and no '.' or '..' components.".into()));
    }
    let root = repo.path.canonicalize()?;
    let mut target = repo.path.clone();
    for part in path.split('/') {
        target.push(part);
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() || !target.canonicalize()?.starts_with(&root) {
                return Err(Error::Other(
                    "Submodule path must stay inside the repository without symlink traversal."
                        .into(),
                ));
            }
        }
    }
    Ok(())
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
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
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
        assert_eq!(
            m.head_id, m.workdir_id,
            "checked out at the recorded commit"
        );
        assert_eq!(m.status, SubmoduleState::UpToDate);

        // Real dirty/untracked state is checked lazily at the mutation boundary.
        std::fs::write(sup.join("sub/local.txt"), "keep me").unwrap();
        for action in [
            SubmoduleAction::Deinit { path: "sub".into() },
            SubmoduleAction::Remove { path: "sub".into() },
            SubmoduleAction::Update {
                path: "sub".into(),
                recursive: true,
            },
        ] {
            assert!(repo
                .submodule_action(action, |_| {}, None)
                .unwrap_err()
                .to_string()
                .contains("local or nested changes"));
        }
        assert_eq!(
            std::fs::read_to_string(sup.join("sub/local.txt")).unwrap(),
            "keep me"
        );
        std::fs::remove_file(sup.join("sub/local.txt")).unwrap();
        let index_before = git(&sup, &["write-tree"]);
        let new_url = format!("{sub_url}-new");
        repo.submodule_action(
            SubmoduleAction::SetUrl {
                path: "sub".into(),
                url: new_url.clone(),
            },
            |_| {},
            None,
        )
        .unwrap();
        assert_eq!(
            git(&sup, &["config", "-f", ".gitmodules", "submodule.sub.url"]),
            new_url
        );
        assert_eq!(git(&sup, &["config", "submodule.sub.url"]), new_url);
        assert_eq!(
            git(&sup, &["write-tree"]),
            index_before,
            "URL edit does not silently stage .gitmodules"
        );
        assert!(
            repo.submodule_action(SubmoduleAction::Remove { path: "sub".into() }, |_| {}, None)
                .is_err(),
            "pending .gitmodules edits are protected"
        );
        git(&sup, &["checkout", "--", ".gitmodules"]);
        repo.submodule_action(
            SubmoduleAction::Sync {
                path: "sub".into(),
                recursive: true,
            },
            |_| {},
            None,
        )
        .unwrap();
        assert_eq!(git(&sup, &["config", "submodule.sub.url"]), sub_url);

        // Add a nested module using the fixture-only local transport override.
        let nested_path = sup.join("sub");
        git(
            &nested_path,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                &sub_url,
                "nested",
            ],
        );
        assert_eq!(
            repo.submodule_children("sub", 0).unwrap().modules[0].path,
            "nested"
        );
        assert!(repo
            .submodule_children("sub/nested", 0)
            .unwrap()
            .modules
            .is_empty());
        assert!(repo.submodule_children("../sub", 0).is_err());
        assert!(repo.submodule_children("sub/a.txt", 0).is_err());
        assert!(repo.submodule_children("", 100).unwrap().modules.is_empty());
        assert!(repo
            .submodule_action(SubmoduleAction::Deinit { path: "sub".into() }, |_| {}, None)
            .is_err());
        git(
            &nested_path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "nested",
            ],
        );
        assert!(repo
            .submodule_action(SubmoduleAction::Deinit { path: "sub".into() }, |_| {}, None)
            .unwrap_err()
            .to_string()
            .contains("different commit"));
        repo.stage_path("sub").unwrap();
        repo.commit("record nested", None, false).unwrap();
        std::fs::write(sup.join("sub/nested/untracked.txt"), "nested data").unwrap();
        assert!(repo
            .submodule_action(SubmoduleAction::Remove { path: "sub".into() }, |_| {}, None)
            .unwrap_err()
            .to_string()
            .contains("local or nested changes"));
        std::fs::remove_file(sup.join("sub/nested/untracked.txt")).unwrap();
        let ignored_rules = base.join("ignored-rules");
        std::fs::write(&ignored_rules, "*.secret\n").unwrap();
        for module in [sup.join("sub"), sup.join("sub/nested")] {
            git(
                &module,
                &[
                    "config",
                    "core.excludesFile",
                    ignored_rules.to_str().unwrap(),
                ],
            );
            std::fs::write(module.join("local.secret"), "ignored local data").unwrap();
            assert!(repo
                .submodule_action(SubmoduleAction::Deinit { path: "sub".into() }, |_| {}, None)
                .unwrap_err()
                .to_string()
                .contains("local or nested changes"));
            assert_eq!(
                std::fs::read_to_string(module.join("local.secret")).unwrap(),
                "ignored local data"
            );
            std::fs::remove_file(module.join("local.secret")).unwrap();
        }
        let before_deinit = git(&sup, &["write-tree"]);
        repo.submodule_action(SubmoduleAction::Deinit { path: "sub".into() }, |_| {}, None)
            .unwrap();
        assert_eq!(git(&sup, &["write-tree"]), before_deinit);
        assert!(sup.join(".gitmodules").exists());
        assert!(!sup.join("sub/a.txt").exists());
        // Local module data survives deinit, so reinitialization needs no fetch.
        repo.submodule_update(&["sub".into()], true, false, |_| {}, None)
            .unwrap();
        assert!(sup.join("sub/a.txt").exists());
        repo.submodule_action(SubmoduleAction::Remove { path: "sub".into() }, |_| {}, None)
            .unwrap();
        assert!(git(&sup, &["ls-files", "--stage", "sub"]).is_empty());
        assert!(!std::fs::read_to_string(sup.join(".gitmodules"))
            .unwrap()
            .contains("submodule"));
        assert!(git(&sup, &["diff", "--cached", "--name-only"]).contains(".gitmodules"));
        assert!(
            sup.join(".git/modules/sub").exists(),
            "local module history retained"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn adds_submodule_over_git_transport_and_preserves_existing_directories() {
        use std::net::{TcpListener, TcpStream};
        let base =
            std::env::temp_dir().join(format!("strand-submodule-add-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let source = base.join("source");
        let target = base.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        git(&source, &["init", "-q", "-b", "main"]);
        std::fs::write(source.join("asset.txt"), "source").unwrap();
        git(&source, &["add", "asset.txt"]);
        git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "initial",
            ],
        );
        git(&target, &["init", "-q", "-b", "main"]);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut daemon = crate::git_command()
            .args([
                "daemon",
                "--export-all",
                "--reuseaddr",
                "--listen=127.0.0.1",
                &format!("--port={port}"),
                &format!("--base-path={}", base.display()),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(started.elapsed().as_secs() < 30);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let repo = Repo::discover(&target).unwrap();
        let url = format!("git://127.0.0.1:{port}/source");
        let result = repo.submodule_action(
            SubmoduleAction::Add {
                url: url.clone(),
                path: "vendor/library".into(),
            },
            |_| {},
            None,
        );
        let _ = daemon.kill();
        let _ = daemon.wait();
        result.unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("vendor/library/asset.txt")).unwrap(),
            "source"
        );
        assert!(git(&target, &["ls-files", "--stage", "vendor/library"]).starts_with("160000"));
        assert!(git(&target, &["show", ":.gitmodules"]).contains(&url));
        let before = git(&target, &["write-tree"]);
        assert!(repo
            .submodule_action(
                SubmoduleAction::Add {
                    url,
                    path: "vendor/library".into()
                },
                |_| {},
                None
            )
            .is_err());
        assert_eq!(git(&target, &["write-tree"]), before);
        let cancel = CancelHandle::new();
        cancel.cancel();
        assert!(matches!(
            repo.submodule_action(
                SubmoduleAction::Sync {
                    path: "vendor/library".into(),
                    recursive: true
                },
                |_| {},
                Some(&cancel)
            ),
            Err(Error::Cancelled)
        ));
        let _ = std::fs::remove_dir_all(base);
    }
}
