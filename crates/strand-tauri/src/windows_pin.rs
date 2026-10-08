//! Repair taskbar pins that still point at a removed MSI ProductIcon cache.
//!
//! Pre-1.7.3 Start Menu shortcuts used `Icon=ProductIcon`, so Explorer copies
//! under `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\` kept
//! a version-specific `%WINDIR%\Installer\{ProductCode}\...` path. A major
//! upgrade deletes that cache and the pin shows Windows' blank-page icon
//! (#135, DAN-81). New MSI shortcuts omit `Icon_` and use `strand.exe`; this
//! module only rewrites leftover pins whose target is the installed executable
//! and whose icon path is missing or inside the Installer cache. Matching
//! `.lnk` files are updated in place (`SetIconLocation` + `IPersistFile::Save`);
//! they are never deleted or replaced with a new file.

#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
use std::path::{Path, PathBuf};

/// Decides whether a `.lnk` is a leftover Strand pin that is safe to rewrite.
pub fn should_heal_pin(
    target_path: &str,
    icon_path: &str,
    installed_exe: &str,
    installer_cache_root: &str,
    icon_file_exists: bool,
) -> bool {
    if !windows_paths_equal(target_path, installed_exe) {
        return false;
    }
    let (icon_path, _) = split_icon_location(icon_path);
    if icon_path.is_empty() || windows_paths_equal(&icon_path, installed_exe) {
        return false;
    }
    icon_is_installer_cache(&icon_path, installer_cache_root) || !icon_file_exists
}

pub fn split_icon_location(icon_location: &str) -> (String, i32) {
    let trimmed = icon_location.trim().trim_matches('"');
    if let Some((path, index)) = trimmed.rsplit_once(',') {
        if let Ok(n) = index.trim().parse::<i32>() {
            return (path.trim().trim_matches('"').to_string(), n);
        }
    }
    (trimmed.to_string(), 0)
}

pub fn windows_paths_equal(left: &str, right: &str) -> bool {
    let left = normalize_windows_path(left);
    let right = normalize_windows_path(right);
    !left.is_empty() && left == right
}

fn icon_is_installer_cache(icon_path: &str, installer_cache_root: &str) -> bool {
    let icon = normalize_windows_path(icon_path);
    let root = normalize_windows_path(installer_cache_root);
    if icon.is_empty() || root.is_empty() {
        return false;
    }
    icon == root || icon.starts_with(&(root + "\\"))
}

fn normalize_windows_path(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"');
    let mut value = trimmed.replace('/', "\\").to_ascii_lowercase();
    const EXTENDED: &str = r"\\?\";
    const EXTENDED_UNC: &str = r"\\?\unc\";
    if let Some(rest) = value.strip_prefix(EXTENDED_UNC) {
        value = format!(r"\\{rest}");
    } else if let Some(rest) = value.strip_prefix(EXTENDED) {
        value = rest.to_string();
    }
    while value.ends_with('\\') && value.len() > 3 {
        value.pop();
    }
    value
}

#[cfg(windows)]
pub fn heal_broken_taskbar_pins() -> windows::core::Result<usize> {
    let installed_exe = std::env::current_exe()?;
    let installer_cache_root = installer_cache_root();
    heal_pins_in(&pinned_directories(), &installed_exe, &installer_cache_root)
}

#[cfg(windows)]
pub(crate) fn heal_pins_in(
    directories: &[PathBuf],
    installed_exe: &Path,
    installer_cache_root: &Path,
) -> windows::core::Result<usize> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    let installed = installed_exe.to_string_lossy();
    let cache_root = installer_cache_root.to_string_lossy();
    let mut lnks = Vec::new();
    for directory in directories {
        collect_lnk_files(directory, &mut lnks);
    }
    if lnks.is_empty() {
        return Ok(0);
    }

    // Ready runs on the UI thread, which already owns COM. Ignore a second
    // init or an apartment mismatch rather than tearing Tauri's apartment down.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    let mut healed = 0usize;
    for lnk in lnks {
        match heal_one_pin(&lnk, installed.as_ref(), cache_root.as_ref()) {
            Ok(true) => healed += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!("skipped Windows pin {}: {error}", lnk.display()),
        }
    }
    Ok(healed)
}

