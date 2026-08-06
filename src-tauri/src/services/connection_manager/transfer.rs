use super::MAX_REMOTE_PATH_BYTES;
use crate::models::{AppError, TransferEvent};
use russh_sftp::client::SftpSession;
use std::{
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};
use tauri::ipc::Channel;

pub(super) struct ActiveTransfer {
    pub(super) connection_id: String,
    pub(super) cancelled: Arc<AtomicBool>,
}

pub(super) async fn validate_upload_source(path: &str) -> Result<PathBuf, AppError> {
    let path = validate_local_path(path, "本地文件路径无效")?;
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| AppError::Validation("无法读取本地文件".to_owned()))?;
    if !metadata.is_file() {
        return Err(AppError::Validation("只能上传普通文件".to_owned()));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|_| AppError::Validation("无法规范化本地文件路径".to_owned()))
}

pub(super) async fn validate_download_target(
    path: &str,
    overwrite: bool,
) -> Result<PathBuf, AppError> {
    let requested = validate_local_path(path, "本地保存路径无效")?;
    let file_name = requested
        .file_name()
        .ok_or_else(|| AppError::Validation("本地保存文件名无效".to_owned()))?;
    let parent = requested
        .parent()
        .ok_or_else(|| AppError::Validation("本地保存目录无效".to_owned()))?;
    let canonical_parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(|_| AppError::Validation("本地保存目录不存在".to_owned()))?;
    let parent_metadata = tokio::fs::metadata(&canonical_parent)
        .await
        .map_err(|_| AppError::Validation("本地保存目录不存在".to_owned()))?;
    if !parent_metadata.is_dir() {
        return Err(AppError::Validation("本地保存目录无效".to_owned()));
    }
    let path = canonical_parent.join(file_name);
    if path.to_string_lossy().len() > MAX_REMOTE_PATH_BYTES {
        return Err(AppError::Validation("本地保存路径过长".to_owned()));
    }
    if let Ok(metadata) = tokio::fs::symlink_metadata(&path).await {
        if !metadata.is_file() {
            return Err(AppError::Conflict("本地目标不是普通文件".to_owned()));
        }
        if !overwrite {
            return Err(AppError::Conflict("本地文件已存在".to_owned()));
        }
    }
    Ok(path)
}

fn validate_local_path(path: &str, message: &str) -> Result<PathBuf, AppError> {
    if path.is_empty()
        || path.len() > MAX_REMOTE_PATH_BYTES
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(AppError::Validation(message.to_owned()));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::Validation(message.to_owned()));
    }
    Ok(path)
}

pub(super) async fn finalize_remote_file(
    sftp: &SftpSession,
    temp: &str,
    target: &str,
    backup: &str,
    target_exists: bool,
) -> Result<(), AppError> {
    if target_exists
        && sftp
            .rename(target.to_owned(), backup.to_owned())
            .await
            .is_err()
    {
        let _ = sftp.remove_file(temp.to_owned()).await;
        return Err(AppError::Sftp("无法备份远程原文件".to_owned()));
    }
    if sftp
        .rename(temp.to_owned(), target.to_owned())
        .await
        .is_err()
    {
        if target_exists {
            let _ = sftp.rename(backup.to_owned(), target.to_owned()).await;
        }
        let _ = sftp.remove_file(temp.to_owned()).await;
        return Err(AppError::Sftp("无法提交远程文件".to_owned()));
    }
    if target_exists {
        let _ = sftp.remove_file(backup.to_owned()).await;
    }
    Ok(())
}

pub(super) async fn finalize_local_file(
    temp: &Path,
    target: &Path,
    backup: &Path,
    overwrite: bool,
) -> Result<(), AppError> {
    let target_exists = tokio::fs::metadata(target).await.is_ok();
    if target_exists {
        if !overwrite {
            let _ = tokio::fs::remove_file(temp).await;
            return Err(AppError::Conflict("本地文件已存在".to_owned()));
        }
        tokio::fs::rename(target, backup).await.map_err(|_| {
            let _ = std::fs::remove_file(temp);
            AppError::Internal("无法备份本地原文件".to_owned())
        })?;
    }
    if tokio::fs::rename(temp, target).await.is_err() {
        let restored = !target_exists || tokio::fs::rename(backup, target).await.is_ok();
        let _ = tokio::fs::remove_file(temp).await;
        return Err(AppError::Internal(
            if restored {
                "无法提交本地文件"
            } else {
                "无法提交本地文件，且原文件恢复失败"
            }
            .to_owned(),
        ));
    }
    if target_exists {
        let _ = tokio::fs::remove_file(backup).await;
    }
    Ok(())
}

pub(super) fn send_progress(
    progress: &Channel<TransferEvent>,
    transfer_id: &str,
    transferred_bytes: u64,
    total_bytes: u64,
) {
    let _ = progress.send(TransferEvent::Progress {
        transfer_id: transfer_id.to_owned(),
        transferred_bytes,
        total_bytes,
    });
}
