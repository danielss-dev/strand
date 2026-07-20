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
    pub ops: Mutex<HashMap<String, OperationCancelHandle>>,
    /// Live embedded PTYs. Their ownership is process-wide so switching views,
    /// repositories, or workspaces never tears down a shell.
    pub terminals: crate::terminal::TerminalManager,
}

#[derive(Clone)]
pub enum OperationCancelHandle {
    Network(CancelHandle),
    Ai(crate::ai::bin::AiCancelHandle),
}

impl OperationCancelHandle {
    pub fn cancel(&self) {
        match self {
            Self::Network(handle) => handle.cancel(),
            Self::Ai(handle) => handle.cancel(),
        }
    }
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

/// Heal stale sqlx migration checksums on a pre-existing `strand.db`.
///
/// sqlx records a SHA-384 checksum of each migration's SQL text in
/// `_sqlx_migrations` and refuses to open a DB whose recorded checksum no
/// longer matches the binary's migration SQL ("migration N was previously
/// applied but has been modified"). A whitespace-only reindent of migration 1
/// (commit `3e1f0bb`) changed that checksum, so every DB created before it —
/// including public 0.x installs — fails to open, which **silently disables
/// session restore and all SQLite-backed settings persistence** (the frontend
/// catches the load error and falls back to defaults).
///
/// Reverting the SQL can't fix it (it would just break the opposite cohort —
/// DBs created with the newer string). Instead we heal at runtime: every
/// migration is an idempotent `CREATE ... IF NOT EXISTS`, so the applied schema
/// is identical regardless of the SQL text's whitespace. We recompute each
/// migration's checksum exactly as sqlx does (SHA-384 of the SQL bytes) and
/// rewrite any stale row, so the migrator sees a match and proceeds without
/// re-running anything and without touching user data.
///
/// Runs before the SQL plugin's migrator (Tauri `setup`, before the webview's
/// first `Database.load`). Best-effort: a fresh DB (no `_sqlx_migrations` table
/// yet) is a no-op; errors are returned for the caller to log, never fatal.
pub async fn repair_migration_checksums(db_path: &std::path::Path) -> Result<u64, String> {
    use sha2::{Digest, Sha384};

    if !db_path.exists() {
        return Ok(0);
    }
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| e.to_string())?;

    // Nothing to repair until the migrator has created its bookkeeping table.
    let has_table: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(&pool)
    .await
    .map_err(|e| e.to_string())?;
    if has_table.is_none() {
        pool.close().await;
        return Ok(0);
    }

    let mut healed = 0u64;
    for m in migrations() {
        let checksum = Sha384::digest(m.sql.as_bytes()).to_vec();
        let res = sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND checksum != ?",
        )
        .bind(checksum.clone())
        .bind(m.version)
        .bind(checksum)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
        healed += res.rows_affected();
    }
    pool.close().await;
    Ok(healed)
}
