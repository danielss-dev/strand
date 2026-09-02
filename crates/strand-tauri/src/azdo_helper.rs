//! Lifecycle and process boundary for the optional Azure DevOps Server helper.
//! The app executes only a version-pinned binary installed under its own config
//! directory; it never resolves this helper through PATH or a repository cwd.

use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use strand_azdo_protocol::{
    resolve_remote, AuthMode, Operation, ProfileConfig, ProtocolError, RepositoryCoordinates,
    RequestEnvelope, ResponseEnvelope, ServerProfile, MAX_RESPONSE_BYTES, PROTOCOL_VERSION,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::ai::bin::base_command;

const HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
const PUBLIC_KEY: &str = concat!(
    "untrusted comment: minisign public key: 84FCBFD2A981CE5D\n",
    "RWRdzoGp0r/8hCXLC+N4EQu9wkpQH7P78mULgVR4V/u6pQyP7hcYmgFy\n"
);

type Result<T> = std::result::Result<T, String>;
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    if load_config(app).is_ok_and(|config| config.enabled) {
        let app = app.clone();
        thread::spawn(move || {
            let _ = ensure_installed_or_download(&app);
        });
    }
}

pub fn handle() -> Result<&'static AppHandle> {
    APP_HANDLE
        .get()
        .ok_or_else(|| "Azure DevOps Server helper is not initialized".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct HelperStatus {
    pub enabled: bool,
    pub installed: bool,
    pub present: bool,
    pub version: Option<String>,
    pub protocol_version: Option<u32>,
    pub profiles: Vec<ServerProfile>,
    pub authentication: Vec<ProfileAuthenticationStatus>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProfileAuthenticationStatus {
    pub profile_id: Uuid,
    pub configured: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionOutput {
    version: String,
    protocol_version: u32,
    #[serde(default)]
    #[serde(rename = "capabilities")]
    _capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperManifest {
    schema_version: u32,
    #[serde(rename = "strand_version")]
    helper_version: String,
    protocol_version: u32,
    assets: Vec<HelperAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperAsset {
    target: String,
    name: String,
    archive_sha256: String,
    binary_sha256: String,
    size: u64,
}

pub fn status(app: &AppHandle) -> HelperStatus {
    let config = load_config(app).unwrap_or_default();
    let present = helper_binary(app).is_ok_and(|path| path.is_file());
    match installed_version(app) {
        Ok(version) if version.protocol_version == PROTOCOL_VERSION => {
            let authentication = config
                .profiles
                .iter()
                .map(|profile| ProfileAuthenticationStatus {
                    profile_id: profile.id,
                    configured: profile.auth_mode == AuthMode::Windows
                        || pat_is_stored(app, profile.id),
                })
                .collect();
            HelperStatus {
                enabled: config.enabled,
                installed: true,
                present,
                version: Some(version.version),
                protocol_version: Some(version.protocol_version),
                profiles: config.profiles,
                authentication,
                error: None,
            }
        }
        Ok(version) => HelperStatus {
            enabled: config.enabled,
            installed: false,
            present,
            version: Some(version.version),
            protocol_version: Some(version.protocol_version),
            profiles: config.profiles,
            authentication: Vec::new(),
            error: Some(
                "The installed strand-azdo helper uses an incompatible protocol; retry installation"
                    .into(),
            ),
        },
        Err(error) => HelperStatus {
            enabled: config.enabled,
            installed: false,
            present,
            version: None,
            protocol_version: None,
            profiles: config.profiles,
            authentication: Vec::new(),
            error: Some(error),
        },
    }
}

fn pat_is_stored(app: &AppHandle, id: Uuid) -> bool {
    run_json(app, &["auth", "status", &id.to_string()], None)
        .ok()
        .and_then(|value| value.get("stored").and_then(Value::as_bool))
        .unwrap_or(false)
}

pub fn enable(app: &AppHandle) -> Result<HelperStatus> {
    ensure_installed(app)?;
    run_json(app, &["config", "enable"], None)?;
    Ok(status(app))
}

pub fn disable(app: &AppHandle) -> Result<HelperStatus> {
    ensure_installed(app)?;
    run_json(app, &["config", "disable"], None)?;
    Ok(status(app))
}

pub fn upsert_profile(app: &AppHandle, profile: &ServerProfile) -> Result<ServerProfile> {
    ensure_installed(app)?;
    let value = serde_json::to_vec(profile).map_err(|error| error.to_string())?;
    let output = run_json(app, &["profile", "upsert"], Some(&value))?;
    serde_json::from_value(output)
        .map_err(|error| format!("Helper returned an invalid profile: {error}"))
}

pub fn import_ca(app: &AppHandle, id: Uuid, source: &str) -> Result<ServerProfile> {
    ensure_installed(app)?;
    let output = run_json(
        app,
        &["profile", "import-ca", &id.to_string(), source],
        None,
    )?;
    serde_json::from_value(output)
        .map_err(|error| format!("Helper returned an invalid profile: {error}"))
}

pub fn remove_profile(app: &AppHandle, id: Uuid) -> Result<()> {
    ensure_installed(app)?;
    run_json(app, &["profile", "remove", &id.to_string()], None)?;
    Ok(())
}

pub fn set_pat(app: &AppHandle, id: Uuid, pat: &str) -> Result<()> {
    ensure_installed(app)?;
    run_json(app, &["auth", "set", &id.to_string()], Some(pat.as_bytes()))?;
    Ok(())
}

pub fn clear_pat(app: &AppHandle, id: Uuid) -> Result<()> {
    ensure_installed(app)?;
    run_json(app, &["auth", "clear", &id.to_string()], None)?;
    Ok(())
}

pub fn test_profile(app: &AppHandle, id: Uuid) -> Result<Value> {
    execute(app, id, Operation::TestConnection)
}

pub fn execute(app: &AppHandle, profile_id: Uuid, operation: Operation) -> Result<Value> {
    ensure_installed(app)?;
    let request_id = Uuid::new_v4().to_string();
    let request = RequestEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.clone(),
        profile_id,
        operation,
    };
    let bytes = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let output = run_json(app, &["rpc"], Some(&bytes));
    match output {
        Ok(value) => {
            let response: ResponseEnvelope = serde_json::from_value(value)
                .map_err(|error| format!("strand-azdo returned an invalid response: {error}"))?;
            validate_response(response, &request_id)
        }
        Err(message) => Err(message),
    }
}

pub fn resolve_for_remotes(
    app: &AppHandle,
    remotes: impl IntoIterator<Item = (String, String)>,
) -> Result<Option<RepositoryCoordinates>> {
    let config = load_config(app)?;
    let mut remotes = remotes.into_iter().collect::<Vec<_>>();
    remotes.sort_by_key(|(name, _)| (name != "origin", name.clone()));
    for (name, url) in remotes {
        if let Some(found) = resolve_remote(&config, &name, &url).map_err(protocol_message)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

pub fn profile(app: &AppHandle, id: Uuid) -> Result<ServerProfile> {
    load_config(app)?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "Azure DevOps Server profile was not found".into())
}

fn validate_response(response: ResponseEnvelope, request_id: &str) -> Result<Value> {
    if response.protocol_version != PROTOCOL_VERSION {
        return Err("Strand and strand-azdo protocol versions do not match".into());
    }
    if response.request_id != request_id {
        return Err("strand-azdo returned a response for a different request".into());
    }
    if let Some(error) = response.error {
        return Err(protocol_message(error));
    }
    response
        .result
        .ok_or_else(|| "strand-azdo returned no result".into())
}

fn load_config(app: &AppHandle) -> Result<ProfileConfig> {
    let path = helper_home(app)?.join("profiles.json");
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Azure DevOps Server profiles are invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProfileConfig::default()),
        Err(error) => Err(format!(
            "Could not read Azure DevOps Server profiles: {error}"
        )),
    }
}

fn ensure_installed(app: &AppHandle) -> Result<()> {
    let version = installed_version(app)?;
    if version.protocol_version != PROTOCOL_VERSION {
        return Err("The installed strand-azdo helper uses an incompatible protocol; reinstall it from Settings \u2192 Hosting".into());
    }
    Ok(())
}

fn installed_version(app: &AppHandle) -> Result<VersionOutput> {
    let output = run_json_unchecked(app, &["version"], None)?;
    serde_json::from_value(output)
        .map_err(|error| format!("Installed strand-azdo version is invalid: {error}"))
}

fn run_json(app: &AppHandle, args: &[&str], input: Option<&[u8]>) -> Result<Value> {
    ensure_binary_exists(app)?;
    run_json_unchecked(app, args, input)
}

fn run_json_unchecked(app: &AppHandle, args: &[&str], input: Option<&[u8]>) -> Result<Value> {
    let binary = helper_binary(app)?;
    run_json_at(app, &binary, args, input)
}

fn run_json_at(
    app: &AppHandle,
    binary: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Value> {
    if !binary.is_file() {
        return Err(
            "strand-azdo is not installed; enable Azure DevOps Server in Settings \u2192 Hosting".into(),
        );
    }
    let home = helper_home(app)?;
    fs::create_dir_all(&home).map_err(|error| {
        format!("Could not create the Azure DevOps Server configuration directory: {error}")
    })?;
    let mut command = base_command(binary, true);
    command
        .args(args)
        .env("STRAND_AZDO_HOME", &home)
        .current_dir(&home)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start strand-azdo: {error}"))?;
    let writer = child.stdin.take().map(|mut stdin| {
        let input = Zeroizing::new(input.unwrap_or_default().to_vec());
        thread::spawn(move || stdin.write_all(input.as_slice()))
    });
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let stdout_reader = thread::spawn(move || read_limited(&mut stdout, MAX_RESPONSE_BYTES));
    let stderr_reader = thread::spawn(move || read_limited(&mut stderr, 64 * 1024));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < HELPER_TIMEOUT => {
                thread::sleep(Duration::from_millis(10))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("strand-azdo timed out after 30 seconds".into());
            }
            Err(error) => return Err(format!("Could not wait for strand-azdo: {error}")),
        }
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let stdout = stdout_reader
        .join()
        .map_err(|_| "strand-azdo output reader failed")??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "strand-azdo error reader failed")??;
    if status.success() {
        serde_json::from_slice(&stdout)
            .map_err(|error| format!("strand-azdo returned invalid JSON: {error}"))
    } else if let Ok(error) = serde_json::from_slice::<ProtocolError>(&stderr) {
        Err(protocol_message(error))
    } else if let Ok(response) = serde_json::from_slice::<ResponseEnvelope>(&stdout) {
        Err(response
            .error
            .map(protocol_message)
            .unwrap_or_else(|| "strand-azdo failed".into()))
    } else {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        Err(if message.is_empty() {
            "strand-azdo failed without an error message".into()
        } else {
            message
        })
    }
}

fn read_limited(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("strand-azdo output exceeded its limit".into());
    }
    Ok(bytes)
}

fn protocol_message(error: ProtocolError) -> String {
    error.message
}

fn ensure_binary_exists(app: &AppHandle) -> Result<()> {
    if helper_binary(app)?.is_file() {
        Ok(())
    } else {
        Err("strand-azdo is not installed".into())
    }
}

fn helper_home(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("azdo"))
        .map_err(|error| error.to_string())
}

