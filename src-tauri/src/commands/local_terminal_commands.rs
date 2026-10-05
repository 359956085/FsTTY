use crate::models::{
    AppError, LocalSessionPayload, LocalShellAvailability, SshConnection, TerminalEvent,
    WorkspaceSession, WorkspaceSessionGroup,
};
use crate::services::AppState;
use tauri::{ipc::Channel, State};

#[tauri::command]
pub async fn list_workspace_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceSessionGroup>, AppError> {
    state
        .session_service
        .lock()
        .await
        .list_workspace(&state.credential_service)
        .await
}
#[tauri::command]
pub async fn save_local_session(
    state: State<'_, AppState>,
    payload: LocalSessionPayload,
) -> Result<WorkspaceSession, AppError> {
    state
        .session_service
        .lock()
        .await
        .save_local(payload)
        .map(WorkspaceSession::Local)
}
#[tauri::command]
pub async fn delete_local_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    state
        .session_service
        .lock()
        .await
        .delete_local(&session_id)?;
    state.local_terminal_service.stop_session(&session_id);
    Ok(())
}
#[tauri::command]
pub async fn detect_local_shells(
    state: State<'_, AppState>,
) -> Result<Vec<LocalShellAvailability>, AppError> {
    let service = state.local_terminal_service.clone();
    tokio::task::spawn_blocking(move || service.detect())
        .await
        .map_err(|_| AppError::Internal("终端检测失败".into()))
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_local_terminal(
    state: State<'_, AppState>,
    session_id: String,
    runtime_id: String,
    request_id: String,
    columns: u32,
    rows: u32,
    run_as_admin: Option<bool>,
    on_event: Channel<TerminalEvent>,
) -> Result<SshConnection, AppError> {
    let _activity = state.lightweight_mode_service.try_gui_activity()?;
    let session = state.session_service.lock().await.find_local(&session_id)?;
    state
        .local_terminal_service
        .start(
            session,
            runtime_id,
            request_id,
            columns,
            rows,
            run_as_admin,
            on_event,
        )
        .await
}
#[tauri::command]
pub fn cancel_local_terminal_start(state: State<'_, AppState>, request_id: String) {
    state.local_terminal_service.cancel_start(&request_id);
}
#[tauri::command]
pub async fn write_local_terminal(
    state: State<'_, AppState>,
    connection_id: String,
    data: String,
) -> Result<(), AppError> {
    state
        .local_terminal_service
        .write(&connection_id, data)
        .await
}
#[tauri::command]
pub async fn resize_local_terminal(
    state: State<'_, AppState>,
    connection_id: String,
    columns: u32,
    rows: u32,
) -> Result<(), AppError> {
    state
        .local_terminal_service
        .resize(&connection_id, columns, rows)
        .await
}
#[tauri::command]
pub fn stop_local_terminal(state: State<'_, AppState>, connection_id: String) {
    state.local_terminal_service.stop(&connection_id);
}
