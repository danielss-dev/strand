//! Shared read allowlist. No operation here mutates Git state or fetches objects.
//! Local desktop hot paths can keep calling typed functions without serializing.
pub mod protocol;
pub mod remote;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use strand_core::{
    diff::FileDiff,
    file::{FileChunk, FileContent, FileHistoryEntry},
    log::Commit,
    repo::RepoMeta,
    snapshot::Snapshot,
    status::FileStatus,
    Repo,
};

pub const SCHEMA_VERSION: u32 = 1;
pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_LOG: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OpError {
    pub code: String,
    pub message: String,
}
impl OpError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<strand_core::Error> for OpError {
    fn from(e: strand_core::Error) -> Self {
        Self::new("repository", e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, OpError>;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DiffSource {
    Unstaged {
        full_context: bool,
    },
    Staged {},
    Commit {
        revision: String,
    },
    Between {
        from: String,
        to: String,
    },
    Since {
        revision: String,
        full_context: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReadOp {
    Meta {},
    Status {},
    Snapshot {},
    Log {
        limit: usize,
        head_only: bool,
    },
    FileHistory {
        path: String,
        limit: usize,
    },
    Diff {
        source: DiffSource,
    },
    Review {
        since: String,
        limit: usize,
    },
    File {
        path: String,
        revision: Option<String>,
    },
    FileChunk {
        path: String,
        offset: u64,
        length: usize,
        version: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub repository: String,
    pub op: ReadOp,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Review {
    pub base: String,
    /// HEAD before and after the bundle allow consumers to detect intervening
    /// commits. Working-tree reads, like the desktop snapshot, are not atomic.
    pub head_before: Option<String>,
    pub head_after: Option<String>,
    pub diffs: Vec<FileDiff>,
    pub log: Vec<Commit>,
    pub status: Vec<FileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ReadResult {
    Meta(RepoMeta),
    Status(Vec<FileStatus>),
    Snapshot(Snapshot),
    Log(Vec<Commit>),
    FileHistory(Vec<FileHistoryEntry>),
    Diff(Vec<FileDiff>),
    Review(Review),
    File(FileContent),
    FileChunk(FileChunk),
}

impl ReadOp {
    pub fn accepts(&self, result: &ReadResult) -> bool {
        matches!(
            (self, result),
            (Self::Meta {}, ReadResult::Meta(_))
                | (Self::Status {}, ReadResult::Status(_))
                | (Self::Snapshot {}, ReadResult::Snapshot(_))
                | (Self::Log { .. }, ReadResult::Log(_))
                | (Self::FileHistory { .. }, ReadResult::FileHistory(_))
                | (Self::Diff { .. }, ReadResult::Diff(_))
                | (Self::Review { .. }, ReadResult::Review(_))
                | (Self::File { .. }, ReadResult::File(_))
                | (Self::FileChunk { .. }, ReadResult::FileChunk(_))
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub schema_version: u32,
    /// Canonical path on the executing machine. SSH clients attach their host
    /// identity outside this value, never reinterpret it as a local path.
    pub repository: String,
    pub result: ReadResult,
}

// Preserve core's error type on the direct local path (see strand-core's
// result_large_err rationale); serialization belongs only to wire consumers.
#[allow(clippy::result_large_err)]
pub fn meta(path: &str) -> strand_core::Result<RepoMeta> {
    Repo::discover(path)?.meta()
}
#[allow(clippy::result_large_err)]
pub fn status(path: &str) -> strand_core::Result<Vec<FileStatus>> {
    Repo::discover(path)?.status()
}
#[allow(clippy::result_large_err)]
pub fn snapshot(path: &str) -> strand_core::Result<Snapshot> {
    Repo::discover(path)?.snapshot()
}

pub fn execute(request: &ReadRequest) -> Result<Envelope> {
    if request.repository.starts_with("ssh://") {
        return Err(OpError::new(
            "invalid_request",
            "The engine requires a filesystem path on its own machine.",
        ));
    }
    let absolute = std::fs::canonicalize(&request.repository)
        .map_err(|error| OpError::new("repository", error.to_string()))?;
    let repo = Repo::discover(absolute)?;
    let limit = |n: usize| {
        if (1..=MAX_LOG).contains(&n) {
            Ok(n)
        } else {
            Err(OpError::new(
                "invalid_request",
                "Log limit must be between 1 and 1000.",
            ))
        }
    };
    let result = match &request.op {
        ReadOp::Meta {} => ReadResult::Meta(repo.meta()?),
        ReadOp::Status {} => ReadResult::Status(repo.status()?),
        ReadOp::Snapshot {} => ReadResult::Snapshot(repo.snapshot()?),
        ReadOp::Log {
            limit: n,
            head_only,
        } => ReadResult::Log(if *head_only {
            repo.log_head(limit(*n)?)?
        } else {
            repo.log(limit(*n)?)?
        }),
        ReadOp::FileHistory { path, limit: n } => {
            relative_path(path)?;
            ReadResult::FileHistory(repo.file_history(path, limit(*n)?)?)
        }
        ReadOp::Diff { source } => ReadResult::Diff(match source {
            DiffSource::Unstaged { full_context: true } => repo.diff_unstaged_full()?,
            DiffSource::Unstaged {
                full_context: false,
            } => repo.diff_unstaged()?,
            DiffSource::Staged {} => repo.diff_staged()?,
            DiffSource::Commit { revision } => repo.diff_commit(revision)?,
            DiffSource::Between { from, to } => repo.diff_between(from, to)?,
            DiffSource::Since {
                revision,
                full_context: true,
            } => repo.diff_since_full(revision)?,
            DiffSource::Since {
                revision,
                full_context: false,
            } => repo.diff_since(revision)?,
        }),
        ReadOp::Review { since, limit: n } => {
            let n = limit(*n)?;
            // Freeze a mutable base ref to an OID before building the payload.
            let base = repo.merge_base(since, since)?;
            let before = repo.meta()?.head_oid;
            let diffs = repo.diff_since_full(&base)?;
            let log = repo.log_head(n)?;
            let status = repo.status()?;
            ReadResult::Review(Review {
                base,
                head_before: before,
                head_after: repo.meta()?.head_oid,
                diffs,
                log,
                status,
            })
        }
        ReadOp::File { path, revision } => {
            relative_path(path)?;
            ReadResult::File(repo.file_content(path, revision.as_deref())?)
        }
        ReadOp::FileChunk {
            path,
            offset,
            length,
            version,
        } => {
            relative_path(path)?;
            ReadResult::FileChunk(repo.file_chunk(path, *offset, *length, version.as_deref())?)
        }
    };
    Ok(Envelope {
        schema_version: SCHEMA_VERSION,
        repository: repo.path().to_string_lossy().into_owned(),
        result,
    })
}

pub fn relative_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains(['\\', '\0', ':'])
        || path.starts_with('/')
        || path
            .split('/')
            .any(|p| p == ".." || p == "." || p.is_empty())
    {
        return Err(OpError::new(
            "invalid_request",
            "File paths must be repository-relative with no traversal.",
        ));
    }
    Ok(())
}

/// Never use read_line: a peer can omit the newline and grow it indefinitely.
pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated frame",
                ))
            };
        }
        let newline = bytes.iter().position(|&b| b == b'\n');
        let n = newline.map_or(bytes.len(), |n| n + 1);
        if frame.len() + n > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame exceeds 8 MiB",
            ));
        }
        frame.extend_from_slice(&bytes[..n]);
        reader.consume(n);
        if newline.is_some() {
            return Ok(Some(frame));
        }
    }
}