fn helper_binary(app: &AppHandle) -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("STRAND_AZDO_HELPER_PATH") {
        return fs::canonicalize(path)
            .map_err(|error| format!("Could not resolve STRAND_AZDO_HELPER_PATH: {error}"));
    }
    Ok(helper_home(app)?.join("bin").join(binary_name()))
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "strand-azdo.exe"
    } else {
        "strand-azdo"
    }
}

fn release_target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => Ok("universal-apple-darwin"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        _ => Err("This Strand platform does not have a strand-azdo release asset".into()),
    }
}

fn install_base_url() -> String {
    format!(
        "https://github.com/danielss-dev/strand/releases/download/strand-azdo-protocol-{PROTOCOL_VERSION}"
    )
}

fn install_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client.builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(concat!("Strand/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not initialize the helper downloader: {error}"))
}

fn ensure_installed_or_download(app: &AppHandle) -> Result<()> {
    download_and_install(app, false)
}

fn download_and_install(app: &AppHandle, force_replace: bool) -> Result<()> {
    let client = install_client()?;
    let base = install_base_url();
    let manifest_bytes = download(
        &client,
        &format!("{base}/strand-azdo-manifest.json"),
        256 * 1024,
    )?;
    let signature_bytes = download(
        &client,
        &format!("{base}/strand-azdo-manifest.json.minisig"),
        16 * 1024,
    )?;
    let public_key =
        PublicKey::decode(PUBLIC_KEY).map_err(|_| "The embedded helper signing key is invalid")?;
    let signature_text = std::str::from_utf8(&signature_bytes)
        .map_err(|_| "The helper manifest signature is invalid")?;
    let signature = Signature::decode(signature_text)
        .map_err(|_| "The helper manifest signature is invalid")?;
    public_key
        .verify(&manifest_bytes, &signature, false)
        .map_err(|_| "The helper manifest signature could not be verified")?;
    let manifest: HelperManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("The helper manifest is invalid: {error}"))?;
    if manifest.schema_version != 1
        || manifest.helper_version.trim().is_empty()
        || manifest.protocol_version != PROTOCOL_VERSION
    {
        return Err("The helper manifest does not match this protocol channel".into());
    }
    if !should_download(
        force_replace,
        installed_version(app).ok().as_ref(),
        &manifest,
    ) {
        return Ok(());
    }
    let target = release_target()?;
    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.target == target)
        .ok_or_else(|| "The helper manifest has no asset for this platform".to_string())?;
    if asset.size as usize > MAX_ARCHIVE_BYTES || asset.name.contains(['/', '\\']) {
        return Err("The helper manifest contains an unsafe asset".into());
    }
    let archive = download(
        &client,
        &format!("{base}/{}", asset.name),
        MAX_ARCHIVE_BYTES,
    )?;
    if archive.len() as u64 != asset.size || sha256(&archive) != asset.archive_sha256 {
        return Err("The downloaded helper archive failed its SHA-256 check".into());
    }
    let binary = extract_binary(&archive, &asset.name)?;
    if sha256(&binary) != asset.binary_sha256 {
        return Err("The extracted helper binary failed its SHA-256 check".into());
    }
    let destination = helper_binary(app)?;
    let parent = destination
        .parent()
        .ok_or("The helper install path has no parent")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the helper install directory: {error}"))?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".strand-azdo-");
    if cfg!(windows) {
        builder.suffix(".exe");
    }
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|error| error.to_string())?;
    temp.write_all(&binary).map_err(|error| error.to_string())?;
    temp.flush().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let staged = temp.into_temp_path();
    let output = run_json_at(app, &staged, &["version"], None)?;
    let version: VersionOutput = serde_json::from_value(output)
        .map_err(|error| format!("Downloaded strand-azdo version is invalid: {error}"))?;
    if version.version != manifest.helper_version
        || version.protocol_version != manifest.protocol_version
    {
        return Err("The downloaded helper did not report the expected version".into());
    }
    staged
        .persist(&destination)
        .map_err(|error| format!("Could not install strand-azdo: {}", error.error))?;
    Ok(())
}

