//! Explicit, previewed patch/mailbox/bundle interchange. Reads stay off snapshots.

use crate::{Error, Repo, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Output, Stdio},
};

const MAX_PATCH: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PatchTarget {
    Worktree,
    Index,
    Both,
    Mailbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchPreview {
    pub token: String,
    pub paths: Vec<String>,
    pub messages: Vec<String>,
    pub valid: bool,
    pub validation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxState {
    pub token: String,
    pub current: String,
    pub total: String,
    pub author: String,
    pub conflicts: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxAction {
    Continue,
    Skip,
    Abort,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterchangeOutcome {
    pub success: bool,
    pub paused: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleRef {
    pub oid: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundlePreview {
    pub token: String,
    pub refs: Vec<BundleRef>,
    pub prerequisites: Vec<String>,
    pub valid: bool,
    pub validation: String,
}

// Private temporary directory, independent of filenames from imported content.
pub(crate) struct InterchangeScratch(pub PathBuf);
impl InterchangeScratch {
    pub(crate) fn new() -> Result<Self> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let p = std::env::temp_dir().join(format!(
                "strand-interchange-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&p) {
                Ok(()) => return Ok(Self(p)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err(Error::Other(
            "cannot allocate interchange scratch directory".into(),
        ))
    }
}
impl Drop for InterchangeScratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str], stdin: Option<&Path>, index: Option<&Path>) -> Result<Output> {
    let mut cmd = crate::git_command();
    cmd.current_dir(cwd)
        .args(crate::GIT_SAFE_CONFIG)
        .args(args)
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    if let Some(p) = stdin {
        cmd.stdin(fs::File::open(p)?);
    }
    if let Some(p) = index {
        cmd.env("GIT_INDEX_FILE", p);
    }
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    fn drain(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
        let mut captured = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = pipe.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let keep = n.min((1024 * 1024usize).saturating_sub(captured.len()));
            captured.extend_from_slice(&buf[..keep]);
        }
        Ok(captured)
    }
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let reader = std::thread::spawn(move || drain(stdout));
    let stderr = drain(stderr)?;
    let status = child.wait()?;
    let stdout = reader
        .join()
        .map_err(|_| Error::Other("Git output reader failed".into()))??;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn diagnostic(out: &Output) -> String {
    let mut bytes = out
        .stdout
        .iter()
        .chain(out.stderr.iter())
        .take(64 * 1024)
        .copied()
        .collect::<Vec<_>>();
    if out.stdout.len() + out.stderr.len() > bytes.len() {
        bytes.extend_from_slice(b"\n[output truncated]");
    }
    String::from_utf8_lossy(&bytes).trim().to_owned()
}
fn checked(out: Output) -> Result<Output> {
    if out.status.success() {
        Ok(out)
    } else {
        Err(Error::Other(diagnostic(&out)))
    }
}
fn utf8_path(p: &Path) -> Result<&str> {
    p.to_str()
        .ok_or_else(|| Error::Other("path is not UTF-8".into()))
}
fn digest(bytes: &[u8]) -> Result<String> {
    Ok(git2::Oid::hash_object(git2::ObjectType::Blob, bytes)?.to_string())
}
fn bounded_read(p: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    fs::File::open(p)?.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(Error::Other(format!(
            "{} exceeds the {} MiB import limit",
            p.display(),
            limit / 1024 / 1024
        )));
    }
    Ok(data)
}

/// Concurrency stamp, not an authentication hash. Streams large bundle files.
fn file_stamp(p: &Path) -> Result<String> {
    use std::hash::Hasher;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut file = fs::File::open(p)?;
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.write(&buf[..n]);
    }
    Ok(format!("{:016x}", hash.finish()))
}

impl Repo {
    // Includes actual file bytes, because equal status rows do not mean equal content.
    fn import_stamp(&self, paths: &[String], extra: &[u8]) -> Result<String> {
        let mut stamp = extra.to_vec();
        for name in [
            "HEAD",
            "index",
            "rebase-apply/next",
            "rebase-apply/last",
            "rebase-apply/info",
            "rebase-apply/patch",
        ] {
            let p = self.git_dir().join(name);
            if p.is_file() {
                stamp.extend_from_slice(file_stamp(&p)?.as_bytes());
            }
        }
        stamp.extend_from_slice(
            format!("{:?}", self.git2()?.head().ok().and_then(|h| h.target())).as_bytes(),
        );
        for p in paths {
            self.check_import_path(p)?;
            stamp.extend_from_slice(p.as_bytes());
            let full = self.path.join(p);
            if full.is_file() {
                stamp.extend_from_slice(file_stamp(&full)?.as_bytes());
            }
        }
        digest(&stamp)
    }

    /// Reject nonportable traversal, Git administrative paths, and symlink ancestors,
    /// including dangling links and not-yet-created nested directories.
    fn check_import_path(&self, path: &str) -> Result<()> {
        if path.is_empty() || path.contains(['\\', ':', '\0']) || path.starts_with('/') {
            return Err(Error::Other(format!("unsafe patch path: {path}")));
        }
        let mut full = self.path.clone();
        for part in path.split('/') {
            if part.is_empty()
                || part == "."
                || part == ".."
                || part.eq_ignore_ascii_case(".git")
                || part
                    .trim_end_matches([' ', '.'])
                    .eq_ignore_ascii_case(".git")
            {
                return Err(Error::Other(format!("unsafe patch path: {path}")));
            }
            full.push(part);
            match fs::symlink_metadata(&full) {
                Ok(m) if m.file_type().is_symlink() => {
                    return Err(Error::Other(format!(
                        "patch path traverses a symlink: {path}"
                    )))
                }
                Ok(_) => {
                    if !full.canonicalize()?.starts_with(self.path.canonicalize()?) {
                        return Err(Error::Other(format!(
                            "patch path escapes repository: {path}"
                        )));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    fn patch_paths(&self, bytes: &[u8]) -> Result<Vec<String>> {
        let diff = git2::Diff::from_buffer(bytes)?;
        let mut paths = BTreeSet::new();
        for delta in diff.deltas() {
            for file in [delta.old_file(), delta.new_file()] {
                // Applying links can change containment of a later patch in a series.
                if file.mode() == git2::FileMode::Link {
                    return Err(Error::Other(
                        "importing symlink patches is not supported; inspect and apply with Git"
                            .into(),
                    ));
                }
                if let Some(p) = file.path() {
                    let p = utf8_path(p)?;
                    self.check_import_path(p)?;
                    paths.insert(p.to_owned());
                }
            }
        }
        if paths.is_empty() {
            return Err(Error::Other("patch contains no affected paths".into()));
        }
        Ok(paths.into_iter().collect())
    }

    pub fn preview_patch_import(&self, source: &Path, target: PatchTarget) -> Result<PatchPreview> {
        if !source.is_absolute() {
            return Err(Error::Other("patch source must be an absolute path".into()));
        }
        let bytes = bounded_read(source, MAX_PATCH)?;
        self.preview_patch_bytes(&bytes, target)
    }

    fn preview_patch_bytes(&self, bytes: &[u8], target: PatchTarget) -> Result<PatchPreview> {
        let scratch = InterchangeScratch::new()?;
        let input = scratch.0.join("input");
        fs::write(&input, bytes)?;
        let mut paths = BTreeSet::new();
        let mut messages = Vec::new();
        let mut valid = true;
        let mut validation = String::new();
        if target == PatchTarget::Mailbox {
            let maildir = scratch.0.join("mail");
            fs::create_dir(&maildir)?;
            let outdir = format!("-o{}", utf8_path(&maildir)?);
            let split = checked(git(
                &self.path,
                &["mailsplit", "-b", &outdir, "--", utf8_path(&input)?],
                None,
                None,
            )?)?;
            let count: usize = String::from_utf8_lossy(&split.stdout)
                .trim()
                .parse()
                .map_err(|_| Error::Other("invalid mailbox count".into()))?;
            if count == 0 || count > 1000 {
                return Err(Error::Other("mailbox must contain 1–1000 patches".into()));
            }
            let index = scratch.0.join("index");
            checked(git(&self.path, &["read-tree", "HEAD"], None, Some(&index))?)?;
            for n in 1..=count {
                let mail = maildir.join(format!("{n:04}"));
                let patch = scratch.0.join("patch");
                let message = scratch.0.join("message");
                let info = checked(git(
                    &self.path,
                    &["mailinfo", utf8_path(&message)?, utf8_path(&patch)?],
                    Some(&mail),
                    None,
                )?)?;
                messages.push(diagnostic(&info));
                paths.extend(self.patch_paths(&bounded_read(&patch, MAX_PATCH)?)?);
                if valid {
                    let out = git(
                        &self.path,
                        &["apply", "--cached", "--", utf8_path(&patch)?],
                        None,
                        Some(&index),
                    )?;
                    if !out.status.success() {
                        valid = false;
                        validation = format!("Patch {n}: {}", diagnostic(&out));
                    }
                }
            }
        } else {
            paths.extend(self.patch_paths(bytes)?);
            let mut args = vec!["apply", "--check"];
            match target {
                PatchTarget::Index => args.push("--cached"),
                PatchTarget::Both => args.push("--index"),
                _ => {}
            }
            args.extend(["--", utf8_path(&input)?]);
            let out = git(&self.path, &args, None, None)?;
            valid = out.status.success();
            validation = diagnostic(&out);
        }
        let paths: Vec<_> = paths.into_iter().collect();
        let token =
            self.import_stamp(&paths, format!("{target:?}:{}", digest(bytes)?).as_bytes())?;
        Ok(PatchPreview {
            token,
            paths,
            messages,
            valid,
            validation,
        })
    }

    pub fn import_patch(
        &self,
        source: &Path,
        target: PatchTarget,
        token: &str,
    ) -> Result<InterchangeOutcome> {
        if !source.is_absolute() {
            return Err(Error::Other("patch source must be an absolute path".into()));
        }
        if let Some(op) = self.operation_in_progress() {
            return Err(Error::Other(format!(
                "finish or abort {op} before importing"
            )));
        }
        let bytes = bounded_read(source, MAX_PATCH)?;
        let preview = self.preview_patch_bytes(&bytes, target)?;
        if preview.token != token {
            return Err(Error::Other(
                "patch or repository changed; preview again".into(),
            ));
        }
        if !preview.valid && target != PatchTarget::Mailbox {
            return Err(Error::Other(preview.validation));
        }
        let scratch = InterchangeScratch::new()?;
        let input = scratch.0.join("input");
        fs::write(&input, bytes)?;
        let mut args = match target {
            PatchTarget::Mailbox => {
                let out = checked(git(
                    &self.path,
                    &["status", "--porcelain", "--untracked-files=normal"],
                    None,
                    None,
                )?)?;
                if !out.stdout.is_empty() {
                    return Err(Error::Other("mailbox import requires a clean index and working tree; commit or stash changes first".into()));
                }
                vec!["am", "--3way"]
            }
            PatchTarget::Index => vec!["apply", "--cached"],
            PatchTarget::Both => vec!["apply", "--index"],
            PatchTarget::Worktree => vec!["apply"],
        };
        args.extend(["--", utf8_path(&input)?]);
        let out = git(&self.path, &args, None, None)?;
        Ok(InterchangeOutcome {
            success: out.status.success(),
            paused: self.operation_in_progress().as_deref() == Some("mailbox"),
            output: diagnostic(&out),
        })
    }

    pub fn mailbox_state(&self) -> Result<Option<MailboxState>> {
        if self.operation_in_progress().as_deref() != Some("mailbox") {
            return Ok(None);
        }
        let dir = self.git_dir().join("rebase-apply");
        let read = |n: &str| -> Result<String> {
            Ok(
                String::from_utf8_lossy(&bounded_read(&dir.join(n), MAX_PATCH)?)
                    .trim()
                    .to_owned(),
            )
        };
        let mut index = self.git2()?.index()?;
        index.read(true)?;
        Ok(Some(MailboxState {
            token: self.import_stamp(&[], &[])?,
            current: read("next")?,
            total: read("last")?,
            author: read("info").unwrap_or_default(),
            conflicts: index.has_conflicts(),
        }))
    }

    pub fn mailbox_action(&self, action: MailboxAction, token: &str) -> Result<InterchangeOutcome> {
        let state = self
            .mailbox_state()?
            .ok_or_else(|| Error::Other("no mailbox operation in progress".into()))?;
        if state.token != token {
            return Err(Error::Other(
                "mailbox state changed; refresh before continuing".into(),
            ));
        }
        if matches!(action, MailboxAction::Continue) && state.conflicts {
            return Err(Error::Other(
                "resolve and stage every conflict first".into(),
            ));
        }
        let arg = match action {
            MailboxAction::Continue => "--continue",
            MailboxAction::Skip => "--skip",
            MailboxAction::Abort => "--abort",
        };
        let out = git(&self.path, &["am", arg], None, None)?;
        Ok(InterchangeOutcome {
            success: out.status.success(),
            paused: self.operation_in_progress().as_deref() == Some("mailbox"),
            output: diagnostic(&out),
        })
    }

    pub fn preview_bundle(&self, source: &Path) -> Result<BundlePreview> {
        if !source.is_absolute() {
            return Err(Error::Other(
                "bundle source must be an absolute path".into(),
            ));
        }
        // Header is bounded even though pack data can be arbitrarily large.
        let mut header = Vec::new();
        use std::io::BufRead;
        let mut input = std::io::BufReader::new(fs::File::open(source)?);
        loop {
            let mut line = Vec::new();
            input
                .by_ref()
                .take(1024 * 1024 + 1)
                .read_until(b'\n', &mut line)?;
            if line.is_empty() {
                return Err(Error::Other("incomplete bundle header".into()));
            }
            if header.len() + line.len() > 1024 * 1024 {
                return Err(Error::Other("bundle header exceeds 1 MiB".into()));
            }
            header.extend_from_slice(&line);
            if line == b"\n" {
                break;
            }
        }
        let text = String::from_utf8_lossy(&header);
        let prerequisites = text
            .lines()
            .filter_map(|l| l.strip_prefix('-').map(str::to_owned))
            .collect();
        let heads = checked(git(
            &self.path,
            &["bundle", "list-heads", utf8_path(source)?],
            None,
            None,
        )?)?;
        let refs = String::from_utf8_lossy(&heads.stdout)
            .lines()
            .filter_map(|l| {
                l.split_once(' ').map(|(oid, name)| BundleRef {
                    oid: oid.into(),
                    name: name.into(),
                })
            })
            .collect();
        let out = git(
            &self.path,
            &["bundle", "verify", utf8_path(source)?],
            None,
            None,
        )?;
        Ok(BundlePreview {
            token: file_stamp(source)?,
            refs,
            prerequisites,
            valid: out.status.success(),
            validation: diagnostic(&out),
        })
    }

    /// Fetch exactly one reviewed bundle ref into a new local branch. Existing
    /// refs/HEAD are never overwritten and Git owns object/prerequisite validation.
    pub fn import_bundle(
        &self,
        source: &Path,
        token: &str,
        source_ref: &str,
        branch: &str,
    ) -> Result<InterchangeOutcome> {
        let scratch = InterchangeScratch::new()?;
        let copy = scratch.0.join("input.bundle");
        fs::copy(source, &copy)?;
        let preview = self.preview_bundle(&copy)?;
        if preview.token != token {
            return Err(Error::Other("bundle changed; verify again".into()));
        }
        if !preview.valid {
            return Err(Error::Other(preview.validation));
        }
        let selected = preview
            .refs
            .iter()
            .find(|r| r.name == source_ref)
            .ok_or_else(|| Error::Other("choose an advertised bundle ref".into()))?;
        let dest = format!("refs/heads/{branch}");
        if branch.starts_with('-') || !git2::Reference::is_valid_name(&dest) {
            return Err(Error::Other("invalid destination branch".into()));
        }
        // Import objects without publishing a ref, then use a compare-and-swap
        // create. A concurrent external branch creation must never be overwritten.
        checked(git(
            &self.path,
            &["bundle", "unbundle", utf8_path(&copy)?],
            None,
            None,
        )?)?;
        let commit = self
            .git2()?
            .find_object(git2::Oid::from_str(&selected.oid)?, None)?
            .peel_to_commit()?
            .id();
        self.git2()?
            .reference(&dest, commit, false, "Strand bundle import")?;
        Ok(InterchangeOutcome {
            success: true,
            paused: false,
            output: format!("Imported {} at {} into {dest}", selected.name, selected.oid),
        })
    }

    /// Export a named ref, optionally excluding a prerequisite revision. Verify
    /// the exported tip before publishing, so concurrent ref updates fail closed.
    pub fn export_bundle(
        &self,
        destination: &Path,
        refname: &str,
        prerequisite: Option<&str>,
    ) -> Result<BundlePreview> {
        if !destination.is_absolute() || destination.exists() {
            return Err(Error::Other(
                "choose a new absolute bundle destination; existing files are never overwritten"
                    .into(),
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| Error::Other("destination has no parent".into()))?
            .canonicalize()?;
        if parent.starts_with(self.git_dir().canonicalize()?)
            || parent.starts_with(self.gix.common_dir().canonicalize()?)
        {
            return Err(Error::Other(
                "bundle destination cannot be inside Git administrative directories".into(),
            ));
        }
        let reference = self.git2()?.find_reference(refname)?;
        let tip = reference.peel_to_commit()?.id().to_string();
        let base = prerequisite
            .map(|r| {
                self.git2()?
                    .revparse_single(r)?
                    .peel_to_commit()
                    .map(|c| format!("^{}", c.id()))
                    .map_err(Error::from)
            })
            .transpose()?;
        // git bundle requires a named positive ref. Verify it again after creation
        // and fail without publishing the artifact if it moved during export.
        let scratch = InterchangeScratch::new()?;
        let output = scratch.0.join("export.bundle");
        let mut args = vec!["bundle", "create", utf8_path(&output)?, refname];
        if let Some(b) = base.as_deref() {
            args.push(b);
        }
        checked(git(&self.path, &args, None, None)?)?;
        let preview = self.preview_bundle(&output)?;
        if !preview
            .refs
            .iter()
            .any(|r| r.name == refname && r.oid == tip)
        {
            return Err(Error::Other("export ref changed; retry".into()));
        }
        let mut dest = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        if let Err(e) =
            std::io::copy(&mut fs::File::open(output)?, &mut dest).and_then(|_| dest.flush())
        {
            drop(dest);
            let _ = fs::remove_file(destination);
            return Err(e.into());
        }
        Ok(preview)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (InterchangeScratch, Repo) {
        let scratch = InterchangeScratch::new().unwrap();
        let repo = git2::Repository::init(&scratch.0).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Committer").unwrap();
        config
            .set_str("user.email", "committer@example.test")
            .unwrap();
        config.set_bool("commit.gpgsign", false).unwrap();
        config.set_bool("core.autocrlf", false).unwrap();
        config.set_str("core.hooksPath", "/dev/null").unwrap();
        fs::write(scratch.0.join("file.txt"), "one\n").unwrap();
        checked(git(&scratch.0, &["add", "."], None, None).unwrap()).unwrap();
        checked(git(&scratch.0, &["commit", "-m", "base"], None, None).unwrap()).unwrap();
        (scratch, Repo::discover(repo.workdir().unwrap()).unwrap())
    }
    fn patch() -> &'static str {
        "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-one\n+two\n"
    }
    fn input(s: &InterchangeScratch, data: &str) -> PathBuf {
        let p = s.0.join("input.patch");
        fs::write(&p, data).unwrap();
        p
    }

    #[test]
    fn patch_targets_validation_and_stale_preview() {
        for target in [PatchTarget::Worktree, PatchTarget::Index, PatchTarget::Both] {
            let (_s, repo) = fixture();
            let input_dir = InterchangeScratch::new().unwrap();
            let p = input(&input_dir, patch());
            let preview = repo.preview_patch_import(&p, target).unwrap();
            assert!(preview.valid, "{}", preview.validation);
            assert_eq!(preview.paths, ["file.txt"]);
            assert!(
                repo.import_patch(&p, target, &preview.token)
                    .unwrap()
                    .success
            );
            let wt = fs::read_to_string(repo.path.join("file.txt")).unwrap();
            assert_eq!(
                wt,
                if target == PatchTarget::Index {
                    "one\n"
                } else {
                    "two\n"
                }
            );
            let staged =
                checked(git(&repo.path, &["show", ":file.txt"], None, None).unwrap()).unwrap();
            assert_eq!(
                staged.stdout,
                if target == PatchTarget::Worktree {
                    b"one\n"
                } else {
                    b"two\n"
                }
            );
            assert!(repo.import_patch(&p, target, &preview.token).is_err());
        }
        let (_s, repo) = fixture();
        let s = InterchangeScratch::new().unwrap();
        let p = input(&s, patch());
        let preview = repo
            .preview_patch_import(&p, PatchTarget::Worktree)
            .unwrap();
        fs::write(repo.path.join("file.txt"), "external edit\n").unwrap();
        assert!(repo
            .import_patch(&p, PatchTarget::Worktree, &preview.token)
            .is_err());
        assert!(
            !repo
                .preview_patch_import(&p, PatchTarget::Worktree)
                .unwrap()
                .valid
        );
    }

    #[test]
    fn reject_path_traversal_admin_and_nested_symlinks() {
        let (_s, repo) = fixture();
        for path in [
            "../outside",
            "/absolute",
            ".git/config",
            "C:/outside",
            "dir/../../out",
            "dir\\..\\out",
        ] {
            assert!(repo.check_import_path(path).is_err(), "{path}");
        }
        assert!(repo.check_import_path("new/nested/file").is_ok());
        let s = InterchangeScratch::new().unwrap();
        let p = input(&s, &patch().replace("file.txt", "../outside"));
        assert!(repo
            .preview_patch_import(&p, PatchTarget::Worktree)
            .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&s.0, repo.path.join("link")).unwrap();
            assert!(repo.check_import_path("link/new/file").is_err());
        }
    }

    fn mailbox(repo: &Repo, dir: &InterchangeScratch) -> PathBuf {
        fs::write(repo.path.join("file.txt"), "two\n").unwrap();
        checked(
            git(
                &repo.path,
                &[
                    "commit",
                    "-am",
                    "authored change",
                    "--author=Original Author <author@example.test>",
                ],
                None,
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let output = checked(
            git(
                &repo.path,
                &["format-patch", "--stdout", "-1", "HEAD"],
                None,
                None,
            )
            .unwrap(),
        )
        .unwrap();
        checked(git(&repo.path, &["reset", "--hard", "HEAD~1"], None, None).unwrap()).unwrap();
        let p = dir.0.join("mailbox");
        fs::write(&p, output.stdout).unwrap();
        p
    }

    #[test]
    fn mailbox_preserves_authors_and_recovers_continue_skip_abort() {
        for action in [
            MailboxAction::Continue,
            MailboxAction::Skip,
            MailboxAction::Abort,
        ] {
            let (_s, repo) = fixture();
            let dir = InterchangeScratch::new().unwrap();
            let p = mailbox(&repo, &dir);
            fs::write(repo.path.join("file.txt"), "diverged\n").unwrap();
            checked(git(&repo.path, &["commit", "-am", "divergence"], None, None).unwrap())
                .unwrap();
            let original = repo.git2().unwrap().head().unwrap().target().unwrap();
            let preview = repo.preview_patch_import(&p, PatchTarget::Mailbox).unwrap();
            assert!(preview.messages[0].contains("Original Author"));
            let outcome = repo
                .import_patch(&p, PatchTarget::Mailbox, &preview.token)
                .unwrap();
            assert!(outcome.paused, "{}", outcome.output);
            assert_eq!(
                Repo::discover(&repo.path)
                    .unwrap()
                    .meta()
                    .unwrap()
                    .operation
                    .as_deref(),
                Some("mailbox")
            );
            let before = repo.mailbox_state().unwrap().unwrap();
            assert!(before.author.contains("Original Author"));
            if matches!(action, MailboxAction::Continue) {
                fs::write(repo.path.join("file.txt"), "resolved\n").unwrap();
                checked(git(&repo.path, &["add", "file.txt"], None, None).unwrap()).unwrap();
                assert!(repo.mailbox_action(action, &before.token).is_err());
            }
            let state = repo.mailbox_state().unwrap().unwrap();
            let outcome = repo.mailbox_action(action, &state.token).unwrap();
            assert!(outcome.success && !outcome.paused, "{}", outcome.output);
            let fresh = git2::Repository::open(&repo.path).unwrap();
            let head = fresh.head().unwrap().peel_to_commit().unwrap();
            if matches!(action, MailboxAction::Continue) {
                assert_eq!(head.author().email(), Some("author@example.test"));
            } else {
                assert_eq!(head.id(), original);
            }
        }
    }

    #[test]
    fn clean_mailbox_series_previews_every_author_and_applies_in_order() {
        let (_s, repo) = fixture();
        let dir = InterchangeScratch::new().unwrap();
        for (text, author) in [
            ("two\n", "First <first@example.test>"),
            ("three\n", "Second <second@example.test>"),
        ] {
            fs::write(repo.path.join("file.txt"), text).unwrap();
            checked(
                git(
                    &repo.path,
                    &["commit", "-am", "series", &format!("--author={author}")],
                    None,
                    None,
                )
                .unwrap(),
            )
            .unwrap();
        }
        let out = checked(
            git(
                &repo.path,
                &["format-patch", "--stdout", "-2", "HEAD"],
                None,
                None,
            )
            .unwrap(),
        )
        .unwrap();
        checked(git(&repo.path, &["reset", "--hard", "HEAD~2"], None, None).unwrap()).unwrap();
        let p = dir.0.join("series");
        fs::write(&p, out.stdout).unwrap();
        let preview = repo.preview_patch_import(&p, PatchTarget::Mailbox).unwrap();
        assert!(preview.valid, "{}", preview.validation);
        assert_eq!(preview.messages.len(), 2);
        assert!(preview.messages[0].contains("first@example.test"));
        assert!(preview.messages[1].contains("second@example.test"));
        assert!(
            repo.import_patch(&p, PatchTarget::Mailbox, &preview.token)
                .unwrap()
                .success
        );
        assert_eq!(
            fs::read_to_string(repo.path.join("file.txt")).unwrap(),
            "three\n"
        );
        assert!(repo.mailbox_state().unwrap().is_none());
    }

    #[test]
    fn bundles_verify_prerequisites_and_never_overwrite_refs() {
        let (_s, repo) = fixture();
        let dir = InterchangeScratch::new().unwrap();
        let full = dir.0.join("full.bundle");
        let refname = repo
            .git2()
            .unwrap()
            .head()
            .unwrap()
            .name()
            .unwrap()
            .to_owned();
        let full_preview = repo.export_bundle(&full, &refname, None).unwrap();
        assert!(full_preview.valid && full_preview.prerequisites.is_empty());
        let (_r, receiver) = fixture();
        let outcome = receiver
            .import_bundle(&full, &full_preview.token, &refname, "imported")
            .unwrap();
        assert!(outcome.success);
        assert!(receiver
            .import_bundle(&full, &full_preview.token, &refname, "imported")
            .is_err());
        assert!(repo.export_bundle(&full, &refname, None).is_err());
        fs::write(repo.path.join("file.txt"), "next\n").unwrap();
        checked(git(&repo.path, &["commit", "-am", "next"], None, None).unwrap()).unwrap();
        let incremental = dir.0.join("incremental.bundle");
        let preview = repo
            .export_bundle(&incremental, &refname, Some("HEAD~1"))
            .unwrap();
        assert_eq!(preview.prerequisites.len(), 1);
        let empty = InterchangeScratch::new().unwrap();
        git2::Repository::init(&empty.0).unwrap();
        let empty_repo = Repo::discover(&empty.0).unwrap();
        assert!(!empty_repo.preview_bundle(&incremental).unwrap().valid);
        assert!(empty_repo
            .import_bundle(&incremental, &preview.token, &refname, "missing")
            .is_err());
    }
}
