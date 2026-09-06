//! A bounded, durable-until-drained argv inbox. Events only wake the consumer;
//! the frontend drains after installing its listener and restoring the session.
use crate::commands::{CmdError, CmdResult};
use std::{collections::VecDeque, path::Path, sync::Mutex};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct LaunchInbox(Mutex<VecDeque<String>>);

pub fn request_path(args: &[String], cwd: &Path) -> Option<String> {
    let path = match args {
        [_, flag, path] if flag == "--open-repo" => path,
        [_, path] if !path.starts_with('-') => path,
        _ => return None,
    };
    let path = Path::new(path);
    Some(
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        }
        .to_string_lossy()
        .into_owned(),
    )
}

pub fn receive(app: &tauri::AppHandle, args: &[String], cwd: &Path) {
    if let Some(path) = request_path(args, cwd) {
        if let Ok(mut inbox) = app.state::<LaunchInbox>().0.lock() {
            if inbox.len() < 32 && !inbox.contains(&path) {
                inbox.push_back(path);
            }
        }
        let _ = app.emit("app://open-request", ());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command(async)]
pub fn app_take_open_requests(inbox: State<'_, LaunchInbox>) -> Vec<String> {
    inbox
        .0
        .lock()
        .map(|mut queue| queue.drain(..).collect())
        .unwrap_or_default()
}

/// Install a private executable + desktop locator without a shell/argv shim.
/// The command directory is added to the user's PATH on Windows; Unix shells
/// report the exact export when ~/.local/bin isn't in PATH already.
#[tauri::command(async)]
pub async fn app_install_cli(app: tauri::AppHandle) -> CmdResult<String> {
    tokio::task::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| CmdError {
            message: e.to_string(),
        })?
        .map_err(|message| CmdError { message })
}

fn install(app: &tauri::AppHandle) -> Result<String, String> {
    let desktop = std::env::current_exe().map_err(|e| e.to_string())?;
    let name = if cfg!(windows) {
        "strand-cli.exe"
    } else {
        "strand-cli"
    };
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("binaries")
        .join(name);
    let sibling = desktop.with_file_name(name);
    let source = if bundled.is_file() { bundled } else { sibling };
    if !source.is_file() {
        return Err(
            "Companion missing. Build strand-headless or reinstall the desktop package.".into(),
        );
    }
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".local")
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let destination = dir.join(if cfg!(windows) {
        "strand.exe"
    } else {
        "strand"
    });
    let locator = destination.with_extension("desktop-path");
    // Do not replace an unrelated executable already using this command name.
    if destination.exists() && !locator.exists() {
        return Err(format!(
            "{} already exists and is not managed by Strand.",
            destination.display()
        ));
    }
    std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
    std::fs::write(locator, desktop.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    add_user_path(&dir)?;
    Ok(format!(
        "Installed {}. {}",
        destination.display(),
        if cfg!(windows) {
            "Open a new terminal to use strand PATH.".to_owned()
        } else {
            format!(
                "If needed, add {} to your shell PATH. Run strand PATH to open a repository.",
                dir.display()
            )
        }
    ))
}

#[cfg(windows)]
fn add_user_path(dir: &Path) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::*;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut key = std::ptr::null_mut();
    unsafe {
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            wide("Environment").as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut key,
        ) != 0
        {
            return Err("Could not open user PATH registry key.".into());
        }
        let result: Result<(), String> = (|| {
            let mut len = 0;
            let mut kind = REG_EXPAND_SZ;
            let name = wide("Path");
            let status = RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut len,
            );
            if status != 0 && status != 2 {
                return Err("Could not read user PATH.".into());
            }
            if status == 0 && kind != REG_SZ && kind != REG_EXPAND_SZ {
                return Err("User PATH is not a string registry value.".into());
            }
            if len > 128 * 1024 {
                return Err("User PATH exceeds supported size.".into());
            }
            let mut value = vec![0u16; len as usize / 2 + 1];
            if status == 0
                && RegQueryValueExW(
                    key,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    value.as_mut_ptr().cast(),
                    &mut len,
                ) != 0
            {
                return Err("Could not read user PATH.".into());
            }
            let old = String::from_utf16_lossy(&value)
                .trim_end_matches('\0')
                .to_string();
            let dir = dir.to_string_lossy();
            if old.split(';').any(|p| p.eq_ignore_ascii_case(&dir)) {
                return Ok(());
            }
            let updated = wide(&format!(
                "{}{}{}",
                old,
                if old.is_empty() || old.ends_with(';') {
                    ""
                } else {
                    ";"
                },
                dir
            ));
            if RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                kind,
                updated.as_ptr().cast(),
                (updated.len() * 2) as u32,
            ) != 0
            {
                return Err("Could not update user PATH.".into());
            }
            Ok(())
        })();
        RegCloseKey(key);
        result?;
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            wide("Environment").as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            1000,
            std::ptr::null_mut(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_is_explicit_and_relative_to_sender() {
        let cwd = std::env::temp_dir();
        assert_eq!(
            request_path(
                &["strand".into(), "--open-repo".into(), "space name".into()],
                &cwd
            ),
            Some(cwd.join("space name").to_string_lossy().into_owned())
        );
        assert!(request_path(&["strand".into(), "--anything".into()], &cwd).is_none());
    }
}
