mod app_paths;
mod commands;
mod local_agent_setup;
mod logging;
mod mcp;
mod mcp_command_policy;
mod mcp_transfer;
mod models;
mod services;

use commands::{
    add_command_history, cancel_transfer, clear_command_history, configure_local_agents,
    connect_session, create_remote_directory, create_session, delete_remote_entry, delete_session,
    delete_session_group, disconnect_session, download_file, export_command_history,
    export_mcp_command_policy, forget_host_key, get_app_settings, get_command_history_settings,
    get_device_status, get_mcp_agent_prompt, get_mcp_http_client_config, get_mcp_http_status,
    get_mcp_permission_catalog, get_mcp_stdio_client_config, get_system_clipboard_content_kind,
    import_command_history, import_mcp_command_policy, inspect_local_agent_setup,
    list_command_history, list_remote_files, list_sessions, move_remote_entry, open_log_directory,
    rename_remote_entry, rename_session_group, reorder_session, reorder_session_group,
    resize_terminal, resolve_session_login_save_prompt, rotate_mcp_http_token,
    set_ignored_update_version, set_language, set_session_credential, trust_host_key,
    update_app_settings, update_command_history_deduplication, update_log_settings,
    update_mcp_settings, update_session, update_shortcut_settings, upload_file, write_terminal,
};
use services::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_window_state::StateFlags;

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run_mcp_stdio() -> Result<(), String> {
    let paths = app_paths::prepare_app_paths()?;
    logging::prepare_log_directory(&paths.app_data_dir, &paths.log_dir)?;
    logging::init_stdio(paths.log_dir)?;
    for warning in paths.migration_warnings {
        log::warn!("{warning}");
    }
    log::info!("FsTTY MCP stdio 服务启动");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(mcp::run_stdio(paths.app_data_dir))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = app_paths::prepare_app_paths().expect("初始化 FsTTY 应用数据目录失败");
    logging::prepare_log_directory(&paths.app_data_dir, &paths.log_dir)
        .expect("初始化 FsTTY 日志目录失败");
    let runtime_log_dir = paths.log_dir.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(logging::tauri_plugin(runtime_log_dir))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::POSITION
                        | StateFlags::SIZE
                        | StateFlags::MAXIMIZED
                        | StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(move |app| {
            for warning in &paths.migration_warnings {
                log::warn!("{warning}");
            }
            log::info!("FsTTY GUI 启动");
            let state = AppState::new(paths.app_data_dir.clone());
            let startup_state = state.clone();
            app.manage(state);
            tauri::async_runtime::spawn(async move {
                let settings = startup_state
                    .settings_service
                    .lock()
                    .ok()
                    .map(|service| service.get());
                if let Some(settings) =
                    settings.filter(|settings| settings.mcp_enabled && settings.mcp_http_enabled)
                {
                    if let Ok(token) = crate::mcp::get_or_create_http_token(&startup_state).await {
                        if let Err(error) = startup_state
                            .mcp_http_runtime
                            .start(
                                startup_state.clone(),
                                settings.mcp_http_port,
                                token.to_string(),
                            )
                            .await
                        {
                            log::error!("MCP HTTP 服务启动失败：{error}");
                        }
                    } else {
                        log::error!("MCP HTTP Token 初始化失败");
                    }
                }
            });

            let show_item = MenuItem::with_id(app, "show-main", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 FsTTY", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("FsTTY")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show-main" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            create_session,
            update_session,
            delete_session,
            reorder_session_group,
            reorder_session,
            rename_session_group,
            delete_session_group,
            set_session_credential,
            resolve_session_login_save_prompt,
            connect_session,
            trust_host_key,
            forget_host_key,
            write_terminal,
            resize_terminal,
            disconnect_session,
            list_remote_files,
            create_remote_directory,
            rename_remote_entry,
            move_remote_entry,
            delete_remote_entry,
            upload_file,
            download_file,
            cancel_transfer,
            get_device_status,
            get_system_clipboard_content_kind,
            get_command_history_settings,
            update_command_history_deduplication,
            list_command_history,
            add_command_history,
            import_command_history,
            export_command_history,
            clear_command_history,
            get_app_settings,
            set_ignored_update_version,
            set_language,
            update_app_settings,
            update_log_settings,
            update_shortcut_settings,
            update_mcp_settings,
            import_mcp_command_policy,
            export_mcp_command_policy,
            get_mcp_agent_prompt,
            get_mcp_permission_catalog,
            get_mcp_http_client_config,
            get_mcp_stdio_client_config,
            inspect_local_agent_setup,
            configure_local_agents,
            get_mcp_http_status,
            rotate_mcp_http_token,
            open_log_directory
        ])
        .run(tauri::generate_context!())
        .expect("启动 FsTTY 失败");
}
