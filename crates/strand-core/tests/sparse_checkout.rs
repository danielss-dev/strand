use std::path::{Path, PathBuf};
use strand_core::Repo;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").current_dir(dir)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
        .args(args).output().unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn fixture() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!("strand-sparse-{}-{:?}-{}", std::process::id(), std::thread::current().id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-b", "main"]);
    git(&dir, &["config", "user.name", "Fixture"]);
    git(&dir, &["config", "user.email", "fixture@example.com"]);
    for name in ["keep/a.txt", "omit/b.txt", "space name/nested/c.txt", "root.txt"] {
        std::fs::create_dir_all(dir.join(name).parent().unwrap()).unwrap();
        std::fs::write(dir.join(name), "original\n").unwrap();
    }
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "fixture"]);
    dir
}

#[test]
fn external_sparse_indexes_open_without_becoming_deletions_or_rewriting_index() {
    for sparse in [false, true] {
        let dir = fixture().join(if sparse { "compressed" } else { "expanded" });
        let source = dir.parent().unwrap();
        git(source, &["clone", "--no-local", source.to_str().unwrap(), dir.to_str().unwrap()]);
        git(&dir, &["sparse-checkout", "set", "--cone", if sparse { "--sparse-index" } else { "--no-sparse-index" }, "keep"]);
        let before = std::fs::read(dir.join(".git/index")).unwrap();
        let repo = Repo::discover(&dir).unwrap();
        assert!(repo.sparse_checkout().unwrap().enabled);
        assert_eq!(repo.sparse_checkout().unwrap().directories, ["keep"]);
        let snapshot = repo.snapshot().unwrap();
        assert!(snapshot.status.is_empty(), "{:?}", snapshot.status);
        assert!(snapshot.work_tree.iter().find(|entry| entry.path == "omit/b.txt").unwrap().excluded);
        assert!(repo.diff_unstaged().unwrap().is_empty());
        assert!(repo.diff_staged().unwrap().is_empty());
        assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), before);
        std::fs::remove_file(dir.join("keep/a.txt")).unwrap();
        let status = Repo::discover(&dir).unwrap().status().unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].path, "keep/a.txt");
    }
}

#[test]
fn sparse_stage_hunks_commit_checkout_and_discard_preserve_excluded_files() {
    let dir = fixture();
    git(&dir, &["branch", "other"]);
    git(&dir, &["sparse-checkout", "set", "--cone", "--sparse-index", "keep"]);
    std::fs::write(dir.join("keep/a.txt"), "edited\n").unwrap();
    let repo = Repo::discover(&dir).unwrap();
    let patch = repo.diff_unstaged().unwrap().remove(0).patch;
    repo.apply_patch(&patch, strand_core::apply::ApplyTarget::Index).unwrap();
    assert!(Repo::discover(&dir).unwrap().diff_staged().unwrap()[0].patch.contains("edited"));
    Repo::discover(&dir).unwrap().unstage_path("keep/a.txt").unwrap();
    Repo::discover(&dir).unwrap().stage_paths(&["keep/a.txt".into()]).unwrap();
    git(&dir, &["config", "commit.gpgsign", "false"]);
    Repo::discover(&dir).unwrap().commit("sparse edit", None, false).unwrap();
    assert_eq!(git(&dir, &["show", "HEAD:omit/b.txt"]), "original");
    assert!(!dir.join("omit/b.txt").exists());
    assert!(git(&dir, &["ls-files", "--sparse"]).lines().any(|line| line == "omit/"));
    Repo::discover(&dir).unwrap().checkout_branch("other").unwrap();
    assert!(!dir.join("omit/b.txt").exists());
    assert_eq!(std::fs::read_to_string(dir.join("keep/a.txt")).unwrap().trim(), "original");
    std::fs::write(dir.join("keep/a.txt"), "discard this\n").unwrap();
    std::fs::write(dir.join("loose.txt"), "new\n").unwrap();
    let repo = Repo::discover(&dir).unwrap();
    assert!(repo.diff_unstaged().unwrap().iter().any(|diff| diff.path == "loose.txt"));
    repo.discard_paths(&["keep/a.txt".into(), "loose.txt".into()]).unwrap();
    assert!(Repo::discover(&dir).unwrap().status().unwrap().is_empty());
}

