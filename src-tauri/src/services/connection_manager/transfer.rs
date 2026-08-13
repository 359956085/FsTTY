use super::super::connection_paths::{
    checked_join_remote_path, normalize_remote_path, validate_remote_name,
};
use super::remote_files::{map_sftp_read_error, RemoteReadKind};
use super::{
    open_sftp, ConnectionManager, MAX_REMOTE_PATH_BYTES, SFTP_TIMEOUT, TRANSFER_BUFFER_BYTES,
};
use crate::models::{AppError, TransferEvent};
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use std::{
    io::SeekFrom,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::{
    fs::{File as LocalFile, OpenOptions as TokioOpenOptions},
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt},
    time,
};
use uuid::Uuid;

pub(super) struct ActiveTransfer {
    pub(super) connection_id: String,
    pub(super) cancelled: Arc<AtomicBool>,
}

impl ConnectionManager {
    pub async fn upload_file_quiet(
        &self,
        connection_id: &str,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64, AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        if sftp.try_exists(remote_path.clone()).await.unwrap_or(false) {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }
        let mut source = LocalFile::open(local_path)
            .await
            .map_err(|_| AppError::Validation("无法打开本地文件".to_owned()))?;
        let mut target = sftp
            .create(remote_path)
            .await
            .map_err(|_| AppError::Sftp("无法创建远程文件".to_owned()))?;
        tokio::io::copy(&mut source, &mut target)
            .await
            .map_err(|_| AppError::Sftp("上传文件失败".to_owned()))
    }

