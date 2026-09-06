//! Personally configured actions. Argument boundaries exist before substitution;
//! repository values are never parsed as command syntax or substituted twice.
use serde::{Deserialize, Serialize};

use crate::{Error, Repo, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserAction {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ActionTarget {
    Repository,
    Ref { reference: String, oid: String },
    File { file: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionContext {
    pub path: String,
    pub target: ActionTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionPreview {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
}

fn invalid(message: &str) -> Error {
    Error::Other(message.into())
}

/// Expand only template text. Escaped braces allow literal script/JSON arguments.
fn substitute(template: &str, vars: &[(&str, String)]) -> Result<String> {
    let mut out = String::new();
    let mut rest = template;
    while !rest.is_empty() {
        if rest.starts_with("{{") {
            out.push('{');
            rest = &rest[2..];
        } else if rest.starts_with("}}") {
            out.push('}');
            rest = &rest[2..];
        } else if rest.starts_with('{') {
            let end = rest
                .find('}')
                .ok_or_else(|| invalid("Unclosed action placeholder"))?;
            let key = &rest[1..end];
            let value = vars
                .iter()
                .find(|(name, _)| *name == key)
                .ok_or_else(|| invalid(&format!("Unavailable action placeholder: {{{key}}}")))?;
            out.push_str(&value.1);
            rest = &rest[end + 1..];
        } else {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    Ok(out)
}

impl Repo {
    pub fn preview_user_action(
        &self,
        action: &UserAction,
        context: &ActionContext,
    ) -> Result<ActionPreview> {
        if action.name.trim().is_empty()
            || action.name.len() > 120
            || action.args.len() > 128
            || action.executable.trim().is_empty()
            || action.executable.contains('\0')
            || action.executable.len() > 4096
            || action.args.iter().map(String::len).sum::<usize>() > 24_000
            || action.args.iter().any(|arg| arg.contains('\0'))
        {
            return Err(invalid("Invalid action: use a name, a literal executable, and at most 128 arguments / 24 KB"));
        }
        let root = self.path().canonicalize()?;
        let mut cwd = root.clone();
        let mut vars = vec![("repo", root.to_string_lossy().into_owned())];
        match &context.target {
            ActionTarget::Repository if action.scope == "repository" => {}
            ActionTarget::Ref { reference, oid } if action.scope == "ref" => {
                if !reference.starts_with("refs/") {
                    return Err(invalid("Select a qualified branch or tag ref"));
                }
                let current = self
                    .git2()?
                    .find_reference(reference)?
                    .peel_to_commit()?
                    .id()
                    .to_string();
                if &current != oid {
                    return Err(invalid(
                        "Selected ref changed. Close this preview and select it again.",
                    ));
                }
                vars.extend([("ref", reference.clone()), ("oid", current)]);
            }
            ActionTarget::File { file } if action.scope == "file" => {
                let full = self.workdir_path(file)?.canonicalize()?;
                if !full.is_file() {
                    return Err(invalid("Select an existing working-tree file"));
                }
                // A replaced symlink must never redirect a preview outside this checkout.
                if !full.starts_with(&root) {
                    return Err(invalid("File escapes the working tree"));
                }
                if action.cwd == "file-parent" {
                    cwd = full.parent().unwrap().to_owned();
                }
                vars.extend([
                    ("file", full.to_string_lossy().into_owned()),
                    ("relativeFile", file.clone()),
                ]);
            }
            _ => return Err(invalid("Action scope does not match the selected context")),
        }
        if action.cwd != "repository" && !(action.cwd == "file-parent" && action.scope == "file") {
            return Err(invalid(
                "Working directory must be the repository or selected file's parent",
            ));
        }
        let mut args = Vec::new();
        if std::path::Path::new(&action.executable)
            .file_stem()
            .is_some_and(|name| name.eq_ignore_ascii_case("git"))
        {
            args.extend(crate::GIT_SAFE_CONFIG.iter().map(|arg| arg.to_string()));
        }
        for arg in &action.args {
            args.push(substitute(arg, &vars)?);
        }
        if args.iter().map(String::len).sum::<usize>() > 28_000 {
            return Err(invalid("Resolved arguments exceed 28 KB"));
        }
        Ok(ActionPreview {
            executable: action.executable.clone(),
            args,
            cwd: cwd.to_string_lossy().into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(scope: &str, args: &[&str]) -> UserAction {
        UserAction {
            id: "test".into(),
            name: "Test".into(),
            scope: scope.into(),
            executable: "probe".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: "repository".into(),
        }
    }

    #[test]
    fn substitution_preserves_boundaries_and_does_not_reexpand_values() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("repo space & %PATH% {oid}");
        std::fs::create_dir(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        let file = "file & %PATH% {repo}.txt";
        std::fs::write(dir.join(file), "text").unwrap();
        let repo = Repo::discover(&dir).unwrap();
        let context = ActionContext {
            path: dir.to_string_lossy().into_owned(),
            target: ActionTarget::File { file: file.into() },
        };
        let mut definition = action(
            "file",
            &["--", "{relativeFile}", "prefix={file}", "", "{{literal}}"],
        );
        definition.cwd = "file-parent".into();
        definition.executable = dir.join("tool {repo}").to_string_lossy().into_owned();
        let preview = repo.preview_user_action(&definition, &context).unwrap();
        assert_eq!(preview.executable, definition.executable);
        assert_eq!(preview.args[1], file);
        assert!(preview.args[2].ends_with(file));
        assert_eq!(&preview.args[3..], &["", "{literal}"]);
        assert_eq!(preview.cwd, dir.canonicalize().unwrap().to_string_lossy());
        definition.args = vec!["{ref}".into()];
        assert!(repo.preview_user_action(&definition, &context).is_err());
        let outside = ActionContext {
            target: ActionTarget::File {
                file: "../outside".into(),
            },
            ..context.clone()
        };
        assert!(repo
            .preview_user_action(&action("file", &[]), &outside)
            .is_err());
        std::fs::remove_file(dir.join(file)).unwrap();
        assert!(repo
            .preview_user_action(&action("file", &[]), &context)
            .is_err());
    }

    #[test]
    fn stale_refs_and_wrong_scopes_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let git = git2::Repository::init(dir.path()).unwrap();
        let tree = git.treebuilder(None).unwrap().write().unwrap();
        let tree = git.find_tree(tree).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let oid = git
            .commit(Some("refs/heads/main"), &sig, &sig, "one", &tree, &[])
            .unwrap();
        let context = ActionContext {
            path: dir.path().to_string_lossy().into_owned(),
            target: ActionTarget::Ref {
                reference: "refs/heads/main".into(),
                oid: oid.to_string(),
            },
        };
        let repo = Repo::discover(dir.path()).unwrap();
        assert!(repo
            .preview_user_action(&action("ref", &["{ref}", "{oid}"]), &context)
            .is_ok());
        assert!(repo
            .preview_user_action(&action("file", &[]), &context)
            .is_err());
        git.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "two",
            &tree,
            &[&git.find_commit(oid).unwrap()],
        )
        .unwrap();
        let repo = Repo::discover(dir.path()).unwrap();
        assert!(repo
            .preview_user_action(&action("ref", &[]), &context)
            .is_err());
    }
}
