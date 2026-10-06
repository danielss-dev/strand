use std::path::{Path, PathBuf};
use strand_core::network::{clone_with_options, CloneOptions};
use strand_core::Repo;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "core.autocrlf=false",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            std::fs::copy(entry.path(), to).unwrap();
        }
    }
}

fn lfs_source(base: &Path) -> (PathBuf, &'static [u8]) {
    let source = base.join("source");
    std::fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "-b", "main"]);
    git(&source, &["lfs", "install", "--local"]);
    git(&source, &["lfs", "track", "*.bin"]);
    let contents: &[u8] = b"hello-lfs-content\0bin\n";
    std::fs::write(source.join("asset.bin"), contents).unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "lfs asset"]);
    (source, contents)
}

fn bare_from(source: &Path, dest: &Path, copy_objects: bool) {
    git(
        source.parent().unwrap(),
        &[
            "clone",
            "--bare",
            "--",
            source.to_str().unwrap(),
            dest.to_str().unwrap(),
        ],
    );
    if copy_objects {
        copy_dir(&source.join(".git/lfs/objects"), &dest.join("lfs/objects"));
    }
}

fn is_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/v1")
}

#[test]
fn clone_with_options_checks_out_real_lfs_contents() {
    let base = std::env::temp_dir().join(format!(
        "strand-clone-lfs-ok-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let (source, contents) = lfs_source(&base);
    let remote = base.join("remote.git");
    bare_from(&source, &remote, true);
    let dest = base.join("clone");
    let outcome = clone_with_options(
        remote.to_str().unwrap(),
        dest.to_str().unwrap(),
        &CloneOptions::default(),
        |_| {},
        None,
    )
    .unwrap();
    assert!(outcome.warning.is_none(), "{:?}", outcome.warning);
    let on_disk = std::fs::read(dest.join("asset.bin")).unwrap();
    assert_eq!(on_disk, contents, "working tree must be real LFS bytes, not a pointer");
    assert!(!is_lfs_pointer(&on_disk));
    let pointer = git(&dest, &["show", "HEAD:asset.bin"]);
    assert!(pointer.starts_with("version https://git-lfs.github.com/spec/v1\n"), "{pointer}");
    let repo = Repo::discover(&dest).unwrap();
    assert!(
        repo.status().unwrap().is_empty(),
        "clean LFS checkout must not appear modified"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn clone_with_options_keeps_repo_when_lfs_objects_are_missing() {
    let base = std::env::temp_dir().join(format!(
        "strand-clone-lfs-miss-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let (source, _) = lfs_source(&base);
    let remote = base.join("remote.git");
    bare_from(&source, &remote, false);
    let dest = base.join("clone");
    let result = clone_with_options(
        remote.to_str().unwrap(),
        dest.to_str().unwrap(),
        &CloneOptions::default(),
        |_| {},
        None,
    );
    match result {
        Ok(outcome) => {
            let warning = outcome.warning.expect("missing LFS objects must surface a warning");
            assert!(
                warning.contains("missing object")
                    || warning.contains("Failed to fetch some objects")
                    || warning.contains("error transferring"),
                "warning must include the Git LFS reason, got: {warning}"
            );
            assert!(!warning.trim().eq_ignore_ascii_case("smudge filter lfs failed"), "{warning}");
            assert!(warning.contains("Download and check out objects"), "{warning}");
            assert!(dest.join(".git").exists());
            let repo = Repo::discover(&dest).unwrap();
            assert_eq!(repo.log(5).unwrap().len(), 1);
            let on_disk = std::fs::read(dest.join("asset.bin")).unwrap();
            assert!(is_lfs_pointer(&on_disk), "failed LFS pull must leave pointers");
            assert!(repo.status().unwrap().is_empty());
        }
        Err(error) => {
            let text = error.to_string();
            assert!(
                text.contains("missing object")
                    || text.contains("Failed to fetch some objects")
                    || text.contains("error transferring")
                    || text.contains("batch response"),
                "error must include the Git LFS reason, not only smudge failure: {text}"
            );
            assert!(
                text.contains("smudge filter lfs failed") == false
                    || text.contains("missing object")
                    || text.contains("Failed to fetch")
                    || text.contains("batch response"),
                "{text}"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&base);
}
