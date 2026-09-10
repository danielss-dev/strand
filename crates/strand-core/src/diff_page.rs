//! Changed-file inventories and bounded patch reads for live review surfaces.
use std::{collections::HashSet, io::Read, process::Stdio};
use serde::{Deserialize, Serialize};
use crate::{diff::{diff_options_with, map_status, review_baseline_tree, DiffStatus, FileDiff}, Error, Repo, Result};

pub const MAX_PATCH_PATHS: usize = 32;
pub const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PATCH_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffChunk {
    pub path: String,
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub next_offset: u64,
    pub total: u64,
    /// Hash of the complete generated patch. Binary libgit2 markers have no
    /// complete byte representation and cannot be continued.
    pub revision: Option<String>,
    pub binary: bool,
}

fn patch_limit() -> Error {
    Error::Other("Patch exceeds the 4 MiB page limit. Open the file for inspection, request fewer files, or use strand diff-chunk --path FILE --offset BYTES --length 65536 to read sections.".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum WorkingDiffSource {
    Unstaged {},
    Staged {},
    Review { baseline: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffSummary {
    pub path: String,
    pub old_path: Option<String>,
    pub status: DiffStatus,
    /// Content identity, never a status-row or timestamp-only cache key.
    /// None requires a new patch read after every inventory refresh.
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DiffPageFile {
    #[serde(flatten)]
    pub diff: FileDiff,
    /// Derived from the generated patch's blob IDs, not a preceding summary.
    pub revision: Option<String>,
}

impl Repo {
    fn working_diff<'repo>(&self, repo: &'repo git2::Repository, source: &WorkingDiffSource, context: u32) -> Result<git2::Diff<'repo>> {
        let mut options = diff_options_with(context);
        let mut diff = match source {
            WorkingDiffSource::Unstaged {} => repo.diff_index_to_workdir(None, Some(&mut options))?,
            WorkingDiffSource::Staged {} => {
                let tree = review_baseline_tree(repo, "HEAD")?;
                repo.diff_tree_to_index(tree.as_ref(), None, Some(&mut options))?
            }
            WorkingDiffSource::Review { baseline } => {
                let tree = review_baseline_tree(repo, baseline)?;
                repo.diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut options))?
            }
        };
        diff.find_similar(Some(git2::DiffFindOptions::new().renames(true).copies(true)))?;
        Ok(diff)
    }

    pub fn diff_summary(&self, source: &WorkingDiffSource) -> Result<Vec<DiffSummary>> {
        if self.sparse_enabled() || self.is_partial_clone() {
            return self.git_diff_summary(source);
        }
        let repo = self.git2()?;
        let diff = self.working_diff(repo, source, 0)?;
        diff.deltas().map(|delta| {
            let mut row = summary(&delta);
            let new_id = if matches!(source, WorkingDiffSource::Staged {}) || delta.status() == git2::Delta::Deleted {
                Some(delta.new_file().id())
            } else {
                self.workdir_blob_id(&row.path)?
            };
            row.revision = new_id.and_then(|id| revision(&delta, id));
            Ok(row)
        }).collect()
    }

    pub fn diff_files(&self, source: &WorkingDiffSource, paths: &[String], full_context: bool) -> Result<Vec<DiffPageFile>> {
        if paths.len() > MAX_PATCH_PATHS {
            return Err(Error::Other(format!("Request at most {MAX_PATCH_PATHS} patch paths at a time")));
        }
        if paths.is_empty() { return Ok(Vec::new()); }
        let wanted: HashSet<_> = paths.iter().map(String::as_str).collect();
        let context = if full_context { 1_000_000 } else { 3 };
        if self.sparse_enabled() || self.is_partial_clone() {
            return self.git_diff_files(source, &wanted, context);
        }
        let repo = self.git2()?;
        let diff = self.working_diff(repo, source, context)?;
        pages_from_diff(&diff, &wanted, MAX_PATCH_BYTES)
    }

    /// Retain only the returned byte window. libgit2/Git still calculate the
    /// selected file's diff; this does not bound that native calculation.
    pub fn diff_chunk(&self, source: &WorkingDiffSource, path: &str, offset: u64, length: usize, full_context: bool, expected_revision: Option<&str>) -> Result<DiffChunk> {
        if length == 0 || length > MAX_PATCH_CHUNK {
            return Err(Error::Other("Patch chunk length must be 1–65536 bytes.".into()));
        }
        if offset > 0 && expected_revision.is_none() {
            return Err(Error::Other("Continue a patch with the revision from its first chunk.".into()));
        }
        let mut window = PatchWindow::new(offset, length);
        let context = if full_context { 1_000_000 } else { 3 };
        let binary;
        let can_continue;
        if self.sparse_enabled() || self.is_partial_clone() {
            let row = self.git_diff_summary(source)?.into_iter().find(|row| row.path == path)
                .ok_or_else(|| Error::Other("Selected path is no longer changed; refresh the comparison.".into()))?;
            if self.is_untracked_patch(source, path)? {
                let diff = self.untracked_patch(path, context)?;
                binary = stream_native_patch(&diff, path, |bytes| { window.push(bytes); true })?;
                can_continue = !binary;
            } else {
                let mut scan = PatchHeaders::default();
                self.stream_git_patch(source, &row, context, |bytes| { scan.push(bytes); window.push(bytes); true })?;
                if scan.files != 1 { return Err(Error::Other("Selected rename changed while reading; refresh the comparison.".into())); }
                // A vanished/reclassified path must not return just its former
                // rename source as if that were the requested file.
                if !self.git_diff_summary(source)?.iter().any(|next| next.path == row.path && next.old_path == row.old_path && next.status == row.status) {
                    return Err(Error::Other("Selected file changed while reading; refresh the comparison.".into()));
                }
                binary = scan.binary;
                can_continue = true;
            }
        } else {
            let diff = self.working_diff(self.git2()?, source, context)?;
            binary = stream_native_patch(&diff, path, |bytes| { window.push(bytes); true })?;
            can_continue = !binary;
        }
        let revision = can_continue.then(|| window.revision());
        if expected_revision.is_some() && expected_revision != revision.as_deref() {
            return Err(Error::Other("Patch changed; restart at offset 0 and inspect the new revision.".into()));
        }
        if offset > window.total { return Err(Error::Other("Patch offset exceeds the generated patch length.".into())); }
        Ok(DiffChunk { path: path.into(), next_offset: offset + window.bytes.len() as u64,
            bytes: window.bytes, offset, total: window.total, revision, binary })
    }

    fn is_untracked_patch(&self, source: &WorkingDiffSource, path: &str) -> Result<bool> {
        Ok(!matches!(source, WorkingDiffSource::Staged {}) && self.status()?.iter().any(|file| file.path == path && file.kind == crate::status::StatusKind::Untracked))
    }

    fn untracked_patch(&self, path: &str, context: u32) -> Result<git2::Diff<'_>> {
        let mut opts = diff_options_with(context);
        opts.disable_pathspec_match(true).pathspec(path);
        Ok(self.git2()?.diff_index_to_workdir(None, Some(&mut opts))?)
    }

    fn git_diff_files(&self, source: &WorkingDiffSource, wanted: &HashSet<&str>, context: u32) -> Result<Vec<DiffPageFile>> {
        let mut files = Vec::new();
        let mut remaining = MAX_PATCH_BYTES;
        for row in self.git_diff_summary(source)?.into_iter().filter(|row| wanted.contains(row.path.as_str())) {
            let selection = HashSet::from([row.path.as_str()]);
            let mut page = if self.is_untracked_patch(source, &row.path)? {
                pages_from_diff(&self.untracked_patch(&row.path, context)?, &selection, remaining)?
            } else {
                let mut bytes = Vec::new();
                self.stream_git_patch(source, &row, context, |part| {
                    if bytes.len() + part.len() > remaining { return false; }
                    bytes.extend_from_slice(part); true
                })?;
                if bytes.is_empty() { Vec::new() } else {
                    let mut scan = PatchHeaders::default();
                    scan.push(&bytes);
                    if scan.files != 1 || !self.git_diff_summary(source)?.iter().any(|next| next.path == row.path && next.old_path == row.old_path && next.status == row.status) {
                        return Err(Error::Other("Selected file changed while reading; refresh the comparison.".into()));
                    }
                    // Git's valid pure-rename headers may contain unquoted spaces
                    // that libgit2's patch parser rejects. The literal path request
                    // and verified inventory supply metadata; retain Git's bytes.
                    let mut file = FileDiff { path: row.path.clone(), old_path: row.old_path.clone(), status: row.status,
                        adds: 0, dels: 0, binary: scan.binary, patch: String::new() };
                    let mut in_hunk = false;
                    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
                        if line.starts_with(b"GIT binary patch") || line.starts_with(b"Binary files ") {
                            file.binary = true;
                            break;
                        }
                        if line.starts_with(b"@@ ") { in_hunk = true; }
                        else if in_hunk {
                            if line.starts_with(b"+") { file.adds += 1; }
                            if line.starts_with(b"-") { file.dels += 1; }
                        }
                        let text = String::from_utf8_lossy(line);
                        if text.len() > remaining - file.patch.len() { return Err(patch_limit()); }
                        file.patch.push_str(&text);
                    }
                    vec![DiffPageFile { diff: file, revision: None }]
                }
            };
            for file in &mut page { remaining -= file.diff.patch.len(); file.revision = None; }
            files.extend(page);
        }
        Ok(files)
    }

    fn stream_git_patch(&self, source: &WorkingDiffSource, row: &DiffSummary, context: u32, mut emit: impl FnMut(&[u8]) -> bool) -> Result<()> {
        let baseline = if let WorkingDiffSource::Review { baseline } = source {
            Some(match review_baseline_tree(self.git2()?, baseline)? {
                Some(tree) => tree.id(), None => git2::Oid::hash_object(git2::ObjectType::Tree, &[])?,
            }.to_string())
        } else { None };
        let mut command = crate::git_command();
        command.current_dir(self.path()).args(crate::GIT_SAFE_CONFIG)
            .env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0")
            .args(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames"])
            .arg(format!("--unified={context}"));
        if matches!(source, WorkingDiffSource::Staged {}) { command.arg("--cached"); }
        if let Some(base) = baseline { command.arg(base); }
        command.arg("--").arg(&row.path);
        if let Some(old) = &row.old_path { command.arg(old); }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        let mut stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let error_reader = std::thread::spawn(move || {
            let mut reader = stderr;
            let mut kept = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let n = reader.read(&mut buf)?;
                if n == 0 { break; }
                kept.extend_from_slice(&buf[..n.min(16384usize.saturating_sub(kept.len()))]);
            }
            Ok::<_, std::io::Error>(kept)
        });
        let mut buffer = [0; MAX_PATCH_CHUNK];
        let mut failed = None;
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) if emit(&buffer[..n]) => {},
                Ok(_) => { failed = Some(patch_limit()); crate::network::kill_git_tree(&mut child); break; }
                Err(error) => { failed = Some(error.into()); crate::network::kill_git_tree(&mut child); break; }
            }
        }
        drop(stdout);
        let status = child.wait()?;
        let stderr = error_reader.join().map_err(|_| Error::Other("Patch error reader failed.".into()))??;
        if let Some(error) = failed { return Err(error); }
        if !status.success() { return Err(Error::Other(String::from_utf8_lossy(&stderr).trim().into())); }
        Ok(())
    }

    /// Stream bytes with Git's blob header: bounded memory, no patch generation.
    fn workdir_blob_id(&self, path: &str) -> Result<Option<git2::Oid>> {
        let full = self.path().join(path);
        let metadata = match std::fs::symlink_metadata(&full) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if metadata.is_dir() { return Ok(None); } // submodule state needs its own reader
        if metadata.file_type().is_symlink() {
            // Read the link text without following it outside the worktree.
            let target = std::fs::read_link(&full)?;
            return Ok(Some(git2::Oid::hash_object(git2::ObjectType::Blob, target.as_os_str().as_encoded_bytes())?));
        }
        let mut file = std::fs::File::open(self.safe_workdir_path(path)?)?;
        let length = file.metadata()?.len();
        let mut hasher = gix::features::hash::hasher(gix::hash::Kind::Sha1);
        hasher.update(format!("blob {length}\0").as_bytes());
        let mut buffer = [0u8; 65536];
        let mut read = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 { break; }
            read += count as u64;
            hasher.update(&buffer[..count]);
        }
        if read != length { return Ok(None); }
        Ok(Some(git2::Oid::from_bytes(&hasher.digest())?))
    }

    /// Git-aware inventories avoid materializing sparse-directory entries or
    /// fetching promised blobs just to enumerate changed paths.
    fn git_diff_summary(&self, source: &WorkingDiffSource) -> Result<Vec<DiffSummary>> {
        let baseline = if let WorkingDiffSource::Review { baseline } = source {
            let repo = self.git2()?;
            Some(match review_baseline_tree(repo, baseline)? {
                Some(tree) => tree.id(),
                None => git2::Oid::hash_object(git2::ObjectType::Tree, &[])?,
            }.to_string())
        } else { None };
        let mut args = vec!["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv"];
        if matches!(source, WorkingDiffSource::Staged {}) { args.push("--cached"); }
        if let Some(oid) = &baseline { args.push(oid); }
        args.push("--");
        let output = self.sparse_git(&args, None)?;
        let mut fields = output.split(|byte| *byte == 0).filter(|value| !value.is_empty());
        let mut rows = Vec::new();
        while let Some(kind) = fields.next() {
            let path = fields.next().ok_or_else(|| Error::Other("Incomplete Git diff inventory".into()))?;
            let path = String::from_utf8_lossy(path).into_owned();
            let renamed = matches!(kind.first(), Some(b'R' | b'C'));
            let (path, old_path) = if renamed {
                let target = fields.next().ok_or_else(|| Error::Other("Incomplete Git rename inventory".into()))?;
                (String::from_utf8_lossy(target).into_owned(), Some(path))
            } else { (path, None) };
            let status = match kind.first() {
                Some(b'A') => DiffStatus::Added, Some(b'D') => DiffStatus::Deleted,
                Some(b'R') => DiffStatus::Renamed, Some(b'C') => DiffStatus::Copied,
                Some(b'T') => DiffStatus::Typechange, _ => DiffStatus::Modified,
            };
            rows.push(DiffSummary { path, old_path, status, revision: None });
        }
        if !matches!(source, WorkingDiffSource::Staged {}) {
            rows.extend(self.status()?.into_iter().filter(|file| file.kind == crate::status::StatusKind::Untracked)
                .map(|file| DiffSummary { path: file.path, old_path: None, status: DiffStatus::Added, revision: None }));
        }
        rows.sort_by(|a, b| a.path.cmp(&b.path));
        rows.dedup_by(|a, b| a.path == b.path);
        Ok(rows)
    }
}

