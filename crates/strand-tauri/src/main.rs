#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod ai;
mod commands;
mod state;

use tauri::Manager;

/// Append Rust panics to a local crash log so alpha bug reports come with
/// evidence. Local-only — nothing leaves the machine (PRD §10); opt-in
/// remote crash reporting is separate future work. The previous hook still
/// runs, so panics keep reaching stderr/tracing too.
fn install_crash_log(app: &tauri::App) {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join("crash.log");

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let when = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backtrace = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "=== panic at unix:{when} (strand {})\n{info}\n{backtrace}\n\n",
            env!("CARGO_PKG_VERSION"),
        );
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            use std::io::Write;
            let _ = f.write_all(entry.as_bytes());
        }
        previous(info);
    }));
}

fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("strand=info,strand_core=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    // Process-global git engine setup (disables git2's owner validation so it
    // opens the same repos gix already does — see strand_core::init). Must run
    // before the Tauri runtime spawns any command thread.
    strand_core::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:strand.db", state::migrations())
                .build(),
        )
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::repo_open,
            commands::repo_meta,
            commands::repo_status,
            commands::repo_snapshot,
            commands::repo_watch,
            commands::repo_unwatch,
            commands::repo_cancel_op,
            commands::repo_diff_since,
            commands::repo_diff_since_full,
            commands::repo_diff_unstaged_full,
            commands::repo_merge_base,
            commands::repo_detect_base_branch,
            commands::repo_log,
            commands::repo_search_log,
            commands::repo_refs,
            commands::repo_diff_unstaged,
            commands::repo_diff_staged,
            commands::repo_diff_between,
            commands::repo_diff_commit,
            commands::repo_diff_commit_file,
            commands::repo_diff_workdir_file,
            commands::repo_file_content,
            commands::repo_file_blob,
            commands::repo_file_history,
            commands::repo_blame,
            commands::repo_reflog,
            commands::repo_stage,
            commands::repo_unstage,
            commands::repo_stage_many,
            commands::repo_unstage_many,
            commands::repo_discard_many,
            commands::repo_discard,
            commands::repo_gitignore_add,
            commands::repo_move_path,
            commands::repo_apply_patch,
            commands::repo_commit,
            commands::repo_fetch,
            commands::repo_pull,
            commands::repo_push,
            commands::repo_clone,
            commands::repo_checkout,
            commands::repo_checkout_commit,
            commands::repo_tree,
            commands::repo_submodules,
            commands::repo_submodule_update,
            commands::repo_worktrees,
            commands::repo_worktree_add,
            commands::repo_worktree_remove,
            commands::repo_worktree_prune,
            commands::repo_worktree_health,
            commands::repo_worktree_integrate,
            commands::repo_worktree_archive,
            commands::repo_worktree_archives,
            commands::repo_worktree_archive_restore,
            commands::repo_worktree_archive_delete,
            commands::repo_worktree_lock,
            commands::repo_worktree_unlock,
            commands::repo_worktree_stats,
            commands::repo_worktree_include_patterns,
            commands::repo_worktree_copy_include,
            commands::repo_branch_create,
            commands::repo_branch_delete,
            commands::repo_branch_rename,
            commands::repo_branch_delete_remote,
            commands::repo_remote_add,
            commands::repo_remote_remove,
            commands::repo_remote_rename,
            commands::repo_remote_set_url,
            commands::repo_tag_create,
            commands::repo_tag_delete,
            commands::repo_tag_push,
            commands::repo_tag_push_all,
            commands::repo_remote_tags,
            commands::repo_cherry_pick,
            commands::repo_revert,
            commands::repo_merge,
            commands::repo_rebase,
            commands::repo_reset,
            commands::repo_abort_operation,
            commands::repo_continue_operation,
            commands::repo_rebase_todo,
            commands::repo_interactive_rebase,
            commands::repo_read_conflict_file,
            commands::repo_resolve_conflict,
            commands::repo_open_mergetool,
            commands::repo_open_in_editor,
            commands::repo_open_in_terminal,
            commands::git_global_identity,
            commands::git_set_global_identity,
            commands::workspace_file_read,
            commands::repo_stash_list,
            commands::repo_stash_save,
            commands::repo_stash_snapshot,
            commands::repo_stash_push_paths,
            commands::repo_stash_apply,
            commands::repo_stash_pop,
            commands::repo_stash_drop,
            commands::ai_provider_status,
            commands::ai_provider_login,
            commands::ai_provider_logout,
            commands::repo_suggest_commit_message,
            commands::crash_report_check,
        ])
        .setup(|app| {
            install_crash_log(app);

            // Heal stale sqlx migration checksums on an existing settings DB
            // *before* the SQL plugin's migrator runs (on the webview's first
            // `Database.load`), so an in-place migration edit can't silently
            // break session restore + settings persistence. See
            // `state::repair_migration_checksums`.
            if let Ok(db_path) = app.path().app_config_dir().map(|d| d.join("strand.db")) {
                match tauri::async_runtime::block_on(state::repair_migration_checksums(&db_path)) {
                    Ok(0) => {}
                    Ok(n) => tracing::info!("healed {n} stale migration checksum(s) in strand.db"),
                    Err(e) => tracing::warn!("migration checksum repair skipped: {e}"),
                }
            }

            if let Some(win) = app.get_webview_window("main") {
                // On Windows the native title bar would sit *above* our toolbar
                // as a redundant second bar. Drop the OS decorations so the
                // toolbar becomes the title bar (custom controls + drag region
                // live in the UI). macOS keeps its decorations — `titleBarStyle:
                // Overlay` already floats the traffic lights over the toolbar.
                // The window is created hidden (`visible: false`), so stripping
                // decorations before `show()` never flashes a frame; re-assert
                // the drop shadow that borderless windows otherwise lose.
                #[cfg(target_os = "windows")]
                {
                    let _ = win.set_decorations(false);
                    let _ = win.set_shadow(true);
                }
                let _ = win.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running strand");
}
