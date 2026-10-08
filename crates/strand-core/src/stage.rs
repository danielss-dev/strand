use std::collections::HashSet;
use std::path::Path;

use crate::{error::Result, repo::Repo};

impl Repo {
    /// Stage `path` — adds new/modified files, records deletions. Mirrors
    /// `git add <path>` for one path at a time.
    pub fn stage_path(&self, path: &str) -> Result<()> {
        if self.is_lfs_path(Path::new(path))? {
            return self.stage_lfs_paths(&[path.to_owned()]);
        }
        if self.sparse_enabled() { return self.stage_paths(&[path.into()]); }
        let repo = self.git2()?;
        let mut index = repo.index()?;

        let on_disk = repo.workdir().map(|w| w.join(path));
        let exists = on_disk.as_deref().map(entry_exists).transpose()?.unwrap_or(false);

        if exists {
            index.add_path(Path::new(path))?;
        } else {
            // File was deleted in the working tree. Mirror that in the index.
            index.remove_path(Path::new(path))?;
        }
        index.write()?;
        Ok(())
    }

    /// Stage many paths in one shot: open the repo + index once and write the
    /// index a single time, instead of the per-path open/read/write the store's
    /// old loop did. The difference is dramatic on a large changeset (e.g. a
    /// squash-merge staging hundreds of files) — one index write, not N.
    pub fn stage_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        for path in paths {
            if self.is_lfs_path(Path::new(path))? {
                return self.stage_lfs_paths(paths);
            }
        }
        if self.sparse_enabled() {
            let mut args = vec!["--literal-pathspecs", "add", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.sparse_git(&args, None)?;
            return Ok(());
        }
        let repo = self.git2()?;
        let mut index = repo.index()?;
        let workdir = repo.workdir().map(Path::to_path_buf);
        for path in paths {
            let p = Path::new(path);
            let exists = workdir.as_deref().map(|w| entry_exists(&w.join(path))).transpose()?.unwrap_or(false);
            if exists {
                index.add_path(p)?;
            } else {
                index.remove_path(p)?;
            }
        }
        index.write()?;
        Ok(())
    }

