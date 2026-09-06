//! Working-tree watcher — the push half of the AI-review loop.
//!
//! The UI used to learn about on-disk changes only when the window regained
//! focus. With a coding agent editing files in a terminal next door, that
//! means a stale view exactly when freshness matters most. `RepoWatcher`
//! watches the working tree (and the bits of `.git` that change repo state:
//! HEAD, index, refs, in-progress-op markers) and fires a callback after a
//! quiet period, so a burst of agent writes collapses into one refresh.
//!
//! UI-agnostic: the Tauri layer wires the callback to an event the webview
//! listens for. Dropping the `RepoWatcher` stops both the OS watcher and the
//! debounce thread.
//!
//! Known tradeoff: the watch is recursive over the whole workdir and does not
//! consult `.gitignore`, so a build writing into `target/` produces events.
//! The trailing debounce means those storms cost at most one status walk per
//! quiet period (~85ms on a 10k-file tree), which is acceptable; per-path
//! ignore filtering can come later if profiling demands it.

use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::error::{Error, Result};

pub struct RepoWatcher {
    // Held only for its Drop: dropping the watcher closes the event channel,
    // which ends the debounce thread.
    _watcher: RecommendedWatcher,
}

/// Watch the repo at `workdir` and call `on_change` (debounced by `quiet`)
/// whenever the working tree or repo state changes.
pub fn watch(
    workdir: &Path,
    git_dir: &Path,
    quiet: Duration,
    on_change: impl Fn(bool) + Send + 'static,
) -> Result<RepoWatcher> {
    let watched_git_dir = git_dir.to_path_buf();
    let git_dir = git_dir.to_path_buf();
    // A build storm needs one wakeup, not an unbounded allocation per event.
    let (tx, rx) = mpsc::sync_channel::<()>(1);
    let files_changed = Arc::new(AtomicBool::new(false));
    let pending_files = files_changed.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if is_relevant(&event, &git_dir) {
            if changes_file_inventory(&event, &git_dir) {
                pending_files.store(true, Ordering::Relaxed);
            }
            // The receiver disappearing just means we've been dropped.
            let _ = tx.try_send(());
        }
    })
    .map_err(|e| Error::Other(format!("start watcher: {e}")))?;

    watcher
        .watch(workdir, RecursiveMode::Recursive)
        .map_err(|e| Error::Other(format!("watch {}: {e}", workdir.display())))?;
    // Linked worktrees keep their real index/HEAD outside the working tree.
    if !watched_git_dir.starts_with(workdir) {
        watcher.watch(&watched_git_dir, RecursiveMode::Recursive)
            .map_err(|e| Error::Other(format!("watch git dir: {e}")))?;
    }

    // Trailing debounce: first event arms the timer, then we keep absorbing
    // events until `quiet` elapses with none, and fire once.
    std::thread::spawn(move || loop {
        match rx.recv() {
            Err(_) => return,
            Ok(()) => {
                let started = Instant::now();
                loop {
                    let remaining = Duration::from_secs(2).saturating_sub(started.elapsed());
                    if remaining.is_zero() { break; }
                    match rx.recv_timeout(quiet.min(remaining)) {
                        Ok(()) => continue,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                on_change(files_changed.swap(false, Ordering::Relaxed));
            }
        }
    });

    Ok(RepoWatcher { _watcher: watcher })
}

fn changes_file_inventory(event: &notify::Event, git_dir: &Path) -> bool {
    let structural = matches!(event.kind, notify::EventKind::Create(_) | notify::EventKind::Remove(_)
        | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
        | notify::EventKind::Any);
    event.paths.iter().any(|path| {
        if let Ok(relative) = path.strip_prefix(git_dir) {
            // Ref/index replacements do not change the Files inventory.
            relative == Path::new("info/exclude") || relative == Path::new("config")
        } else {
            structural || path.file_name().is_some_and(|name| name == ".gitignore")
        }
    })
}

/// Decide whether an FS event should trigger a refresh.
///
/// Everything outside `.git` counts. Inside `.git`, only the files that
/// change what the UI shows count: HEAD (branch switch / commit), the index
/// (staging from another client), refs (branches/tags moving), and the
/// in-progress-op markers (merge/rebase/cherry-pick state). Object/pack
/// writes, reflogs, and `*.lock` churn from git's own atomic writes are
/// ignored — they'd double-fire every operation.
fn is_relevant(event: &notify::Event, git_dir: &Path) -> bool {
    use notify::EventKind;
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|p| relevant_path(p, git_dir))
}

