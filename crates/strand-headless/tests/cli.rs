use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process::{Command, Output},
};

fn git(path: &Path, args: &[&str]) {
    let result = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath="])
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn fixture() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Companion Test"]);
    git(
        temp.path(),
        &["config", "user.email", "companion@example.com"],
    );
    let text: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    fs::write(temp.path().join("space name.txt"), &text).unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-qm", "initial"]);
    fs::write(
        temp.path().join("space name.txt"),
        text.replace("line 20", "staged change"),
    )
    .unwrap();
    git(temp.path(), &["add", "."]);
    fs::write(
        temp.path().join("space name.txt"),
        text.replace("line 20", "unstaged change"),
    )
    .unwrap();
    fs::write(temp.path().join("binary.bin"), [0, 1, 2, 3]).unwrap();
    temp
}
fn run(path: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_strand-cli"))
        .current_dir(path)
        .args(args)
        .output()
        .unwrap()
}
fn json(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}
fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
                    fs::read(p).unwrap(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn reads_reuse_engine_shapes_and_leave_every_repository_byte_unchanged() {
    let repo = fixture();
    let before = files(repo.path());
    let status = json(run(repo.path(), &["status", "--json"]));
    assert_eq!(status["schemaVersion"], 1);
    assert_eq!(status["result"]["data"].as_array().unwrap().len(), 3);
    let staged = json(run(repo.path(), &["--json", "diff", "--staged"]));
    assert!(staged["result"]["data"][0]["patch"]
        .as_str()
        .unwrap()
        .contains("+staged change"));
    let full = json(run(repo.path(), &["diff", "--json", "--full-context"]));
    let patch = full["result"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["path"] == "space name.txt")
        .unwrap()["patch"]
        .as_str()
        .unwrap();
    assert!(
        patch.contains("line 1\n")
            && patch.contains("line 40\n")
            && patch.contains("+unstaged change")
    );
    let snapshot = json(run(
        repo.path(),
        &["-C", ".", "status", "--snapshot", "--json"],
    ));
    assert!(snapshot["result"]["data"]["meta"]["head_oid"].is_string());
    assert!(snapshot["result"]["data"]["log"].is_null());
    let log = json(run(repo.path(), &["log", "--json", "-n", "1"]));
    assert_eq!(log["result"]["data"][0]["subject"], "initial");
    let review = json(run(repo.path(), &["review", "--json", "--since", "HEAD"]));
    assert_eq!(
        review["result"]["data"]["head_before"],
        review["result"]["data"]["head_after"]
    );
    assert_eq!(review["result"]["data"]["status"], status["result"]["data"]);
    json(run(
        repo.path(),
        &["log", "--file", "space name.txt", "--json"],
    ));
    json(run(repo.path(), &["diff", "--commit", "HEAD", "--json"]));
    json(run(
        repo.path(),
        &["diff", "--between", "HEAD", "HEAD", "--json"],
    ));
    assert_eq!(before, files(repo.path()));
}

#[test]
fn machine_errors_are_single_json_on_stderr_and_output_is_deterministic() {
    let repo = fixture();
    let a = run(repo.path(), &["status", "--json"]);
    assert_eq!(a.stdout, run(repo.path(), &["--json", "status"]).stdout);
    for args in [
        vec!["--json", "push"],
        vec!["--json", "log", "-n", "0"],
        vec!["--json", "diff", "--staged", "--since", "HEAD"],
        vec!["--json", "diff", "--staged", "--full-context"],
    ] {
        let out = run(repo.path(), &args);
        assert_eq!(out.status.code(), Some(2));
        assert!(out.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&out.stderr).unwrap()["code"],
            "invalid_request"
        );
    }
    let error = run(
        repo.path(),
        &["--json", "diff", "--since", "missing-revision"],
    );
    assert_eq!(error.status.code(), Some(3));
    let schema = json(run(repo.path(), &["schema"]));
    assert!(schema["output"]["definitions"]["FileDiff"].is_object());
    assert_eq!(schema["schemaVersion"], 1);
}

#[test]
fn unborn_repository_and_linked_worktree_identity() {
    let empty = tempfile::tempdir().unwrap();
    git(empty.path(), &["init", "-q"]);
    assert_eq!(
        json(run(empty.path(), &["status", "--json"]))["result"]["data"],
        serde_json::json!([])
    );
    let repo = fixture();
    let sibling = tempfile::tempdir().unwrap();
    git(
        repo.path(),
        &[
            "worktree",
            "add",
            "--detach",
            sibling.path().to_str().unwrap(),
            "HEAD",
        ],
    );
    let snap = json(run(sibling.path(), &["status", "--snapshot", "--json"]));
    assert_eq!(snap["result"]["data"]["meta"]["is_linked_worktree"], true);
    assert_ne!(
        snap["result"]["data"]["meta"]["path"],
        snap["result"]["data"]["meta"]["common_dir"]
    );
}
