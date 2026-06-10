//! Global git configuration access — the user-level identity (`user.name` /
//! `user.email`) shown and edited in Settings → Git. Reads resolve the same
//! merged view git itself uses (system + global + XDG); writes always target
//! the **global** file, never a repo's `.git/config`.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::Result;

#[derive(Debug, Serialize)]
pub struct GlobalIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Read `user.name` / `user.email` as git resolves them outside any repo.
/// Missing keys come back as `None` (a fresh machine has neither).
pub fn global_identity() -> Result<GlobalIdentity> {
    let mut cfg = git2::Config::open_default()?;
    let snap = cfg.snapshot()?;
    Ok(GlobalIdentity {
        name: snap.get_string("user.name").ok(),
        email: snap.get_string("user.email").ok(),
    })
}

/// Write `user.name` / `user.email` to the global git config, creating
/// `~/.gitconfig` if the user has never configured git before
/// (`find_global` errors when no global file exists yet; git2's file
/// backend creates it on the first `set_str`).
pub fn set_global_identity(name: &str, email: &str) -> Result<()> {
    let path = git2::Config::find_global().unwrap_or_else(|_| default_global_path());
    set_identity_in(&path, name, email)
}

fn set_identity_in(path: &std::path::Path, name: &str, email: &str) -> Result<()> {
    let mut cfg = git2::Config::open(path)?;
    cfg.set_str("user.name", name)?;
    cfg.set_str("user.email", email)?;
    Ok(())
}

/// Where the global config goes when none exists yet: `$HOME/.gitconfig`
/// (`%USERPROFILE%` on Windows) — git's primary location, ahead of the XDG
/// fallback.
fn default_global_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".gitconfig")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_round_trips_through_a_config_file() {
        let dir = std::env::temp_dir().join(format!(
            "strand-gitconfig-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gitconfig");

        // File doesn't exist yet — the first write must create it.
        set_identity_in(&path, "Ada Lovelace", "ada@example.com").unwrap();
        let mut cfg = git2::Config::open(&path).unwrap();
        let snap = cfg.snapshot().unwrap();
        assert_eq!(snap.get_string("user.name").unwrap(), "Ada Lovelace");
        assert_eq!(snap.get_string("user.email").unwrap(), "ada@example.com");

        // Overwrite, not append-duplicate.
        set_identity_in(&path, "Grace Hopper", "grace@example.com").unwrap();
        let mut cfg = git2::Config::open(&path).unwrap();
        let snap = cfg.snapshot().unwrap();
        assert_eq!(snap.get_string("user.name").unwrap(), "Grace Hopper");
        assert_eq!(snap.get_string("user.email").unwrap(), "grace@example.com");

        let _ = std::fs::remove_dir_all(dir);
    }
}
