use crate::{
    models::{
        AppError, LocalUploadDirectory, LocalUploadLocation, LocalUploadLocations,
        RemotePermissionEntry,
    },
    services::AppState,
};
use tauri::{Manager, State};

#[tauri::command]
pub async fn get_local_upload_locations(
    app: tauri::AppHandle,
) -> Result<LocalUploadLocations, AppError> {
    let paths = app.path();
    let mut locations = Vec::new();
    for (label, path) in [
        ("home", paths.home_dir()),
        ("desktop", paths.desktop_dir()),
        ("downloads", paths.download_dir()),
        ("documents", paths.document_dir()),
    ] {
        if let Ok(path) = path {
            locations.push(LocalUploadLocation {
                label: label.into(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
        let drives = unsafe { GetLogicalDrives() };
        for index in 0..26 {
            if drives & (1 << index) != 0 {
                let path = format!("{}:\\", (b'A' + index) as char);
                locations.push(LocalUploadLocation {
                    label: path.clone(),
                    path,
                });
            }
        }
    }
    let initial_path = crate::services::local_files::last_directory()
        .or_else(|| locations.first().map(|l| l.path.clone()));
    Ok(LocalUploadLocations {
        locations,
        initial_path,
    })
}
#[tauri::command]
pub async fn list_local_upload_entries(path: String) -> Result<LocalUploadDirectory, AppError> {
    crate::services::local_files::list_directory(&path).await
}
#[tauri::command]
pub async fn get_remote_permissions(
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
) -> Result<Vec<RemotePermissionEntry>, AppError> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(AppError::Validation("权限查询项目数量无效".into()));
    }
    let mut entries = Vec::new();
    for path in paths {
        entries.push(
            state
                .connection_manager
                .file_details(&connection_id, &path)
                .await?,
        );
    }
    Ok(entries)
}