fn relevant_path(path: &Path, git_dir: &Path) -> bool {
    let Ok(inside_git) = path.strip_prefix(git_dir) else {
        // Outside .git → a working-tree write.
        return true;
    };
    let mut comps = inside_git.components();
    let Some(first) = comps.next().and_then(|c| c.as_os_str().to_str()) else {
        // The .git dir itself.
        return false;
    };
    if first.ends_with(".lock") {
        return false;
    }
    matches!(
        first,
        "HEAD"
            | "index"
            | "packed-refs"
            | "refs"
            | "MERGE_HEAD"
            | "CHERRY_PICK_HEAD"
            | "REVERT_HEAD"
            | "rebase-merge"
            | "rebase-apply"
            | "info"
            | "config"
            | "BISECT_START"
            | "BISECT_LOG"
            | "BISECT_TERMS"
            | "BISECT_HEAD"
            | "BISECT_EXPECTED_REV"
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn git_dir() -> PathBuf {
        PathBuf::from("/repo/.git")
    }

    #[test]
    fn worktree_paths_are_relevant() {
        assert!(relevant_path(&PathBuf::from("/repo/src/main.rs"), &git_dir()));
        assert!(relevant_path(&PathBuf::from("/repo/new.txt"), &git_dir()));
    }

    #[test]
    fn git_state_files_are_relevant() {
        for p in [
            "/repo/.git/HEAD",
            "/repo/.git/index",
            "/repo/.git/packed-refs",
            "/repo/.git/refs/heads/main",
            "/repo/.git/MERGE_HEAD",
            "/repo/.git/rebase-merge/done",
            "/repo/.git/rebase-apply/applying",
            "/repo/.git/rebase-apply/next",
            "/repo/.git/BISECT_START",
            "/repo/.git/BISECT_LOG",
        ] {
            assert!(relevant_path(&PathBuf::from(p), &git_dir()), "{p} should refresh");
        }
    }

    #[test]
    fn git_noise_is_ignored() {
        for p in [
            "/repo/.git",
            "/repo/.git/objects/ab/cdef",
            "/repo/.git/logs/HEAD",
            "/repo/.git/index.lock",
            "/repo/.git/HEAD.lock",
            "/repo/.git/FETCH_HEAD",
            "/repo/.git/COMMIT_EDITMSG",
        ] {
            assert!(!relevant_path(&PathBuf::from(p), &git_dir()), "{p} should not refresh");
        }
    }

    #[test]
    fn files_inventory_only_invalidates_for_paths_and_ignore_rules() {
        use notify::event::{CreateKind, DataChange, ModifyKind};
        let data = notify::EventKind::Modify(ModifyKind::Data(DataChange::Content));
        let create = notify::EventKind::Create(CreateKind::File);
        for (kind, path, expected) in [
            (data, "/repo/src/main.rs", false),
            (create, "/repo/src/new.rs", true),
            (data, "/repo/src/.gitignore", true),
            (data, "/repo/.git/info/exclude", true),
            (data, "/repo/.git/config", true),
            (create, "/repo/.git/index", false),
            (create, "/repo/.git/refs/heads/main", false),
        ] {
            let event = notify::Event::new(kind).add_path(PathBuf::from(path));
            assert_eq!(changes_file_inventory(&event, &git_dir()), expected, "{path}");
        }
    }

    #[test]
    fn debounce_collapses_a_burst_into_one_callback() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!(
            "strand-watch-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git")).unwrap();

        let fired = Arc::new(AtomicUsize::new(0));
        let fired2 = fired.clone();
        let _w = watch(&dir, &dir.join(".git"), Duration::from_millis(150), move |_| {
            fired2.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        // Wait out the quiet period plus scheduling slack.
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(fired.load(Ordering::SeqCst), 1, "burst collapses to one refresh");

        let _ = std::fs::remove_dir_all(dir);
    }
}