    /// Unstage many paths in one shot. `reset_default` already takes a pathspec
    /// list, so the common (born-HEAD) case is a single call; the unborn-branch
    /// fallback drops the entries with one index write.
    pub fn unstage_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        if paths.iter().any(|path| needs_literal_pathspec(path)) {
            return self.run_literal_paths(
                &["--literal-pathspecs", "reset", "--pathspec-from-file=-", "--pathspec-file-nul"],
                paths.iter().map(String::as_str),
            );
        }
        if self.sparse_enabled() {
            let mut args = vec!["--literal-pathspecs", "restore", "--staged", "--"];
            args.extend(paths.iter().map(String::as_str));
            self.sparse_git(&args, None)?;
            return Ok(());
        }
        let repo = self.git2()?;
        match repo.head().ok().map(|h| h.peel_to_commit()) {
            None => {
                let mut index = repo.index()?;
                for path in paths {
                    let _ = index.remove_path(Path::new(path));
                }
                index.write()?;
            }
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(commit)) => {
                repo.reset_default(Some(commit.as_object()), paths.iter())?;
            }
        }
        Ok(())
    }

    /// Discard working-tree changes for many paths in one `checkout_index`
    /// (each path added as a pathspec). Untracked paths have no index entry
    /// for checkout to restore from — `checkout_index` would silently skip
    /// them — so "discard" for those means deleting the file from disk, the
    /// same way `git clean` would. **Destructive** — undo is a frontend
    /// concern, as in [`discard_path`](Repo::discard_path).
    pub fn discard_paths(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let repo = self.git2()?;
        let index = repo.index()?;
        let workdir = repo.workdir().map(Path::to_path_buf);
        let mut tracked: Vec<&str> = Vec::new();
        for path in paths {
            if index.get_path(Path::new(path), 0).is_some() {
                tracked.push(path);
            } else if let Some(w) = workdir.as_deref() {
                match std::fs::remove_file(w.join(path)) {
                    Ok(()) => {}
                    // Already gone (e.g. a stale status entry) — nothing to do.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
        }
        if !tracked.is_empty() {
            for path in &tracked {
                if self.is_lfs_path(Path::new(path))? {
                    return self.discard_lfs_paths(&tracked);
                }
            }
            if self.sparse_enabled() {
                let mut args = vec!["--literal-pathspecs", "checkout-index", "--force", "--"];
                args.extend(tracked);
                self.sparse_git(&args, None)?;
                return Ok(());
            }
            // git2 0.19 does not expose checkout's literal-pathspec flag.
            // checkout-index consumes exact filenames; ordinary batches stay in-process.
            if tracked.iter().any(|path| needs_literal_pathspec(path)) {
                return self.run_literal_paths(&["checkout-index", "--force", "-z", "--stdin"], tracked.into_iter());
            }
            let mut opts = git2::build::CheckoutBuilder::new();
            // This command opened a fresh repository + index above, so there
            // is nothing stale to refresh. More importantly, libgit2's refresh
            // can walk unrelated ignored directories and hit its legacy
            // MAX_PATH guard on Windows before it checks the pathspec.
            opts.force().refresh(false);
            for path in &tracked {
                opts.path(path);
            }
            if let Err(error) = repo.checkout_index(None, Some(&mut opts)) {
                #[cfg(windows)]
                if is_windows_path_too_long(&error) {
                    checkout_index_with_system_git(self, &tracked)?;
                } else {
                    return Err(error.into());
                }
                #[cfg(not(windows))]
                return Err(error.into());
            }
            // libgit2 force-checkout skips a workdir file when the *filtered*
            // OID matches the index, even if the on-disk bytes still differ
            // (CRLF vs `eol=lf`). Those files stay `M` with an empty patch.
            // `git checkout-index --force` always writes the smudge form.
            rewrite_skipped_checkouts(self, &tracked)?;
        }
        Ok(())
    }

    /// Unstage `path` — reset the index entry for that path back to HEAD,
    /// without touching the working tree. Equivalent to
    /// `git restore --staged <path>`.
    pub fn unstage_path(&self, path: &str) -> Result<()> {
        if self.sparse_enabled() || needs_literal_pathspec(path) { return self.unstage_paths(&[path.into()]); }
        let repo = self.git2()?;
        match repo.head().ok().map(|h| h.peel_to_commit()) {
            // No HEAD yet (unborn branch): just drop the index entry.
            None => {
                let mut index = repo.index()?;
                let _ = index.remove_path(Path::new(path));
                index.write()?;
            }
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(commit)) => {
                repo.reset_default(Some(commit.as_object()), [path])?;
            }
        }
        Ok(())
    }

    fn run_literal_paths<'a>(&self, args: &[&str], paths: impl Iterator<Item = &'a str>) -> Result<()> {
        let mut input = Vec::new();
        for path in paths {
            if path.contains('\0') { return Err(crate::Error::Other("Invalid file path".into())); }
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        let result = crate::network::run_git_input_transcript(&self.path, args, Some(input), |_| {}, None)?;
        if !result.success { return Err(crate::Error::Other(result.output)); }
        Ok(())
    }

    /// Discard working-tree changes for `path` — restore the file from the
    /// index (mirrors `git checkout -- <path>`), or delete it if untracked.
    ///
    /// **Destructive.** The UI is responsible for offering an undo affordance
    /// (we don't snapshot here; the toast undo path is a frontend concern).
    pub fn discard_path(&self, path: &str) -> Result<()> {
        self.discard_paths(&[path.to_owned()])
    }
}

// libgit2 parses glob characters, leading comments/negation and whitespace.
fn needs_literal_pathspec(path: &str) -> bool {
    path.bytes().any(|byte| b"*?[]\\!#:".contains(&byte) || byte.is_ascii_whitespace())
}

