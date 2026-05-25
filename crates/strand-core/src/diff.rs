use serde::{Deserialize, Serialize};

/// Diff types shared with the frontend.
///
/// `Repo::diff` is intentionally not implemented yet — the rendering side
/// (`@pierre/diffs`) will dictate the exact shape we want here, and we'd
/// rather build the type to fit the consumer than the producer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub adds: u32,
    pub dels: u32,
    pub hunks: Vec<Hunk>,
}
