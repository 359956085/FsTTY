use crate::models::{
    AppError, CreateSessionPayload, DeviceStatus, FileEntry, Session, SessionConnection,
    SessionGroup, UpdateSessionPayload,
};
use crate::services::{AppState, SessionService};
use std::sync::MutexGuard;
use tauri::State;

const DEFAULT_REMOTE_PATH: &str = "/var/www/app";

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionGroup>, AppError> {
    let service = lock_session_service(&state)?;

    Ok(service.list_groups())
}

#[tauri::command]
pub fn create_session(
    state: State<'_, AppState>,
    payload: CreateSessionPayload,
) -> Result<Session, AppError> {
    validate_create_payload(&payload)?;

    let mut service = lock_session_service(&state)?;

    Ok(service.create(payload))
}

#[tauri::command]
pub fn update_session(
    state: State<'_, AppState>,
    payload: UpdateSessionPayload,
) -> Result<Session, AppError> {
    validate_update_payload(&payload)?;

    let mut service = lock_session_service(&state)?;

    service.update(payload)
}

#[tauri::command]
pub fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), AppError> {
    validate_id(&session_id)?;

    let mut service = lock_session_service(&state)?;

    service.delete(&session_id)
}

#[tauri::command]
pub fn open_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionConnection, AppError> {
    validate_id(&session_id)?;

    let service = lock_session_service(&state)?;

    service.open(&session_id)
}

#[tauri::command]
pub fn list_remote_files(
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<Vec<FileEntry>, AppError> {
    validate_id(&session_id)?;

    let safe_path = sanitize_remote_path(path.as_deref().unwrap_or(DEFAULT_REMOTE_PATH))?;
    let session_service = lock_session_service(&state)?;

    // 文件服务必须先确认 session 存在，避免后续真实 SFTP 时访问未知目标。
    session_service.find(&session_id)?;
    Ok(state.file_service.list(&session_id, &safe_path))
}

#[tauri::command]
pub fn get_device_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<DeviceStatus, AppError> {
    validate_id(&session_id)?;

    let session_service = lock_session_service(&state)?;
    let session = session_service.find(&session_id)?;

    Ok(state.device_service.status(session))
}

fn lock_session_service<'a>(
    state: &'a State<'_, AppState>,
) -> Result<MutexGuard<'a, SessionService>, AppError> {
    state
        .session_service
        .lock()
        .map_err(|_| AppError::Internal("session 服务锁定失败".to_owned()))
}

fn validate_create_payload(payload: &CreateSessionPayload) -> Result<(), AppError> {
    validate_required("session 名称", &payload.name)?;
    validate_required("主机地址", &payload.host)?;
    validate_required("用户名", &payload.username)?;
    validate_port(payload.port)
}

fn validate_update_payload(payload: &UpdateSessionPayload) -> Result<(), AppError> {
    validate_id(&payload.id)?;

    if let Some(name) = &payload.name {
        validate_required("session 名称", name)?;
    }
    if let Some(host) = &payload.host {
        validate_required("主机地址", host)?;
    }
    if let Some(username) = &payload.username {
        validate_required("用户名", username)?;
    }
    if let Some(port) = payload.port {
        validate_port(port)?;
    }

    Ok(())
}

fn validate_required(label: &str, value: &str) -> Result<(), AppError> {
    let trimmed = value.trim();

    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err(AppError::Validation(format!(
            "{label}不能为空或包含控制字符"
        )));
    }

    Ok(())
}

fn validate_id(value: &str) -> Result<(), AppError> {
    validate_required("session id", value)
}

fn validate_port(port: u16) -> Result<(), AppError> {
    if port == 0 {
        return Err(AppError::Validation(
            "端口必须在 1 到 65535 之间".to_owned(),
        ));
    }

    Ok(())
}

fn sanitize_remote_path(path: &str) -> Result<String, AppError> {
    let trimmed = path.trim();

    if trimmed.is_empty()
        || !trimmed.starts_with('/')
        || trimmed.contains("..")
        || trimmed.chars().any(char::is_control)
    {
        return Err(AppError::Validation("远程路径不合法".to_owned()));
    }

    Ok(trimmed.trim_end_matches('/').to_owned())
}
