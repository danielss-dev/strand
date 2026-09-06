//! Git LFS operations are explicit, lazy, and delegated to the installed Git LFS.

use crate::{
    network::{run_git_streaming, CancelHandle, NetworkOutcome, Progress},
    Error, Repo, Result,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum LfsAction {
    Environment,
    Install,
    Patterns,
    Track { pattern: String },
    Untrack { pattern: String },
    Status,
    Objects,
    Fetch { remote: String },
    Pull { remote: String },
    Push { remote: String },
    Locks { path: String },
    Lock { path: String },
    Unlock { id: String },
}

fn argument(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() || value.starts_with('-') || value.contains(['\0', '\n', '\r']) {
        return Err(Error::Other(format!(
            "Enter a non-empty {label} that does not start with '-' or contain line breaks."
        )));
    }
    Ok(())
}

impl Repo {
    /// No LFS subprocesses run in snapshots or ordinary status refreshes.
    pub fn lfs_action(
        &self,
        action: LfsAction,
        progress: impl FnMut(Progress),
        cancel: Option<&CancelHandle>,
    ) -> Result<NetworkOutcome> {
        let mut args = vec!["lfs".to_string()];
        match action {
            LfsAction::Environment => args.push("env".into()),
            LfsAction::Install => args.extend(["install".into(), "--local".into()]),
            LfsAction::Patterns => args.push("track".into()),
            LfsAction::Track { pattern } => {
                argument(&pattern, "tracking pattern")?;
                args.extend(["track".into(), "--".into(), pattern]);
            }
            LfsAction::Untrack { pattern } => {
                argument(&pattern, "tracking pattern")?;
                args.extend(["untrack".into(), "--".into(), pattern]);
            }
            LfsAction::Status => args.push("status".into()),
            LfsAction::Objects => args.extend(["ls-files".into(), "--size".into()]),
            LfsAction::Fetch { remote } => {
                argument(&remote, "remote")?;
                args.extend(["fetch".into(), remote]);
            }
            LfsAction::Pull { remote } => {
                argument(&remote, "remote")?;
                args.extend(["pull".into(), remote]);
            }
            LfsAction::Push { remote } => {
                argument(&remote, "remote")?;
                args.extend(["push".into(), remote]);
            }
            LfsAction::Locks { path } => {
                args.extend(["locks".into(), "--limit=100".into()]);
                if !path.is_empty() {
                    argument(&path, "lock path")?;
                    args.push(format!("--path={path}"));
                }
            }
            LfsAction::Lock { path } => {
                argument(&path, "file path")?;
                args.extend(["lock".into(), "--".into(), path]);
            }
            LfsAction::Unlock { id } => {
                argument(&id, "lock ID")?;
                args.extend(["unlock".into(), format!("--id={id}")]);
            }
        }
        run_git_streaming(&self.path, &args.iter().map(String::as_str).collect::<Vec<_>>(), progress, cancel)
            .map_err(|error| match error {
                Error::Cancelled => Error::Cancelled,
                other => Error::Other(format!("{other}\nCheck Git LFS installation, repository setup and remote access, then retry. Completed objects are retained; history is never migrated.")),
            })
    }

    pub(crate) fn is_lfs_path(&self, path: &Path) -> Result<bool> {
        Ok(self
            .git2()?
            .get_attr(path, "filter", git2::AttrCheckFlags::FILE_THEN_INDEX)?
            == Some("lfs"))
    }

    fn require_lfs_filter(&self) -> Result<()> {
        let config = self.git2()?.config()?;
        if !config
            .get_string("filter.lfs.process")
            .is_ok_and(|v| !v.trim().is_empty())
            && !config
                .get_string("filter.lfs.clean")
                .is_ok_and(|v| !v.trim().is_empty())
        {
            return Err(Error::Other("LFS filters are not configured. Open Git LFS → Set up this repository, then retry.".into()));
        }
        Ok(())
    }

    pub(crate) fn stage_lfs_paths(&self, paths: &[String]) -> Result<()> {
        self.run_lfs_paths(
            &[
                "--literal-pathspecs",
                "add",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            paths.iter().map(String::as_str),
        )
    }

    pub(crate) fn discard_lfs_paths(&self, paths: &[&str]) -> Result<()> {
        self.run_lfs_paths(
            &["checkout-index", "--force", "-z", "--stdin"],
            paths.iter().copied(),
        )
    }

    fn run_lfs_paths<'a>(&self, args: &[&str], paths: impl Iterator<Item = &'a str>) -> Result<()> {
        self.require_lfs_filter()?;
        let mut input = Vec::new();
        for path in paths {
            if path.contains('\0') {
                return Err(Error::Other("Invalid file path".into()));
            }
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        let mut filtered = vec!["-c", "filter.lfs.required=true"];
        filtered.extend_from_slice(args);
        let transcript = crate::network::run_git_input_transcript(
            &self.path,
            &filtered,
            Some(input),
            |_| {},
            None,
        )?;
        if !transcript.success {
            return Err(Error::Other(transcript.output));
        }
        self.git2()?.index()?.read(true)?;
        Ok(())
    }

    pub(crate) fn lfs_checkout_needed(&self, tree: &git2::Tree<'_>) -> Result<bool> {
        let repo = self.git2()?;
        for entry in repo.index()?.iter() {
            if let Ok(path) = std::str::from_utf8(&entry.path) {
                if self.is_lfs_path(Path::new(path))? {
                    return Ok(true);
                }
            }
        }
        let mut found = false;
        let mut attribute_error = None;
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                if let Some(name) = entry.name() {
                    match self.is_lfs_path(Path::new(&format!("{root}{name}"))) {
                        Ok(lfs) => found |= lfs,
                        Err(error) => attribute_error = Some(error),
                    }
                }
            }
            if entry.name() == Some(".gitattributes") {
                if let Ok(blob) = repo.find_blob(entry.id()) {
                    found |= String::from_utf8_lossy(blob.content()).contains("filter=lfs");
                }
            }
            if found {
                git2::TreeWalkResult::Skip
            } else {
                git2::TreeWalkResult::Ok
            }
        })?;
        if let Some(error) = attribute_error {
            return Err(error);
        }
        Ok(found)
    }

    pub(crate) fn run_lfs_filtered(&self, args: &[&str]) -> Result<()> {
        self.require_lfs_filter()?;
        let mut filtered = vec!["-c", "filter.lfs.required=true"];
        filtered.extend_from_slice(args);
        run_git_streaming(&self.path, &filtered, |_| {}, None)?;
        // In-process fixtures and chained operations may reuse this handle.
        self.git2()?.index()?.read(true)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::LfsAction;
    use crate::Repo;
    use std::{
        path::{Path, PathBuf},
        process::Command,
    };

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn fixture() -> (Repo, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "strand-lfs-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        git(&dir, &["lfs", "install", "--local"]);
        git(&dir, &["lfs", "track", "*.bin"]);
        (Repo::discover(&dir).unwrap(), dir)
    }

    #[test]
    fn single_and_bulk_stage_store_real_lfs_pointers() {
        let (repo, dir) = fixture();
        std::fs::write(dir.join("one.bin"), b"large content\0one\n").unwrap();
        repo.stage_path("one.bin").unwrap();
        let expected = git(&dir, &["hash-object", "--path=one.bin", "one.bin"]);
        assert_eq!(git(&dir, &["rev-parse", ":one.bin"]), expected);
        let pointer = git(&dir, &["show", ":one.bin"]);
        assert!(
            pointer.starts_with("version https://git-lfs.github.com/spec/v1\noid sha256:"),
            "{pointer}"
        );
        std::fs::write(dir.join("two.bin"), b"large content\0two\n").unwrap();
        repo.stage_paths(&[".gitattributes".into(), "one.bin".into(), "two.bin".into()])
            .unwrap();
        let two = git(&dir, &["show", ":two.bin"]);
        assert!(two.starts_with("version https://git-lfs.github.com/spec/v1\noid sha256:"));
        repo.commit("LFS assets", None, false).unwrap();
        assert_eq!(git(&dir, &["show", "HEAD:one.bin"]), pointer);
        assert_eq!(git(&dir, &["show", "HEAD:two.bin"]), two);
        assert!(
            repo.status().unwrap().is_empty(),
            "clean LFS files must not appear modified"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn checkout_discard_and_network_round_trip_content_and_pointer_bytes() {
        let (repo, dir) = fixture();
        let original = b"large content\0first\n";
        let changed = b"large content\0second\n";
        std::fs::write(dir.join("asset.bin"), original).unwrap();
        repo.stage_paths(&[".gitattributes".into(), "asset.bin".into()])
            .unwrap();
        let first = repo.commit("first", None, false).unwrap().oid;
        repo.create_branch("next", None, true).unwrap();
        std::fs::write(dir.join("asset.bin"), changed).unwrap();
        repo.stage_path("asset.bin").unwrap();
        let second = repo.commit("second", None, false).unwrap().oid;
        let pointer = git(&dir, &["show", "HEAD:asset.bin"]);
        repo.checkout_branch("main").unwrap();
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), original);
        repo.checkout_branch("next").unwrap();
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), changed);
        std::fs::write(dir.join("asset.bin"), b"uncommitted").unwrap();
        assert!(repo.checkout_branch("main").is_err());
        assert_eq!(
            std::fs::read(dir.join("asset.bin")).unwrap(),
            b"uncommitted"
        );
        repo.discard_path("asset.bin").unwrap();
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), changed);
        repo.checkout_commit(&first).unwrap();
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), original);
        repo.checkout_branch("next").unwrap();

        repo.reset(&first, crate::reset::ResetMode::Hard).unwrap();
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), original);
        repo.reset(&second, crate::reset::ResetMode::Hard).unwrap();
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), changed);

        let remote = dir.join("upstream.git");
        git(&dir, &["init", "--bare", remote.to_str().unwrap()]);
        git(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        repo.push_current_to_remote("origin", true, |_| {}, None)
            .unwrap();
        let consumer = dir.join("consumer");
        // Git LFS 3.5 installs post-checkout during smudge, which newer Git's
        // clone protection refuses. Keep clone configuration in F09's scope:
        // acquire objects without checkout, then exercise Strand's checkout.
        git(
            &dir,
            &[
                "clone",
                "--no-checkout",
                "--branch",
                "next",
                remote.to_str().unwrap(),
                consumer.to_str().unwrap(),
            ],
        );
        Repo::discover(&consumer)
            .unwrap()
            .checkout_branch("next")
            .unwrap();
        assert_eq!(std::fs::read(consumer.join("asset.bin")).unwrap(), changed);
        assert_eq!(git(&consumer, &["show", "HEAD:asset.bin"]), pointer);
        std::fs::write(dir.join("asset.bin"), b"third\0version").unwrap();
        repo.stage_path("asset.bin").unwrap();
        repo.commit("third", None, false).unwrap();
        repo.push_current_to_remote("origin", true, |_| {}, None)
            .unwrap();
        Repo::discover(&consumer)
            .unwrap()
            .pull(
                crate::network::PullMode::FastForwardOnly,
                false,
                |_| {},
                None,
            )
            .unwrap();
        assert_eq!(
            std::fs::read(consumer.join("asset.bin")).unwrap(),
            b"third\0version"
        );
        assert_eq!(
            git(&consumer, &["show", "HEAD:asset.bin"]),
            git(&dir, &["show", "HEAD:asset.bin"])
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_filter_fails_without_writing_raw_bytes_or_losing_bulk_index() {
        let (repo, dir) = fixture();
        std::fs::write(dir.join("asset.bin"), b"content\0").unwrap();
        std::fs::write(dir.join("keep.txt"), b"keep").unwrap();
        repo.stage_path("keep.txt").unwrap();
        let before = git(&dir, &["write-tree"]);
        git(
            &dir,
            &[
                "config",
                "filter.lfs.process",
                "strand-missing-git-lfs filter-process",
            ],
        );
        assert!(repo.stage_path("asset.bin").is_err());
        assert!(repo
            .stage_paths(&["keep.txt".into(), "asset.bin".into()])
            .is_err());
        assert_eq!(git(&dir, &["write-tree"]), before);
        assert_eq!(std::fs::read(dir.join("asset.bin")).unwrap(), b"content\0");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn management_tracks_without_history_migration_and_reports_server_locks() {
        use std::io::{Read, Write};
        let (repo, dir) = fixture();
        repo.stage_path(".gitattributes").unwrap();
        let head = repo.commit("attributes", None, false).unwrap().oid;
        repo.lfs_action(LfsAction::Install, |_| {}, None).unwrap();
        repo.lfs_action(
            LfsAction::Track {
                pattern: "*.psd".into(),
            },
            |_| {},
            None,
        )
        .unwrap();
        assert!(repo
            .lfs_action(LfsAction::Patterns, |_| {}, None)
            .unwrap()
            .output
            .contains("*.psd"));
        repo.lfs_action(
            LfsAction::Untrack {
                pattern: "*.psd".into(),
            },
            |_| {},
            None,
        )
        .unwrap();
        assert!(!std::fs::read_to_string(dir.join(".gitattributes"))
            .unwrap()
            .contains("*.psd"));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
        for action in [
            LfsAction::Environment,
            LfsAction::Status,
            LfsAction::Objects,
        ] {
            repo.lfs_action(action, |_| {}, None).unwrap();
        }
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        git(
            &dir,
            &[
                "config",
                "lfs.url",
                &format!("http://{}", server.local_addr().unwrap()),
            ],
        );
        let worker = std::thread::spawn(move || {
            let lock = r#"{"id":"1","path":"asset.bin","locked_at":"2026-09-06T10:00:00Z","owner":{"name":"Test"}}"#;
            for (request, body) in [
                ("POST /locks", format!("{{\"lock\":{lock}}}")),
                ("GET /locks?", format!("{{\"locks\":[{lock}]}}")),
                ("POST /locks/1/unlock", format!("{{\"lock\":{lock}}}")),
            ] {
                let started = std::time::Instant::now();
                let mut stream = loop {
                    match server.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                started.elapsed().as_secs() < 120,
                                "LFS did not contact lock server"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(30)))
                    .unwrap();
                let mut received = Vec::new();
                let mut byte = [0];
                while !received.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    received.push(byte[0]);
                    assert!(received.len() < 16_384);
                }
                assert!(
                    String::from_utf8_lossy(&received).starts_with(request),
                    "{}",
                    String::from_utf8_lossy(&received)
                );
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.git-lfs+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        std::fs::write(dir.join("asset.bin"), b"content").unwrap();
        repo.lfs_action(
            LfsAction::Lock {
                path: "asset.bin".into(),
            },
            |_| {},
            None,
        )
        .unwrap();
        assert!(repo
            .lfs_action(
                LfsAction::Locks {
                    path: String::new()
                },
                |_| {},
                None
            )
            .unwrap()
            .output
            .contains("asset.bin"));
        repo.lfs_action(LfsAction::Unlock { id: "1".into() }, |_| {}, None)
            .unwrap();
        worker.join().unwrap();
        let cancel = crate::network::CancelHandle::new();
        cancel.cancel();
        assert!(matches!(
            repo.lfs_action(LfsAction::Status, |_| {}, Some(&cancel)),
            Err(crate::Error::Cancelled)
        ));
        let _ = std::fs::remove_dir_all(dir);
    }
}
