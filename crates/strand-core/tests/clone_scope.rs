use std::path::{Path, PathBuf};
use strand_core::{network::{clone_with_options, CancelHandle, CloneFilter, CloneOptions, HistoryExpansion}, Repo};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").current_dir(dir)
        .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
        .args(args).output().unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn fixture() -> (PathBuf, PathBuf, String) {
    let base = std::env::temp_dir().join(format!("strand-clone-scope-{}-{:?}", std::process::id(), std::thread::current().id()));
    std::fs::create_dir_all(&base).unwrap();
    let source = base.join("source");
    std::fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "-b", "main"]);
    git(&source, &["config", "user.name", "Fixture"]);
    git(&source, &["config", "user.email", "fixture@example.com"]);
    git(&source, &["config", "uploadpack.allowFilter", "true"]);
    for n in 0..5 {
        std::fs::write(source.join("file.txt"), format!("version {n}\n")).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", &format!("commit {n}")]);
    }
    git(&source, &["branch", "topic"]);
    let url = format!("file:///{}", source.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    (base, source, url)
}

#[test]
fn shallow_clone_choices_deepen_and_unshallow_preserve_work() {
    let (base, _, url) = fixture();
    let dest = base.join("shallow");
    let mut updates = 0;
    clone_with_options(&url, dest.to_str().unwrap(), &CloneOptions {
        branch: Some("topic".into()), depth: Some(1), single_branch: true, ..Default::default()
    }, |_| updates += 1, None).unwrap();
    assert!(updates > 0);
    let repo = Repo::discover(&dest).unwrap();
    assert_eq!(repo.meta().unwrap().branch, "topic");
    assert_eq!(repo.log(20).unwrap().len(), 1);
    assert!(repo.diff_commit("HEAD").unwrap()[0].patch.contains("version 4"));
    assert!(repo.diff_commit_file("HEAD", "file.txt").unwrap()[0].patch.contains("version 4"));
    assert_eq!(repo.blame("file.txt").unwrap()[0].author, "Fixture");
    assert!(repo.snapshot().unwrap().status.is_empty());
    assert!(repo.clone_scope().unwrap().shallow);
    assert_eq!(repo.clone_scope().unwrap().remotes[0].fetch_refspecs, ["+refs/heads/topic:refs/remotes/origin/topic"]);
    std::fs::write(dest.join("file.txt"), "staged\n").unwrap();
    repo.stage_path("file.txt").unwrap();
    std::fs::write(dest.join("file.txt"), "unstaged\n").unwrap();
    repo.expand_history("origin", HistoryExpansion::Deepen { commits: 2 }, |_| {}, None).unwrap();
    assert_eq!(Repo::discover(&dest).unwrap().log(20).unwrap().len(), 3);
    repo.expand_history("origin", HistoryExpansion::Unshallow, |_| {}, None).unwrap();
    let repo = Repo::discover(&dest).unwrap();
    assert!(!repo.clone_scope().unwrap().shallow);
    assert_eq!(repo.log(20).unwrap().len(), 5);
    assert_eq!(git(&dest, &["show", ":file.txt"]), "staged");
    assert_eq!(std::fs::read_to_string(dest.join("file.txt")).unwrap(), "unstaged\n");
    assert!(repo.expand_history("origin", HistoryExpansion::Unshallow, |_| {}, None).is_err());
}

#[test]
fn external_shallow_and_partial_repositories_open_and_inspect() {
    let (base, _, url) = fixture();
    let dest = base.join("external");
    git(&base, &["clone", "--depth=1", "--filter=blob:none", "--no-single-branch", &url, dest.to_str().unwrap()]);
    let repo = Repo::discover(&dest).unwrap();
    let scope = repo.clone_scope().unwrap();
    assert!(scope.shallow);
    assert_eq!(scope.remotes[0].filter.as_deref(), Some("blob:none"));
    assert_eq!(scope.remotes[0].fetch_refspecs, ["+refs/heads/*:refs/remotes/origin/*"]);
    assert!(repo.snapshot().unwrap().status.is_empty());
    assert!(repo.diff_unstaged().unwrap().is_empty());
    assert_eq!(repo.log(20).unwrap().len(), 1);
}

#[test]
fn partial_clone_fetches_historical_content_on_demand() {
    let (base, source, url) = fixture();
    let dest = base.join("partial");
    clone_with_options(&url, dest.to_str().unwrap(), &CloneOptions {
        filter: Some(CloneFilter::BlobNone), ..Default::default()
    }, |_| {}, None).unwrap();
    let missing = git(&dest, &["rev-list", "--objects", "--all", "--missing=print"]);
    assert!(missing.lines().any(|line| line.starts_with('?')), "fixture must omit real objects");
    let old = git(&source, &["rev-parse", "HEAD~3"]);
    let repo = Repo::discover(&dest).unwrap();
    assert!(repo.file_content("file.txt", Some(&old)).unwrap().text.contains("version 1"));
    assert!(!repo.diff_commit(&old).unwrap().is_empty());
    assert!(repo.diff_since(&old).unwrap()[0].patch.contains("version 4"));
    assert_eq!(repo.blame("file.txt").unwrap()[0].content, "version 4");
}

#[test]
fn invalid_options_and_pre_cancel_do_not_create_a_destination() {
    let (base, _, url) = fixture();
    let dest = base.join("invalid");
    for options in [
        CloneOptions { depth: Some(0), ..Default::default() },
        CloneOptions { branch: Some("--upload-pack=evil".into()), ..Default::default() },
        CloneOptions { branch: Some("bad\nbranch".into()), ..Default::default() },
    ] {
        assert!(clone_with_options(&url, dest.to_str().unwrap(), &options, |_| {}, None).is_err());
        assert!(!dest.exists());
    }
    let cancel = CancelHandle::new();
    cancel.cancel();
    assert!(matches!(clone_with_options(&url, dest.to_str().unwrap(), &CloneOptions::default(), |_| {}, Some(&cancel)), Err(strand_core::Error::Cancelled)));
    assert!(!dest.exists());
}

#[test]
fn cancellation_stops_a_live_http_clone_and_its_transport_child() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/repository", listener.local_addr().unwrap());
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        accepted_tx.send(()).unwrap();
        let _ = release_rx.recv();
        drop(stream);
    });
    let dest = std::env::temp_dir().join(format!("strand-clone-cancel-{}", std::process::id()));
    let cancel = CancelHandle::new();
    let worker_cancel = cancel.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = clone_with_options(&url, dest.to_str().unwrap(), &CloneOptions::default(), |_| {}, Some(&worker_cancel));
        done_tx.send(result).unwrap();
    });
    accepted_rx.recv_timeout(std::time::Duration::from_secs(15)).unwrap();
    cancel.cancel();
    let result = done_rx.recv_timeout(std::time::Duration::from_secs(10));
    release_tx.send(()).unwrap();
    server.join().unwrap();
    worker.join().unwrap();
    assert!(matches!(result.unwrap(), Err(strand_core::Error::Cancelled)));
}
