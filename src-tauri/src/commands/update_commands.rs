use crate::models::{AppError, AppUpdateInfo, AppUpdateProgress, UpdateSourcePreference};
use crate::services::AppState;
use tauri::{ipc::Channel, AppHandle, State};

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
    source: UpdateSourcePreference,
) -> Result<Option<AppUpdateInfo>, AppError> {
    let proxy = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("代理配置不可用".into()))?
        .proxy_snapshot();
    state.app_update_service.check(&app, &proxy.0, source).await
}

#[tauri::command]
pub async fn install_app_update(
    state: State<'_, AppState>,
    on_progress: Channel<AppUpdateProgress>,
) -> Result<(), AppError> {
    let _activity = state.lightweight_mode_service.try_gui_activity()?;
    let proxy = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("代理配置不可用".into()))?
        .proxy_snapshot();
    state
        .app_update_service
        .install(on_progress, &proxy.0)
        .await
}

#[tauri::command]
pub async fn close_app_update(state: State<'_, AppState>) -> Result<(), AppError> {
    state.app_update_service.close().await;
    Ok(())
}
