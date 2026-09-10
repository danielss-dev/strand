//! Stage inspected contents without ever passing mutable worktree paths to Git add.

use std::{collections::HashSet, fs::{self, File, OpenOptions}, io::Write, path::{Component, Path, PathBuf}, process::Stdio};
use serde::{Deserialize, Serialize};
use crate::{diff::FileDiff, Error, Repo, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewedStageState {
    pub workdir: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub head_ref: Option<String>,
    pub head_oid: Option<String>,
    pub index_hash: Option<String>,
}

fn stale() -> Error {
    Error::Other("The repository, index, or reviewed contents changed. Refresh Review and inspect the changes before staging reviewed files.".into())
}

fn read_index(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

impl Repo {
    /// Read before refreshing the review pool so concurrent index/HEAD changes
    /// cannot change the meaning of the later reviewed-file write.
    pub fn reviewed_stage_state(&self) -> Result<ReviewedStageState> {
        let repo = self.git2()?;
        let head = repo.find_reference("HEAD")?;
        let head_oid = match head.resolve() {
            Ok(head) => head.target().map(|oid| oid.to_string()),
            Err(e) if e.code() == git2::ErrorCode::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let git_dir = self.git_dir().canonicalize()?;
        Ok(ReviewedStageState {
            workdir: self.path.canonicalize()?,
            git_dir: git_dir.clone(),
            common_dir: self.gix.common_dir().canonicalize()?,
            head_ref: head.symbolic_target().map(str::to_owned),
            head_oid,
            index_hash: read_index(&git_dir.join("index"))?.map(|bytes| git2::Oid::hash_object(git2::ObjectType::Blob, &bytes).map(|oid| oid.to_string())).transpose()?,
        })
    }

    pub fn stage_reviewed(&self, state: &ReviewedStageState, baseline: Option<&str>, files: &[FileDiff]) -> Result<()> {
        self.stage_reviewed_captured(state, baseline, files, || {})
    }

    fn stage_reviewed_captured(&self, state: &ReviewedStageState, baseline: Option<&str>, files: &[FileDiff], after_capture: impl FnOnce()) -> Result<()> {
        if files.is_empty() { return Ok(()); }
        if self.reviewed_stage_state()? != *state { return Err(stale()); }
        let repo = self.git2()?;
        // Cooperate with Git's write locks, including checkout and commits in
        // another linked worktree. No reference is modified by this transaction.
        let mut refs = repo.transaction()?;
        refs.lock_ref("HEAD")?;
        if let Some(name) = &state.head_ref { refs.lock_ref(name)?; }
        let mut lock = IndexLock::acquire(&state.git_dir)?;
        if self.reviewed_stage_state()? != *state { return Err(stale()); }
        if repo.index()?.has_conflicts() {
            return Err(Error::Other("Resolve index conflicts before staging reviewed files.".into()));
        }
        let base = match baseline.or(state.head_oid.as_deref()) {
            Some(oid) => repo.find_commit(git2::Oid::from_str(oid)?)?.tree()?,
            None => repo.find_tree(repo.treebuilder(None)?.write()?)?,
        };
        let index = repo.index()?;
        let current = self.reviewed_stage_targets(&index)?;
        let mut selected = HashSet::new();
        let mut updates = Vec::new();
        for file in files {
            validate_path(&file.path)?;
            if !selected.insert(&file.path) { return Err(Error::Other("Duplicate reviewed path.".into())); }
            let Some(target) = current.iter().find(|target| target.path == file.path) else { continue; };
            if file.binary || file.patch.is_empty() {
                return Err(Error::Other(format!("{} has no complete textual review patch. Inspect it and use ordinary Stage for this file.", file.path)));
            }
            let diff = git2::Diff::from_buffer(file.patch.as_bytes()).map_err(|_| Error::Other(format!("The Git patch for {} cannot be reconstructed safely by Stage reviewed. Inspect it and use ordinary Stage for this file.", file.path)))?;
            let delta = diff.get_delta(0).ok_or_else(stale)?;
            if diff.deltas().len() != 1 || delta.new_file().path() != Some(Path::new(&file.path)) || delta.old_file().path() != Some(Path::new(file.old_path.as_deref().unwrap_or(&file.path))) {
                return Err(stale());
            }
            if let Some(old) = &file.old_path { validate_path(old)?; }
            // The reviewed patch, applied only in memory to its immutable base,
            // proves the complete target content. We never apply it to the real index.
            let inspected = repo.apply_to_tree(&base, &diff, None).map_err(|_| stale())?;
            let expected = inspected.get_path(Path::new(&file.path), 0);
            let captured = capture_file(self, &file.path, &index)?;
            match (expected, captured) {
                (None, None) => updates.push((file.path.clone(), 0, git2::Oid::zero())),
                (Some(entry), Some((mode, bytes))) if mode == entry.mode && matches!(mode, 0o100644 | 0o100755 | 0o120000) => {
                    let raw = git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)?;
                    let filtered = if mode == 0o120000 {
                        repo.blob(&bytes)?
                    } else {
                        if self.is_lfs_path(Path::new(&file.path))? {
                            let config = repo.config()?;
                            if !["filter.lfs.process", "filter.lfs.clean"].iter().any(|key| config.get_string(key).is_ok_and(|v| !v.trim().is_empty())) {
                                return Err(Error::Other("LFS filters are not configured. Set up Git LFS before staging reviewed files.".into()));
                            }
                        }
                        let oid = run_git(self, None, &["-c", "filter.lfs.required=true", "hash-object", "-w", "--stdin", &format!("--path={}", file.path)], Some(&bytes))?;
                        git2::Oid::from_str(std::str::from_utf8(&oid).map_err(|_| stale())?.trim())?
                    };
                    // libgit2 diffs may show raw custom-filter/LFS contents;
                    // Git-backed sparse diffs and CRLF conversion show clean contents.
                    if raw != entry.id && filtered != entry.id { return Err(stale()); }
                    updates.push((file.path.clone(), mode, filtered));
                }
                _ => return Err(stale()),
            }
            // Only the current index-to-workdir rename owns a source deletion.
            // A historical baseline's old_path may name an unrelated live file.
            if let Some(old) = &target.old_path {
                if capture_file(self, old, &index)?.is_none() {
                    updates.push((old.clone(), 0, git2::Oid::zero()));
                }
            }
        }
        if updates.is_empty() { return Ok(()); }
        after_capture();
        let temp = TemporaryIndex::new(&state.git_dir)?;
        if let Some(bytes) = read_index(&state.git_dir.join("index"))? {
            fs::write(&temp.index, bytes)?;
        }
        let mut input = Vec::new();
        for (path, mode, oid) in updates {
            input.extend_from_slice(format!("{mode:o} {oid}\t{path}\0").as_bytes());
        }
        // Git understands sparse-directory index extensions. Updating
        // captured OIDs preserves untouched entries and never reads worktree bytes.
        run_git(self, Some(&temp.index), &["update-index", "-z", "--index-info"], Some(&input))?;
        if Repo::discover(&state.workdir)?.reviewed_stage_state()? != *state { return Err(stale()); }
        lock.publish(&fs::read(&temp.index)?)?;
        Ok(())
    }

    fn reviewed_stage_targets(&self, index: &git2::Index) -> Result<Vec<crate::diff::DiffPath>> {
        // Git-backed enumeration protects sparse excluded paths. Ask libgit2
        // only about those concrete candidates, including untracked rename ends.
        let candidates = self.diff_unstaged_paths()?;
        if candidates.is_empty() { return Ok(candidates); }
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true).disable_pathspec_match(true);
        for target in &candidates {
            opts.pathspec(&target.path);
            if let Some(old) = &target.old_path { opts.pathspec(old); }
        }
        let mut diff = self.git2()?.diff_index_to_workdir(Some(index), Some(&mut opts))?;
        diff.find_similar(Some(git2::DiffFindOptions::new().renames(true).for_untracked(true)))?;
        Ok(diff.deltas().map(|delta| crate::diff::DiffPath {
            path: delta.new_file().path().unwrap_or_else(|| Path::new("")).to_string_lossy().into_owned(),
            old_path: (delta.status() == git2::Delta::Renamed).then(|| delta.old_file().path().unwrap_or_else(|| Path::new("")).to_string_lossy().into_owned()),
        }).collect())
    }
}

fn validate_path(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\0') || cfg!(windows) && path.contains('\\') || Path::new(path).components().any(|part| !matches!(part, Component::Normal(_)) || part.as_os_str().to_str().is_some_and(|s| s.eq_ignore_ascii_case(".git"))) {
        return Err(Error::Other("Invalid reviewed file path.".into()));
    }
    Ok(())
}

