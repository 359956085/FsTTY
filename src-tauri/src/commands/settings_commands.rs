use crate::models::{AppError, AppSettings, Language};
use crate::services::AppState;
use tauri::State;

#[tauri::command]
pub fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    let service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;

    Ok(service.get())
}

#[tauri::command]
pub fn set_language(
    state: State<'_, AppState>,
    language: Language,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;

    service.set_language(language)
}

#[tauri::command]
pub fn update_app_settings(
    state: State<'_, AppState>,
    auto_update: bool,
    update_proxy: String,
    allow_remote_clipboard_write: bool,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    service.update(auto_update, update_proxy, allow_remote_clipboard_write)
}

#[tauri::command]
pub fn set_ignored_update_version(
    state: State<'_, AppState>,
    version: String,
) -> Result<AppSettings, AppError> {
    let mut service = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    service.set_ignored_update_version(version)
}
