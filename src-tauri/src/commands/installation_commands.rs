use crate::{installation::InstallationStatus, models::AppError};

#[tauri::command]
pub async fn get_installation_status() -> Result<InstallationStatus, AppError> {
    #[cfg(windows)]
    {
        let record = fstty_broker::installation::read().map_err(AppError::Internal)?;
        Ok(InstallationStatus {
            directory: record.map(|r| r.directory.display().to_string()),
            ..crate::installation::status()
        })
    }
    #[cfg(not(windows))]
    {
        Ok(InstallationStatus::default())
    }
}

#[tauri::command]
pub async fn repair_installation_entries() -> Result<InstallationStatus, AppError> {
    let paths = crate::app_paths::prepare_app_paths().map_err(AppError::Internal)?;
    tokio::task::spawn_blocking(move || crate::installation::retry(&paths.app_data_dir))
        .await
        .map_err(|_| AppError::Internal("入口修复任务失败".into()))
}