fn capture_file(repo: &Repo, path: &str, index: &git2::Index) -> Result<Option<(u32, Vec<u8>)>> {
    validate_path(path)?;
    let mut full = repo.path.clone();
    let parts: Vec<_> = Path::new(path).components().collect();
    for (i, part) in parts.iter().enumerate() {
        full.push(part.as_os_str());
        match fs::symlink_metadata(&full) {
            Ok(meta) if i + 1 < parts.len() && (!meta.is_dir() || meta.file_type().is_symlink()) => return Err(stale()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
            _ => {}
        }
    }
    let meta = fs::symlink_metadata(&full)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(full)?;
        #[cfg(unix)]
        let bytes = { use std::os::unix::ffi::OsStrExt; target.as_os_str().as_bytes().to_vec() };
        #[cfg(not(unix))]
        let bytes = target.to_str().ok_or_else(stale)?.as_bytes().to_vec();
        return Ok(Some((0o120000, bytes)));
    }
    if !meta.is_file() { return Err(Error::Other(format!("{path} is not a regular file. Use ordinary Stage for submodules."))); }
    let config = repo.git2()?.config()?;
    let old_mode = index.get_path(Path::new(path), 0).map(|entry| entry.mode);
    let mut mode = if old_mode == Some(0o120000) && !config.get_bool("core.symlinks").unwrap_or(true) { 0o120000 } else { old_mode.filter(|m| matches!(m, 0o100644 | 0o100755)).unwrap_or(0o100644) };
    #[cfg(unix)]
    if config.get_bool("core.filemode").unwrap_or(true) {
        use std::os::unix::fs::PermissionsExt;
        mode = if meta.permissions().mode() & 0o111 != 0 { 0o100755 } else { 0o100644 };
    }
    #[cfg(not(unix))]
    let _ = &mut mode;
    Ok(Some((mode, fs::read(full)?)))
}

