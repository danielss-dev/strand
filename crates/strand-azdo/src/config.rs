use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use strand_azdo_protocol::{
    validate_profile, ErrorCode, ProfileConfig, ProtocolError, ServerProfile,
};
use url::Url;
use uuid::Uuid;

pub fn home_dir() -> Result<PathBuf, ProtocolError> {
    if let Some(path) = std::env::var_os("STRAND_AZDO_HOME") {
        return Ok(PathBuf::from(path));
    }
    dirs::config_dir()
        .map(|path| path.join("dev.danielss.strand").join("azdo"))
        .ok_or_else(|| {
            error(
                ErrorCode::Internal,
                "Could not determine the configuration directory",
            )
        })
}

pub fn load() -> Result<ProfileConfig, ProtocolError> {
    let path = home_dir()?.join("profiles.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let config: ProfileConfig = serde_json::from_slice(&bytes).map_err(|_| {
                error(
                    ErrorCode::InvalidResponse,
                    "Azure DevOps Server profile configuration is invalid",
                )
            })?;
            if config.schema_version != 1 {
                return Err(error(
                    ErrorCode::ServerUnsupported,
                    "Azure DevOps Server profile schema is not supported",
                ));
            }
            for profile in &config.profiles {
                validate_profile(profile)?;
            }
            Ok(config)
        }
        Err(value) if value.kind() == std::io::ErrorKind::NotFound => Ok(ProfileConfig::default()),
        Err(value) => Err(error(
            ErrorCode::Internal,
            &format!("Could not read Azure DevOps Server profiles: {value}"),
        )),
    }
}

pub fn save(config: &ProfileConfig) -> Result<(), ProtocolError> {
    let home = home_dir()?;
    fs::create_dir_all(&home).map_err(|value| {
        error(
            ErrorCode::Internal,
            &format!("Could not create the helper configuration directory: {value}"),
        )
    })?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| {
        error(
            ErrorCode::Internal,
            "Could not encode Azure DevOps Server profiles",
        )
    })?;
    let mut temp = tempfile::NamedTempFile::new_in(&home).map_err(|value| {
        error(
            ErrorCode::Internal,
            &format!("Could not prepare profile configuration: {value}"),
        )
    })?;
    temp.write_all(&bytes)
        .and_then(|_| temp.flush())
        .map_err(|value| {
            error(
                ErrorCode::Internal,
                &format!("Could not write profile configuration: {value}"),
            )
        })?;
    temp.persist(home.join("profiles.json")).map_err(|value| {
        error(
            ErrorCode::Internal,
            &format!("Could not replace profile configuration: {}", value.error),
        )
    })?;
    Ok(())
}

pub fn upsert(
    mut profile: ServerProfile,
    ca_source: Option<&Path>,
) -> Result<ServerProfile, ProtocolError> {
    validate_profile(&profile)?;
    profile.collection_url = Url::parse(&profile.collection_url)
        .map_err(|_| error(ErrorCode::Validation, "Collection URL is not valid"))?
        .to_string()
        .trim_end_matches('/')
        .to_string();
    if let Some(source) = ca_source {
        let bytes = fs::read(source).map_err(|value| {
            error(
                ErrorCode::Validation,
                &format!("Could not read the CA certificate: {value}"),
            )
        })?;
        reqwest::Certificate::from_pem(&bytes)
            .map_err(|_| error(ErrorCode::Validation, "The CA certificate is not valid PEM"))?;
        let home = home_dir()?;
        let cert_dir = home.join("certs");
        fs::create_dir_all(&cert_dir).map_err(|value| {
            error(
                ErrorCode::Internal,
                &format!("Could not create the certificate directory: {value}"),
            )
        })?;
        let name = format!("{}.pem", profile.id);
        fs::write(cert_dir.join(&name), bytes).map_err(|value| {
            error(
                ErrorCode::Internal,
                &format!("Could not import the CA certificate: {value}"),
            )
        })?;
        profile.ca_certificate = Some(name);
    }
    let mut config = load()?;
    if let Some(existing) = config
        .profiles
        .iter_mut()
        .find(|value| value.id == profile.id)
    {
        *existing = profile.clone();
    } else {
        config.profiles.push(profile.clone());
    }
    save(&config)?;
    Ok(profile)
}

pub fn remove(id: Uuid) -> Result<(), ProtocolError> {
    let mut config = load()?;
    let before = config.profiles.len();
    config.profiles.retain(|profile| profile.id != id);
    if before == config.profiles.len() {
        return Err(error(
            ErrorCode::ProfileNotFound,
            "Azure DevOps Server profile was not found",
        ));
    }
    let _ = fs::remove_file(home_dir()?.join("certs").join(format!("{id}.pem")));
    save(&config)
}

pub fn set_enabled(enabled: bool) -> Result<ProfileConfig, ProtocolError> {
    let mut config = load()?;
    config.enabled = enabled;
    save(&config)?;
    Ok(config)
}

pub fn find(id: Uuid) -> Result<ServerProfile, ProtocolError> {
    load()?
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| {
            error(
                ErrorCode::ProfileNotFound,
                "Azure DevOps Server profile was not found",
            )
        })
}

pub fn ca_path(profile: &ServerProfile) -> Result<Option<PathBuf>, ProtocolError> {
    let Some(name) = profile.ca_certificate.as_deref() else {
        return Ok(None);
    };
    if Path::new(name).components().count() != 1 {
        return Err(error(
            ErrorCode::Validation,
            "The configured CA certificate path is invalid",
        ));
    }
    Ok(Some(home_dir()?.join("certs").join(name)))
}

pub fn error(code: ErrorCode, message: &str) -> ProtocolError {
    ProtocolError {
        code,
        message: message.into(),
        status: None,
    }
}
