//! Blame — per-line authorship for a tracked file at HEAD.
//!
//! Uses `git2::Repository::blame_file`, which maps each line of the file (as it
//! exists at HEAD) to the commit that last touched it. We pair the blame hunks
//! with the file's HEAD content so the UI gets line text + author + commit in
//! one shot, ready to render and to jump to the blamed commit in the graph.
//!
//! Blame is always against HEAD's version of the file (not the working tree),
//! matching `git blame` — uncommitted edits aren't attributed. Binary or very
//! large files are rejected rather than blamed.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

/// Cap on lines we'll blame — blame is O(history × lines) and this view is
/// on-demand, so we refuse pathologically large files instead of freezing.
const MAX_BLAME_LINES: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlameLine {
    /// 1-based line number in the HEAD version of the file.
    pub line_no: u32,
    /// The line's text (newline stripped).
    pub content: String,
    /// Full OID of the commit that last touched this line. Empty if unknown.
    pub commit: String,
    /// Short OID for display.
    pub short: String,
    pub author: String,
    pub author_email: String,
    /// Author time (unix seconds).
    pub time_unix: i64,
    /// Subject line of the blamed commit.
    pub summary: String,
}

impl Repo {
    /// Blame `rel_path` against HEAD, returning one entry per line. Errors when
    /// the file isn't in HEAD, is binary, or exceeds [`MAX_BLAME_LINES`].
    pub fn blame(&self, rel_path: &str) -> Result<Vec<BlameLine>> {
        let repo = self.git2()?;

        // Load the HEAD version of the file — blame's line numbers index into
        // exactly this content.
        let tree = repo
            .head()
            .map_err(|_| Error::Other("repository has no commits to blame".into()))?
            .peel_to_commit()?
            .tree()?;
        let entry = tree
            .get_path(Path::new(rel_path))
            .map_err(|_| Error::Other(format!("{rel_path} is not tracked at HEAD")))?;
        let blob = self.find_blob(entry.id())?;
        if blob.is_binary() {
            return Err(Error::Other(format!("{rel_path} is binary — no blame")));
        }
        let text = String::from_utf8_lossy(blob.content());
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() > MAX_BLAME_LINES {
            return Err(Error::Other(format!(
                "{rel_path} has {} lines — too large to blame",
                lines.len()
            )));
        }

        if self.is_partial_clone() || repo.is_shallow() {
            return self.blame_with_git(rel_path);
        }
        let mut opts = git2::BlameOptions::new();
        let blame = repo.blame_file(Path::new(rel_path), Some(&mut opts))?;

        // Cache (short, summary) per commit so we don't re-find a commit for
        // every line attributed to it.
        let mut meta: HashMap<git2::Oid, (String, String)> = HashMap::new();
        let mut out = Vec::with_capacity(lines.len());
        for (i, line) in lines.iter().enumerate() {
            let line_no = (i + 1) as u32;
            match blame.get_line(i + 1) {
                Some(hunk) => {
                    let oid = hunk.final_commit_id();
                    let sig = hunk.final_signature();
                    let (short, summary) = meta
                        .entry(oid)
                        .or_insert_with(|| {
                            let s = oid.to_string();
                            let short = s[..7.min(s.len())].to_string();
                            let summary = repo
                                .find_commit(oid)
                                .ok()
                                .and_then(|c| c.summary().map(|x| x.to_string()))
                                .unwrap_or_default();
                            (short, summary)
                        })
                        .clone();
                    out.push(BlameLine {
                        line_no,
                        content: (*line).to_string(),
                        commit: oid.to_string(),
                        short,
                        author: sig.name().unwrap_or("").to_string(),
                        author_email: sig.email().unwrap_or("").to_string(),
                        time_unix: sig.when().seconds(),
                        summary,
                    });
                }
                None => out.push(BlameLine {
                    line_no,
                    content: (*line).to_string(),
                    commit: String::new(),
                    short: String::new(),
                    author: String::new(),
                    author_email: String::new(),
                    time_unix: 0,
                    summary: String::new(),
                }),
            }
        }
        Ok(out)
    }

    /// Git understands shallow boundaries and can fetch promised blobs while
    /// walking history. Keep that work on demand, after the size/binary gate.
    fn blame_with_git(&self, path: &str) -> Result<Vec<BlameLine>> {
        let output = crate::git_command().current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0").args(crate::GIT_SAFE_CONFIG)
            .args(["blame", "--line-porcelain", "HEAD", "--", path]).output()?;
        if !output.status.success() {
            return Err(Error::Other(String::from_utf8_lossy(&output.stderr).trim().into()));
        }
        let mut result = Vec::new();
        let mut current: Option<BlameLine> = None;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(content) = line.strip_prefix('\t') {
                if let Some(mut entry) = current.take() {
                    entry.content = content.to_owned();
                    result.push(entry);
                }
                continue;
            }
            let fields: Vec<_> = line.split(' ').collect();
            if fields.len() >= 3 && fields[0].len() == 40 && fields[0].bytes().all(|b| b.is_ascii_hexdigit()) {
                current = Some(BlameLine {
                    line_no: fields[2].parse().map_err(|_| Error::Other("Invalid Git blame line".into()))?,
                    commit: fields[0].into(), short: fields[0][..7].into(), content: String::new(),
                    author: String::new(), author_email: String::new(), time_unix: 0, summary: String::new(),
                });
            } else if let Some(entry) = &mut current {
                if let Some(value) = line.strip_prefix("author ") { entry.author = value.into(); }
                else if let Some(value) = line.strip_prefix("author-mail ") { entry.author_email = value.trim_start_matches('<').trim_end_matches('>').into(); }
                else if let Some(value) = line.strip_prefix("author-time ") { entry.time_unix = value.parse().map_err(|_| Error::Other("Invalid Git blame time".into()))?; }
                else if let Some(value) = line.strip_prefix("summary ") { entry.summary = value.into(); }
            }
        }
        Ok(result)
    }
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

    #[test]
    fn blames_lines_to_their_commits() {
        let dir = std::env::temp_dir().join(format!(
            "strand-blame-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Alice"]);
        git(&dir, &["config", "user.email", "alice@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);

        std::fs::write(dir.join("f.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        let first = git(&dir, &["rev-parse", "HEAD"]);

        // Append a third line in a second commit.
        std::fs::write(dir.join("f.txt"), "one\ntwo\nthree\n").unwrap();
        git(&dir, &["add", "f.txt"]);
        git(&dir, &["commit", "-q", "-m", "add three"]);
        let second = git(&dir, &["rev-parse", "HEAD"]);

        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();
        let lines = repo.blame("f.txt").unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].content, "one");
        assert_eq!(lines[0].commit, first, "line 1 from the first commit");
        assert_eq!(lines[2].content, "three");
        assert_eq!(lines[2].commit, second, "line 3 from the second commit");
        assert_eq!(lines[2].author, "Alice");
        assert_eq!(lines[2].summary, "add three");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
