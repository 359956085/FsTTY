use crate::gui_lifecycle::GuiLifecycle;
use crate::models::{
    AppError, BeginLightweightModeResult, LightweightModeState, LightweightSnapshotKind,
    LightweightTerminalRequest, PreservedTerminalAttachment, StartTransferJobRequest,
    TerminalResumeEvent, TransferConflictDecision, TransferJobEvent, TransferJobSummary,
};
use crate::services::AppState;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[tauri::command]
pub async fn get_lightweight_mode_state(
    state: State<'_, AppState>,
) -> Result<LightweightModeState, AppError> {
    let mut result = state.lightweight_mode_service.state().await;
    result.transfer_jobs = state.transfer_job_service.summaries().await;
    Ok(result)
}

#[tauri::command]
pub async fn begin_lightweight_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    terminals: Vec<LightweightTerminalRequest>,
    suppress_confirmation: bool,
) -> Result<BeginLightweightModeResult, AppError> {
    if app.tray_by_id("main-tray").is_none() {
        return Err(AppError::Busy(
            "系统托盘不可用，暂时无法进入轻量模式".to_owned(),
        ));
    }
    if state.connection_manager.has_connecting_sessions().await {
        return Err(AppError::Busy(
            "连接或认证正在进行，暂时无法进入轻量模式".to_owned(),
        ));
    }
    if state.app_update_service.is_installing() {
        return Err(AppError::Busy(
            "应用更新正在安装，暂时无法进入轻量模式".to_owned(),
        ));
    }
    state
        .lightweight_mode_service
        .begin(&state.connection_manager, terminals, suppress_confirmation)
        .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn append_lightweight_snapshot_chunk(
    state: State<'_, AppState>,
    token: String,
    runtime_id: String,
    kind: LightweightSnapshotKind,
    chunk_index: u32,
    total_chunks: u32,
    data: String,
) -> Result<(), AppError> {
    state
        .lightweight_mode_service
        .append_snapshot_chunk(&token, &runtime_id, kind, chunk_index, total_chunks, &data)
        .await
}

#[tauri::command]
pub async fn commit_lightweight_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::NotFound("主窗口不存在".to_owned()))?;
    let lifecycle = app.state::<GuiLifecycle>().inner().clone();
    state
        .lightweight_mode_service
        .commit(
            &token,
            || {
                app.save_window_state(
                    StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED,
                )
                .map_err(|_| AppError::Persistence("无法保存主窗口状态".to_owned()))
            },
            || {
                lifecycle
                    .destroy_window(|| window.destroy())
                    .map_err(|_| AppError::Internal("无法销毁主窗口".to_owned()))
            },
        )
        .await
}

#[tauri::command]
pub async fn abort_lightweight_mode(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), AppError> {
    state.lightweight_mode_service.abort(&token).await;
    Ok(())
}

#[tauri::command]
pub async fn attach_preserved_terminal(
    state: State<'_, AppState>,
    runtime_id: String,
    on_event: Channel<TerminalResumeEvent>,
) -> Result<PreservedTerminalAttachment, AppError> {
    state
        .lightweight_mode_service
        .attach_terminal(&runtime_id, on_event)
        .await
}

#[tauri::command]
pub async fn finish_lightweight_restore(
    state: State<'_, AppState>,
    valid_runtime_ids: Vec<String>,
) -> Result<(), AppError> {
    state
        .lightweight_mode_service
        .finish_restore(&state.connection_manager, valid_runtime_ids.clone())
        .await?;
    state
        .transfer_job_service
        .cleanup_orphans(&state.connection_manager, &valid_runtime_ids)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn start_transfer_job(
    state: State<'_, AppState>,
    request: StartTransferJobRequest,
) -> Result<TransferJobSummary, AppError> {
    state
        .transfer_job_service
        .start(state.connection_manager.clone(), request)
        .await
}

#[tauri::command]
pub async fn attach_transfer_job(
    state: State<'_, AppState>,
    job_id: String,
    on_event: Channel<TransferJobEvent>,
) -> Result<TransferJobSummary, AppError> {
    state.transfer_job_service.attach(&job_id, on_event).await
}

#[tauri::command]
pub async fn resolve_transfer_job_conflict(
    state: State<'_, AppState>,
    job_id: String,
    decision: TransferConflictDecision,
) -> Result<(), AppError> {
    state
        .transfer_job_service
        .resolve_conflict(&job_id, decision)
        .await
}

#[tauri::command]
pub async fn acknowledge_transfer_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), AppError> {
    state.transfer_job_service.acknowledge(&job_id).await
}
