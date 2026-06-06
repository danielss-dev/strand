//! Per-file reads for the file view: content (working tree or at a revision)
//! and history (the log for one path).
//!
//! Content is read straight from the working tree (default) or from a blob at a
//! revision via `git2`. History **shells out** to `git log --follow` — git's
//! pathspec-limited, rename-following history walk is both faster and more
//! correct than re-implementing rename detection across a `git2` revwalk, and
//! it's an on-demand view, not a hot path.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// Cap on bytes returned for the Content tab. A file past this is truncated
/// (with `truncated = true`) so the renderer never tries to lay out a 100 MB
/// blob.
const MAX_CONTENT_BYTES: usize = 2_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    /// File text (empty when `binary`). Truncated to [`MAX_CONTENT_BYTES`].
    pub text: String,
    /// True when the bytes look binary (a NUL byte / git's binary heuristic).
    pub binary: bool,
    /// True when the file exceeded [`MAX_CONTENT_BYTES`] and `text` is a prefix.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl Repo {
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
                let blob = repo
                    .find_blob(entry.id())
                    .map_err(|_| Error::Other(format!("{rel_path} is not a file at {spec}")))?;
                Ok(build_content(rel_path, blob.content(), blob.is_binary()))
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
        let out = Command::new("git")
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
    }
}

/// Cheap binary heuristic: a NUL byte in the first 8 KiB (what git effectively
/// does). Avoids scanning a huge file in full.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
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

        let head = repo.file_content("c.txt", Some("HEAD")).unwrap();
        assert_eq!(head.text, "v1\n", "HEAD blob is the committed version");

        // Empty / untracked-path history.
        assert!(repo.file_history("nope.txt", 10).unwrap().is_empty());

        // Path traversal is rejected.
        assert!(repo.file_content("../escape.txt", None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
