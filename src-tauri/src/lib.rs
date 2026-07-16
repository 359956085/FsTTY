mod commands;
mod models;
mod services;

use commands::{
    cancel_transfer, connect_session, create_session, delete_session, disconnect_session,
    download_file, forget_host_key, get_app_settings, get_device_status, list_remote_files,
    list_sessions, resize_terminal, set_language, set_session_credential, trust_host_key,
    update_app_settings, update_session, upload_file, write_terminal,
};
use services::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(app_data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            create_session,
            update_session,
            delete_session,
            set_session_credential,
            connect_session,
            trust_host_key,
            forget_host_key,
            write_terminal,
            resize_terminal,
            disconnect_session,
            list_remote_files,
            upload_file,
            download_file,
            cancel_transfer,
            get_device_status,
            get_app_settings,
            set_language
            , update_app_settings
        ])
        .run(tauri::generate_context!())
        .expect("启动 FsTTY 失败");
}
