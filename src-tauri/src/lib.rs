mod commands;
mod models;
mod services;

use commands::{
    cancel_transfer, connect_session, create_remote_directory, create_session, delete_remote_entry,
    delete_session, disconnect_session, download_file, forget_host_key, get_app_settings,
    get_device_status, get_system_clipboard_content_kind, list_remote_files, list_sessions,
    move_remote_entry, rename_remote_entry, resize_terminal, resolve_session_login_save_prompt,
    set_ignored_update_version, set_language, set_session_credential, trust_host_key,
    update_app_settings, update_session, upload_file, write_terminal,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
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
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(app_data_dir));

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
            get_app_settings,
            set_ignored_update_version,
            set_language,
            update_app_settings
        ])
        .run(tauri::generate_context!())
        .expect("启动 FsTTY 失败");
}
