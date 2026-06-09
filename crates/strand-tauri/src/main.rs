#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod commands;
mod state;

use tauri::Manager;

fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("strand=info,strand_core=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
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
            commands::repo_log,
            commands::repo_refs,
            commands::repo_diff_unstaged,
            commands::repo_diff_staged,
            commands::repo_diff_between,
            commands::repo_diff_commit,
            commands::repo_diff_commit_file,
            commands::repo_diff_workdir_file,
            commands::repo_file_content,
            commands::repo_file_history,
            commands::repo_blame,
            commands::repo_reflog,
            commands::repo_stage,
            commands::repo_unstage,
            commands::repo_stage_many,
            commands::repo_unstage_many,
            commands::repo_discard_many,
            commands::repo_discard,
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
            commands::repo_branch_create,
            commands::repo_branch_delete,
            commands::repo_tag_create,
            commands::repo_tag_delete,
            commands::repo_tag_push,
            commands::repo_tag_push_all,
            commands::repo_remote_tags,
            commands::repo_cherry_pick,
            commands::repo_revert,
            commands::repo_merge,
            commands::repo_rebase,
            commands::repo_abort_operation,
            commands::repo_read_conflict_file,
            commands::repo_resolve_conflict,
            commands::repo_stash_list,
            commands::repo_stash_save,
            commands::repo_stash_snapshot,
            commands::repo_stash_apply,
            commands::repo_stash_pop,
            commands::repo_stash_drop,
        ])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running strand");
}
