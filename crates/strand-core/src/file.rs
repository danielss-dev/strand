//! Per-file reads for the file view: content (working tree or at a revision)
//! and history (the log for one path).
//!
//! Content is read straight from the working tree (default) or from a blob at a
//! revision via `git2`. History **shells out** to `git log --follow` — git's
//! pathspec-limited, rename-following history walk is both faster and more
//! correct than re-implementing rename detection across a `git2` revwalk, and
//! it's an on-demand view, not a hot path.

use std::path::Path;
use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// Cap on bytes returned for the Content tab. A file past this is truncated
/// (with `truncated = true`) so the renderer never tries to lay out a 100 MB
/// blob.
const MAX_CONTENT_BYTES: usize = 2_000_000;

/// Cap on raw bytes returned by [`Repo::file_blob`] (image previews). Past
/// this the blob comes back empty with `too_large = true`.
const MAX_BLOB_BYTES: usize = 8_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct FileContent {
    pub path: String,
    /// File text (empty when `binary`). Truncated to [`MAX_CONTENT_BYTES`].
    pub text: String,
    /// True when the bytes look binary (a NUL byte / git's binary heuristic).
    pub binary: bool,
    /// True when the file exceeded [`MAX_CONTENT_BYTES`] and `text` is a prefix.
    pub truncated: bool,
    /// True when the complete file is UTF-8 text and can be edited safely.
    pub editable: bool,
}

/// Raw file bytes (base64) for the image diff preview.
#[derive(Debug, Clone, Serialize)]
pub struct FileBlob {
    /// Standard base64 (RFC 4648, padded). Empty when `too_large`.
    pub base64: String,
    /// Byte size of the file — reported even when `too_large`.
    pub size: usize,
    /// True when the file exceeded [`MAX_BLOB_BYTES`] and `base64` is empty.
    pub too_large: bool,
}

/// Where [`Repo::file_blob`] reads from. Internal — the IPC layer maps its
/// `(rev: Option<String>, index: bool)` arguments onto this.
pub enum BlobSource<'a> {
    Worktree,
    Index,
    Rev(&'a str),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct FileHistoryEntry {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub time_unix: i64,
    pub subject: String,
    /// Lines added to this path in the commit (`0` for a binary change).
    pub adds: u32,
    /// Lines removed from this path in the commit.
    pub dels: u32,
}

/// One bounded working-tree read for transports. The metadata token detects
/// ordinary concurrent edits between chunks; it is not a content hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct FileChunk {
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub next_offset: u64,
    pub total: u64,
    pub version: String,
}

impl Repo {
    pub fn file_chunk(&self, path: &str, offset: u64, length: usize, expected: Option<&str>) -> Result<FileChunk> {
        use std::io::{Read, Seek, SeekFrom};
        if !(1..=65_536).contains(&length) { return Err(Error::Other("File chunk must be 1–65536 bytes.".into())); }
        let mut file = std::fs::File::open(self.workdir_path(path)?)?;
        let meta = file.metadata()?;
        if !meta.is_file() || offset > meta.len() { return Err(Error::Other("Invalid file or chunk offset.".into())); }
        let token = |meta: &std::fs::Metadata| -> Result<String> {
            let time = meta.modified()?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
            Ok(format!("{}:{time}", meta.len()))
        };
        let version = token(&meta)?;
        if expected.is_some_and(|expected| expected != version) { return Err(Error::Other("File changed; restart reading at byte 0.".into())); }
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::with_capacity(length);
        (&mut file).take(length as u64).read_to_end(&mut bytes)?;
        if token(&file.metadata()?)? != version { return Err(Error::Other("File changed during read; retry.".into())); }
        Ok(FileChunk { next_offset: offset + bytes.len() as u64, bytes, offset, total: meta.len(), version })
    }

