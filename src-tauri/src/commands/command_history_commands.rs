use crate::models::{
    AppError, CommandHistoryImportResult, CommandHistoryPage, CommandHistorySettings,
};
use crate::services::AppState;
use std::path::PathBuf;
use tauri::State;

fn lock_service<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, crate::services::CommandHistoryService>, AppError> {
    state
        .command_history_service
        .lock()
        .map_err(|_| AppError::Internal("历史命令服务锁定失败".to_owned()))
}

#[tauri::command]
pub fn get_command_history_settings(
    state: State<'_, AppState>,
) -> Result<CommandHistorySettings, AppError> {
    lock_service(&state)?.settings()
}

#[tauri::command]
pub fn update_command_history_deduplication(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<CommandHistorySettings, AppError> {
    lock_service(&state)?.update_deduplication(enabled)
}

#[tauri::command]
pub fn list_command_history(
    state: State<'_, AppState>,
    query: String,
    before_cursor: Option<String>,
) -> Result<CommandHistoryPage, AppError> {
    lock_service(&state)?.list(&query, before_cursor.as_deref())
}

#[tauri::command]
pub fn add_command_history(state: State<'_, AppState>, command: String) -> Result<(), AppError> {
    lock_service(&state)?.add(&command)
}

#[tauri::command]
pub fn import_command_history(
    state: State<'_, AppState>,
    path: String,
) -> Result<CommandHistoryImportResult, AppError> {
    lock_service(&state)?.import(&PathBuf::from(path))
}

#[tauri::command]
pub fn export_command_history(state: State<'_, AppState>, path: String) -> Result<(), AppError> {
    lock_service(&state)?.export(&PathBuf::from(path))
}

#[tauri::command]
pub fn clear_command_history(
    state: State<'_, AppState>,
) -> Result<CommandHistorySettings, AppError> {
    lock_service(&state)?.clear()
}
