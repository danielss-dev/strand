//! One-call repo refresh bundle.
//!
//! The frontend refreshes meta + status + work-tree + refs + submodules after
//! every mutation (and, with the file watcher, after every agent write
//! burst). As separate IPC commands that meant five repo opens and **two**
//! full `statuses()` walks — the two slowest pieces of the refresh path on a
//! 10k-file tree. `snapshot` runs one walk and feeds both consumers.
//!
//! The commit log is deliberately *not* bundled: it's much larger, has its
//! own pagination, and doesn't change on working-tree writes.

use serde::{Deserialize, Serialize};

use crate::{
    error::Result,
    refs::Refs,
    repo::{Repo, RepoMeta},
    status::FileStatus,
    submodule::Submodule,
    tree::WorkTreeEntry,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub meta: RepoMeta,
    pub status: Vec<FileStatus>,
    pub work_tree: Vec<WorkTreeEntry>,
    pub refs: Refs,
    pub submodules: Vec<Submodule>,
}

impl Repo {
    /// Everything the UI needs for a post-change refresh, from a single
    /// `git2` open and a single `statuses()` walk.
    pub fn snapshot(&self) -> Result<Snapshot> {
        let repo = self.git2()?;
        let statuses = repo.statuses(Some(&mut crate::status::status_options()))?;
        let status = crate::status::from_statuses(&statuses);
        let work_tree = crate::tree::from_index_and_statuses(repo, &statuses)?;
        drop(statuses);

        Ok(Snapshot {
            meta: self.meta()?,
            status,
            work_tree,
            refs: self.refs()?,
            submodules: self.submodules()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::Repo;

    #[test]
    fn snapshot_matches_individual_calls() {
        let dir = std::env::temp_dir().join(format!(
            "strand-snapshot-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let g2 = git2::Repository::init(&dir).unwrap();
        {
            let mut cfg = g2.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = g2.index().unwrap().write_tree().unwrap();
        let tree = g2.find_tree(tree_oid).unwrap();
        g2.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();

        let repo = Repo::discover(dir.to_str().unwrap()).unwrap();
        std::fs::write(dir.join("tracked.txt"), "x\n").unwrap();
        repo.stage_paths(&["tracked.txt".into()]).unwrap();
        std::fs::write(dir.join("loose.txt"), "y\n").unwrap();

        let snap = repo.snapshot().unwrap();
        let status = repo.status().unwrap();
        let work_tree = repo.work_tree().unwrap();

        assert_eq!(
            serde_json::to_string(&snap.status).unwrap(),
            serde_json::to_string(&status).unwrap(),
            "snapshot status mirrors Repo::status"
        );
        assert_eq!(
            serde_json::to_string(&snap.work_tree).unwrap(),
            serde_json::to_string(&work_tree).unwrap(),
            "snapshot work_tree mirrors Repo::work_tree"
        );
        assert_eq!(snap.meta.branch, repo.meta().unwrap().branch);

        let _ = std::fs::remove_dir_all(dir);
    }
}
