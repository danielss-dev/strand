//! Explicit repository housekeeping and integrity checks.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::network::{run_git_streaming_transcript, CancelHandle};
use crate::{Result, Repo, GIT_SAFE_CONFIG};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceTask {
    Maintenance,
    GarbageCollect,
    IntegrityCheck,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceOutcome {
    /// Exact argv executed, including Strand's safety overrides.
    pub command: String,
    /// Combined stdout and stderr from Git.
    pub output: String,
    pub success: bool,
    pub duration_ms: u64,
}

impl MaintenanceTask {
    fn args(self) -> &'static [&'static str] {
        match self {
            Self::Maintenance => &["maintenance", "run"],
            Self::GarbageCollect => &["gc"],
            Self::IntegrityCheck => &["fsck", "--full"],
        }
    }
}

impl Repo {
    pub fn run_maintenance(
        &self,
        task: MaintenanceTask,
        cancel: Option<&CancelHandle>,
    ) -> Result<MaintenanceOutcome> {
        let args = task.args();
        let command = std::iter::once("git")
            .chain(GIT_SAFE_CONFIG.iter().copied())
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let started = Instant::now();
        let transcript = run_git_streaming_transcript(&self.path, args, |_| {}, cancel)?;
        Ok(MaintenanceOutcome {
            command,
            output: transcript.output,
            success: transcript.success,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo() -> (Repo, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-maintenance-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = {
            let mut index = repo.index().unwrap();
            index.write_tree().unwrap()
        };
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "init", &tree, &[])
            .unwrap();
        (Repo::discover(dir.to_str().unwrap()).unwrap(), dir)
    }

    #[test]
    fn maintenance_gc_and_integrity_return_exact_transcripts() {
        let (repo, dir) = scratch_repo();
        for (task, suffix) in [
            (MaintenanceTask::Maintenance, "maintenance run"),
            (MaintenanceTask::GarbageCollect, "gc"),
            (MaintenanceTask::IntegrityCheck, "fsck --full"),
        ] {
            let outcome = repo.run_maintenance(task, None).unwrap();
            assert!(outcome.success, "{}: {}", outcome.command, outcome.output);
            assert!(outcome.command.ends_with(suffix), "{}", outcome.command);
            assert!(outcome.command.contains("core.fsmonitor="));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
