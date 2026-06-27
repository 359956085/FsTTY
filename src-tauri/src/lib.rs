mod commands;
mod models;
mod services;

use commands::{
    create_session, delete_session, get_app_settings, get_device_status, list_remote_files,
    list_sessions, open_session, set_language, update_session,
};
use services::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            create_session,
            update_session,
            delete_session,
            open_session,
            list_remote_files,
            get_device_status,
            get_app_settings,
            set_language
        ])
        .run(tauri::generate_context!())
        .expect("启动 FsTTY 失败");
}
