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
        }
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