#[test]
fn ignored_untracked_staged_and_invalid_selection_refuse_without_mutation() {
    let dir = fixture();
    std::fs::write(dir.join(".gitignore"), "omit/cache/\n").unwrap();
    git(&dir, &["add", ".gitignore"]);
    git(&dir, &["commit", "-m", "ignore cache"]);
    std::fs::create_dir_all(dir.join("omit/cache")).unwrap();
    std::fs::write(dir.join("omit/cache/precious.txt"), "preserve\n").unwrap();
    let repo = Repo::discover(&dir).unwrap();
    let before = std::fs::read(dir.join(".git/index")).unwrap();
    assert!(repo.set_sparse_checkout(&["keep".into()], true).unwrap_err().to_string().contains("Ignored"));
    for name in ["../outside", "--cone", "keep\nother", ".git", "unknown"] {
        assert!(repo.set_sparse_checkout(&[name.into()], true).is_err());
    }
    assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), before);
    assert!(dir.join("omit/cache/precious.txt").exists());
    // Keeping the ignored directory's parent is safe.
    repo.set_sparse_checkout(&["omit".into()], true).unwrap();
    std::fs::write(dir.join("root.txt"), "staged\n").unwrap();
    git(&dir, &["add", "root.txt"]);
    std::fs::write(dir.join("root.txt"), "unstaged\n").unwrap();
    std::fs::write(dir.join("untracked.txt"), "loose\n").unwrap();
    let before = std::fs::read(dir.join(".git/index")).unwrap();
    assert!(Repo::discover(&dir).unwrap().disable_sparse_checkout().is_err());
    assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), before);
    assert_eq!(git(&dir, &["show", ":root.txt"]), "staged");
    assert_eq!(std::fs::read_to_string(dir.join("root.txt")).unwrap(), "unstaged\n");
    assert!(dir.join("untracked.txt").exists());
}

#[test]
fn external_non_cone_inspection_and_linked_worktree_isolation() {
    let dir = fixture();
    git(&dir, &["sparse-checkout", "set", "--no-cone", "/keep/"]);
    let repo = Repo::discover(&dir).unwrap();
    assert!(!repo.sparse_checkout().unwrap().cone);
    assert!(repo.set_sparse_checkout(&["omit".into()], false).is_err());
    repo.disable_sparse_checkout().unwrap();
    let linked = dir.with_extension("linked");
    git(&dir, &["worktree", "add", "-b", "linked", linked.to_str().unwrap()]);
    Repo::discover(&linked).unwrap().set_sparse_checkout(&["keep".into()], true).unwrap();
    assert!(!linked.join("omit/b.txt").exists());
    assert!(dir.join("omit/b.txt").exists());
    assert!(!Repo::discover(&dir).unwrap().sparse_checkout().unwrap().enabled);
    assert!(Repo::discover(&linked).unwrap().snapshot().unwrap().status.is_empty());
}

#[test]
fn sparse_file_diff_limits_work_to_a_literal_tracked_or_untracked_path() {
    let dir = fixture();
    std::fs::write(dir.join("keep/[one].txt"), "original\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "literal path"]);
    Repo::discover(&dir).unwrap().set_sparse_checkout(&["keep".into()], true).unwrap();
    for path in ["root.txt", "keep/[one].txt", "keep/[new].txt"] {
        std::fs::write(dir.join(path), "edited\n").unwrap();
    }
    for path in ["keep/[one].txt", "keep/[new].txt"] {
        let diffs = Repo::discover(&dir).unwrap().diff_workdir_file(path).unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].path, path);
        assert!(diffs[0].patch.contains("edited"));
    }
}

#[test]
fn restored_clean_file_is_removed_when_its_directory_is_excluded() {
    let dir = fixture();
    Repo::discover(&dir).unwrap().set_sparse_checkout(&["keep".into()], true).unwrap();
    let path = dir.join("keep/a.txt");
    let original = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(Repo::discover(&dir).unwrap().set_sparse_checkout(&["omit".into()], true).is_err());
    std::fs::write(&path, original).unwrap();
    std::fs::File::options().write(true).open(&path).unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(3)).unwrap();
    Repo::discover(&dir).unwrap().set_sparse_checkout(&["omit".into()], true).unwrap();
    assert!(!path.exists(), "Clean files with stale index stat data must be excluded");
    assert!(dir.join("omit/b.txt").exists());
}

#[test]
fn cone_selection_round_trip_and_dirty_refusal() {
    let dir = fixture();
    let repo = Repo::discover(&dir).unwrap();
    repo.set_sparse_checkout(&["space name/nested".into()], true).unwrap();
    assert!(dir.join("root.txt").exists());
    assert!(dir.join("space name/nested/c.txt").exists());
    assert!(!dir.join("omit/b.txt").exists());
    let repo = Repo::discover(&dir).unwrap();
    assert_eq!(repo.sparse_checkout().unwrap().directories, ["space name/nested"]);
    std::fs::write(dir.join("root.txt"), "dirty\n").unwrap();
    let before = std::fs::read(dir.join(".git/index")).unwrap();
    assert!(repo.set_sparse_checkout(&["keep".into()], true).is_err());
    assert!(repo.disable_sparse_checkout().is_err());
    assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), before);
    assert_eq!(std::fs::read_to_string(dir.join("root.txt")).unwrap(), "dirty\n");
    git(&dir, &["restore", "root.txt"]);
    Repo::discover(&dir).unwrap().disable_sparse_checkout().unwrap();
    assert!(dir.join("omit/b.txt").exists());
    assert!(Repo::discover(&dir).unwrap().status().unwrap().is_empty());
}