fn run_git(repo: &Repo, index: Option<&Path>, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut command = crate::git_command();
    command.current_dir(&repo.path).args(crate::GIT_SAFE_CONFIG)
        .env_remove("GIT_DIR").env_remove("GIT_WORK_TREE").env_remove("GIT_COMMON_DIR").env_remove("GIT_INDEX_FILE")
        .env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0")
        .arg("--git-dir").arg(repo.git_dir()).arg("--work-tree").arg(&repo.path).args(args);
    if let Some(index) = index { command.env("GIT_INDEX_FILE", git_path(index)); }
    let mut child = command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let output = std::thread::scope(|scope| {
        let writer = input.map(|input| { let mut stdin = child.stdin.take().expect("piped stdin"); scope.spawn(move || stdin.write_all(input)) });
        let output = child.wait_with_output();
        if let Some(writer) = writer { let _ = writer.join(); }
        output
    })?;
    if !output.status.success() { return Err(Error::Other(String::from_utf8_lossy(&output.stderr).trim().into())); }
    Ok(output.stdout)
}

fn git_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    // Git for Windows does not accept verbatim prefixes in GIT_INDEX_FILE.
    if cfg!(windows) {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") { return format!(r"\\{unc}"); }
        if let Some(path) = path.strip_prefix(r"\\?\") { return path.to_owned(); }
    }
    path.into_owned()
}