fn download(client: &reqwest::blocking::Client, url: &str, limit: usize) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("Could not download strand-azdo: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download strand-azdo ({})",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("The strand-azdo download exceeded its size limit".into());
    }
    read_limited(&mut response.take((limit + 1) as u64), limit)
}

fn extract_binary(archive: &[u8], name: &str) -> Result<Vec<u8>> {
    if name.ends_with(".zip") {
        let mut archive =
            zip::ZipArchive::new(Cursor::new(archive)).map_err(|error| error.to_string())?;
        if archive.len() != 1 {
            return Err("The helper archive must contain exactly one file".into());
        }
        let mut entry = archive.by_index(0).map_err(|error| error.to_string())?;
        if entry.name() != binary_name() || entry.is_dir() || entry.is_symlink() {
            return Err("The helper archive contains an unexpected path".into());
        }
        return read_limited(&mut entry, MAX_ARCHIVE_BYTES);
    }
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| error.to_string())?;
    let mut binary = None;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path().map_err(|error| error.to_string())?;
        if path.as_ref() != Path::new(binary_name())
            || !entry.header().entry_type().is_file()
            || binary.is_some()
        {
            return Err("The helper archive contains an unexpected path".into());
        }
        binary = Some(read_limited(&mut entry, MAX_ARCHIVE_BYTES)?);
    }
    binary.ok_or_else(|| "The helper archive did not contain strand-azdo".into())
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256.digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn install(app: &AppHandle) -> Result<HelperStatus> {
    download_and_install(app, true)?;
    Ok(status(app))
}