    /// Read a file's content. `rev = None` reads the working-tree copy from disk
    /// (with the same path-traversal guard the conflict reader uses); `rev =
    /// Some(spec)` reads the blob from that revision's tree.
    pub fn file_content(&self, rel_path: &str, rev: Option<&str>) -> Result<FileContent> {
        match rev {
            None => {
                let full = self.safe_workdir_path(rel_path)?;
                let bytes = std::fs::read(&full)?;
                Ok(build_content(rel_path, &bytes, looks_binary(&bytes)))
            }
            Some(spec) => {
                let repo = self.git2()?;
                let tree = repo.revparse_single(spec)?.peel_to_commit()?.tree()?;
                let entry = tree.get_path(Path::new(rel_path)).map_err(|_| {
                    Error::Other(format!("{rel_path} does not exist at {spec}"))
                })?;
                let blob = self.find_blob(entry.id())?;
                Ok(build_content(rel_path, blob.content(), blob.is_binary()))
            }
        }
    }

    /// Replace an existing working-tree text file. `expected` is the content
    /// returned by the last read; refusing a stale write prevents the editor
    /// from silently overwriting an agent or external editor's newer version.
    pub fn write_file_content(
        &self,
        rel_path: &str,
        expected: &str,
        content: &str,
    ) -> Result<FileContent> {
        if content.len() > MAX_CONTENT_BYTES {
            return Err(Error::Other(format!(
                "{rel_path} is too large to edit in Strand"
            )));
        }

        let full = self.safe_workdir_path(rel_path)?;
        let metadata = std::fs::symlink_metadata(&full)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(Error::Other(format!("{rel_path} is not an editable file")));
        }

        let bytes = std::fs::read(&full)?;
        if bytes.len() > MAX_CONTENT_BYTES || looks_binary(&bytes) {
            return Err(Error::Other(format!("{rel_path} is not editable text")));
        }
        let current = std::str::from_utf8(&bytes)
            .map_err(|_| Error::Other(format!("{rel_path} is not UTF-8 text")))?;
        if current != expected {
            return Err(Error::Other(format!(
                "{rel_path} changed on disk; reload it before saving"
            )));
        }

        // A textarea normalizes newlines to LF. Keep a consistently-CRLF file
        // consistently CRLF so one edit does not turn every line into a diff.
        let crlf_count = current.matches("\r\n").count();
        let lf_count = current.bytes().filter(|byte| *byte == b'\n').count();
        let output = if crlf_count > 0 && crlf_count == lf_count {
            content.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            content.to_string()
        };
        std::fs::write(&full, output.as_bytes())?;
        Ok(build_content(rel_path, output.as_bytes(), false))
    }

    /// Read a file's raw bytes for the image preview: the working-tree copy,
    /// the staged (index) copy, or the blob at a revision. Oversized files
    /// return `too_large` instead of bytes (the worktree branch checks the
    /// fs metadata size before reading anything).
    pub fn file_blob(&self, rel_path: &str, source: BlobSource) -> Result<FileBlob> {
        match source {
            BlobSource::Worktree => {
                let full = self.safe_workdir_path(rel_path)?;
                let size = std::fs::metadata(&full)?.len();
                if size as usize > MAX_BLOB_BYTES {
                    return Ok(FileBlob { base64: String::new(), size: size as usize, too_large: true });
                }
                Ok(build_blob(&std::fs::read(&full)?))
            }
            BlobSource::Index => {
                let repo = self.git2()?;
                let entry = repo
                    .index()?
                    .get_path(Path::new(rel_path), 0)
                    .ok_or_else(|| Error::Other(format!("{rel_path} is not in the index")))?;
                let blob = self.find_blob(entry.id)?;
                Ok(build_blob(blob.content()))
            }
            BlobSource::Rev(spec) => {
                let repo = self.git2()?;
                let tree = repo.revparse_single(spec)?.peel_to_commit()?.tree()?;
                let entry = tree.get_path(Path::new(rel_path)).map_err(|_| {
                    Error::Other(format!("{rel_path} does not exist at {spec}"))
                })?;
                let blob = self.find_blob(entry.id())?;
                Ok(build_blob(blob.content()))
            }
        }
    }

    /// Commits that touched `rel_path`, newest first, following renames
    /// (`git log --follow`). Returns up to `limit` entries with per-path
    /// add/delete counts. An untracked / never-committed path yields an empty
    /// list (not an error).
    pub fn file_history(&self, rel_path: &str, limit: usize) -> Result<Vec<FileHistoryEntry>> {
        if rel_path.is_empty() {
            return Err(Error::Other("empty path".into()));
        }
        if rel_path.starts_with('-') {
            return Err(Error::Other(format!("path may not start with '-': {rel_path}")));
        }
        let limit_arg = limit.to_string();
        // Record separator (\x1f) between fields; a marker prefix distinguishes
        // the format line from the interleaved `--numstat` lines.
        let format = format!("--format={MARKER}%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s");
        let out = crate::git_command()
            .current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(crate::GIT_SAFE_CONFIG)
            .args([
                "log",
                "--follow",
                "--no-color",
                "-n",
                &limit_arg,
                "--numstat",
                &format,
                "--",
                rel_path,
            ])
            .output()
            .map_err(|e| Error::Other(format!("spawn git failed: {e}")))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(Error::Other(if err.is_empty() {
                "git log failed".to_string()
            } else {
                err
            }));
        }
        Ok(parse_history(&String::from_utf8_lossy(&out.stdout)))
    }
}