fn pages_from_diff(diff: &git2::Diff<'_>, wanted: &HashSet<&str>, limit: usize) -> Result<Vec<DiffPageFile>> {
    let mut files = Vec::new();
    let mut used = 0;
    for index in 0..diff.deltas().len() {
        let delta = diff.get_delta(index).expect("delta in range");
        let row = summary(&delta);
        if !wanted.contains(row.path.as_str()) { continue; }
        let mut file = FileDiff { path: row.path, old_path: row.old_path, status: row.status,
            adds: 0, dels: 0, binary: false, patch: String::new() };
        let token;
        if let Some(mut patch) = git2::Patch::from_diff(diff, index)? {
            token = revision(&patch.delta(), patch.delta().new_file().id());
            let mut exceeded = false;
            let result = patch.print(&mut |_, _, line| {
                let origin = line.origin();
                if origin == 'B' { file.binary = true; }
                if matches!(origin, 'F' | 'H' | ' ' | '+' | '-' | '=' | '<' | '>') {
                    let text = String::from_utf8_lossy(line.content());
                    let prefix = matches!(origin, ' ' | '+' | '-');
                    let size = text.len() + usize::from(prefix);
                    if size > limit - used { exceeded = true; return false; }
                    used += size;
                    if origin == '+' { file.adds += 1; }
                    if origin == '-' { file.dels += 1; }
                    if prefix { file.patch.push(origin); }
                    file.patch.push_str(&text);
                }
                true
            });
            if exceeded { return Err(patch_limit()); }
            result?;
        } else {
            file.binary = true;
            let computed = diff.get_delta(index).expect("delta in range");
            token = revision(&computed, computed.new_file().id());
        }
        files.push(DiffPageFile { diff: file, revision: token });
    }
    Ok(files)
}

