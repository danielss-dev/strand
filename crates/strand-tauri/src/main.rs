#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod ai;
mod azdo_helper;
mod commands;
mod hosting;
mod heroi;
mod microsoft_store;
mod path_env;
mod pull_requests;
mod state;
mod terminal;

use tauri::Manager;

#[cfg(target_os = "windows")]
fn apply_windows_taskbar_icon() -> windows::core::Result<bool> {
    use windows::{
        core::{BOOL, PCWSTR},
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                EnumWindows, GetSystemMetrics, GetWindowThreadProcessId, IsWindowVisible,
                LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_SHARED, SM_CXICON,
                SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
            },
        },
    };

    unsafe extern "system" fn find_visible_process_window(hwnd: HWND, state: LPARAM) -> BOOL {
        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
            if process_id == std::process::id() && IsWindowVisible(hwnd).as_bool() {
                *(state.0 as *mut HWND) = hwnd;
            }
        }
        true.into()
    }

    // tauri-winres embeds icon.ico as resource 32512. Load shared handles from
    // the running module so Windows owns their lifetime for the whole process.
    const APP_ICON_RESOURCE_ID: usize = 32512;
    unsafe {
        let mut hwnd = HWND::default();
        EnumWindows(
            Some(find_visible_process_window),
            LPARAM((&mut hwnd as *mut HWND) as isize),
        )?;
        if hwnd.0.is_null() {
            return Ok(false);
        }
        let module = GetModuleHandleW(None)?;
        let instance = HINSTANCE(module.0);
        let resource = PCWSTR(APP_ICON_RESOURCE_ID as *const u16);
        let big = LoadImageW(
            Some(instance),
            resource,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXICON),
            GetSystemMetrics(SM_CYICON),
            LR_SHARED,
        )?;
        let small = LoadImageW(
            Some(instance),
            resource,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
            LR_SHARED,
        )?;
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(big.0 as isize)),
        );
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_SMALL as usize)),
            Some(LPARAM(small.0 as isize)),
        );
    }
    Ok(true)
}

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

    // GUI launchers commonly omit the user's shell PATH. Resolve it in the
    // background so provider and AI CLIs are ready without delaying the first
    // window; child commands receive it explicitly (see `path_env`).
    path_env::warm_up();

    // Process-global git engine setup (disables git2's owner validation so it
    // opens the same repos gix already does — see strand_core::init). Must run
    // before the Tauri runtime spawns any command thread.
    strand_core::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            commands::microsoft_store_update_available,
            commands::microsoft_store_open_product,
            commands::repo_terminal_create,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::repo_terminal_close_all,
            commands::repo_terminal_count,
            commands::terminal_shell_check,
            commands::terminal_wsl_distributions,
            commands::repo_init,
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
            commands::repo_commit_signature,
            commands::repo_commit_export_patch,
            commands::repo_refs,
            commands::azdo_helper_status,
            commands::hosting_connection_status,
            commands::azdo_helper_enable,
            commands::azdo_helper_disable,
            commands::azdo_helper_remove,
            commands::azdo_profile_upsert,
            commands::azdo_profile_import_ca,
            commands::azdo_profile_remove,
            commands::azdo_profile_set_pat,
            commands::azdo_profile_clear_pat,
            commands::azdo_profile_test,
            commands::repo_pull_requests,
            commands::repo_pull_request_for_branch,
            commands::repo_pull_request_create,
            commands::repo_pull_request_activity,
            commands::repo_pull_request,
            commands::repo_pull_request_diff,
            commands::repo_pull_request_comment,
            commands::repo_pull_request_inline_comment,
            commands::repo_pull_request_submit_review,
            commands::repo_pull_request_update_review,
            commands::repo_pull_request_dismiss_review,
            commands::repo_pull_request_thread_reply,
            commands::repo_pull_request_thread_resolve,
            commands::repo_pull_request_merge,
            commands::repo_pull_request_ready,
            commands::repo_pull_request_lifecycle,
            commands::repo_pull_request_update_branch,
            commands::repo_pull_request_prepare_checkout,
            commands::repo_diff_unstaged,
            commands::repo_diff_unstaged_paths,
            commands::repo_diff_staged,
            commands::repo_diff_between,
            commands::repo_diff_commit,
            commands::repo_diff_commit_file,
            commands::repo_diff_workdir_file,
            commands::repo_file_content,
            commands::repo_file_write,
            commands::repo_file_blob,
            commands::repo_file_history,
            commands::repo_blame,
            commands::repo_file_create,
            commands::repo_file_delete,
            commands::repo_file_absolute_paths,
            commands::repo_file_reveal,
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
            commands::repo_branch_push,
            commands::repo_branch_fetch,
            commands::repo_branch_pull,
            commands::repo_clone,
            commands::repo_checkout,
            commands::repo_checkout_commit,
            commands::repo_tree,
            commands::repo_tree_ignored_children,
            commands::repo_tree_at,
            commands::repo_submodules,
            commands::repo_submodule_update,
            commands::repo_submodule_children,
            commands::repo_submodule_action,
            commands::repo_worktrees,
            commands::repo_worktree_add,
            commands::repo_worktree_remove,
            commands::repo_worktree_move,
            commands::repo_worktree_prune,
            commands::repo_worktree_repair,
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
            commands::repo_branch_delete_at,
            commands::repo_branch_rename,
            commands::repo_branch_set_upstream,
            commands::repo_branch_delete_remote,
            commands::repo_remote_add,
            commands::repo_remote_remove,
            commands::repo_remote_rename,
            commands::repo_remote_set_urls,
            commands::repo_remote_set_default,
            commands::repo_maintenance,
            commands::repo_lfs_action,
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
            commands::repo_tag_verify,
            commands::repo_signing_settings,
            commands::repo_set_signing_config,
            commands::repo_identity,
            commands::repo_set_identity,
            commands::git_global_identity,
            commands::git_set_global_identity,
            commands::workspace_file_read,
            commands::repo_stash_list,
            commands::repo_stash_save,
            commands::repo_stash_snapshot,
            commands::repo_stash_push_paths,
            commands::repo_stash_apply,
            commands::repo_stash_pop,
            commands::repo_stash_branch,
            commands::repo_stash_drop,
            commands::ai_provider_status,
            commands::ai_provider_login,
            commands::ai_provider_logout,
            commands::repo_suggest_commit_message,
            commands::heroi_agent_send,
            commands::heroi_provider_models,
            commands::heroi_skills,
            commands::repo_suggest_pull_request,
            commands::repo_review_changes,
            commands::crash_report_check,
        ])
        .setup(|app| {
            install_crash_log(app);
            azdo_helper::init(app.handle());

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
        .build(tauri::generate_context!())
        .expect("error while building strand")
        .run(|app, event| {
            #[cfg(target_os = "windows")]
            if matches!(&event, tauri::RunEvent::Ready) {
                // Assign both HWND icon handles after Tauri finishes restoring
                // the window. Otherwise Windows falls back to its executable-
                // path cache, which can go generic after an in-place update.
                match apply_windows_taskbar_icon() {
                    Ok(true) => {}
                    Ok(false) => tracing::warn!("no visible Windows taskbar handle was found"),
                    Err(error) => tracing::warn!("failed to apply Windows taskbar icon: {error}"),
                }
            }
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                app.state::<state::AppState>().terminals.close_all(None);
            }
        });
}