/// Marker prefixing each commit's `--format` line so the parser can tell it
/// apart from the `--numstat` rows that follow.
const MARKER: &str = "\u{1e}C\u{1e}";

fn build_content(path: &str, bytes: &[u8], binary: bool) -> FileContent {
    let truncated = bytes.len() > MAX_CONTENT_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_CONTENT_BYTES)];
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(slice).into_owned()
    };
    FileContent {
        path: path.to_string(),
        text,
        binary,
        truncated,
        editable: !binary && !truncated && std::str::from_utf8(bytes).is_ok(),
    }
}

/// Cheap binary heuristic: a NUL byte in the first 8 KiB (what git effectively
/// does). Avoids scanning a huge file in full.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

fn build_blob(bytes: &[u8]) -> FileBlob {
    if bytes.len() > MAX_BLOB_BYTES {
        return FileBlob { base64: String::new(), size: bytes.len(), too_large: true };
    }
    FileBlob { base64: base64_encode(bytes), size: bytes.len(), too_large: false }
}

/// Standard base64 (RFC 4648 alphabet, `=`-padded). Std-only — the crate has
/// no base64 dependency and this is the lone encoder use.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Parse `git log --numstat --format=<MARKER>…` output into history entries.
/// A line starting with [`MARKER`] opens a new commit; the `adds\tdels\tpath`
/// rows that follow accumulate into it (binary changes report `-` and count 0).
fn parse_history(stdout: &str) -> Vec<FileHistoryEntry> {
    let mut out: Vec<FileHistoryEntry> = Vec::new();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix(MARKER) {
            let mut f = rest.split('\u{1f}');
            let entry = FileHistoryEntry {
                hash: f.next().unwrap_or("").to_string(),
                short_hash: f.next().unwrap_or("").to_string(),
                author_name: f.next().unwrap_or("").to_string(),
                author_email: f.next().unwrap_or("").to_string(),
                time_unix: f.next().unwrap_or("0").parse().unwrap_or(0),
                subject: f.next().unwrap_or("").to_string(),
                adds: 0,
                dels: 0,
            };
            out.push(entry);
        } else if !line.trim().is_empty() {
            // numstat row: adds \t dels \t path
            if let Some(cur) = out.last_mut() {
                let mut cols = line.split('\t');
                let a = cols.next().unwrap_or("");
                let d = cols.next().unwrap_or("");
                cur.adds += a.parse::<u32>().unwrap_or(0);
                cur.dels += d.parse::<u32>().unwrap_or(0);
            }
        }
    }
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

    fn scratch() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-file-test-{}-{:?}",
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

    #[test]
    fn history_follows_renames_with_counts() {
        let (repo, dir) = scratch();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "create a"]);

        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "edit a"]);

        // Rename a.txt -> b.txt; --follow should still report all three.
        git(&dir, &["mv", "a.txt", "b.txt"]);
        git(&dir, &["commit", "-q", "-m", "rename to b"]);

        let hist = repo.file_history("b.txt", 50).unwrap();
        assert_eq!(hist.len(), 3, "follows the rename across all commits");
        assert_eq!(hist[0].subject, "rename to b");
        assert_eq!(hist[2].subject, "create a");
        // The "edit a" commit added one line.
        assert_eq!(hist[1].adds, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_reads_working_tree_and_revision() {
        let (repo, dir) = scratch();
        std::fs::write(dir.join("c.txt"), "v1\n").unwrap();
        git(&dir, &["add", "c.txt"]);
        git(&dir, &["commit", "-q", "-m", "v1"]);
        // Modify the working tree without committing.
        std::fs::write(dir.join("c.txt"), "v2\n").unwrap();

        let wt = repo.file_content("c.txt", None).unwrap();
        assert_eq!(wt.text, "v2\n");
        assert!(!wt.binary);
        assert!(wt.editable);

        let head = repo.file_content("c.txt", Some("HEAD")).unwrap();
        assert_eq!(head.text, "v1\n", "HEAD blob is the committed version");

        // Empty / untracked-path history.
        assert!(repo.file_history("nope.txt", 10).unwrap().is_empty());

        // Path traversal is rejected.
        assert!(repo.file_content("../escape.txt", None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_write_preserves_line_endings_and_rejects_stale_writes() {
        let (repo, dir) = scratch();
        std::fs::write(dir.join("edit.txt"), "one\r\ntwo\r\n").unwrap();

        let saved = repo
            .write_file_content("edit.txt", "one\r\ntwo\r\n", "one\nchanged\n")
            .unwrap();
        assert_eq!(saved.text, "one\r\nchanged\r\n");
        assert_eq!(std::fs::read(dir.join("edit.txt")).unwrap(), b"one\r\nchanged\r\n");

        let stale = repo.write_file_content("edit.txt", "one\r\ntwo\r\n", "lost\n");
        assert!(stale.is_err());
        assert_eq!(std::fs::read(dir.join("edit.txt")).unwrap(), b"one\r\nchanged\r\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_write_rejects_non_utf8_and_traversal() {
        let (repo, dir) = scratch();
        std::fs::write(dir.join("invalid.txt"), [0xff, 0xfe]).unwrap();

        let invalid = repo.file_content("invalid.txt", None).unwrap();
        assert!(!invalid.binary);
        assert!(!invalid.editable);
        assert!(repo.write_file_content("invalid.txt", &invalid.text, "text").is_err());
        assert!(repo.write_file_content("../escape.txt", "", "text").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // Binary bytes (not valid UTF-8).
        assert_eq!(base64_encode(&[0x00, 0xff, 0x10]), "AP8Q");
    }

    #[test]
    fn blob_reads_worktree_index_and_rev() {
        let (repo, dir) = scratch();
        // Bytes with a NUL so the file is unambiguously binary.
        let v1: &[u8] = b"\x89PNG\x00\n";
        std::fs::write(dir.join("img.png"), v1).unwrap();
        git(&dir, &["add", "img.png"]);
        git(&dir, &["commit", "-q", "-m", "v1"]);

        // Stage v2, then write v3 to the working tree — three distinct copies.
        let v2: &[u8] = b"\x89PNG\x00\x01";
        std::fs::write(dir.join("img.png"), v2).unwrap();
        git(&dir, &["add", "img.png"]);
        let v3: &[u8] = b"\x89PNG\x00\x02";
        std::fs::write(dir.join("img.png"), v3).unwrap();

        let wt = repo.file_blob("img.png", BlobSource::Worktree).unwrap();
        assert_eq!(wt.base64, "iVBORwAC", "worktree bytes, precomputed base64");
        assert_eq!(wt.size, v3.len());
        assert!(!wt.too_large);

        let idx = repo.file_blob("img.png", BlobSource::Index).unwrap();
        assert_eq!(idx.base64, "iVBORwAB");

        let head = repo.file_blob("img.png", BlobSource::Rev("HEAD")).unwrap();
        assert_eq!(head.base64, "iVBORwAK");

        assert!(repo.file_blob("missing.png", BlobSource::Index).is_err());
        assert!(repo.file_blob("missing.png", BlobSource::Rev("HEAD")).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blob_caps_oversized_files() {
        let (repo, dir) = scratch();
        let big = vec![0u8; MAX_BLOB_BYTES + 1];
        std::fs::write(dir.join("big.bin"), &big).unwrap();

        let blob = repo.file_blob("big.bin", BlobSource::Worktree).unwrap();
        assert!(blob.too_large);
        assert_eq!(blob.base64, "");
        assert_eq!(blob.size, MAX_BLOB_BYTES + 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
