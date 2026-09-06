use std::path::Path;
use strand_core::network::{clone_with_options, CloneOptions};

fn git(path: &Path, args: &[&str]) {
    let result = std::process::Command::new("git").current_dir(path)
        .args(["-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"])
        .args(args).output().unwrap();
    assert!(result.status.success(), "{args:?}: {}", String::from_utf8_lossy(&result.stderr));
}

#[test]
fn recursive_clone_initializes_nested_modules() {
    // This integration-test process owns its environment; other test binaries
    // cannot inherit this test-only local transport allowance.
    std::env::set_var("GIT_CONFIG_COUNT", "1");
    std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
    std::env::set_var("GIT_CONFIG_VALUE_0", "always");
    let base = std::env::temp_dir().join(format!("strand-recursive-clone-{}", std::process::id()));
    for name in ["leaf", "module", "source"] {
        let path = base.join(name);
        std::fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-b", "main"]);
        std::fs::write(path.join("file.txt"), "fixture\n").unwrap();
        git(&path, &["add", "."]);
        git(&path, &["commit", "-m", "fixture"]);
    }
    git(&base.join("module"), &["submodule", "add", "../leaf", "nested"]);
    git(&base.join("module"), &["commit", "-am", "add nested"]);
    git(&base.join("source"), &["submodule", "add", "../module", "module"]);
    git(&base.join("source"), &["commit", "-am", "add module"]);
    let dest = base.join("clone");
    clone_with_options(base.join("source").to_str().unwrap(), dest.to_str().unwrap(), &CloneOptions {
        recurse_submodules: true, ..Default::default()
    }, |_| {}, None).unwrap();
    assert!(dest.join("module/file.txt").exists());
    assert!(dest.join("module/nested/file.txt").exists());
    assert!(strand_core::Repo::discover(dest).unwrap().snapshot().unwrap().status.is_empty());
}
