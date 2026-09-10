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
fn large_review_can_be_enumerated_and_narrowed_without_raising_output_cap() {
    let repo = fixture();
    let mut large = (0..120_000).map(|i| format!("line {i:06} {}\n", "context ".repeat(10))).collect::<String>();
    fs::write(repo.path().join("large.txt"), &large).unwrap();
    git(repo.path(), &["add", "large.txt"]);
    git(repo.path(), &["commit", "-qm", "large baseline"]);
    large = large.replacen("line 060000", "EDIT 060000", 1);
    fs::write(repo.path().join("large.txt"), &large).unwrap();

    let full = run(repo.path(), &["review", "--json"]);
    assert!(!full.status.success());
    assert!(full.stdout.is_empty(), "over-limit output must not leak a partial JSON document");
    let error: Value = serde_json::from_slice(&full.stderr).unwrap();
    assert!(error.to_string().contains("output_limit"));

    let summary = json(run(repo.path(), &["review", "--summary", "--json"]));
    let rows = summary["result"]["data"].as_array().unwrap();
    assert!(rows.iter().any(|file| file["path"] == "large.txt"));
    assert!(rows.iter().all(|file| file.get("patch").is_none()));
    let selected = json(run(repo.path(), &["review", "--path", "space name.txt", "--json"]));
    assert_eq!(selected["result"]["data"]["diffs"].as_array().unwrap().len(), 1);
    assert_eq!(selected["result"]["data"]["diffs"][0]["path"], "space name.txt");
    let compact = json(run(repo.path(), &["review", "--path", "large.txt", "--compact", "--json"]));
    let patch = compact["result"]["data"]["diffs"][0]["patch"].as_str().unwrap();
    assert!(patch.contains("+EDIT 060000"));
    assert!(patch.len() < 2000);
    let diff = json(run(repo.path(), &["diff", "--path", "large.txt", "--json"]));
    assert_eq!(diff["result"]["kind"], "diff_page");
    assert!(diff["result"]["data"][0]["patch"].as_str().unwrap().contains("+EDIT 060000"));
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
    fs::write(empty.path().join("new.txt"), "new before first commit\n").unwrap();
    git(empty.path(), &["add", "new.txt"]);
    let before = files(empty.path());
    for args in [vec!["review", "--json"], vec!["review", "--path", "new.txt", "--json"]] {
        let review = json(run(empty.path(), &args));
        assert_eq!(review["result"]["data"]["base"], strand_core::diff::EMPTY_TREE_OID);
        assert!(review["result"]["data"]["head_before"].is_null());
        assert!(review["result"]["data"]["head_after"].is_null());
        assert!(review["result"]["data"]["log"].as_array().unwrap().is_empty());
        assert_eq!(review["result"]["data"]["diffs"][0]["path"], "new.txt");
    }
    assert_eq!(before, files(empty.path()), "unborn review must not create a synthetic tree or commit");
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

#[test]
fn large_added_file_chunks_have_bounded_exact_bytes_and_stale_guards() {
    let repo = fixture();
    let line = "agent added content ".repeat(7) + "\n";
    fs::write(repo.path().join("huge.txt"), line.repeat(65_000)).unwrap();
    let capped = run(repo.path(), &["diff", "--path", "huge.txt", "--json"]);
    assert!(!capped.status.success());
    assert!(capped.stdout.is_empty());
    assert!(String::from_utf8_lossy(&capped.stderr).contains("4 MiB page limit"));
    let first = json(run(repo.path(), &["diff-chunk", "--path", "huge.txt", "--json"]));
    let data = &first["result"]["data"];
    assert_eq!(first["result"]["kind"], "diff_chunk");
    assert!(data["total"].as_u64().unwrap() > 8 * 1024 * 1024);
    assert_eq!(data["bytes"].as_array().unwrap().len(), 65536);
    let token = data["revision"].as_str().unwrap();
    let tail_offset = (data["total"].as_u64().unwrap() - 20).to_string();
    let tail = json(run(repo.path(), &["diff-chunk", "--path", "huge.txt", "--offset", &tail_offset, "--length", "64", "--revision", token, "--json"]));
    assert_eq!(tail["result"]["data"]["bytes"].as_array().unwrap().len(), 20);
    assert_eq!(tail["result"]["data"]["next_offset"], data["total"]);
    assert_eq!(tail["result"]["data"]["revision"], data["revision"]);
    fs::write(repo.path().join("huge.txt"), "changed during review\n").unwrap();
    let stale = run(repo.path(), &["diff-chunk", "--path", "huge.txt", "--offset", "10", "--revision", token, "--json"]);
    assert!(!stale.status.success());
    assert!(stale.stdout.is_empty());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("Patch changed"));
    for args in [
        vec!["diff-chunk", "--path", "huge.txt", "--length", "65537", "--json"],
        vec!["diff-chunk", "--path", "../outside", "--json"],
    ] {
        let error = run(repo.path(), &args);
        assert_eq!(error.status.code(), Some(2));
        assert!(error.stdout.is_empty());
    }
}
