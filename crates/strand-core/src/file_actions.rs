//! Safe working-tree file creation, deletion, path resolution, and reveal.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use crate::{Error, Repo, Result};

fn native_path_string(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    if cfg!(target_os = "windows") {
        value.replace('/', "\\")
    } else {
        value
    }
}

fn validate_user_path(path: &str) -> Result<&str> {
    let path = path.trim_end_matches(['/', '\\']);
    if path.is_empty() {
        return Err(Error::Other("empty working-tree path".into()));
    }
    if Path::new(path).components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|part| part.eq_ignore_ascii_case(".git"))
    }) {
        return Err(Error::Other("working-tree file actions cannot modify .git".into()));
    }
    Ok(path)
}

impl Repo {
    /// Create one empty file or directory. The parent must already exist and
    /// existing entries are never overwritten.
    pub fn create_worktree_entry(&self, rel_path: &str, directory: bool) -> Result<()> {
        let rel_path = validate_user_path(rel_path)?;
        let full = self.safe_workdir_path(rel_path)?;
        if std::fs::symlink_metadata(&full).is_ok() {
            return Err(Error::Other(format!("{rel_path} already exists")));
        }
        if directory {
            std::fs::create_dir(&full)?;
        } else {
            OpenOptions::new().write(true).create_new(true).open(&full)?;
        }
        Ok(())
    }

    /// Delete files/directories from the working tree without touching the
    /// index. Every target is validated before the first deletion, and child
    /// targets are folded into an already-selected parent directory.
    pub fn delete_worktree_entries(&self, rel_paths: &[String]) -> Result<()> {
        if rel_paths.is_empty() {
            return Err(Error::Other("no working-tree paths selected".into()));
        }

        let mut seen = HashSet::new();
        let mut targets: Vec<(String, PathBuf, std::fs::Metadata)> = Vec::new();
        for rel_path in rel_paths {
            let rel_path = validate_user_path(rel_path)?.replace('\\', "/");
            if !seen.insert(rel_path.clone()) {
                continue;
            }
            let full = self.safe_workdir_path(&rel_path)?;
            let metadata = std::fs::symlink_metadata(&full)
                .map_err(|_| Error::Other(format!("{rel_path} does not exist")))?;
            targets.push((rel_path, full, metadata));
        }

        targets.sort_by_key(|(rel, _, _)| rel.matches('/').count());
        let mut kept: Vec<(String, PathBuf, std::fs::Metadata)> = Vec::new();
        for target in targets {
            let rel = Path::new(&target.0);
            if kept.iter().any(|(parent, _, metadata)| {
                metadata.is_dir() && rel.starts_with(Path::new(parent))
            }) {
                continue;
            }
            kept.push(target);
        }

        for (_, full, metadata) in kept {
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                std::fs::remove_dir_all(full)?;
            } else {
                std::fs::remove_file(full)?;
            }
        }
        Ok(())
    }

    pub fn absolute_worktree_paths(&self, rel_paths: &[String]) -> Result<Vec<String>> {
        rel_paths
            .iter()
            .map(|rel_path| {
                let rel_path = validate_user_path(rel_path)?;
                let full = self.safe_workdir_path(rel_path)?;
                std::fs::symlink_metadata(&full)
                    .map_err(|_| Error::Other(format!("{rel_path} does not exist")))?;
                Ok(native_path_string(&full))
            })
            .collect()
    }
}

pub(crate) fn reveal_argv(path: &Path, directory: bool) -> Vec<String> {
    let value = native_path_string(path);
    if cfg!(target_os = "windows") {
        vec!["explorer.exe".into(), format!("/select,{value}")]
    } else if cfg!(target_os = "macos") {
        vec!["open".into(), "-R".into(), value]
    } else {
        let target = if directory {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        vec!["xdg-open".into(), target.to_string_lossy().into_owned()]
    }
}

impl Repo {
    pub fn reveal_in_file_manager(&self, rel_path: &str) -> Result<()> {
        let rel_path = validate_user_path(rel_path)?;
        let full = self.safe_workdir_path(rel_path)?;
        let metadata = std::fs::symlink_metadata(&full)
            .map_err(|_| Error::Other(format!("{rel_path} does not exist")))?;
        crate::external::spawn_detached(&reveal_argv(&full, metadata.is_dir()), self.path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo(tag: &str) -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-file-actions-test-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn creates_and_deletes_files_and_directories_without_overwrite() {
        let (repo, dir) = scratch_repo("round-trip");
        repo.create_worktree_entry("docs", true).unwrap();
        repo.create_worktree_entry("docs/note.txt", false).unwrap();
        std::fs::write(dir.join("docs/note.txt"), "keep").unwrap();

        assert!(repo.create_worktree_entry("docs/note.txt", false).is_err());
        assert_eq!(
            repo.absolute_worktree_paths(&["docs/note.txt".into()]).unwrap(),
            vec![native_path_string(&dir.join("docs/note.txt"))]
        );
        repo.delete_worktree_entries(&["docs".into(), "docs/note.txt".into()])
            .unwrap();
        assert!(!dir.join("docs").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_metadata_and_escape_paths_before_mutating() {
        let (repo, dir) = scratch_repo("guards");
        std::fs::write(dir.join("safe.txt"), "safe").unwrap();

        assert!(repo.create_worktree_entry(".git/owned", false).is_err());
        assert!(repo.create_worktree_entry("../outside", false).is_err());
        assert!(repo
            .delete_worktree_entries(&["safe.txt".into(), ".git/config".into()])
            .is_err());
        assert_eq!(std::fs::read_to_string(dir.join("safe.txt")).unwrap(), "safe");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reveal_command_keeps_the_path_in_one_argument() {
        let path = Path::new("/tmp/a repo/file.txt");
        let argv = reveal_argv(path, false);
        if cfg!(target_os = "windows") {
            assert_eq!(argv.len(), 2);
            assert!(argv[1].contains("a repo"));
            assert!(!argv[1].trim_start_matches("/select,").contains('/'));
        } else if cfg!(target_os = "macos") {
            assert_eq!(argv, ["open", "-R", "/tmp/a repo/file.txt"]);
        } else {
            assert_eq!(argv, ["xdg-open", "/tmp/a repo"]);
        }
    }
}
