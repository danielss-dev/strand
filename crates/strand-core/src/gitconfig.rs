//! Global defaults and effective repository identity. Repository reads use
//! system Git so conditional/worktree config and environment match commits.
//! Writes target only the explicitly selected global or direct local config.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::{Error, Repo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedValue {
    pub value: String,
    pub scope: String,
    pub origin: String,
}

#[derive(Debug, Serialize)]
pub struct EffectiveIdentity {
    pub identity: Option<String>,
    pub error: Option<String>,
    pub name_source: ScopedValue,
    pub email_source: ScopedValue,
}

#[derive(Debug, Serialize)]
pub struct RepositoryIdentity {
    pub author: EffectiveIdentity,
    pub committer: EffectiveIdentity,
    pub local: GlobalIdentity,
}

pub(crate) type ConfigValues = std::collections::BTreeMap<String, ScopedValue>;

pub(crate) fn config_values(repo: &Repo, scope: Option<&str>, pattern: &str) -> Result<ConfigValues> {
    let mut args = vec!["config", "--null", "--show-scope", "--show-origin"];
    if let Some(scope) = scope { args.extend([scope, "--no-includes"]); }
    else { args.push("--includes"); }
    args.extend(["--get-regexp", pattern]);
    let out = config_git(repo, &args)?;
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(config_error(&out));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    if text.contains("[output truncated;") {
        return Err(Error::Other("Git identity/config output exceeded the display limit".into()));
    }
    let mut fields = text.split_terminator('\0');
    let mut values = ConfigValues::new();
    while let Some(scope) = fields.next() {
        let origin = fields.next().ok_or_else(|| Error::Other("Invalid Git config origin".into()))?;
        let entry = fields.next().ok_or_else(|| Error::Other("Invalid Git config value".into()))?;
        let (key, value) = entry.split_once('\n').map_or((entry, None), |(key, value)| (key, Some(value)));
        // Git distinguishes a valueless boolean (true) from an explicitly
        // empty value (false). Keep both editable as actual signing states.
        let value = if matches!(key, "commit.gpgsign" | "tag.gpgsign" | "tag.forcesignannotated") {
            match value { None => "true", Some("") => "false", Some(value) => value }
        } else { value.unwrap_or_default() };
        values.insert(key.to_owned(), ScopedValue {
            value: value.to_owned(), scope: scope.to_owned(), origin: origin.to_owned(),
        });
    }
    Ok(values)
}

fn config_git(repo: &Repo, args: &[&str]) -> Result<std::process::Output> {
    crate::git_output::capture(crate::git_command().current_dir(&repo.path)
        .env("GIT_TERMINAL_PROMPT", "0").args(crate::GIT_SAFE_CONFIG).args(args))
}

fn config_error(output: &std::process::Output) -> Error {
    Error::Other(format!("Git config: {}", String::from_utf8_lossy(&output.stderr).trim()))
}

fn identity_source(values: &ConfigValues, role: &str, field: &str) -> ScopedValue {
    let env_key = format!("GIT_{}_{}", role.to_uppercase(), field.to_uppercase());
    if let Ok(value) = std::env::var(&env_key) {
        return ScopedValue { value, scope: "environment".into(), origin: env_key };
    }
    values.get(&format!("{role}.{field}")).or_else(|| values.get(&format!("user.{field}")))
        .cloned().unwrap_or_else(|| ScopedValue {
            value: String::new(), scope: "fallback".into(), origin: "Git environment/system fallback".into(),
        })
}

impl Repo {
    /// Read using the same Git resolver as commit, including conditional
    /// includes, worktree config, author/committer overrides and environment.
    /// Only queried on the settings surface, never on status/log refresh.
    pub fn repository_identity(&self) -> Result<RepositoryIdentity> {
        let values = config_values(self, None, "^(user|author|committer)\\.(name|email)$")?;
        let local = config_values(self, Some("--local"), "^user\\.(name|email)$")?;
        let identity = |role: &str| -> Result<EffectiveIdentity> {
            let variable = format!("GIT_{}_IDENT", role.to_uppercase());
            let out = config_git(self, &["var", &variable])?;
            let text = String::from_utf8_lossy(&out.stdout);
            Ok(EffectiveIdentity {
                identity: out.status.success().then(|| text.rsplit_once('>').map(|(id, _)| format!("{id}>"))
                    .unwrap_or_else(|| text.trim().to_owned())),
                error: (!out.status.success()).then(|| String::from_utf8_lossy(&out.stderr).trim().to_owned()),
                name_source: identity_source(&values, role, "name"),
                email_source: identity_source(&values, role, "email"),
            })
        };
        Ok(RepositoryIdentity {
            author: identity("author")?, committer: identity("committer")?,
            local: GlobalIdentity {
                name: local.get("user.name").map(|v| v.value.clone()),
                email: local.get("user.email").map(|v| v.value.clone()),
            },
        })
    }