fn entry_exists(path: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn is_windows_path_too_long(error: &git2::Error) -> bool {
    error.class() == git2::ErrorClass::Filesystem
        && error
            .message()
            .to_ascii_lowercase()
            .contains("path too long")
}

#[cfg(windows)]
fn checkout_index_with_system_git(repo: &Repo, paths: &[&str]) -> Result<()> {
    let mut args = vec![
        "-c".to_string(),
        "core.longpaths=true".to_string(),
        "checkout-index".to_string(),
        "--force".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().map(|path| (*path).to_string()));
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    repo.run_git(&refs)?;
    Ok(())
}

/// Rewrite tracked paths git2 still reports as workdir-dirty after libgit2
/// checkout. Index `file_size` is cached stat data, not the blob size, so a
/// CLI `git status` / editor refresh while CRLF is on disk makes a size
/// comparison miss. Status on the discard pathspec is the real leftover signal.
fn rewrite_skipped_checkouts(repo: &Repo, tracked: &[&str]) -> Result<()> {
    let skipped = leftover_workdir_paths(repo, tracked)?;
    if skipped.is_empty() {
        return Ok(());
    }
    invalidate_index_stat_cache(repo, &skipped)?;
    let refs: Vec<&str> = skipped.iter().map(String::as_str).collect();
    force_checkout_index(repo, &refs)?;
    repo.git2()?.index()?.read(true)?;
    Ok(())
}

/// `checkout-index --force` still skips a write when cached `file_size` equals
/// the workdir (the CRLF-on-disk + refreshed-index case). Zero the stat cache
/// so Git actually smudge-writes.
fn invalidate_index_stat_cache(repo: &Repo, paths: &[String]) -> Result<()> {
    let git = repo.git2()?;
    let mut index = git.index()?;
    for path in paths {
        let Some(mut entry) = index.get_path(Path::new(path), 0) else { continue };
        entry.file_size = 0;
        entry.mtime = git2::IndexTime::new(0, 0);
        index.add(&entry)?;
    }
    index.write()?;
    Ok(())
}

fn leftover_workdir_paths(repo: &Repo, tracked: &[&str]) -> Result<Vec<String>> {
    if tracked.is_empty() {
        return Ok(Vec::new());
    }
    let git = repo.git2()?;
    let mut opts = git2::StatusOptions::new();
    opts.show(git2::StatusShow::Workdir)
        .include_untracked(false)
        .include_ignored(false)
        .include_unmodified(false)
        .disable_pathspec_match(true);
    for path in tracked {
        opts.pathspec(*path);
    }
    let mut leftover: HashSet<String> = {
        let statuses = git.statuses(Some(&mut opts))?;
        statuses
            .iter()
            .filter(|entry| {
                let status = entry.status();
                status.is_wt_modified() || status.is_wt_deleted()
            })
            .filter_map(|entry| entry.path().map(str::to_owned))
            .collect()
    };
    // Filtered OID can match while on-disk bytes are still CRLF. After a CLI
    // `git status` refreshes `file_size` to the CRLF length, git2 status is
    // clean — so also rewrite paths whose workdir and index blob differ only
    // by CR/LF.
    if let Some(workdir) = git.workdir() {
        let index = git.index()?;
        for path in tracked {
            if leftover.contains(*path) {
                continue;
            }
            let Some(entry) = index.get_path(Path::new(path), 0) else { continue };
            let Ok(disk) = std::fs::read(workdir.join(path)) else { continue };
            let Ok(blob) = git.find_blob(entry.id) else { continue };
            if crate::diff::only_line_endings_differ(&disk, blob.content()) {
                leftover.insert((*path).to_string());
            }
        }
    }
    Ok(leftover.into_iter().collect())
}

fn force_checkout_index(repo: &Repo, paths: &[&str]) -> Result<()> {
    repo.run_literal_paths(
        &["-c", "core.longpaths=true", "checkout-index", "--force", "-z", "--stdin"],
        paths.iter().copied(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::FileStatus;

    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-stage-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        // Configure an identity so `Repo::commit` (which reads `repo.signature()`)
        // works without relying on the machine's global git config.
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
            cfg.set_bool("commit.gpgsign", false).unwrap();
        }
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    fn staged_paths(status: &[FileStatus]) -> Vec<&str> {
        status.iter().filter(|s| s.staged).map(|s| s.path.as_str()).collect()
    }

    #[test]
    fn stage_paths_then_unstage_paths_round_trips_in_one_call_each() {
        let (repo, dir) = scratch_repo();
        let files: Vec<String> = (0..5).map(|i| format!("f{i}.txt")).collect();
        for f in &files {
            std::fs::write(dir.join(f), "x\n").unwrap();
        }

        // One batched stage call lands every path in the index.
        repo.stage_paths(&files).unwrap();
        let status = repo.status().unwrap();
        let mut staged = staged_paths(&status);
        staged.sort();
        assert_eq!(staged, vec!["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);

        // One batched unstage call clears them all again.
        repo.unstage_paths(&files).unwrap();
        assert!(repo.status().unwrap().iter().all(|s| !s.staged), "nothing staged after unstage");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn discard_paths_deletes_untracked_and_restores_tracked() {
        let (repo, dir) = scratch_repo();
        // Tracked file with a local edit…
        std::fs::write(dir.join("tracked.txt"), "clean\n").unwrap();
        repo.stage_paths(&["tracked.txt".into()]).unwrap();
        repo.commit("add tracked", None, false).unwrap();
        std::fs::write(dir.join("tracked.txt"), "dirty\n").unwrap();
        // …plus an untracked file, discarded together in one call.
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();

        repo.discard_paths(&["tracked.txt".into(), "untracked.txt".into()]).unwrap();

        let restored = std::fs::read_to_string(dir.join("tracked.txt")).unwrap();
        // autocrlf may rewrite line endings on checkout — compare normalized.
        assert_eq!(restored.replace("\r\n", "\n"), "clean\n");
        assert!(!dir.join("untracked.txt").exists(), "untracked file deleted from disk");
        // Discarding an already-gone path is a no-op, not an error.
        repo.discard_paths(&["untracked.txt".into()]).unwrap();

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn system_git_checkout_restores_with_unrelated_long_ignored_path() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("tracked.txt"), "clean\n").unwrap();
        repo.stage_paths(&["tracked.txt".into()]).unwrap();
        repo.commit("add tracked", None, false).unwrap();
        std::fs::write(dir.join("tracked.txt"), "dirty\n").unwrap();

        let ignored = dir
            .join(".claude/worktrees/generated/node_modules/.pnpm")
            .join("react-resizable-panels@2.1.9_react-dom@18.3.1_react@18.3.1__react@18.3.1")
            .join("node_modules/react-resizable-panels/dist/declarations/src/utils/dom");
        std::fs::create_dir_all(&ignored).unwrap();
        std::fs::write(
            ignored.join("getResizeHandleElementsForGroup.d.ts"),
            "generated\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(".claude/worktrees/generated/.git"),
            "gitdir: nowhere\n",
        )
        .unwrap();
        std::fs::write(dir.join(".git/info/exclude"), ".claude/worktrees/\n").unwrap();

        checkout_index_with_system_git(&repo, &["tracked.txt"]).unwrap();

        let restored = std::fs::read_to_string(dir.join("tracked.txt")).unwrap();
        assert_eq!(restored.replace("\r\n", "\n"), "clean\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_long_path_checkout_error_is_detected_narrowly() {
        let long_path = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Filesystem,
            "path too long: 'generated/file'",
        );
        assert!(is_windows_path_too_long(&long_path));

        let other_filesystem = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Filesystem,
            "permission denied",
        );
        assert!(!is_windows_path_too_long(&other_filesystem));

        let wrong_class = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Checkout,
            "path too long",
        );
        assert!(!is_windows_path_too_long(&wrong_class));
    }

    #[test]
    fn stage_paths_records_a_deletion() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("keep.txt"), "x\n").unwrap();
        repo.stage_paths(&["keep.txt".into()]).unwrap();
        repo.commit("add keep", None, false).unwrap();

        // Delete on disk, then a batched stage should stage the removal.
        std::fs::remove_file(dir.join("keep.txt")).unwrap();
        repo.stage_paths(&["keep.txt".into()]).unwrap();
        let status = repo.status().unwrap();
        let entry = status.iter().find(|s| s.path == "keep.txt").expect("deletion tracked");
        assert!(entry.staged, "deletion is staged");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn literal_discard_and_unstage_preserve_unselected_files() {
        let (repo, dir) = scratch_repo();
        let names = vec!["[id].tsx", "i.tsx", "!bang", "#hash", "space name"];
        #[cfg(unix)]
        let names = [names, vec!["a*.txt", "abc.txt", "q?.txt", "qa.txt", ":(glob)*", "back\\slash"]].concat();
        let paths: Vec<String> = names.iter().map(|name| (*name).into()).collect();
        for name in &names { std::fs::write(dir.join(name), "base").unwrap(); }
        repo.stage_paths(&paths).unwrap();
        repo.commit("literal base", None, false).unwrap();
        for name in &names { std::fs::write(dir.join(name), "edited").unwrap(); }
        repo.discard_path("[id].tsx").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("[id].tsx")).unwrap(), "base");
        assert_eq!(std::fs::read_to_string(dir.join("i.tsx")).unwrap(), "edited");
        let selected: Vec<String> = paths.iter().filter(|name| needs_literal_pathspec(name)).cloned().collect();
        repo.discard_paths(&selected).unwrap();
        for name in &selected { assert_eq!(std::fs::read_to_string(dir.join(name)).unwrap(), "base"); }
        assert_eq!(std::fs::read_to_string(dir.join("i.tsx")).unwrap(), "edited");
        for name in &names { std::fs::write(dir.join(name), "staged").unwrap(); }
        repo.stage_paths(&paths).unwrap();
        repo.unstage_path("[id].tsx").unwrap();
        let status = repo.status().unwrap();
        assert!(!staged_paths(&status).contains(&"[id].tsx"));
        assert!(staged_paths(&status).contains(&"i.tsx"));
        repo.unstage_paths(&selected).unwrap();
        let status = repo.status().unwrap();
        assert!(staged_paths(&status).contains(&"i.tsx"));
        for name in &selected { assert!(!staged_paths(&status).contains(&name.as_str())); }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn literal_unstage_works_before_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        for name in ["[id].tsx", "i.tsx"] { std::fs::write(dir.path().join(name), "new").unwrap(); }
        repo.stage_paths(&["[id].tsx".into(), "i.tsx".into()]).unwrap();
        repo.unstage_path("[id].tsx").unwrap();
        assert_eq!(staged_paths(&repo.status().unwrap()), ["i.tsx"]);
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn git_stdout(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn eol_lf_crlf_repo() -> (Repo, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join(".gitattributes"), "* text eol=lf\n").unwrap();
        std::fs::write(root.join("package.json"), "{\n  \"name\": \"x\"\n}\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "lf"]);
        std::fs::write(root.join("package.json"), "{\r\n  \"name\": \"x\"\r\n}\r\n").unwrap();
        (Repo::discover(root.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn discard_paths_rewrites_crlf_when_attributes_require_lf() {
        let (repo, dir) = eol_lf_crlf_repo();
        let root = dir.path();
        assert_eq!(git_stdout(root, &["status", "--porcelain=v1"]).trim(), "M package.json");
        assert!(git_stdout(root, &["diff"]).trim().is_empty(), "git diff is empty before discard");
        let diffs = repo.diff_unstaged().unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].path, "package.json");
        assert_eq!((diffs[0].adds, diffs[0].dels), (0, 0));
        assert!(diffs[0].patch.is_empty());
        assert_eq!(diffs[0].note.as_deref(), Some("Only line endings differ"));

        repo.discard_paths(&["package.json".into()]).unwrap();
        let repo = Repo::discover(root.to_str().unwrap()).unwrap();
        assert!(repo.status().unwrap().is_empty(), "discard must leave a clean status");
        assert!(repo.diff_unstaged().unwrap().is_empty());
        assert!(git_stdout(root, &["status", "--porcelain=v1"]).trim().is_empty());
        let on_disk = std::fs::read(root.join("package.json")).unwrap();
        assert_eq!(on_disk, b"{\n  \"name\": \"x\"\n}\n");
    }

    #[test]
    fn discard_paths_rewrites_crlf_after_index_stat_refresh() {
        let (repo, dir) = eol_lf_crlf_repo();
        let root = dir.path();
        git(root, &["status", "--porcelain=v1"]);
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["update-index", "--refresh"])
            .output();
        {
            let git2 = repo.git2().unwrap();
            let mut index = git2.index().unwrap();
            let mut entry = index.get_path(Path::new("package.json"), 0).unwrap();
            let size = std::fs::metadata(root.join("package.json")).unwrap().len() as u32;
            assert_ne!(entry.file_size, size, "index still has the LF blob size before we smash it");
            entry.file_size = size;
            index.add(&entry).unwrap();
            index.write().unwrap();
            assert_eq!(
                index.get_path(Path::new("package.json"), 0).unwrap().file_size,
                size,
                "cached stat now matches the CRLF workdir; a size heuristic would skip"
            );
        }
        assert_eq!(
            leftover_workdir_paths(&repo, &["package.json"]).unwrap(),
            vec!["package.json".to_string()],
            "CRLF vs LF blob must still be rewritten after the stat cache matches the workdir size"
        );
        repo.discard_paths(&["package.json".into()]).unwrap();
        let repo = Repo::discover(root.to_str().unwrap()).unwrap();
        assert!(repo.status().unwrap().is_empty());
        assert!(git_stdout(root, &["status", "--porcelain=v1"]).trim().is_empty());
        assert_eq!(std::fs::read(root.join("package.json")).unwrap(), b"{\n  \"name\": \"x\"\n}\n");
    }

    #[test]
    fn discard_paths_clears_eol_lf_ghosts_in_a_mixed_batch() {
        let (repo, dir) = eol_lf_crlf_repo();
        let root = dir.path();
        let mut paths = vec!["package.json".to_string()];
        for i in 0..12 {
            let name = format!("f{i}.txt");
            std::fs::write(root.join(&name), format!("clean {i}\n")).unwrap();
            paths.push(name);
        }
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "batch"]);
        std::fs::write(root.join("package.json"), "{\r\n  \"name\": \"x\"\r\n}\r\n").unwrap();
        for i in 0..12 {
            std::fs::write(root.join(format!("f{i}.txt")), format!("dirty {i}\n")).unwrap();
        }
        repo.discard_paths(&paths).unwrap();
        let repo = Repo::discover(root.to_str().unwrap()).unwrap();
        assert!(repo.status().unwrap().is_empty());
        assert!(git_stdout(root, &["status", "--porcelain=v1"]).trim().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn discard_paths_restores_mode_only_change() {
        let (repo, dir) = scratch_repo();
        std::fs::write(dir.join("script.sh"), "echo hi\n").unwrap();
        repo.stage_paths(&["script.sh".into()]).unwrap();
        repo.commit("script", None, false).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dir.join("script.sh")).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dir.join("script.sh"), perms).unwrap();
        let diffs = repo.diff_unstaged().unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!((diffs[0].adds, diffs[0].dels), (0, 0));
        assert_eq!(diffs[0].note.as_deref(), Some("File mode changed 100644 → 100755"));
        repo.discard_paths(&["script.sh".into()]).unwrap();
        assert!(repo.status().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn stages_new_and_modified_dangling_links_singly_and_in_bulk() {
        let (repo, dir) = scratch_repo();
        for bulk in [false, true] {
            let name = if bulk { "bulk-link" } else { "single-link" };
            for target in ["missing-first", "missing-second"] {
                let _ = std::fs::remove_file(dir.join(name));
                std::os::unix::fs::symlink(target, dir.join(name)).unwrap();
                if bulk { repo.stage_paths(&[name.into()]).unwrap(); }
                else { repo.stage_path(name).unwrap(); }
                let entry = repo.git2().unwrap().index().unwrap().get_path(Path::new(name), 0).unwrap();
                assert_eq!(entry.mode, 0o120000);
                assert_eq!(repo.git2().unwrap().find_blob(entry.id).unwrap().content(), target.as_bytes());
                repo.commit("link", None, false).unwrap();
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
