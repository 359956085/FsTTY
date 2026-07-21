use crate::models::{
    AppError, ConnectResult, CreateSessionPayload, DeviceStatus, FileEntry, SessionGroup,
    SessionProfile, TerminalEvent, TransferEvent, UpdateSessionPayload,
};
use crate::services::AppState;
use tauri::{ipc::Channel, State};
use zeroize::Zeroizing;

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionGroup>, AppError> {
    state
        .session_service
        .lock()
        .await
        .list_groups(&state.credential_service)
        .await
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    payload: CreateSessionPayload,
) -> Result<SessionProfile, AppError> {
    state
        .session_service
        .lock()
        .await
        .create(payload, &state.credential_service)
        .await
}

#[tauri::command]
pub async fn update_session(
    state: State<'_, AppState>,
    payload: UpdateSessionPayload,
) -> Result<SessionProfile, AppError> {
    let session_id = payload.id.clone();
    let (profile, connection_invalidated) = state
        .session_service
        .lock()
        .await
        .update(payload, &state.credential_service)
        .await?;
    if connection_invalidated {
        state
            .connection_manager
            .disconnect_session(&session_id)
            .await;
    }
    Ok(profile)
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    {
        state.session_service.lock().await.find(&session_id)?;
    }
    state
        .connection_manager
        .disconnect_session(&session_id)
        .await;
    state
        .session_service
        .lock()
        .await
        .delete(&session_id, &state.credential_service)
        .await
}

#[tauri::command]
pub async fn set_session_credential(
    state: State<'_, AppState>,
    session_id: String,
    credential: Zeroizing<String>,
) -> Result<SessionProfile, AppError> {
    state
        .session_service
        .lock()
        .await
        .set_credential(&session_id, credential, &state.credential_service)
        .await
}

#[tauri::command]
pub async fn connect_session(
    state: State<'_, AppState>,
    session_id: String,
    columns: u32,
    rows: u32,
    on_event: Channel<TerminalEvent>,
    one_time_credential: Option<Zeroizing<String>>,
) -> Result<ConnectResult, AppError> {
    let session = state.session_service.lock().await.find(&session_id)?;
    state
        .connection_manager
        .connect(
            session,
            columns,
            rows,
            on_event,
            &state.credential_service,
            one_time_credential,
        )
        .await
}

#[tauri::command]
pub async fn trust_host_key(
    state: State<'_, AppState>,
    session_id: String,
    challenge_id: String,
) -> Result<(), AppError> {
    let session = state.session_service.lock().await.find(&session_id)?;
    state
        .connection_manager
        .trust_host_key(&session, &challenge_id)
        .await
}

#[tauri::command]
pub async fn forget_host_key(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, AppError> {
    let session = state.session_service.lock().await.find(&session_id)?;
    state.connection_manager.forget_host_key(&session).await
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    connection_id: String,
    data: String,
) -> Result<(), AppError> {
    state
        .connection_manager
        .write_terminal(&connection_id, data)
        .await
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    connection_id: String,
    columns: u32,
    rows: u32,
) -> Result<(), AppError> {
    state
        .connection_manager
        .resize_terminal(&connection_id, columns, rows)
        .await
}

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    state.connection_manager.disconnect(&connection_id).await
}

#[tauri::command]
pub async fn list_remote_files(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    state
        .connection_manager
        .list_files(&connection_id, &path)
        .await
}

#[tauri::command]
pub async fn create_remote_directory(
    state: State<'_, AppState>,
    connection_id: String,
    parent_path: String,
    name: String,
) -> Result<(), AppError> {
    state
        .connection_manager
        .create_remote_directory(&connection_id, &parent_path, &name)
        .await
}

#[tauri::command]
pub async fn rename_remote_entry(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    new_name: String,
) -> Result<(), AppError> {
    state
        .connection_manager
        .rename_remote_entry(&connection_id, &path, &new_name)
        .await
}

#[tauri::command]
pub async fn move_remote_entry(
    state: State<'_, AppState>,
    connection_id: String,
    source_path: String,
    target_directory: String,
) -> Result<(), AppError> {
    state
        .connection_manager
        .move_remote_entry(&connection_id, &source_path, &target_directory)
        .await
}

#[tauri::command]
pub async fn delete_remote_entry(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<(), AppError> {
    state
        .connection_manager
        .delete_remote_entry(&connection_id, &path)
        .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn upload_file(
    state: State<'_, AppState>,
    connection_id: String,
    transfer_id: String,
    local_path: String,
    remote_directory: String,
    overwrite: bool,
    on_progress: Channel<TransferEvent>,
) -> Result<(), AppError> {
    state
        .connection_manager
        .upload_file(
            &connection_id,
            &transfer_id,
            &local_path,
            &remote_directory,
            overwrite,
            on_progress,
        )
        .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn download_file(
    state: State<'_, AppState>,
    connection_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
    on_progress: Channel<TransferEvent>,
) -> Result<(), AppError> {
    state
        .connection_manager
        .download_file(
            &connection_id,
            &transfer_id,
            &remote_path,
            &local_path,
            overwrite,
            on_progress,
        )
        .await
}

#[tauri::command]
pub async fn cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<bool, AppError> {
    Ok(state.connection_manager.cancel_transfer(&transfer_id).await)
}

#[tauri::command]
pub async fn get_device_status(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DeviceStatus, AppError> {
    state
        .device_service
        .status(&state.connection_manager, &connection_id)
        .await
}