struct BoundedBuffer(Vec<u8>);
impl Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len() + bytes.len() >= MAX_FRAME_BYTES {
            return Err(io::Error::other("result exceeds 8 MiB; narrow the request"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut buffer = BoundedBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, value)
        .map_err(|e| OpError::new("output_limit", e.to_string()))?;
    buffer.0.push(b'\n');
    Ok(buffer.0)
}

pub fn schema() -> serde_json::Value {
    serde_json::json!({ "schemaVersion": SCHEMA_VERSION, "output": schemars::schema_for!(Envelope), "request": schemars::schema_for!(ReadRequest), "error": schemars::schema_for!(OpError) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_frames_reject_partial_and_oversized_input() {
        assert!(read_frame(&mut &b"{}"[..]).is_err());
        assert_eq!(read_frame(&mut &b"{}\n"[..]).unwrap().unwrap(), b"{}\n");
        assert!(read_frame(&mut vec![b'x'; MAX_FRAME_BYTES + 1].as_slice()).is_err());
        assert!(encode(&"x".repeat(MAX_FRAME_BYTES)).is_err());
    }
    #[test]
    fn read_allowlist_is_strict() {
        for kind in ["commit", "fetch", "push", "stage", "run", "clone"] {
            assert!(serde_json::from_value::<ReadOp>(serde_json::json!({"kind": kind})).is_err());
        }
        assert!(serde_json::from_str::<ReadOp>(r#"{"kind":"status","command":"push"}"#).is_err());
        for path in ["../secret", "/etc/passwd", "C:/secret", "a\\b", "a/../b"] {
            assert!(relative_path(path).is_err());
        }
    }
}
