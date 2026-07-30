#[cfg(target_os = "windows")]
const STRAND_STORE_URI: &str = "ms-windows-store://pdp/?ProductId=9N0JG96LRC4W";

#[cfg(target_os = "windows")]
pub fn update_available() -> Result<bool, String> {
    use windows::Services::Store::StoreContext;

    let context = StoreContext::GetDefault()
        .map_err(|error| format!("Could not connect to Microsoft Store: {error}"))?;
    let updates = context
        .GetAppAndOptionalStorePackageUpdatesAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Could not check Microsoft Store updates: {error}"))?;

    updates
        .Size()
        .map(|count| count > 0)
        .map_err(|error| format!("Could not read Microsoft Store updates: {error}"))
}

#[cfg(not(target_os = "windows"))]
pub fn update_available() -> Result<bool, String> {
    Err("Microsoft Store updates are only available on Windows".into())
}

#[cfg(target_os = "windows")]
pub fn open_product() -> Result<(), String> {
    use windows::Foundation::Uri;
    use windows::System::Launcher;

    let uri = Uri::CreateUri(&STRAND_STORE_URI.into())
        .map_err(|error| format!("Could not prepare Microsoft Store link: {error}"))?;
    let launched = Launcher::LaunchUriAsync(&uri)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Could not open Microsoft Store: {error}"))?;

    if launched {
        Ok(())
    } else {
        Err("Windows could not open Microsoft Store".into())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn open_product() -> Result<(), String> {
    Err("Microsoft Store is only available on Windows".into())
}