#[cfg(windows)]
fn heal_one_pin(
    lnk: &Path,
    installed_exe: &str,
    installer_cache_root: &str,
) -> windows::core::Result<bool> {
    let shortcut = read_shortcut(lnk)?;
    let icon_exists = !shortcut.icon_path.is_empty() && Path::new(&shortcut.icon_path).exists();
    if !should_heal_pin(
        &shortcut.target_path,
        &shortcut.icon_path,
        installed_exe,
        installer_cache_root,
        icon_exists,
    ) {
        return Ok(false);
    }
    write_shortcut_icon(lnk, installed_exe, 0)?;
    notify_explorer(lnk);
    Ok(true)
}

#[cfg(windows)]
struct ShortcutState {
    target_path: String,
    icon_path: String,
}

#[cfg(windows)]
fn with_shell_link<T>(
    path: &Path,
    persist_mode: windows::Win32::System::Com::STGM,
    work: impl FnOnce(
        &windows::Win32::UI::Shell::IShellLinkW,
        &windows::Win32::System::Com::IPersistFile,
        windows::core::PCWSTR,
    ) -> windows::core::Result<T>,
) -> windows::core::Result<T> {
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER},
            UI::Shell::{IShellLinkW, ShellLink},
        },
    };

    let wide = wide_path(path);
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }?;
    let persist: IPersistFile = link.cast()?;
    unsafe { persist.Load(PCWSTR(wide.as_ptr()), persist_mode) }?;
    work(&link, &persist, PCWSTR(wide.as_ptr()))
}

#[cfg(windows)]
fn read_shortcut(path: &Path) -> windows::core::Result<ShortcutState> {
    use windows::Win32::System::Com::STGM_READ;

    with_shell_link(path, STGM_READ, |link, _, _| {
        const SLGP_RAWPATH: u32 = 4;
        let mut target = vec![0u16; 2048];
        unsafe { link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH) }?;
        let mut icon = vec![0u16; 2048];
        let mut icon_index = 0i32;
        unsafe { link.GetIconLocation(&mut icon, std::ptr::addr_of_mut!(icon_index)) }?;
        Ok(ShortcutState {
            target_path: from_wide(&target),
            icon_path: from_wide(&icon),
        })
    })
}

#[cfg(windows)]
fn write_shortcut_icon(path: &Path, icon_path: &str, icon_index: i32) -> windows::core::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{core::PCWSTR, Win32::System::Com::STGM_READWRITE};

    let wide_icon: Vec<u16> = std::ffi::OsStr::new(icon_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // Load read-write so IPersistFile::Save can update the existing .lnk in place.
    // STGM_READ + Save fails with access denied and would leave broken pins untouched.
    with_shell_link(path, STGM_READWRITE, |link, persist, wide_path| {
        unsafe { link.SetIconLocation(PCWSTR(wide_icon.as_ptr()), icon_index) }?;
        unsafe { persist.Save(wide_path, true) }?;
        Ok(())
    })
}

#[cfg(all(windows, test))]
fn create_shortcut(path: &Path, target: &Path, icon: &Path) -> windows::core::Result<()> {
    use windows::{
        core::{Interface, PCWSTR},
        Win32::{
            System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER},
            UI::Shell::{IShellLinkW, ShellLink},
        },
    };

    let lnk_wide = wide_path(path);
    let target_wide = wide_path(target);
    let icon_wide = wide_path(icon);
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }?;
    unsafe { link.SetPath(PCWSTR(target_wide.as_ptr())) }?;
    unsafe { link.SetIconLocation(PCWSTR(icon_wide.as_ptr()), 0) }?;
    let persist: IPersistFile = link.cast()?;
    unsafe { persist.Save(PCWSTR(lnk_wide.as_ptr()), true) }?;
    Ok(())
}

