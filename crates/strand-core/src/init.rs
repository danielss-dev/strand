//! Initialize a local repository without shelling out to Git.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitOutcome {
    pub path: String,
    pub initial_branch: String,
    pub initial_commit: Option<String>,
}

/// Initialize `path` as a non-bare repository.
///
/// `gitignore` is written only when non-empty and never overwrites an existing
/// file. When `create_initial_commit` is set, the first commit contains the
/// newly-created `.gitignore` (if any) and is otherwise an empty commit.
pub fn init_repository(
    path: impl AsRef<Path>,
    initial_branch: &str,
    gitignore: Option<&str>,
    create_initial_commit: bool,
) -> Result<InitOutcome> {
    let path = path.as_ref();
    let branch = initial_branch.trim();
    if branch.is_empty()
        || branch.starts_with('-')
        || !git2::Reference::is_valid_name(&format!("refs/heads/{branch}"))
    {
        return Err(Error::Other(format!(
            "invalid initial branch name: {initial_branch}"
        )));
    }
    if path.exists() && !path.is_dir() {
        return Err(Error::Other(format!(
            "repository path is not a directory: {}",
            path.display()
        )));
    }

    let ignore = gitignore.map(str::trim).filter(|value| !value.is_empty());
    let ignore_path = path.join(".gitignore");
    if ignore.is_some() && ignore_path.exists() {
        return Err(Error::Other(
            ".gitignore already exists; Strand will not overwrite it".into(),
        ));
    }

    // Resolve identity before touching the destination so a requested initial
    // commit cannot leave a half-created repository on a fresh machine.
    let signature = if create_initial_commit {
        let identity = crate::gitconfig::global_identity()?;
        let name = identity.name.ok_or_else(|| {
            Error::Other("set Git user.name before creating an initial commit".into())
        })?;
        let email = identity.email.ok_or_else(|| {
            Error::Other("set Git user.email before creating an initial commit".into())
        })?;
        Some(git2::Signature::now(&name, &email)?)
    } else {
        None
    };

    std::fs::create_dir_all(path)?;
    let mut opts = git2::RepositoryInitOptions::new();
    opts.no_reinit(true).mkdir(false).initial_head(branch);
    let repo = git2::Repository::init_opts(path, &opts)?;

    if let Some(contents) = ignore {
        let mut normalized = contents.to_string();
        if !normalized.ends_with('\n') {
            normalized.push('\n');
        }
        std::fs::write(&ignore_path, normalized)?;
    }

    let initial_commit = if let Some(signature) = signature {
        let mut index = repo.index()?;
        if ignore.is_some() {
            index.add_path(Path::new(".gitignore"))?;
        }
        index.write()?;
        let tree_id = index.write_tree()?;
        let tree = repo.find_tree(tree_id)?;
        Some(
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                "Initial commit",
                &tree,
                &[],
            )?
            .to_string(),
        )
    } else {
        None
    };

    let canonical = path.canonicalize().unwrap_or_else(|_| PathBuf::from(path));
    Ok(InitOutcome {
        path: canonical.to_string_lossy().into_owned(),
        initial_branch: branch.to_string(),
        initial_commit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "strand-init-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id(),
        ))
    }

    #[test]
    fn initializes_unborn_repository_on_requested_branch() {
        let dir = scratch("unborn");
        let _ = std::fs::remove_dir_all(&dir);
        let outcome = init_repository(&dir, "trunk", None, false).unwrap();
        let repo = git2::Repository::open(&dir).unwrap();
        match repo.head() {
            Err(error) => assert_eq!(error.code(), git2::ErrorCode::UnbornBranch),
            Ok(_) => panic!("new repository unexpectedly has a resolved HEAD"),
        }
        assert_eq!(outcome.initial_branch, "trunk");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_invalid_branch_without_creating_directory() {
        let dir = scratch("invalid");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(init_repository(&dir, "bad branch", None, false).is_err());
        assert!(init_repository(&dir, "-bad", None, false).is_err());
        assert!(!dir.exists());
    }

    #[test]
    fn writes_gitignore_without_overwriting_existing_file() {
        let dir = scratch("ignore");
        let _ = std::fs::remove_dir_all(&dir);
        init_repository(&dir, "main", Some("target/\nnode_modules/"), false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "target/\nnode_modules/\n"
        );

        let second = init_repository(&dir, "main", Some("dist/"), false).unwrap_err();
        assert!(second.to_string().contains("will not overwrite"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