pub fn remove_all(app: &AppHandle) -> Result<()> {
    let config = load_config(app)?;
    for profile in config.profiles {
        clear_vault_credential(profile.id)?;
    }
    remove_helper_home(&helper_home(app)?)
}

fn remove_helper_home(home: &Path) -> Result<()> {
    if home.exists() {
        fs::remove_dir_all(home)
            .map_err(|error| format!("Could not remove strand-azdo: {error}"))?;
    }
    Ok(())
}

fn helper_matches_manifest(version: Option<&VersionOutput>, manifest: &HelperManifest) -> bool {
    version.is_some_and(|version| {
        version.version == manifest.helper_version
            && version.protocol_version == manifest.protocol_version
    })
}

fn should_download(
    force_replace: bool,
    version: Option<&VersionOutput>,
    manifest: &HelperManifest,
) -> bool {
    force_replace || !helper_matches_manifest(version, manifest)
}

fn clear_vault_credential(id: Uuid) -> Result<()> {
    let entry = keyring::Entry::new("dev.danielss.strand.azdo", &id.to_string())
        .map_err(|_| "The operating-system credential vault is unavailable".to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(
            "Could not remove the personal access token from the operating-system credential vault"
                .into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{write::SimpleFileOptions, ZipWriter};

    #[test]
    fn helper_version_accepts_the_declared_capabilities_contract() {
        let version: VersionOutput = serde_json::from_value(serde_json::json!({
            "version": "0.11.0",
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": ["pull_requests", "pat"]
        }))
        .unwrap();
        assert_eq!(version.protocol_version, PROTOCOL_VERSION);
        assert_eq!(version._capabilities, ["pull_requests", "pat"]);

        let minimal: VersionOutput = serde_json::from_value(serde_json::json!({
            "version": "0.11.0",
            "protocol_version": PROTOCOL_VERSION
        }))
        .unwrap();
        assert!(minimal._capabilities.is_empty());
    }

    #[test]
    fn helper_download_uses_its_protocol_specific_signed_release() {
        assert_eq!(
            install_base_url(),
            format!(
                "https://github.com/danielss-dev/strand/releases/download/strand-azdo-protocol-{PROTOCOL_VERSION}"
            )
        );
    }

    #[test]
    fn protocol_mismatch_downloads_the_matching_channel_helper() {
        let manifest = manifest("1.2.2", PROTOCOL_VERSION);
        let mismatched = VersionOutput {
            version: "1.2.1".into(),
            protocol_version: PROTOCOL_VERSION - 1,
            _capabilities: Vec::new(),
        };

        assert!(should_download(false, Some(&mismatched), &manifest));
    }

    #[test]
    fn explicit_retry_forces_download_even_when_the_installed_helper_matches() {
        let manifest = manifest("1.2.2", PROTOCOL_VERSION);
        let installed = VersionOutput {
            version: "1.2.2".into(),
            protocol_version: PROTOCOL_VERSION,
            _capabilities: Vec::new(),
        };

        assert!(!should_download(false, Some(&installed), &manifest));
        assert!(should_download(true, Some(&installed), &manifest));
    }

    #[test]
    fn removal_does_not_execute_a_protocol_mismatched_binary() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::write(bin.join(binary_name()), b"broken protocol-mismatched helper").unwrap();
        fs::write(
            root.path().join("profiles.json"),
            b"profiles survive until remove",
        )
        .unwrap();

        remove_helper_home(root.path()).unwrap();

        assert!(!root.path().exists());
    }

    fn manifest(helper_version: &str, protocol_version: u32) -> HelperManifest {
        HelperManifest {
            schema_version: 1,
            helper_version: helper_version.into(),
            protocol_version,
            assets: Vec::new(),
        }
    }

    #[test]
    fn zip_extraction_accepts_only_the_expected_regular_binary() {
        let archive = zip_with(|writer| {
            writer
                .start_file(binary_name(), SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"verified helper").unwrap();
        });
        assert_eq!(
            extract_binary(&archive, "helper.zip").unwrap(),
            b"verified helper"
        );

        let traversal = zip_with(|writer| {
            writer
                .start_file("../strand-azdo", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"bad").unwrap();
        });
        assert!(extract_binary(&traversal, "helper.zip").is_err());

        let symlink = zip_with(|writer| {
            writer
                .add_symlink(binary_name(), "elsewhere", SimpleFileOptions::default())
                .unwrap();
        });
        assert!(extract_binary(&symlink, "helper.zip").is_err());
    }

    fn zip_with(write: impl FnOnce(&mut ZipWriter<Cursor<Vec<u8>>>)) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        write(&mut writer);
        writer.finish().unwrap().into_inner()
    }
}
