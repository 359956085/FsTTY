mod app_paths;
mod commands;
mod gui_lifecycle;
mod gui_startup;
mod local_agent_setup;
mod logging;
mod mcp;
mod mcp_command_policy;
mod mcp_runtime;
mod mcp_transfer;
mod models;
mod services;

use commands::{
    abort_lightweight_mode, acknowledge_transfer_job, add_command_history,
    append_lightweight_snapshot_chunk, attach_preserved_terminal, attach_transfer_job,
    begin_lightweight_mode, cancel_transfer, check_app_update, clear_command_history,
    close_app_update, commit_lightweight_mode, configure_local_agents, connect_session,
    create_remote_directory, create_session, delete_remote_entry, delete_session,
    delete_session_group, disconnect_session, download_file, export_command_history,
    export_mcp_command_policy, finish_lightweight_restore, forget_host_key, get_app_settings,
    get_autostart_state, get_command_history_settings, get_device_metrics_snapshot,
    get_device_status, get_lightweight_mode_state, get_mcp_agent_prompt,
    get_mcp_http_client_config, get_mcp_http_status, get_mcp_permission_catalog,
    get_mcp_stdio_client_config, get_system_clipboard_content_kind, import_command_history,
    import_mcp_command_policy, inspect_local_agent_setup, install_app_update, list_command_history,
    list_remote_files, list_sessions, move_remote_entry, open_log_directory, open_project_link,
    rename_remote_entry, rename_session_group, reorder_session, reorder_session_group,
    resize_terminal, resolve_session_login_save_prompt, resolve_transfer_job_conflict,
    rotate_mcp_http_token, set_autostart_enabled, set_ignored_update_version, set_language,
    set_session_credential, set_theme, start_transfer_job, trust_host_key, update_app_settings,
    update_command_history_deduplication, update_log_settings, update_mcp_settings, update_session,
    update_shortcut_settings, upload_file, write_terminal,
};
use gui_lifecycle::{create_main_window, request_app_exit, request_main_window, GuiLifecycle};
use gui_startup::GuiStartupGuard;
use services::AppState;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_window_state::StateFlags;

fn create_system_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show-main", "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 FsTTY", true, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("FsTTY")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show-main" => request_main_window(app),
            "quit" => request_app_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                request_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map(|_| ())
}

fn keeps_lightweight_background(code: Option<i32>, active: bool) -> bool {
    // 无退出码表示最后一个窗口被销毁；显式关闭按钮和托盘退出仍结束进程。
    code.is_none() && active
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
    let startup_guard =
        GuiStartupGuard::acquire(&paths.app_data_dir).expect("无法完成 FsTTY GUI 单实例启动检查");
    logging::prepare_log_directory(&paths.app_data_dir, &paths.log_dir)
        .expect("初始化 FsTTY 日志目录失败");
    let runtime_log_dir = paths.log_dir.clone();
    let lifecycle = GuiLifecycle::default();
    let setup_lifecycle = lifecycle.clone();
    let app = tauri::Builder::default()
        .manage(lifecycle.clone())
        // 单实例必须最先注册，确保其他 GUI 插件启动前拦截第二个进程。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            request_main_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(logging::tauri_plugin(runtime_log_dir))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(move |app| {
            for warning in &paths.migration_warnings {
                log::warn!("{warning}");
            }
            log::info!("FsTTY GUI 启动");
            let state = AppState::new(paths.app_data_dir.clone());
            let starts_lightweight = state.lightweight_mode_service.starts_active();
            let startup_state = state.clone();
            let runtime_app_data = paths.app_data_dir.clone();
            app.manage(state);
            tauri::async_runtime::spawn_blocking(move || {
                let result = std::env::current_exe()
                    .map_err(|error| format!("无法获取 FsTTY 程序路径：{error}"))
                    .and_then(|executable| {
                        crate::mcp_runtime::prepare(&runtime_app_data, &executable).map(|_| ())
                    });
                match result {
                    Ok(()) => log::info!("MCP 版本化运行时已准备"),
                    Err(error) => log::warn!("MCP 版本化运行时准备失败：{error}"),
                }
            });
            tauri::async_runtime::spawn(async move {
                let _configuration = startup_state.mcp_configuration_lock.lock().await;
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

            let tray_available = match create_system_tray(app) {
                Ok(_) => true,
                Err(error) => {
                    log::error!("创建系统托盘失败，已回退普通窗口：{error}");
                    let state = app.state::<AppState>();
                    if let Err(error) = state.lightweight_mode_service.force_normal() {
                        log::error!("回退普通模式设置失败：{error}");
                    }
                    false
                }
            };
            if !starts_lightweight || !tray_available {
                let window = create_main_window(app.handle())?;
                window.show()?;
                window.set_focus()?;
            }
            setup_lifecycle.mark_ready();
            // build 只初始化插件；持锁到 setup 完成，第二个进程才可发送激活请求。
            drop(startup_guard);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        // 关闭按钮仍退出程序，但不能让默认销毁提前绕过后台任务清理。
                        api.prevent_close();
                        request_app_exit(window.app_handle());
                    }
                    tauri::WindowEvent::Destroyed => {
                        window
                            .app_handle()
                            .state::<GuiLifecycle>()
                            .window_destroyed();
                    }
                    _ => {}
                }
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
            get_lightweight_mode_state,
            begin_lightweight_mode,
            append_lightweight_snapshot_chunk,
            commit_lightweight_mode,
            abort_lightweight_mode,
            attach_preserved_terminal,
            finish_lightweight_restore,
            start_transfer_job,
            attach_transfer_job,
            resolve_transfer_job_conflict,
            acknowledge_transfer_job,
            get_device_status,
            get_device_metrics_snapshot,
            get_system_clipboard_content_kind,
            get_command_history_settings,
            update_command_history_deduplication,
            list_command_history,
            add_command_history,
            import_command_history,
            export_command_history,
            clear_command_history,
            get_app_settings,
            get_autostart_state,
            set_autostart_enabled,
            set_ignored_update_version,
            set_language,
            set_theme,
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
            open_log_directory,
            open_project_link,
            check_app_update,
            install_app_update,
            close_app_update
        ])
        .build(tauri::generate_context!())
        .expect("启动 FsTTY 失败");
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            let state = app_handle.state::<AppState>().inner().clone();
            if !lifecycle.is_exiting()
                && keeps_lightweight_background(
                    code,
                    state.lightweight_mode_service.starts_active(),
                )
            {
                api.prevent_exit();
                return;
            }
            if lifecycle.shutdown_complete() {
                return;
            }
            api.prevent_exit();
            if !lifecycle.begin_shutdown() {
                return;
            }
            let app = app_handle.clone();
            let shutdown_lifecycle = lifecycle.clone();
            tauri::async_runtime::spawn(async move {
                state.connection_manager.shutdown_device_metrics().await;
                state
                    .transfer_job_service
                    .shutdown(&state.connection_manager)
                    .await;
                shutdown_lifecycle.finish_shutdown();
                app.exit(code.unwrap_or(0));
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::keeps_lightweight_background;

    #[test]
    fn 轻量窗口销毁保活但显式退出不被拦截() {
        assert!(keeps_lightweight_background(None, true));
        assert!(!keeps_lightweight_background(Some(0), true));
        assert!(!keeps_lightweight_background(Some(1), true));
        assert!(!keeps_lightweight_background(None, false));
    }
}
