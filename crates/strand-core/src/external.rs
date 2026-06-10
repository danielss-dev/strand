//! Launching external apps (editor, terminal) from user-configured command
//! templates like `code -g {file}:{line}` or `open -a iTerm {dir}`.
//!
//! Safety model: the template itself is the **user's own setting** (same
//! trust as git's `merge.tool`), but `{file}` comes from repo content. We
//! tokenize the template *first* and substitute placeholders *inside* each
//! token afterwards, so a hostile path (spaces, quotes, `;`, `&&`) stays a
//! single argv element and can never add flags or commands. No shell is
//! ever invoked — argv goes straight to the OS.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::{
    error::{Error, Result},
    repo::Repo,
};

impl Repo {
    /// Open a file (or, with `rel_path: None`, the working directory) in the
    /// editor described by `template`. With a file, `{file}` / `{line}` /
    /// `{dir}` substitute; a template without `{file}` gets the absolute path
    /// appended. Without a file, tokens still referencing `{file}` / `{line}`
    /// are dropped (their context is gone) and the working directory is
    /// appended — every editor CLI accepts a directory argument.
    pub fn open_in_editor(
        &self,
        rel_path: Option<&str>,
        line: Option<u32>,
        template: &str,
    ) -> Result<()> {
        let dir = self.path().to_string_lossy().into_owned();
        let argv = match rel_path {
            Some(rel) => {
                // Same traversal/symlink guard as the conflict file I/O.
                let full = self.workdir_path(rel)?;
                let file = full.to_string_lossy().into_owned();
                let line = line.unwrap_or(1).to_string();
                let mut argv =
                    build_argv(template, &[("file", &file), ("line", &line), ("dir", &dir)])?;
                if !template.contains("{file}") {
                    argv.push(file);
                }
                argv
            }
            None => {
                let mut argv: Vec<String> = build_argv(template, &[("dir", &dir)])?
                    .into_iter()
                    .filter(|t| !t.contains("{file}") && !t.contains("{line}"))
                    .collect();
                argv.push(dir);
                argv
            }
        };
        spawn_detached(&argv, self.path())
    }

    /// Open the working directory in the terminal described by `template`
    /// (`{dir}` substitutes; appended when the template doesn't mention it).
    pub fn open_in_terminal(&self, template: &str) -> Result<()> {
        let dir = self.path().to_string_lossy().into_owned();
        let mut argv = build_argv(template, &[("dir", &dir)])?;
        if !template.contains("{dir}") {
            argv.push(dir);
        }
        spawn_detached(&argv, self.path())
    }
}

/// Split `template` into argv tokens (whitespace separates; `'…'` / `"…"`
/// group, with no escape processing beyond closing the quote), then replace
/// `{key}` placeholders from `vars` inside each token.
pub fn build_argv(template: &str, vars: &[(&str, &str)]) -> Result<Vec<String>> {
    let tokens = tokenize(template)?;
    if tokens.is_empty() {
        return Err(Error::Other("empty command template".into()));
    }
    Ok(tokens
        .into_iter()
        .map(|tok| {
            let mut out = tok;
            for (key, value) in vars {
                out = out.replace(&format!("{{{key}}}"), value);
            }
            out
        })
        .collect())
}

fn tokenize(template: &str) -> Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                in_token = true;
                let quote = c;
                let mut closed = false;
                for q in chars.by_ref() {
                    if q == quote {
                        closed = true;
                        break;
                    }
                    current.push(q);
                }
                if !closed {
                    return Err(Error::Other("unclosed quote in command template".into()));
                }
            }
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            c => {
                in_token = true;
                current.push(c);
            }
        }
    }
    if in_token {
        tokens.push(current);
    }
    Ok(tokens)
}

/// Spawn `argv[0]` with `argv[1..]`, detached: stdio nulled, no wait. The
/// child outlives us; launching an editor must never block the IPC thread.
pub fn spawn_detached(argv: &[String], cwd: &Path) -> Result<()> {
    let (program, args) = argv.split_first().ok_or_else(|| Error::Other("empty command".into()))?;
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Other(format!(
                    "`{program}` not found on PATH — install its shell command or set a custom command in Settings → Integrations"
                ))
            } else {
                Error::Other(format!("launch `{program}` failed: {e}"))
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(
            build_argv("code -g {file}:{line}", &[("file", "src/a.ts"), ("line", "7")]).unwrap(),
            vec!["code", "-g", "src/a.ts:7"]
        );
    }

    #[test]
    fn quotes_group_a_token() {
        assert_eq!(
            build_argv("open -a 'Visual Studio Code' {dir}", &[("dir", "/tmp/r")]).unwrap(),
            vec!["open", "-a", "Visual Studio Code", "/tmp/r"]
        );
    }

    #[test]
    fn substituted_path_with_spaces_stays_one_token() {
        let argv = build_argv("subl {file}", &[("file", "/tmp/my repo/a b.txt")]).unwrap();
        assert_eq!(argv, vec!["subl", "/tmp/my repo/a b.txt"]);
    }

    #[test]
    fn hostile_path_cannot_smuggle_tokens() {
        // Quotes/semicolons in a substituted value are literal bytes of one
        // argv element — substitution happens after tokenization.
        let argv = build_argv("code {file}", &[("file", "a'; rm -rf /;'b")]).unwrap();
        assert_eq!(argv, vec!["code", "a'; rm -rf /;'b"]);
    }

    #[test]
    fn unclosed_quote_errors() {
        assert!(build_argv("open -a 'iTerm", &[]).is_err());
    }

    #[test]
    fn empty_template_errors() {
        assert!(build_argv("   ", &[]).is_err());
    }

    #[test]
    fn adjacent_quotes_join_into_one_token() {
        assert_eq!(tokenize("a'b c'd").unwrap(), vec!["ab cd"]);
    }
}