fn stream_native_patch(diff: &git2::Diff<'_>, path: &str, mut emit: impl FnMut(&[u8]) -> bool) -> Result<bool> {
    let index = diff.deltas().position(|delta| summary(&delta).path == path)
        .ok_or_else(|| Error::Other("Selected path is no longer changed; refresh the comparison.".into()))?;
    let Some(mut patch) = git2::Patch::from_diff(diff, index)? else { return Ok(true); };
    let mut binary = false;
    patch.print(&mut |_, _, line| {
        let origin = line.origin();
        if origin == 'B' { binary = true; }
        if matches!(origin, 'F' | 'H' | ' ' | '+' | '-' | '=' | '<' | '>') {
            if matches!(origin, ' ' | '+' | '-') && !emit(&[origin as u8]) { return false; }
            return emit(line.content());
        }
        true
    })?;
    Ok(binary)
}

struct PatchWindow {
    offset: u64,
    length: usize,
    total: u64,
    bytes: Vec<u8>,
    hasher: gix::features::hash::Sha1,
}
impl PatchWindow {
    fn new(offset: u64, length: usize) -> Self {
        Self { offset, length, total: 0, bytes: Vec::with_capacity(length), hasher: gix::features::hash::Sha1::default() }
    }
    fn push(&mut self, bytes: &[u8]) {
        self.hasher.update(bytes);
        let start = self.total;
        self.total += bytes.len() as u64;
        let from = self.offset.max(start);
        let to = self.total.min(self.offset.saturating_add(self.length as u64));
        if from < to { self.bytes.extend_from_slice(&bytes[(from - start) as usize..(to - start) as usize]); }
    }
    fn revision(&self) -> String {
        git2::Oid::from_bytes(&self.hasher.clone().digest()).expect("SHA-1 digest").to_string()
    }
}

