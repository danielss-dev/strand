//! JSON-RPC 2.0 frames. Unknown envelope/parameter fields fail closed.
use crate::{OpError, MAX_FRAME_BYTES, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Value,
}
impl Request {
    pub fn new(id: u64, method: &str, params: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    pub data: OpError,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_result"
    )]
    pub result: Option<Value>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_error"
    )]
    pub error: Option<RpcError>,
}
// JSON-RPC permits a null result. Option's default deserializer loses the
// distinction between an absent field and a successful `result: null`.
fn present_result<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}
fn present_error<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<RpcError>, D::Error> {
    RpcError::deserialize(d).map(Some)
}
impl Response {
    pub fn result(id: u64, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }
    pub fn error(id: u64, error: OpError) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(RpcError {
                code: if error.code == "invalid_request" {
                    -32602
                } else {
                    -32000
                },
                message: error.message.clone(),
                data: error,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Changed {
    pub repository: String,
    pub files_changed: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Changed,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Frame {
    Response(Response),
    Notification(Notification),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloRequest {
    pub protocol_version: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub protocol_version: u32,
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub read_only: bool,
    pub watch: bool,
    pub file_chunks: bool,
    pub max_frame_bytes: usize,
}
impl Default for Hello {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            schema_version: crate::SCHEMA_VERSION,
            version: env!("CARGO_PKG_VERSION").into(),
            platform: std::env::consts::OS.into(),
            read_only: true,
            watch: true,
            file_chunks: true,
            max_frame_bytes: MAX_FRAME_BYTES,
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryRequest {
    pub repository: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    pub id: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_result_is_present_but_null_error_is_invalid() {
        let encoded = crate::encode(&Response::result(1, Value::Null)).unwrap();
        let response: Response = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(response.result, Some(Value::Null));
        assert!(response.error.is_none());
        assert!(
            serde_json::from_str::<Response>(r#"{"jsonrpc":"2.0","id":1,"error":null}"#).is_err()
        );
    }
}
