use crate::{OpError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteIdentity {
    pub host: String,
    pub path: String,
}

impl RemoteIdentity {
    pub fn parse(address: &str) -> Result<Self> {
        let invalid = || {
            OpError::new("invalid_request", "Use ssh://HOST-ALIAS/absolute/repository/path; configure users and ports in OpenSSH config.")
        };
        let raw = address.strip_prefix("ssh://").ok_or_else(invalid)?;
        let (host, path) = raw.split_once('/').ok_or_else(invalid)?;
        if host.len() > 253
            || !host
                .bytes()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric())
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            || path.contains(['?', '#'])
        {
            return Err(invalid());
        }
        let path = percent_encoding::percent_decode_str(path)
            .decode_utf8()
            .map_err(|_| invalid())?;
        if path.len() > 4096
            || path.chars().any(|c| c.is_control() || c == '\\')
            || path.split('/').any(|c| c == "." || c == "..")
        {
            return Err(invalid());
        }
        Ok(Self {
            host: host.to_ascii_lowercase(),
            path: format!("/{}", path.trim_end_matches('/')),
        })
    }
    pub fn address(&self) -> String {
        let path = self
            .path
            .split('/')
            .map(|part| {
                percent_encoding::utf8_percent_encode(part, percent_encoding::NON_ALPHANUMERIC)
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("/");
        format!("ssh://{}{path}", self.host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_preserves_host_and_encoded_absolute_path() {
        let id = RemoteIdentity::parse("ssh://DevBox/home/me/space%20name").unwrap();
        assert_eq!(id.path, "/home/me/space name");
        assert_eq!(id.address(), "ssh://devbox/home/me/space%20name");
        let percent = RemoteIdentity::parse("ssh://host/space%2520name").unwrap();
        assert_eq!(RemoteIdentity::parse(&percent.address()).unwrap(), percent);
        for bad in [
            "/local",
            "ssh://-oProxyCommand=bad/repo",
            "ssh://me@host/repo",
            "ssh://host:22/repo",
            "ssh://host/a/../b",
            "ssh://host/%2e%2e/b",
            "ssh://host/repo?x",
            "ssh://host/repo%00",
        ] {
            assert!(RemoteIdentity::parse(bad).is_err(), "{bad}");
        }
    }
}