#[derive(Default)]
struct PatchHeaders { prefix: Vec<u8>, files: usize, binary: bool }
impl PatchHeaders {
    fn push(&mut self, bytes: &[u8]) {
        for byte in bytes {
            if *byte == b'\n' { self.prefix.clear(); continue; }
            if self.prefix.len() < 16 {
                self.prefix.push(*byte);
                if self.prefix == b"diff --git " { self.files += 1; }
                if self.prefix == b"GIT binary patch" { self.binary = true; }
            }
        }
    }
}

fn summary(delta: &git2::DiffDelta<'_>) -> DiffSummary {
    let path = delta.new_file().path().or_else(|| delta.old_file().path()).map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    let old_path = if matches!(delta.status(), git2::Delta::Renamed | git2::Delta::Copied) {
        delta.old_file().path().map(|path| path.to_string_lossy().into_owned())
    } else { None };
    DiffSummary { path, old_path, status: map_status(delta.status()), revision: None }
}

fn revision(delta: &git2::DiffDelta<'_>, new_id: git2::Oid) -> Option<String> {
    let old = delta.old_file();
    if new_id.is_zero() && delta.status() != git2::Delta::Deleted { return None; }
    if old.id().is_zero() && !matches!(delta.status(), git2::Delta::Added | git2::Delta::Untracked) { return None; }
    Some(format!("{}:{}:{:?}:{:?}:{:?}", old.id(), new_id, old.mode(), delta.new_file().mode(), delta.status()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};

    fn git(root: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(root)
            .args(["-c", "core.hooksPath=", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q"]);
        git(root.path(), &["config", "user.name", "Review Test"]);
        git(root.path(), &["config", "user.email", "review@example.com"]);
        git(root.path(), &["config", "core.autocrlf", "false"]);
        fs::write(root.path().join("first.txt"), "before\ncontext\n").unwrap();
        fs::write(root.path().join("second.txt"), "other\n").unwrap();
        git(root.path(), &["add", "."]);
        git(root.path(), &["commit", "-qm", "initial"]);
        root
    }

    #[test]
    fn summaries_and_selected_patches_match_full_diffs_and_track_content() {
        let root = fixture();
        fs::write(root.path().join("first.txt"), "after\ncontext\n").unwrap();
        git(root.path(), &["add", "first.txt"]);
        fs::write(root.path().join("first.txt"), "latest\ncontext\n").unwrap();
        fs::write(root.path().join("second.txt"), "other changed\n").unwrap();
        fs::write(root.path().join("binary.bin"), [0, 5, 0, 6]).unwrap();
        let repo = Repo::discover(root.path()).unwrap();
        for source in [WorkingDiffSource::Unstaged {}, WorkingDiffSource::Staged {}, WorkingDiffSource::Review { baseline: "HEAD".into() }] {
            let summaries = repo.diff_summary(&source).unwrap();
            let selected = repo.diff_files(&source, &["first.txt".into()], true).unwrap();
            let all = match &source {
                WorkingDiffSource::Unstaged {} => repo.diff_unstaged_full().unwrap(),
                WorkingDiffSource::Staged {} => repo.diff_staged().unwrap(),
                WorkingDiffSource::Review { .. } => repo.diff_since_full("HEAD").unwrap(),
            };
            assert_eq!(selected.len(), 1);
            let expected = all.iter().find(|file| file.path == "first.txt").unwrap();
            assert_eq!(selected[0].diff.patch, expected.patch);
            let row = summaries.iter().find(|row| row.path == "first.txt").unwrap();
            assert!(row.revision.is_some());
            assert_eq!(row.revision, selected[0].revision);
        }
        let source = WorkingDiffSource::Unstaged {};
        let original = repo.diff_summary(&source).unwrap();
        fs::write(root.path().join("first.txt"), "newest\ncontext\n").unwrap();
        let newer = repo.diff_summary(&source).unwrap();
        assert_ne!(original.iter().find(|row| row.path == "first.txt").unwrap().revision,
            newer.iter().find(|row| row.path == "first.txt").unwrap().revision);
        let binary = repo.diff_files(&source, &["binary.bin".into()], true).unwrap();
        assert!(binary[0].diff.binary);
        assert!(binary[0].revision.is_some(), "binary cache identity must include content");
    }

    #[test]
    fn selected_renames_keep_both_paths_and_do_not_include_other_files() {
        let root = fixture();
        fs::rename(root.path().join("first.txt"), root.path().join("renamed.txt")).unwrap();
        git(root.path(), &["add", "-A"]);
        fs::write(root.path().join("second.txt"), "another edit\n").unwrap();
        let repo = Repo::discover(root.path()).unwrap();
        let source = WorkingDiffSource::Review { baseline: "HEAD".into() };
        let page = repo.diff_files(&source, &["renamed.txt".into()], true).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].diff.old_path.as_deref(), Some("first.txt"));
        assert_eq!(page[0].diff.status, DiffStatus::Renamed);
        assert!(repo.diff_files(&source, &vec!["second.txt".into(); 33], false).is_err());
        assert!(repo.diff_files(&source, &["../outside".into()], false).unwrap().is_empty());
    }

    #[test]
    fn unborn_review_inventory_and_git_fallback_do_not_hide_staged_files() {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q"]);
        fs::write(root.path().join("new.txt"), "new\n").unwrap();
        git(root.path(), &["add", "."]);
        let repo = Repo::discover(root.path()).unwrap();
        let source = WorkingDiffSource::Review { baseline: "HEAD".into() };
        assert_eq!(repo.diff_summary(&source).unwrap()[0].path, "new.txt");
        assert_eq!(repo.git_diff_summary(&source).unwrap()[0].path, "new.txt");
        assert!(repo.diff_files(&source, &["new.txt".into()], true).unwrap()[0].diff.patch.contains("+new"));
    }

    #[test]
    fn chunks_reconstruct_exact_bytes_and_reject_stale_continuations() {
        let root = fixture();
        let name = "[literal] file.txt";
        fs::write(root.path().join(name), b"first \xff line\nsecond multibyte \xc3\xa9 line\nthird line\n").unwrap();
        let repo = Repo::discover(root.path()).unwrap();
        let source = WorkingDiffSource::Unstaged {};
        let mut expected = Vec::new();
        stream_native_patch(&repo.working_diff(repo.git2().unwrap(), &source, 3).unwrap(), name, |bytes| {
            expected.extend_from_slice(bytes); true
        }).unwrap();
        let first = repo.diff_chunk(&source, name, 0, 17, false, None).unwrap();
        let mut actual = first.bytes.clone();
        let mut offset = first.next_offset;
        while offset < first.total {
            let chunk = repo.diff_chunk(&source, name, offset, 17, false, first.revision.as_deref()).unwrap();
            assert_eq!(chunk.total, first.total);
            assert_eq!(chunk.revision, first.revision);
            actual.extend(chunk.bytes);
            offset = chunk.next_offset;
        }
        assert_eq!(actual, expected, "chunks must preserve invalid UTF-8 and split multibyte characters exactly");
        assert!(repo.diff_chunk(&source, name, 1, 17, false, None).is_err());
        assert!(repo.diff_chunk(&source, name, 0, MAX_PATCH_CHUNK + 1, false, None).is_err());
        assert!(repo.diff_chunk(&source, name, first.total + 1, 17, false, first.revision.as_deref()).is_err());
        fs::write(root.path().join(name), b"changed while the client was reading\n").unwrap();
        let error = repo.diff_chunk(&source, name, 17, 17, false, first.revision.as_deref()).unwrap_err();
        assert!(error.to_string().contains("Patch changed"));

        fs::write(root.path().join("binary.bin"), [0, 1, 0, 2]).unwrap();
        let binary = repo.diff_chunk(&source, "binary.bin", 0, 17, false, None).unwrap();
        assert!(binary.binary);
        assert!(binary.revision.is_none(), "a binary marker is not immutable binary content");
    }

    #[test]
    fn large_added_patch_is_capped_but_sections_remain_exact() {
        let root = fixture();
        let large = "0123456789abcdef".repeat(8) + "\n";
        fs::write(root.path().join("huge.txt"), large.repeat(70_000)).unwrap();
        let repo = Repo::discover(root.path()).unwrap();
        let source = WorkingDiffSource::Unstaged {};
        let error = repo.diff_files(&source, &["huge.txt".into()], false).unwrap_err();
        assert!(error.to_string().contains("4 MiB page limit"));
        let expected = repo.diff_unstaged().unwrap().into_iter().find(|file| file.path == "huge.txt").unwrap().patch;
        assert!(expected.len() > 8 * 1024 * 1024);
        let first = repo.diff_chunk(&source, "huge.txt", 0, MAX_PATCH_CHUNK, false, None).unwrap();
        assert_eq!(first.total as usize, expected.len());
        assert_eq!(first.bytes, expected.as_bytes()[..MAX_PATCH_CHUNK]);
        for offset in [MAX_PATCH_CHUNK as u64, first.total / 2, first.total - 19, first.total] {
            let chunk = repo.diff_chunk(&source, "huge.txt", offset, MAX_PATCH_CHUNK, false, first.revision.as_deref()).unwrap();
            assert_eq!(chunk.bytes, expected.as_bytes()[offset as usize..(offset as usize + MAX_PATCH_CHUNK).min(expected.len())]);
            assert!(chunk.bytes.len() <= MAX_PATCH_CHUNK);
        }
        // Exercise the bounded system-Git parser used by sparse/partial repos.
        git(root.path(), &["add", "huge.txt"]);
        let staged = WorkingDiffSource::Staged {};
        let error = repo.git_diff_files(&staged, &HashSet::from(["huge.txt"]), 3).unwrap_err();
        assert!(error.to_string().contains("4 MiB page limit"));
    }

    #[test]
    fn git_pages_and_chunks_keep_literal_renames_and_sparse_index_bytes() {
        let root = fixture();
        fs::create_dir(root.path().join("outside")).unwrap();
        fs::write(root.path().join("outside/hidden.txt"), "keep excluded\n").unwrap();
        git(root.path(), &["add", "."]);
        git(root.path(), &["commit", "-qm", "outside"]);
        git(root.path(), &["sparse-checkout", "set", "--cone", "--sparse-index", "inside"]);
        fs::rename(root.path().join("first.txt"), root.path().join("[new] name.txt")).unwrap();
        git(root.path(), &["add", "-A"]);
        fs::write(root.path().join("loose.txt"), "new loose\n").unwrap();
        let before = fs::read(root.path().join(".git/index")).unwrap();
        let repo = Repo::discover(root.path()).unwrap();
        let source = WorkingDiffSource::Review { baseline: "HEAD".into() };
        let files = repo.diff_files(&source, &["[new] name.txt".into(), "loose.txt".into()], true).unwrap();
        assert_eq!(files.len(), 2);
        let rename = files.iter().find(|file| file.diff.path == "[new] name.txt").unwrap();
        assert_eq!(rename.diff.old_path.as_deref(), Some("first.txt"));
        let first = repo.diff_chunk(&source, "[new] name.txt", 0, 16, true, None).unwrap();
        let next = repo.diff_chunk(&source, "[new] name.txt", 16, MAX_PATCH_CHUNK, true, first.revision.as_deref()).unwrap();
        let combined = [first.bytes, next.bytes].concat();
        assert!(String::from_utf8_lossy(&combined).contains("rename from first.txt"));
        assert_eq!(fs::read(root.path().join(".git/index")).unwrap(), before);
        assert!(!root.path().join("outside/hidden.txt").exists());
    }
}
