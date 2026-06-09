use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

use strand_core::{network::CancelHandle, watch::RepoWatcher};
use tauri_plugin_sql::{Migration, MigrationKind};

/// Process-wide app state.
///
/// `gix::Repository` is `!Sync` (it holds `RefCell`s internally), so we
/// don't cache opened repos here — commands re-discover from the path on
/// each call. gix open is cheap; we'll cache later if a hot path needs it.
/// What we *do* track is which paths the frontend currently considers
/// "open" so the SQL `recent_repos` table can be kept in sync.
#[derive(Default)]
pub struct AppState {
    pub open_paths: Mutex<HashSet<String>>,
    /// One live working-tree watcher per open repo path; dropping an entry
    /// stops the watcher.
    pub watchers: Mutex<HashMap<String, RepoWatcher>>,
    /// In-flight cancellable ops (clone/fetch/pull/push), keyed by the
    /// frontend-generated op id.
    pub ops: Mutex<HashMap<String, CancelHandle>>,
}

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: r#"
                CREATE TABLE IF NOT EXISTS recent_repos (
                    path        TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    last_opened INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "commit message history",
            sql: r#"
                CREATE TABLE IF NOT EXISTS commit_messages (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_path    TEXT NOT NULL,
                    subject      TEXT NOT NULL,
                    body         TEXT NOT NULL DEFAULT '',
                    committed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_commit_messages_repo
                    ON commit_messages (repo_path, committed_at DESC);
            "#,
            kind: MigrationKind::Up,
        },
    ]
}