    /// Write only the selected key in the common repository config. Git's
    /// --local writes never follow includes back into global/conditional files.
    pub fn set_repository_identity(&self, field: &str, value: Option<&str>) -> Result<()> {
        let key = match field {
            "name" => "user.name", "email" => "user.email",
            _ => return Err(Error::Other("Unknown identity field".into())),
        };
        self.set_scoped_config("--local", key, value)
    }

    pub(crate) fn set_scoped_config(&self, scope: &str, key: &str, value: Option<&str>) -> Result<()> {
        if value.is_some_and(|v| v.trim().is_empty() || v.len() > 4096 || v.contains(['\0', '\r', '\n'])) {
            return Err(Error::Other("Use a non-empty, single-line config value (up to 4096 bytes), or remove the override".into()));
        }
        let args = match value {
            Some(value) => vec!["config", scope, "--replace-all", key, value],
            None => vec!["config", scope, "--unset-all", key],
        };
        let out = config_git(self, &args)?;
        if out.status.success() || (value.is_none() && out.status.code() == Some(5)) { Ok(()) }
        else { Err(config_error(&out)) }
    }
}

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
    fn repository_overrides_preserve_conditional_identity_and_other_repositories() {
        let dir = std::env::temp_dir().join(format!("strand-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("one");
        let second = dir.join("two");
        for path in [&first, &second] {
            let g2 = git2::Repository::init(path).unwrap();
            let mut config = g2.config().unwrap();
            config.set_str("user.name", "Base").unwrap();
            config.set_str("user.email", "base@example.com").unwrap();
        }
        let repo = Repo::discover(&first).unwrap();
        let other = Repo::discover(&second).unwrap();
        let included = dir.join("conditional.gitconfig");
        let content = "[user]\nname = Conditional\nemail = conditional@example.com\n";
        std::fs::write(&included, content).unwrap();
        let mut config = repo.git2().unwrap().config().unwrap();
        let condition = format!("includeIf.gitdir:{}/.git.path", first.to_string_lossy().replace('\\', "/"));
        config.set_str(&condition, &included.to_string_lossy().replace('\\', "/")).unwrap();
        assert_eq!(repo.repository_identity().unwrap().author.identity.as_deref(), Some("Conditional <conditional@example.com>"));
        repo.set_repository_identity("name", Some("Local")).unwrap();
        repo.set_repository_identity("email", Some("local@example.com")).unwrap();
        // The direct local keys occur before the include, so Git correctly
        // keeps the later conditional identity effective. UI shows both.
        let state = repo.repository_identity().unwrap();
        assert_eq!(state.local.name.as_deref(), Some("Local"));
        assert!(state.author.name_source.origin.contains("conditional.gitconfig"));
        repo.set_repository_identity("name", None).unwrap();
        repo.set_repository_identity("email", None).unwrap();
        assert_eq!(repo.repository_identity().unwrap().author.identity.as_deref(), Some("Conditional <conditional@example.com>"));
        assert_eq!(std::fs::read_to_string(&included).unwrap(), content);
        assert_eq!(other.repository_identity().unwrap().author.identity.as_deref(), Some("Base <base@example.com>"));
        assert!(repo.set_repository_identity("signingkey", Some("bad")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn local_identity_is_shared_by_linked_worktrees_and_worktree_identity_stays_effective() {
        let dir = std::env::temp_dir().join(format!("strand-linked-identity-{}", std::process::id()));
        let main = dir.join("main");
        let linked = dir.join("linked");
        std::fs::create_dir_all(&main).unwrap();
        let repo = Repo::discover({ git2::Repository::init(&main).unwrap(); &main }).unwrap();
        repo.set_repository_identity("name", Some("Shared")).unwrap();
        repo.set_repository_identity("email", Some("shared@example.com")).unwrap();
        let out = config_git(&repo, &["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base"]).unwrap();
        assert!(out.status.success());
        assert!(config_git(&repo, &["worktree", "add", "-b", "linked", linked.to_str().unwrap()]).unwrap().status.success());
        let worktree = Repo::discover(&linked).unwrap();
        worktree.set_repository_identity("name", Some("Both")).unwrap();
        assert_eq!(repo.repository_identity().unwrap().author.identity.as_deref(), Some("Both <shared@example.com>"));
        assert!(config_git(&repo, &["config", "extensions.worktreeConfig", "true"]).unwrap().status.success());
        assert!(config_git(&worktree, &["config", "--worktree", "user.name", "Worktree"]).unwrap().status.success());
        worktree.set_repository_identity("name", None).unwrap();
        let identity = worktree.repository_identity().unwrap();
        assert_eq!(identity.author.identity.as_deref(), Some("Worktree <shared@example.com>"));
        assert_eq!(identity.author.name_source.scope, "worktree");
        assert_eq!(identity.local.name, None);
        let _ = std::fs::remove_dir_all(dir);
    }

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
