use crate::{
    models::{AppError, SessionProfile},
    services::AppState,
};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialServiceStatus {
    required: bool,
    available: bool,
    message: Option<String>,
}

#[tauri::command]
pub async fn get_credential_service_status() -> CredentialServiceStatus {
    #[cfg(windows)]
    {
        let result = fstty_broker::windows::request(&fstty_broker::protocol::Request::Status).await;
        CredentialServiceStatus {
            required: true,
            available: result.is_ok(),
            message: result.err(),
        }
    }
    #[cfg(not(windows))]
    {
        CredentialServiceStatus {
            required: false,
            available: true,
            message: None,
        }
    }
}

#[tauri::command]
pub async fn repair_credential_service() -> Result<(), AppError> {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(fstty_broker::windows::repair)
            .await
            .map_err(|_| AppError::Credential("无法启动服务修复窗口".into()))?
            .map_err(AppError::Credential)
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Validation("仅 Windows 支持凭据服务修复".into()))
    }
}

#[tauri::command]
pub async fn migrate_ssh_credentials(
    state: State<'_, AppState>,
    session_ids: Vec<String>,
) -> Result<(), AppError> {
    #[cfg(all(windows, not(test)))]
    {
        state
            .session_service
            .lock()
            .await
            .migrate_batch_to_broker(&session_ids)
            .await
    }
    #[cfg(any(not(windows), test))]
    {
        let _ = (state, session_ids);
        Err(AppError::Validation(
            "仅 Windows 服务模式支持凭据迁移".into(),
        ))
    }
}

#[tauri::command]
pub async fn migrate_ssh_credential(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionProfile, AppError> {
    #[cfg(all(windows, not(test)))]
    {
        state
            .session_service
            .lock()
            .await
            .migrate_to_broker(&session_id)
            .await
    }
    #[cfg(any(not(windows), test))]
    {
        let _ = (state, session_id);
        Err(AppError::Validation(
            "仅 Windows 服务模式支持凭据迁移".into(),
        ))
    }
}

#[tauri::command]
pub async fn manage_ssh_credential(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionProfile, AppError> {
    #[cfg(all(windows, not(test)))]
    {
        let result = state
            .session_service
            .lock()
            .await
            .manage_broker_credential(&session_id)
            .await?;
        state
            .connection_manager
            .disconnect_session(&session_id)
            .await;
        Ok(result)
    }
    #[cfg(any(not(windows), test))]
    {
        let _ = (state, session_id);
        Err(AppError::Validation(
            "仅 Windows 服务模式支持安全窗口".into(),
        ))
    }
}