struct IndexLock { path: PathBuf, file: Option<File>, published: bool }
impl IndexLock {
    fn acquire(git_dir: &Path) -> Result<Self> {
        let path = git_dir.join("index.lock");
        let file = OpenOptions::new().create_new(true).write(true).open(&path)
            .map_err(|e| Error::Other(format!("Cannot lock the index for Stage reviewed: {e}. Finish other Git operations and retry.")))?;
        Ok(Self { path, file: Some(file), published: false })
    }
    fn publish(&mut self, bytes: &[u8]) -> Result<()> {
        let file = self.file.as_mut().expect("index lock held");
        file.write_all(bytes)?;
        file.sync_all()?;
        self.file.take();
        fs::rename(&self.path, self.path.with_file_name("index"))?;
        self.published = true;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) { self.file.take(); if !self.published { let _ = fs::remove_file(&self.path); } }
}

struct TemporaryIndex { dir: PathBuf, index: PathBuf }
impl TemporaryIndex {
    fn new(git_dir: &Path) -> Result<Self> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        loop {
            let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = git_dir.join(format!("strand-reviewed-stage-{}-{id}", std::process::id()));
            match fs::create_dir(&dir) {
                Ok(()) => return Ok(Self { index: dir.join("index"), dir }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
}
impl Drop for TemporaryIndex {
    fn drop(&mut self) { let _ = fs::remove_file(&self.index); let _ = fs::remove_file(self.index.with_extension("lock")); let _ = fs::remove_dir(&self.dir); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = crate::git_command().current_dir(path).args(crate::GIT_SAFE_CONFIG).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim_end().to_owned()
    }
    fn fixture() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            git(dir.path(), &["config", key, value]);
        }
        fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        fs::write(dir.path().join("other.txt"), "untouched\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "base"]);
        let repo = Repo::discover(dir.path()).unwrap();
        (dir, repo)
    }
    fn reviewed(repo: &Repo) -> (ReviewedStageState, Vec<FileDiff>) {
        (repo.reviewed_stage_state().unwrap(), repo.diff_since_full("HEAD").unwrap())
    }
    fn index_bytes(repo: &Repo) -> Vec<u8> { fs::read(repo.git_dir().join("index")).unwrap() }

    #[test]
    fn concurrent_edit_after_capture_never_enters_the_index() {
        let (dir, repo) = fixture();
        fs::write(dir.path().join("file.txt"), "inspected\n").unwrap();
        let (state, files) = reviewed(&repo);
        repo.stage_reviewed_captured(&state, None, &files, || {
            fs::write(dir.path().join("file.txt"), "newer unreviewed\n").unwrap();
            assert!(repo.git_dir().join("index.lock").exists());
            assert!(!crate::git_command().current_dir(dir.path()).args(["add", "file.txt"]).output().unwrap().status.success());
            assert!(!crate::git_command().current_dir(dir.path()).args(["update-ref", "refs/heads/main", &git(dir.path(), &["rev-parse", "HEAD"])]).output().unwrap().status.success());
        }).unwrap();
        assert_eq!(git(dir.path(), &["show", ":file.txt"]), "inspected");
        assert_eq!(fs::read_to_string(dir.path().join("file.txt")).unwrap(), "newer unreviewed\n");
        assert!(git(dir.path(), &["diff", "--", "file.txt"]).contains("newer unreviewed"));
    }

    #[test]
    fn stale_file_rejects_the_entire_batch_without_touching_index() {
        let (dir, repo) = fixture();
        fs::write(dir.path().join("file.txt"), "inspected\n").unwrap();
        fs::write(dir.path().join("other.txt"), "also inspected\n").unwrap();
        let (state, files) = reviewed(&repo);
        let before = index_bytes(&repo);
        fs::write(dir.path().join("other.txt"), "newer\n").unwrap();
        assert!(repo.stage_reviewed(&state, None, &files).unwrap_err().to_string().contains("changed"));
        assert_eq!(index_bytes(&repo), before);
        assert!(!repo.git_dir().join("index.lock").exists());
    }

    #[test]
    fn changed_head_or_index_invalidates_prepared_review() {
        let (dir, repo) = fixture();
        fs::write(dir.path().join("file.txt"), "inspected\n").unwrap();
        let (state, files) = reviewed(&repo);
        fs::write(dir.path().join("other.txt"), "staged by agent\n").unwrap();
        git(dir.path(), &["add", "other.txt"]);
        let changed_index = index_bytes(&repo);
        assert!(repo.stage_reviewed(&state, None, &files).is_err());
        assert_eq!(index_bytes(&repo), changed_index);
        let (state, files) = reviewed(&Repo::discover(dir.path()).unwrap());
        git(dir.path(), &["commit", "--allow-empty", "-qm", "agent commit"]);
        let after_commit = index_bytes(&repo);
        assert!(Repo::discover(dir.path()).unwrap().stage_reviewed(&state, None, &files).is_err());
        assert_eq!(index_bytes(&repo), after_commit);
    }

    #[test]
    fn noncooperating_index_edit_after_capture_is_not_overwritten() {
        let (dir, repo) = fixture();
        fs::write(dir.path().join("file.txt"), "inspected\n").unwrap();
        let (state, files) = reviewed(&repo);
        let original = index_bytes(&repo);
        let mut changed = original.clone();
        changed.push(1);
        let error = repo.stage_reviewed_captured(&state, None, &files, || fs::write(repo.git_dir().join("index"), &changed).unwrap());
        assert!(error.is_err());
        assert_eq!(index_bytes(&repo), changed);
        fs::write(repo.git_dir().join("index"), original).unwrap();
    }

    #[test]
    fn current_rename_deletion_is_staged_without_using_historical_source() {
        let (dir, repo) = fixture();
        let baseline = git(dir.path(), &["rev-parse", "HEAD"]);
        fs::rename(dir.path().join("file.txt"), dir.path().join("middle.txt")).unwrap();
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-qm", "rename before session"]);
        fs::rename(dir.path().join("middle.txt"), dir.path().join("new.txt")).unwrap();
        fs::write(dir.path().join("file.txt"), "unrelated original-name work\n").unwrap();
        let repo = Repo::discover(repo.path()).unwrap();
        let state = repo.reviewed_stage_state().unwrap();
        let files = repo.diff_since_full(&baseline).unwrap().into_iter().filter(|f| f.path == "new.txt").collect::<Vec<_>>();
        assert_eq!(files.len(), 1);
        assert!(repo.reviewed_stage_targets(&repo.git2().unwrap().index().unwrap()).unwrap().iter().any(|d| d.path == "new.txt" && d.old_path.as_deref() == Some("middle.txt")));
        repo.stage_reviewed(&state, Some(&baseline), &files).unwrap();
        assert_eq!(git(dir.path(), &["show", ":new.txt"]), "base");
        assert_eq!(git(dir.path(), &["ls-files", "middle.txt", "file.txt"]), "");
        assert_eq!(fs::read_to_string(dir.path().join("file.txt")).unwrap(), "unrelated original-name work\n");
    }

    #[test]
    fn pure_rename_and_deletion_keep_their_modes_and_both_index_paths() {
        let (dir, repo) = fixture();
        fs::rename(dir.path().join("file.txt"), dir.path().join("renamed.txt")).unwrap();
        fs::remove_file(dir.path().join("other.txt")).unwrap();
        let (state, files) = reviewed(&repo);
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert_eq!(git(dir.path(), &["ls-files"]), "renamed.txt");
        assert_eq!(git(dir.path(), &["show", ":renamed.txt"]), "base");
    }

    #[test]
    fn rename_with_spaces_stages_safely_or_explains_parser_fallback() {
        for sparse in [false, true] {
            let (dir, _) = fixture();
            let original = (0..30).map(|line| format!("context {line}\n")).collect::<String>();
            fs::write(dir.path().join("file.txt"), &original).unwrap();
            git(dir.path(), &["add", "file.txt"]);
            git(dir.path(), &["commit", "-qm", "rename context"]);
            if sparse { git(dir.path(), &["sparse-checkout", "set", "--cone", "--sparse-index", "included"]); }
            git(dir.path(), &["mv", "file.txt", "new name.txt"]);
            let edited = original + "reviewed edit\n";
            fs::write(dir.path().join("new name.txt"), &edited).unwrap();
            let repo = Repo::discover(dir.path()).unwrap();
            let state = repo.reviewed_stage_state().unwrap();
            let files = repo.diff_files(&crate::diff_page::WorkingDiffSource::Review { baseline: "HEAD".into() }, &["new name.txt".into()], true).unwrap()
                .into_iter().map(|file| file.diff).collect::<Vec<_>>();
            assert_eq!(files[0].old_path.as_deref(), Some("file.txt"));
            let supported = git2::Diff::from_buffer(files[0].patch.as_bytes()).is_ok();
            let before = index_bytes(&repo);
            let result = repo.stage_reviewed(&state, None, &files);
            if supported {
                result.unwrap();
                assert_eq!(git(dir.path(), &["show", ":new name.txt"]), edited.trim());
                assert_eq!(git(dir.path(), &["ls-files", "file.txt"]), "");
            } else {
                assert!(result.unwrap_err().to_string().contains("use ordinary Stage"));
                assert_eq!(index_bytes(&repo), before);
            }
        }
    }

    #[test]
    fn untracked_and_partially_staged_files_preserve_unrelated_index_contents() {
        let (dir, repo) = fixture();
        fs::write(dir.path().join("file.txt"), "partly staged\n").unwrap();
        fs::write(dir.path().join("other.txt"), "unrelated staged bytes\n").unwrap();
        git(dir.path(), &["add", "."]);
        fs::write(dir.path().join("file.txt"), "complete inspected version\n").unwrap();
        fs::write(dir.path().join("new.txt"), "new inspected file\n").unwrap();
        let repo = Repo::discover(repo.path()).unwrap();
        let (state, mut files) = reviewed(&repo);
        files.retain(|f| f.path != "other.txt");
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert_eq!(git(dir.path(), &["show", ":file.txt"]), "complete inspected version");
        assert_eq!(git(dir.path(), &["show", ":new.txt"]), "new inspected file");
        assert_eq!(git(dir.path(), &["show", ":other.txt"]), "unrelated staged bytes");
    }

    #[test]
    fn captured_input_uses_git_clean_filters_and_crlf_conversion() {
        let (dir, _) = fixture();
        git(dir.path(), &["config", "filter.review-test.clean", "git hash-object --stdin"]);
        fs::write(dir.path().join(".gitattributes"), "filtered.txt filter=review-test\ncrlf.txt text\n").unwrap();
        fs::write(dir.path().join("filtered.txt"), "reviewed raw input\n").unwrap();
        fs::write(dir.path().join("crlf.txt"), b"line one\r\nline two\r\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let (state, mut files) = reviewed(&repo);
        files.retain(|f| f.path != ".gitattributes");
        let expected = git(dir.path(), &["hash-object", "--path=filtered.txt", "filtered.txt"]);
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert_eq!(git(dir.path(), &["rev-parse", ":filtered.txt"]), expected);
        assert_eq!(repo.git2().unwrap().find_blob(git2::Oid::from_str(&git(dir.path(), &["rev-parse", ":crlf.txt"])).unwrap()).unwrap().content(), b"line one\nline two\n");
    }

    #[test]
    fn sparse_index_keeps_excluded_entries_and_stages_real_lfs_pointers() {
        let (dir, _) = fixture();
        git(dir.path(), &["lfs", "install", "--local"]);
        fs::create_dir(dir.path().join("assets")).unwrap();
        fs::create_dir(dir.path().join("excluded")).unwrap();
        fs::write(dir.path().join(".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        fs::write(dir.path().join("assets/one.asset"), "old asset\n").unwrap();
        fs::write(dir.path().join("excluded/keep.txt"), "excluded\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "lfs base"]);
        git(dir.path(), &["sparse-checkout", "set", "--cone", "--sparse-index", "assets"]);
        fs::write(dir.path().join("assets/one.asset"), "inspected asset\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let (state, files) = reviewed(&repo);
        let expected = git(dir.path(), &["hash-object", "--path=assets/one.asset", "assets/one.asset"]);
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert_eq!(git(dir.path(), &["rev-parse", ":assets/one.asset"]), expected);
        assert!(git(dir.path(), &["show", ":assets/one.asset"]).starts_with("version https://git-lfs.github.com/spec/v1\n"));
        assert!(git(dir.path(), &["ls-files", "--sparse", "-t"]).contains("S excluded/"));
        assert!(!dir.path().join("excluded").exists());
    }

    #[cfg(unix)]
    #[test]
    fn executable_and_symlink_modes_are_preserved() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (dir, repo) = fixture();
        fs::set_permissions(dir.path().join("file.txt"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(dir.path().join("file.txt"), "executable\n").unwrap();
        symlink("../outside", dir.path().join("link")).unwrap();
        let (state, files) = reviewed(&repo);
        repo.stage_reviewed(&state, None, &files).unwrap();
        let entries = git(dir.path(), &["ls-files", "--stage"]);
        assert!(entries.contains("100755"));
        assert!(entries.contains("120000"));
        assert_eq!(git(dir.path(), &["show", ":link"]), "../outside");
    }

    #[test]
    fn binary_review_fails_explicitly_and_preserves_index() {
        let (dir, repo) = fixture();
        fs::write(dir.path().join("binary"), b"unreviewable\0bytes").unwrap();
        let (state, files) = reviewed(&repo);
        let before = index_bytes(&repo);
        assert!(repo.stage_reviewed(&state, None, &files).unwrap_err().to_string().contains("ordinary Stage"));
        assert_eq!(index_bytes(&repo), before);
    }

    #[test]
    fn unborn_head_stages_into_an_initially_missing_index() {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        fs::write(dir.path().join("new.txt"), "inspected scaffold\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let (state, files) = reviewed(&repo);
        assert_eq!(state.head_oid, None);
        assert_eq!(state.index_hash, None);
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert_eq!(git(dir.path(), &["show", ":new.txt"]), "inspected scaffold");
    }

    #[test]
    fn existing_executable_mode_survives_with_filemode_disabled() {
        let (dir, _) = fixture();
        git(dir.path(), &["update-index", "--chmod=+x", "file.txt"]);
        git(dir.path(), &["commit", "-qm", "executable"]);
        git(dir.path(), &["config", "core.filemode", "false"]);
        fs::write(dir.path().join("file.txt"), "inspected executable\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let (state, files) = reviewed(&repo);
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert!(git(dir.path(), &["ls-files", "--stage", "file.txt"]).starts_with("100755"));
        assert_eq!(git(dir.path(), &["show", ":file.txt"]), "inspected executable");
        assert_eq!(git(dir.path(), &["show", ":other.txt"]), "untouched");
    }

    #[test]
    fn normal_repository_lfs_review_uses_captured_raw_contents() {
        let (dir, _) = fixture();
        git(dir.path(), &["lfs", "install", "--local"]);
        fs::write(dir.path().join(".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        fs::write(dir.path().join("file.asset"), "old asset\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-qm", "lfs base"]);
        fs::write(dir.path().join("file.asset"), "reviewed asset\n").unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        let (state, files) = reviewed(&repo);
        let expected = git(dir.path(), &["hash-object", "--path=file.asset", "file.asset"]);
        repo.stage_reviewed(&state, None, &files).unwrap();
        assert_eq!(git(dir.path(), &["rev-parse", ":file.asset"]), expected);
        assert!(git(dir.path(), &["show", ":file.asset"]).starts_with("version https://git-lfs.github.com/spec/v1\n"));
    }

    #[test]
    fn successful_publish_does_not_remove_the_next_writers_lock() {
        let dir = tempfile::tempdir().unwrap();
        let mut lock = IndexLock::acquire(dir.path()).unwrap();
        lock.publish(b"published index").unwrap();
        fs::write(dir.path().join("index.lock"), "next writer owns this").unwrap();
        drop(lock);
        assert_eq!(fs::read_to_string(dir.path().join("index.lock")).unwrap(), "next writer owns this");
    }
}
