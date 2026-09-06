use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub fn repository_path(args: &[String]) -> Result<PathBuf, String> {
    let path = match args {
        [path] if !path.starts_with('-') => path,
        [separator, path] if separator == "--" => path,
        _ => {
            return Err(
                "Usage: strand PATH (use strand -- PATH for a path starting with '-')".into(),
            )
        }
    };
    let repo = strand_core::Repo::discover(path).map_err(|e| e.to_string())?;
    Ok(repo.path().to_path_buf())
}

pub fn launch(args: &[String]) -> Result<(), String> {
    let path = repository_path(args)?;
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let desktop = std::env::var_os("STRAND_DESKTOP")
        .map(PathBuf::from)
        .or_else(|| {
            std::fs::read_to_string(current.with_extension("desktop-path"))
                .ok()
                .map(PathBuf::from)
        });
    let mut command = if let Some(desktop) = desktop {
        if !desktop.is_absolute() || !desktop.is_file() || desktop == current {
            return Err("STRAND_DESKTOP must name an existing absolute desktop executable.".into());
        }
        Command::new(desktop)
    } else {
        desktop_command(&current)?
    };
    command
        .arg("--open-repo")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|e| format!("Could not launch Strand: {e}"))?;
    Ok(())
}

fn desktop_command(_current: &Path) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/open");
        command.args(["-n", "-a", "Strand", "--args"]);
        Ok(command)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let sibling = _current
            .parent()
            .unwrap_or(Path::new("/"))
            .join(if cfg!(windows) {
                "strand.exe"
            } else {
                "strand"
            });
        if sibling.is_file() && sibling != _current {
            return Ok(Command::new(sibling));
        }
        Err("Desktop app not found. Install the command from Settings → Integrations, or set STRAND_DESKTOP.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_nested_paths_and_rejects_extra_arguments() {
        let temp = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(temp.path())
            .status()
            .unwrap();
        let nested = temp.path().join("space name");
        std::fs::create_dir(&nested).unwrap();
        assert_eq!(
            repository_path(&[nested.to_string_lossy().into_owned()]).unwrap(),
            strand_core::Repo::discover(temp.path()).unwrap().path()
        );
        assert!(repository_path(&["--bad".into()]).is_err());
        assert!(repository_path(&[".".into(), "extra".into()]).is_err());
    }
}
