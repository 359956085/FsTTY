use crate::{models::AppError, services::AppState};
use tauri::State;

#[tauri::command]
pub async fn get_autostart_state(state: State<'_, AppState>) -> Result<bool, AppError> {
    let service = state.autostart_service.clone();
    tauri::async_runtime::spawn_blocking(move || service.get())
        .await
        .map_err(|_| AppError::Internal("开机自启读取任务异常终止".to_owned()))?
}

#[tauri::command]
pub async fn set_autostart_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, AppError> {
    let service = state.autostart_service.clone();
    tauri::async_runtime::spawn_blocking(move || service.set_enabled(enabled))
        .await
        .map_err(|_| AppError::Internal("开机自启保存任务异常终止".to_owned()))?
}