    pub async fn download_file_quiet(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> Result<u64, AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        if local_path.exists() {
            return Err(AppError::Conflict("本地文件已存在".to_owned()));
        }
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let mut source = sftp.open(remote_path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        let mut target = LocalFile::create(local_path)
            .await
            .map_err(|_| AppError::Validation("无法创建本地文件".to_owned()))?;
        tokio::io::copy(&mut source, &mut target)
            .await
            .map_err(|_| AppError::Sftp("下载文件失败".to_owned()))
    }

    pub(crate) async fn remote_file_info(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> Result<(String, u64), AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = time::timeout(SFTP_TIMEOUT, sftp.symlink_metadata(remote_path.clone()))
            .await
            .map_err(|_| AppError::Sftp("读取远程文件信息超时".to_owned()))?
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::File,
                    &entry.username,
                    "无法读取远程文件信息",
                )
            })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("只能下载普通文件".to_owned()));
        }
        Ok((remote_path, metadata.len()))
    }

    pub(crate) async fn remote_directory_path(
        &self,
        connection_id: &str,
        remote_directory: &str,
    ) -> Result<String, AppError> {
        let remote_directory = normalize_remote_path(remote_directory)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = time::timeout(SFTP_TIMEOUT, sftp.metadata(remote_directory.clone()))
            .await
            .map_err(|_| AppError::Sftp("读取远程目录信息超时".to_owned()))?
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::Directory,
                    &entry.username,
                    "无法读取远程目录信息",
                )
            })?;
        if !metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程目标不是目录".to_owned()));
        }
        Ok(remote_directory)
    }

    pub(crate) async fn stream_remote_file<W>(
        &self,
        connection_id: &str,
        remote_path: &str,
        byte_range: (u64, u64),
        destination: &mut W,
        cancellation: &tokio_util::sync::CancellationToken,
        idle_timeout: Duration,
    ) -> Result<u64, AppError>
    where
        W: AsyncWrite + Unpin,
    {
        let (offset, length) = byte_range;
        let remote_path = normalize_remote_path(remote_path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let mut source = time::timeout(SFTP_TIMEOUT, sftp.open(remote_path))
            .await
            .map_err(|_| AppError::Sftp("打开远程文件超时".to_owned()))?
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::File,
                    &entry.username,
                    "无法打开远程文件",
                )
            })?;
        if offset > 0 {
            time::timeout(idle_timeout, source.seek(SeekFrom::Start(offset)))
                .await
                .map_err(|_| AppError::Sftp("定位远程文件超时".to_owned()))?
                .map_err(|_| AppError::Sftp("无法定位远程文件".to_owned()))?;
        }

        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = 0_u64;
        while transferred < length {
            let remaining = length - transferred;
            let read_limit = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            let read = tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(AppError::Connection("文件传输已取消".to_owned()));
                }
                result = time::timeout(idle_timeout, source.read(&mut buffer[..read_limit])) => {
                    result
                        .map_err(|_| AppError::Sftp("下载远程文件超时".to_owned()))?
                        .map_err(|_| AppError::Sftp("读取远程文件失败".to_owned()))?
                }
            };
            if read == 0 {
                return Err(AppError::Sftp("远程文件在下载期间发生变化".to_owned()));
            }
            tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(AppError::Connection("文件传输已取消".to_owned()));
                }
                result = time::timeout(idle_timeout, destination.write_all(&buffer[..read])) => {
                    result
                        .map_err(|_| AppError::Connection("发送下载数据超时".to_owned()))?
                        .map_err(|_| AppError::Connection("下载客户端已断开".to_owned()))?;
                }
            }
            transferred += read as u64;
        }
        time::timeout(idle_timeout, destination.flush())
            .await
            .map_err(|_| AppError::Connection("刷新下载数据超时".to_owned()))?
            .map_err(|_| AppError::Connection("无法发送下载数据".to_owned()))?;
        Ok(transferred)
    }

    pub(crate) async fn upload_remote_stream_exclusive<R>(
        &self,
        connection_id: &str,
        remote_directory: &str,
        file_name: &str,
        source: &mut R,
        cancellation: &tokio_util::sync::CancellationToken,
        idle_timeout: Duration,
    ) -> Result<(String, u64), AppError>
    where
        R: AsyncRead + Unpin,
    {
        validate_remote_name(file_name)?;
        let remote_directory = normalize_remote_path(remote_directory)?;
        let target = checked_join_remote_path(&remote_directory, file_name)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let directory_metadata =
            time::timeout(SFTP_TIMEOUT, sftp.metadata(remote_directory.clone()))
                .await
                .map_err(|_| AppError::Sftp("读取远程目录信息超时".to_owned()))?
                .map_err(|error| {
                    map_sftp_read_error(
                        error,
                        RemoteReadKind::Directory,
                        &entry.username,
                        "无法读取远程目录信息",
                    )
                })?;
        if !directory_metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程目标不是目录".to_owned()));
        }
        if time::timeout(SFTP_TIMEOUT, sftp.try_exists(target.clone()))
            .await
            .map_err(|_| AppError::Sftp("检查远程目标超时".to_owned()))?
            .map_err(|_| AppError::Sftp("无法检查远程目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }

        // 排他创建是标准 SFTP 下唯一可移植的“绝不覆盖”保证；代价是上传中目标可见。
        let destination = time::timeout(
            SFTP_TIMEOUT,
            sftp.open_with_flags(
                target.clone(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            ),
        )
        .await
        .map_err(|_| AppError::Sftp("创建远程文件超时".to_owned()))?;
        let mut destination = match destination {
            Ok(destination) => destination,
            Err(_) => {
                if sftp.try_exists(target.clone()).await.unwrap_or(false) {
                    return Err(AppError::Conflict("远程文件已存在".to_owned()));
                }
                return Err(AppError::Sftp("无法创建远程文件".to_owned()));
            }
        };

        let transfer = async {
            let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
            let mut transferred = 0_u64;
            loop {
                let read = tokio::select! {
                    _ = cancellation.cancelled() => {
                        return Err(AppError::Connection("文件传输已取消".to_owned()));
                    }
                    result = time::timeout(idle_timeout, source.read(&mut buffer)) => {
                        result
                            .map_err(|_| AppError::Connection("接收上传数据超时".to_owned()))?
                            .map_err(|_| AppError::Connection("上传客户端已断开".to_owned()))?
                    }
                };
                if read == 0 {
                    break;
                }
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        return Err(AppError::Connection("文件传输已取消".to_owned()));
                    }
                    result = time::timeout(idle_timeout, destination.write_all(&buffer[..read])) => {
                        result
                            .map_err(|_| AppError::Sftp("写入远程文件超时".to_owned()))?
                            .map_err(|_| AppError::Sftp("上传文件失败".to_owned()))?;
                    }
                }
                transferred = transferred
                    .checked_add(read as u64)
                    .ok_or_else(|| AppError::Validation("上传文件过大".to_owned()))?;
            }
            time::timeout(idle_timeout, destination.shutdown())
                .await
                .map_err(|_| AppError::Sftp("提交远程文件超时".to_owned()))?
                .map_err(|_| AppError::Sftp("提交远程文件失败".to_owned()))?;
            Ok(transferred)
        }
        .await;

        match transfer {
            Ok(transferred) => Ok((target, transferred)),
            Err(error) => {
                let _ = time::timeout(SFTP_TIMEOUT, destination.shutdown()).await;
                drop(destination);
                let _ = time::timeout(SFTP_TIMEOUT, sftp.remove_file(target)).await;
                Err(error)
            }
        }
    }

    pub async fn upload_file(
        &self,
        connection_id: &str,
        transfer_id: &str,
        local_path: &str,
        remote_directory: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
    ) -> Result<(), AppError> {
        let cancelled = self.begin_transfer(connection_id, transfer_id).await?;
        let result = self
            .upload_file_inner(
                connection_id,
                transfer_id,
                local_path,
                remote_directory,
                overwrite,
                progress,
                cancelled,
            )
            .await;
        self.end_transfer(transfer_id).await;
        result
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn upload_file_inner(
        &self,
        connection_id: &str,
        transfer_id: &str,
        local_path: &str,
        remote_directory: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), AppError> {
        let local_path = validate_upload_source(local_path).await?;
        let file_name = local_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::Validation("本地文件名必须是有效 Unicode".to_owned()))?;
        validate_remote_name(file_name)?;
        let remote_directory = normalize_remote_path(remote_directory)?;
        let target = checked_join_remote_path(&remote_directory, file_name)?;
        let temp =
            checked_join_remote_path(&remote_directory, &format!(".fstty-{transfer_id}.part"))?;
        let backup =
            checked_join_remote_path(&remote_directory, &format!(".fstty-{transfer_id}.bak"))?;
        let metadata = tokio::fs::metadata(&local_path)
            .await
            .map_err(|_| AppError::Validation("无法读取本地文件".to_owned()))?;
        let total = metadata.len();
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let target_exists = sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程目标".to_owned()))?;
        if target_exists && !overwrite {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }
        if target_exists {
            let target_metadata = sftp
                .symlink_metadata(target.clone())
                .await
                .map_err(|_| AppError::Sftp("无法读取远程目标信息".to_owned()))?;
            if !target_metadata.file_type().is_file() {
                return Err(AppError::Conflict("远程目标不是普通文件".to_owned()));
            }
        }

        let mut source = LocalFile::open(&local_path)
            .await
            .map_err(|_| AppError::Validation("无法打开本地文件".to_owned()))?;
        let mut destination = sftp
            .create(temp.clone())
            .await
            .map_err(|_| AppError::Sftp("无法创建远程临时文件".to_owned()))?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = 0_u64;
        let mut last_progress = Instant::now() - Duration::from_millis(100);
        send_progress(&progress, transfer_id, transferred, total);

        loop {
            if cancelled.load(Ordering::Relaxed) {
                let _ = destination.shutdown().await;
                let _ = sftp.remove_file(temp).await;
                let _ = progress.send(TransferEvent::Cancelled {
                    transfer_id: transfer_id.to_owned(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                });
                return Ok(());
            }
            let read = match source.read(&mut buffer).await {
                Ok(read) => read,
                Err(_) => {
                    let _ = destination.shutdown().await;
                    let _ = sftp.remove_file(temp).await;
                    return Err(AppError::Internal("读取本地文件失败".to_owned()));
                }
            };
            if read == 0 {
                break;
            }
            if destination.write_all(&buffer[..read]).await.is_err() {
                let _ = destination.shutdown().await;
                let _ = sftp.remove_file(temp).await;
                return Err(AppError::Sftp("上传文件失败".to_owned()));
            }
            transferred += read as u64;
            if last_progress.elapsed() >= Duration::from_millis(100) {
                send_progress(&progress, transfer_id, transferred, total);
                last_progress = Instant::now();
            }
        }
        if destination.shutdown().await.is_err() {
            let _ = sftp.remove_file(temp).await;
            return Err(AppError::Sftp("提交远程临时文件失败".to_owned()));
        }
        finalize_remote_file(&sftp, &temp, &target, &backup, target_exists).await?;
        let _ = progress.send(TransferEvent::Completed {
            transfer_id: transfer_id.to_owned(),
            transferred_bytes: transferred,
            total_bytes: total,
        });
        Ok(())
    }

    pub async fn download_file(
        &self,
        connection_id: &str,
        transfer_id: &str,
        remote_path: &str,
        local_path: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
    ) -> Result<(), AppError> {
        let cancelled = self.begin_transfer(connection_id, transfer_id).await?;
        let result = self
            .download_file_inner(
                connection_id,
                transfer_id,
                remote_path,
                local_path,
                overwrite,
                progress,
                cancelled,
            )
            .await;
        self.end_transfer(transfer_id).await;
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_file_inner(
        &self,
        connection_id: &str,
        transfer_id: &str,
        remote_path: &str,
        local_path: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        let local_path = validate_download_target(local_path, overwrite).await?;
        let parent = local_path
            .parent()
            .ok_or_else(|| AppError::Validation("本地保存目录无效".to_owned()))?;
        let temp = parent.join(format!(".fstty-{transfer_id}.part"));
        let backup = parent.join(format!(".fstty-{transfer_id}.bak"));
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = sftp
            .symlink_metadata(remote_path.clone())
            .await
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::File,
                    &entry.username,
                    "无法读取远程文件信息",
                )
            })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("只能下载普通文件".to_owned()));
        }
        let total = metadata.len();
        let mut source = sftp.open(remote_path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        let mut destination = TokioOpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await
            .map_err(|_| AppError::Conflict("本地临时文件已存在".to_owned()))?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = 0_u64;
        let mut last_progress = Instant::now() - Duration::from_millis(100);
        send_progress(&progress, transfer_id, transferred, total);

        loop {
            if cancelled.load(Ordering::Relaxed) {
                drop(destination);
                let _ = tokio::fs::remove_file(&temp).await;
                let _ = progress.send(TransferEvent::Cancelled {
                    transfer_id: transfer_id.to_owned(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                });
                return Ok(());
            }
            let read = match source.read(&mut buffer).await {
                Ok(read) => read,
                Err(_) => {
                    drop(destination);
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(AppError::Sftp("下载文件失败".to_owned()));
                }
            };
            if read == 0 {
                break;
            }
            if destination.write_all(&buffer[..read]).await.is_err() {
                drop(destination);
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(AppError::Internal("写入本地文件失败".to_owned()));
            }
            transferred += read as u64;
            if last_progress.elapsed() >= Duration::from_millis(100) {
                send_progress(&progress, transfer_id, transferred, total);
                last_progress = Instant::now();
            }
        }
        if destination.flush().await.is_err() || destination.sync_all().await.is_err() {
            drop(destination);
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(AppError::Internal("同步本地临时文件失败".to_owned()));
        }
        drop(destination);
        finalize_local_file(&temp, &local_path, &backup, overwrite).await?;
        let _ = progress.send(TransferEvent::Completed {
            transfer_id: transfer_id.to_owned(),
            transferred_bytes: transferred,
            total_bytes: total,
        });
        Ok(())
    }

    pub async fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let transfers = self.inner.transfers.lock().await;
        if let Some(transfer) = transfers.get(transfer_id) {
            transfer.cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    async fn begin_transfer(
        &self,
        connection_id: &str,
        transfer_id: &str,
    ) -> Result<Arc<AtomicBool>, AppError> {
        Uuid::parse_str(transfer_id)
            .map_err(|_| AppError::Validation("传输 ID 无效".to_owned()))?;
        self.entry(connection_id).await?;
        let mut transfers = self.inner.transfers.lock().await;
        if transfers.contains_key(transfer_id) {
            return Err(AppError::Conflict("传输 ID 已存在".to_owned()));
        }
        if transfers
            .values()
            .any(|transfer| transfer.connection_id == connection_id)
        {
            return Err(AppError::Busy("当前会话已有文件传输".to_owned()));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        transfers.insert(
            transfer_id.to_owned(),
            ActiveTransfer {
                connection_id: connection_id.to_owned(),
                cancelled: cancelled.clone(),
            },
        );
        Ok(cancelled)
    }

    async fn end_transfer(&self, transfer_id: &str) {
        self.inner.transfers.lock().await.remove(transfer_id);
    }

    pub(super) async fn cancel_connection_transfers(&self, connection_id: &str) {
        for transfer in self.inner.transfers.lock().await.values() {
            if transfer.connection_id == connection_id {
                transfer.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }
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
