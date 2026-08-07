use crate::models::{AppError, AppUpdateInfo, AppUpdateProgress, UpdateSourcePreference};
use crate::services::AppState;
use tauri::{ipc::Channel, AppHandle, State};

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
    proxy: String,
    source: UpdateSourcePreference,
) -> Result<Option<AppUpdateInfo>, AppError> {
    state.app_update_service.check(&app, &proxy, source).await
}

#[tauri::command]
pub async fn install_app_update(
    state: State<'_, AppState>,
    on_progress: Channel<AppUpdateProgress>,
) -> Result<(), AppError> {
    state.app_update_service.install(on_progress).await
}

#[tauri::command]
pub async fn close_app_update(state: State<'_, AppState>) -> Result<(), AppError> {
    state.app_update_service.close().await;
    Ok(())
}
