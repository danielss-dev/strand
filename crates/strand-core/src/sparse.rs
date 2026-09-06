//! Cone checkout management and an in-memory read bridge for libgit2 1.8,
//! which cannot read Git's mandatory sparse-directory index extension.
use std::{collections::BTreeSet, io::Write, process::Stdio};
use serde::{Deserialize, Serialize};
use crate::{Error, Repo, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SparseCheckout {
    pub enabled: bool,
    pub cone: bool,
    pub sparse_index: bool,
    pub directories: Vec<String>,
    pub available: Vec<String>,
    pub patterns: String,
}

impl Repo {
    pub(crate) fn sparse_enabled(&self) -> bool {
        self.gix.config_snapshot().boolean("core.sparseCheckout").unwrap_or(false)
    }

    pub fn sparse_checkout(&self) -> Result<SparseCheckout> {
        let enabled = self.sparse_enabled();
        let config = self.gix.config_snapshot();
        let cone = config.boolean("core.sparseCheckoutCone").unwrap_or(false);
        let sparse_index = config.boolean("index.sparse").unwrap_or(false);
        let patterns = if enabled {
            std::fs::read_to_string(self.git_dir().join("info/sparse-checkout"))?
        } else { String::new() };
        let directories = if enabled && cone {
            // Read the literal cone rules rather than Git's quoted display output.
            patterns.lines().filter_map(|line| {
                if line.starts_with('/') && line.ends_with('/') && line != "/*" {
                    Some(unescape_cone(&line[1..line.len() - 1]))
                } else { None }
            }).filter(|dir| !patterns.lines().any(|line| line == format!("!/{dir}/*/", dir = escape_cone(dir)))).collect()
        } else { Vec::new() };
        let available = self.sparse_git(&["ls-tree", "-d", "-r", "--name-only", "-z", "HEAD"], None)?;
        Ok(SparseCheckout { enabled, cone, sparse_index, directories, available: nul_paths(&available)?, patterns })
    }

    pub fn set_sparse_checkout(&self, directories: &[String], sparse_index: bool) -> Result<String> {
        let state = self.sparse_checkout()?;
        if state.enabled && !state.cone {
            return Err(Error::Other("This checkout uses non-cone patterns. Disable it before selecting cone directories.".into()));
        }
        let available: BTreeSet<_> = state.available.iter().chain(state.directories.iter()).collect();
        for directory in directories {
            if directory.is_empty() || directory.contains(['\\', '\n', '\r', '\0'])
                || directory.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git"))
                || !available.contains(directory)
            {
                return Err(Error::Other(format!("Not a tracked repository directory: {directory}")));
            }
        }
        self.ensure_sparse_change_clean(Some(directories))?;
        // --stdin avoids Windows argv limits and Git option/pathspec interpretation.
        let input = directories.iter().map(|dir| format!("\"{}\"\n", dir.replace('"', "\\\""))).collect::<String>();
        let output = self.sparse_git(&["sparse-checkout", "set", "--cone", if sparse_index { "--sparse-index" } else { "--no-sparse-index" }, "--stdin"], Some(input.as_bytes()))?;
        Ok(String::from_utf8_lossy(&output).trim().into())
    }

    pub fn disable_sparse_checkout(&self) -> Result<String> {
        self.ensure_sparse_change_clean(None)?;
        let output = self.sparse_git(&["sparse-checkout", "disable"], None)?;
        Ok(String::from_utf8_lossy(&output).trim().into())
    }

    fn ensure_sparse_change_clean(&self, directories: Option<&[String]>) -> Result<()> {
        if self.operation_in_progress().is_some() {
            return Err(Error::Other("Finish the current Git operation before changing sparse checkout.".into()));
        }
        let output = self.sparse_git(&["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"], None)?;
        let records = nul_paths(&output)?;
        for record in records {
            if let Some(path) = record.strip_prefix("!! ") {
                let probe = if path.ends_with('/') { format!("{path}__ignored__") } else { path.to_owned() };
                if directories.is_some_and(|dirs| !cone_includes(&probe, dirs)) {
                    return Err(Error::Other(format!("Ignored files in {path} could be removed by Git. Include that directory or move those files before changing sparse checkout.")));
                }
            } else {
                return Err(Error::Other("Commit or stash local changes and move untracked files before changing sparse checkout. Your files and index have been preserved.".into()));
            }
        }
        // The read-only guard leaves index stat data untouched. Refresh only
        // after it passes: otherwise Git can retain a restored clean file as
        // "not up to date" when removing its directory from the cone.
        self.sparse_git(&["update-index", "--refresh"], None)?;
        Ok(())
    }

    pub(crate) fn sparse_git(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
        let mut child = crate::git_command().current_dir(&self.path)
            .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
            .args(crate::GIT_SAFE_CONFIG).args(args)
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
        if let Some(input) = input {
            // Write concurrently so an early Git error cannot deadlock a large selection.
            let mut stdin = child.stdin.take().expect("piped stdin");
            let input = input.to_vec();
            std::thread::spawn(move || { let _ = stdin.write_all(&input); });
        }
        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(Error::Other(String::from_utf8_lossy(&output.stderr).trim().into()));
        }
        let mut bytes = output.stdout;
        // Successful sparse changes can still warn about retained files.
        if args.first() == Some(&"sparse-checkout") { bytes.extend_from_slice(&output.stderr); }
        Ok(bytes)
    }

    /// Attach an expanded *memory-only* index for readers. Never rewrite the
    /// user's sparse index merely by opening/refreshing a repository.
    pub(crate) fn sparse_read_index(&self, repo: &git2::Repository) -> Result<()> {
        let output = self.sparse_git(&["ls-files", "--stage", "-t", "-z"], None)?;
        let mut index = git2::Index::new()?;
        for record in output.split(|byte| *byte == 0).filter(|row| !row.is_empty()) {
            let tab = record.iter().position(|byte| *byte == b'\t').ok_or_else(|| Error::Other("Invalid Git index listing".into()))?;
            let header = std::str::from_utf8(&record[..tab]).map_err(|e| Error::Other(e.to_string()))?;
            let fields: Vec<_> = header.split(' ').collect();
            if fields.len() != 4 { return Err(Error::Other("Invalid Git index entry".into())); }
            let mode = u32::from_str_radix(fields[1], 8).map_err(|e| Error::Other(e.to_string()))?;
            let stage = fields[3].parse::<u16>().map_err(|e| Error::Other(e.to_string()))?;
            index.add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0), mtime: git2::IndexTime::new(0, 0),
                dev: 0, ino: 0, mode, uid: 0, gid: 0, file_size: 0,
                id: git2::Oid::from_str(fields[2])?, flags: stage << 12,
                flags_extended: if fields[0] == "S" { 1 << 14 } else { 0 },
                path: record[tab + 1..].to_vec(),
            })?;
        }
        repo.set_index(&mut index)?;
        Ok(())
    }
}

pub(crate) fn cone_includes(path: &str, directories: &[String]) -> bool {
    !path.contains('/') || directories.iter().any(|dir| {
        path == dir || path.starts_with(&format!("{dir}/"))
            || path.rsplit_once('/').is_some_and(|(parent, _)| dir.starts_with(&format!("{parent}/")))
    })
}

fn nul_paths(bytes: &[u8]) -> Result<Vec<String>> {
    bytes.split(|byte| *byte == 0).filter(|row| !row.is_empty())
        .map(|row| String::from_utf8(row.to_vec()).map_err(|_| Error::Other("Sparse directory names must be UTF-8.".into()))).collect()
}

fn unescape_cone(value: &str) -> String {
    let mut chars = value.chars();
    let mut result = String::new();
    while let Some(c) = chars.next() { result.push(if c == '\\' { chars.next().unwrap_or(c) } else { c }); }
    result
}
fn escape_cone(value: &str) -> String {
    value.chars().flat_map(|c| if matches!(c, '*' | '?' | '[' | ']' | '\\') { vec!['\\', c] } else { vec![c] }).collect()
}
