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
    resolve_remote, Operation, ProfileConfig, ProtocolError, RepositoryCoordinates,
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
    pub version: Option<String>,
    pub protocol_version: Option<u32>,
    pub profiles: Vec<ServerProfile>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionOutput {
    version: String,
    protocol_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperManifest {
    schema_version: u32,
    strand_version: String,
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
    match installed_version(app) {
        Ok(version)
            if version.version == env!("CARGO_PKG_VERSION")
                && version.protocol_version == PROTOCOL_VERSION =>
        {
            HelperStatus {
                enabled: config.enabled,
                installed: true,
                version: Some(version.version),
                protocol_version: Some(version.protocol_version),
                profiles: config.profiles,
                error: None,
            }
        }
        Ok(version) => HelperStatus {
            enabled: config.enabled,
            installed: false,
            version: Some(version.version),
            protocol_version: Some(version.protocol_version),
            profiles: config.profiles,
            error: Some(
                "The installed strand-azdo helper does not match this Strand release; retry installation"
                    .into(),
            ),
        },
        Err(error) => HelperStatus {
            enabled: config.enabled,
            installed: false,
            version: None,
            protocol_version: None,
            profiles: config.profiles,
            error: Some(error),
        },
    }
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
    if version.version != env!("CARGO_PKG_VERSION") || version.protocol_version != PROTOCOL_VERSION
    {
        return Err("The installed strand-azdo helper does not match this Strand release; reinstall it from Settings → Hosting".into());
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
            "strand-azdo is not installed; enable Azure DevOps Server in Settings → Hosting".into(),
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
    Ok(helper_home(app)?
        .join("bin")
        .join(env!("CARGO_PKG_VERSION"))
        .join(binary_name()))
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
        "https://github.com/danielss-dev/strand/releases/download/v{}",
        env!("CARGO_PKG_VERSION")
    )
}

fn install_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(concat!("Strand/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not initialize the helper downloader: {error}"))
}

fn ensure_installed_or_download(app: &AppHandle) -> Result<()> {
    if installed_version(app).is_ok_and(|value| {
        value.version == env!("CARGO_PKG_VERSION") && value.protocol_version == PROTOCOL_VERSION
    }) {
        return Ok(());
    }
    download_and_install(app)
}

fn download_and_install(app: &AppHandle) -> Result<()> {
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
        || manifest.strand_version != env!("CARGO_PKG_VERSION")
        || manifest.protocol_version != PROTOCOL_VERSION
    {
        return Err("The helper manifest does not match this Strand release".into());
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
    if version.version != env!("CARGO_PKG_VERSION") || version.protocol_version != PROTOCOL_VERSION
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
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn install(app: &AppHandle) -> Result<HelperStatus> {
    ensure_installed_or_download(app)?;
    Ok(status(app))
}

pub fn remove_all(app: &AppHandle) -> Result<()> {
    let config = load_config(app)?;
    if !config.profiles.is_empty() {
        ensure_installed(app).map_err(|_| {
            "Reinstall the matching strand-azdo helper before removing profiles so Strand can delete their vault credentials".to_string()
        })?;
        for profile in config.profiles {
            clear_pat(app, profile.id)?;
        }
    }
    let home = helper_home(app)?;
    if home.exists() {
        fs::remove_dir_all(home)
            .map_err(|error| format!("Could not remove strand-azdo: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::{write::SimpleFileOptions, ZipWriter};

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