#[cfg(windows)]
fn notify_explorer(path: &Path) {
    use windows::Win32::UI::Shell::{
        SHChangeNotify, SHCNE_UPDATEDIR, SHCNE_UPDATEITEM, SHCNF_FLUSH, SHCNF_PATHW,
    };

    let wide = wide_path(path);
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEITEM,
            SHCNF_PATHW | SHCNF_FLUSH,
            Some(wide.as_ptr().cast()),
            None,
        );
    }
    if let Some(parent) = path.parent() {
        let parent_wide = wide_path(parent);
        unsafe {
            SHChangeNotify(
                SHCNE_UPDATEDIR,
                SHCNF_PATHW | SHCNF_FLUSH,
                Some(parent_wide.as_ptr().cast()),
                None,
            );
        }
    }
}

#[cfg(windows)]
fn pinned_directories() -> Vec<PathBuf> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(appdata).join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned");
    ["TaskBar", "StartMenu", "ImplicitAppShortcuts"]
        .into_iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_dir())
        .collect()
}

#[cfg(windows)]
fn installer_cache_root() -> PathBuf {
    let windir = std::env::var_os("WINDIR")
        .or_else(|| std::env::var_os("SystemRoot"))
        .unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(windir).join("Installer")
}

#[cfg(windows)]
fn collect_lnk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_lnk = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"));
        if is_lnk {
            out.push(path);
        } else if path.is_dir() {
            collect_lnk_files(&path, out);
        }
    }
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn from_wide(buf: &[u16]) -> String {
    use std::os::windows::ffi::OsStringExt;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    std::ffi::OsString::from_wide(&buf[..len])
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Program Files\Strand\strand.exe";
    const CACHE: &str = r"C:\Windows\Installer";
    const PRODUCT_ICON: &str =
        r"C:\Windows\Installer\{43173C17-8D6E-4182-AD64-FD38EC263504}\ProductIcon";

    #[test]
    fn heals_missing_product_icon_cache_path() {
        assert!(should_heal_pin(EXE, PRODUCT_ICON, EXE, CACHE, false));
        assert!(should_heal_pin(
            EXE,
            &format!("{PRODUCT_ICON},0"),
            EXE,
            CACHE,
            false
        ));
    }

    #[test]
    fn heals_installer_cache_even_if_the_file_still_exists() {
        assert!(should_heal_pin(EXE, PRODUCT_ICON, EXE, CACHE, true));
    }

    #[test]
    fn ignores_pins_that_already_use_the_executable_icon() {
        assert!(!should_heal_pin(EXE, EXE, EXE, CACHE, true));
        assert!(!should_heal_pin(EXE, "", EXE, CACHE, false));
        assert!(!should_heal_pin(
            EXE,
            &format!("{EXE},0"),
            EXE,
            CACHE,
            false
        ));
    }

    #[test]
    fn ignores_other_applications() {
        assert!(!should_heal_pin(
            r"C:\Program Files\Other\app.exe",
            PRODUCT_ICON,
            EXE,
            CACHE,
            false
        ));
        assert!(!should_heal_pin("", PRODUCT_ICON, EXE, CACHE, false));
    }

    #[test]
    fn ignores_a_working_custom_icon_outside_the_installer_cache() {
        assert!(!should_heal_pin(
            EXE,
            r"C:\Icons\custom.ico",
            EXE,
            CACHE,
            true
        ));
    }

    #[test]
    fn heals_a_strand_pin_whose_custom_icon_file_is_gone() {
        assert!(should_heal_pin(
            EXE,
            r"C:\Icons\custom.ico",
            EXE,
            CACHE,
            false
        ));
    }

    #[test]
    fn matches_windows_path_quirks() {
        assert!(windows_paths_equal(
            r"C:\Program Files\Strand\strand.exe",
            r"c:/program files/strand/strand.exe"
        ));
        assert!(windows_paths_equal(
            r"\\?\C:\Program Files\Strand\strand.exe",
            EXE
        ));
        assert!(icon_is_installer_cache(
            r"C:\WINDOWS\Installer\{guid}\icon",
            r"C:\Windows\Installer\"
        ));
        assert!(!icon_is_installer_cache(
            r"C:\Windows\System32\shell32.dll",
            CACHE
        ));
    }

    #[test]
    fn split_icon_location_reads_wscript_format() {
        let (path, index) = split_icon_location(&format!("{PRODUCT_ICON},0"));
        assert_eq!(path, PRODUCT_ICON);
        assert_eq!(index, 0);
        let (path, index) = split_icon_location(r"C:\Program Files\Strand\strand.exe,-32512");
        assert_eq!(path, r"C:\Program Files\Strand\strand.exe");
        assert_eq!(index, -32512);
    }

    #[cfg(windows)]
    #[test]
    fn heals_only_broken_strand_pins_on_disk() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join("strand.exe");
        std::fs::write(&exe, b"fake-strand").unwrap();
        let other = temp.path().join("other.exe");
        std::fs::write(&other, b"other").unwrap();
        let cache = temp.path().join("Installer").join("{old-product}");
        std::fs::create_dir_all(&cache).unwrap();
        let missing_icon = cache.join("ProductIcon");
        let custom = temp.path().join("custom.ico");
        std::fs::write(&custom, b"ico").unwrap();
        let pin_dir = temp.path().join("TaskBar");
        std::fs::create_dir(&pin_dir).unwrap();

        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        create_shortcut(&pin_dir.join("broken.lnk"), &exe, &missing_icon).unwrap();
        create_shortcut(&pin_dir.join("healthy.lnk"), &exe, &exe).unwrap();
        create_shortcut(&pin_dir.join("other.lnk"), &other, &missing_icon).unwrap();
        create_shortcut(&pin_dir.join("custom.lnk"), &exe, &custom).unwrap();

        let cache_root = temp.path().join("Installer");
        let broken_before = read_shortcut(&pin_dir.join("broken.lnk")).unwrap();
        assert!(
            should_heal_pin(
                &broken_before.target_path,
                &broken_before.icon_path,
                &exe.to_string_lossy(),
                &cache_root.to_string_lossy(),
                Path::new(&broken_before.icon_path).exists(),
            ),
            "broken pin was not selected: target={:?} icon={:?}",
            broken_before.target_path,
            broken_before.icon_path
        );

        let healed = heal_pins_in(&[pin_dir.clone()], &exe, cache_root.as_path()).unwrap();
        if healed != 1 {
            let broken = read_shortcut(&pin_dir.join("broken.lnk")).unwrap();
            panic!(
                "healed={healed} after write; broken target={:?} icon={:?}",
                broken.target_path, broken.icon_path
            );
        }

        let broken = read_shortcut(&pin_dir.join("broken.lnk")).unwrap();
        assert!(windows_paths_equal(
            &broken.target_path,
            &exe.to_string_lossy()
        ));
        assert!(windows_paths_equal(
            &broken.icon_path,
            &exe.to_string_lossy()
        ));

        let healthy = read_shortcut(&pin_dir.join("healthy.lnk")).unwrap();
        assert!(windows_paths_equal(
            &healthy.icon_path,
            &exe.to_string_lossy()
        ));

        let other_pin = read_shortcut(&pin_dir.join("other.lnk")).unwrap();
        assert!(windows_paths_equal(
            &other_pin.target_path,
            &other.to_string_lossy()
        ));
        assert!(windows_paths_equal(
            &other_pin.icon_path,
            &missing_icon.to_string_lossy()
        ));

        let custom_pin = read_shortcut(&pin_dir.join("custom.lnk")).unwrap();
        assert!(windows_paths_equal(
            &custom_pin.icon_path,
            &custom.to_string_lossy()
        ));
    }

    /// Rehearsal vehicle: `heal_pins_in` on the runner's real User Pinned dir.
    /// Default `cargo test` skips this so we never rewrite a developer machine.
    #[cfg(windows)]
    #[test]
    #[ignore = "rehearsal: set STRAND_PIN_HEAL_DIR and STRAND_PIN_HEAL_EXE"]
    fn heals_rehearsal_user_pinned_dir() {
        let dir = std::env::var("STRAND_PIN_HEAL_DIR")
            .expect("STRAND_PIN_HEAL_DIR must point at the User Pinned directory");
        let exe = std::env::var("STRAND_PIN_HEAL_EXE")
            .expect("STRAND_PIN_HEAL_EXE must point at the installed strand.exe");
        let healed = heal_pins_in(
            &[PathBuf::from(&dir)],
            Path::new(&exe),
            &installer_cache_root(),
        )
        .expect("heal_pins_in");
        eprintln!("STRAND_PIN_HEAL healed={healed} dir={dir} exe={exe}");
    }
}
