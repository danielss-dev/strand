use keyring::Entry;
use strand_azdo_protocol::{ErrorCode, ProtocolError};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::config::error;

const SERVICE: &str = "dev.danielss.strand.azdo";

trait CredentialStore {
    fn set(&self, id: Uuid, value: &str) -> Result<(), ProtocolError>;
    fn get(&self, id: Uuid) -> Result<String, ProtocolError>;
    fn clear(&self, id: Uuid) -> Result<(), ProtocolError>;
}

struct NativeStore;

impl NativeStore {
    fn entry(id: Uuid) -> Result<Entry, ProtocolError> {
        Entry::new(SERVICE, &id.to_string()).map_err(|_| {
            error(
                ErrorCode::CredentialStore,
                "The operating-system credential vault is unavailable",
            )
        })
    }
}

impl CredentialStore for NativeStore {
    fn set(&self, id: Uuid, value: &str) -> Result<(), ProtocolError> {
        Self::entry(id)?.set_password(value).map_err(|_| {
            error(
                ErrorCode::CredentialStore,
                "Could not save the personal access token in the operating-system credential vault",
            )
        })
    }

    fn get(&self, id: Uuid) -> Result<String, ProtocolError> {
        Self::entry(id)?.get_password().map_err(|_| {
            error(
                ErrorCode::AuthRequired,
                "No personal access token is stored for this profile",
            )
        })
    }

    fn clear(&self, id: Uuid) -> Result<(), ProtocolError> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(error(
                ErrorCode::CredentialStore,
                "Could not remove the personal access token from the operating-system credential vault",
            )),
        }
    }
}

fn set_with(
    store: &impl CredentialStore,
    id: Uuid,
    value: Zeroizing<String>,
) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(error(
            ErrorCode::Validation,
            "The personal access token is empty",
        ));
    }
    if value.len() > 4096 {
        return Err(error(
            ErrorCode::Validation,
            "The personal access token exceeds 4096 characters",
        ));
    }
    store.set(id, &value)
}

fn get_with(store: &impl CredentialStore, id: Uuid) -> Result<Zeroizing<String>, ProtocolError> {
    store.get(id).map(Zeroizing::new)
}

pub fn set(id: Uuid, value: Zeroizing<String>) -> Result<(), ProtocolError> {
    set_with(&NativeStore, id, value)
}

pub fn get(id: Uuid) -> Result<Zeroizing<String>, ProtocolError> {
    get_with(&NativeStore, id)
}

pub fn clear(id: Uuid) -> Result<(), ProtocolError> {
    NativeStore.clear(id)
}

pub fn exists(id: Uuid) -> bool {
    get(id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<Uuid, String>>);

    impl CredentialStore for MemoryStore {
        fn set(&self, id: Uuid, value: &str) -> Result<(), ProtocolError> {
            self.0.lock().unwrap().insert(id, value.into());
            Ok(())
        }

        fn get(&self, id: Uuid) -> Result<String, ProtocolError> {
            self.0
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or_else(|| error(ErrorCode::AuthRequired, "missing"))
        }

        fn clear(&self, id: Uuid) -> Result<(), ProtocolError> {
            self.0.lock().unwrap().remove(&id);
            Ok(())
        }
    }

    #[test]
    fn credential_contract_stores_reads_and_clears_without_plaintext_fallback() {
        let store = MemoryStore::default();
        let id = Uuid::new_v4();
        assert_eq!(
            set_with(&store, id, Zeroizing::new(String::new()))
                .unwrap_err()
                .code,
            ErrorCode::Validation
        );
        set_with(&store, id, Zeroizing::new("secret".into())).unwrap();
        assert_eq!(get_with(&store, id).unwrap().as_str(), "secret");
        store.clear(id).unwrap();
        assert_eq!(
            get_with(&store, id).unwrap_err().code,
            ErrorCode::AuthRequired
        );
    }
}
