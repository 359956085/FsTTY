use super::{open_sftp, ConnectionManager, SFTP_TIMEOUT};
use crate::models::{AppError, FileKind, PermissionPatch, RemotePermissionEntry};
use crate::services::connection_paths::{
    checked_join_remote_path, normalize_mutable_remote_path, normalize_remote_path,
};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, FileType, StatusCode},
};

fn details(path: String, attr: FileAttributes) -> RemotePermissionEntry {
    let kind = match attr.file_type() {
        FileType::Dir => FileKind::Folder,
        FileType::File => FileKind::File,
        FileType::Symlink => FileKind::Symlink,
        FileType::Other => FileKind::Other,
    };
    RemotePermissionEntry {
        name: path.rsplit('/').next().unwrap_or_default().into(),
        path,
        kind,
        mode: attr.permissions,
        size: attr.size.unwrap_or(0),
        owner: attr
            .user
            .or_else(|| attr.uid.map(|id| id.to_string()))
            .unwrap_or_else(|| "--".into()),
        group: attr
            .group
            .or_else(|| attr.gid.map(|id| id.to_string()))
            .unwrap_or_else(|| "--".into()),
    }
}
fn remote_error(error: SftpError) -> AppError {
    match error {
        SftpError::Status(ref status) if status.status_code == StatusCode::NoSuchFile => {
            AppError::NotFound("远程项目不存在".into())
        }
        SftpError::Status(ref status) if status.status_code == StatusCode::PermissionDenied => {
            AppError::Sftp("当前账号权限不足".into())
        }
        error => AppError::Sftp(format!("远程文件操作失败：{error}")),
    }
}
impl ConnectionManager {
    pub async fn file_details(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<RemotePermissionEntry, AppError> {
        let path = normalize_remote_path(path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let attr = tokio::time::timeout(SFTP_TIMEOUT, sftp.symlink_metadata(path.clone()))
            .await
            .map_err(|_| AppError::Sftp("读取远程属性超时".into()))?
            .map_err(remote_error)?;
        Ok(details(path, attr))
    }
    pub(crate) async fn tree_children(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<Vec<RemotePermissionEntry>, AppError> {
        let path = normalize_remote_path(path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let meta = tokio::time::timeout(SFTP_TIMEOUT, sftp.symlink_metadata(path.clone()))
            .await
            .map_err(|_| AppError::Sftp("目录检查超时".into()))?
            .map_err(remote_error)?;
        if !meta.file_type().is_dir() {
            return Err(AppError::Conflict("远程目录已变化或是链接".into()));
        }
        // Read protocol pages directly: the high-level iterator buffers the entire directory.
        let raw = {
            let handle = entry.handle.lock().await;
            let channel = tokio::time::timeout(SFTP_TIMEOUT, handle.channel_open_session())
                .await
                .map_err(|_| AppError::Sftp("创建目录扫描通道超时".into()))?
                .map_err(|e| AppError::Sftp(e.to_string()))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| AppError::Sftp(e.to_string()))?;
            let raw = RawSftpSession::new(channel.into_stream());
            raw.set_timeout(SFTP_TIMEOUT.as_secs());
            raw.init().await.map_err(remote_error)?;
            raw
        };
        let handle = raw
            .opendir(path.clone())
            .await
            .map_err(remote_error)?
            .handle;
        let mut entries = Vec::new();
        let result = async {
            loop {
                match raw.readdir(handle.clone()).await {
                    Ok(page) => {
                        for child in page.files {
                            if child.filename == "." || child.filename == ".." {
                                continue;
                            }
                            if entries.len() >= 10_000 {
                                return Err(AppError::Validation("目录项目超过 10000 个".into()));
                            }
                            entries.push(details(
                                checked_join_remote_path(&path, &child.filename)?,
                                child.attrs,
                            ));
                        }
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break
                    }
                    Err(error) => return Err(remote_error(error)),
                }
            }
            Ok(())
        }
        .await;
        let closed = raw.close(handle).await.map_err(remote_error);
        result?;
        closed?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }
    pub(crate) async fn ensure_upload_directory(
        &self,
        connection_id: &str,
        base: &str,
        segments: &[String],
    ) -> Result<String, AppError> {
        let mut path = normalize_remote_path(base)?;
        if self.file_details(connection_id, &path).await?.kind != FileKind::Folder {
            return Err(AppError::Conflict("上传目标不是普通目录".into()));
        }
        for segment in segments {
            let child = checked_join_remote_path(&path, segment)?;
            match self.file_details(connection_id, &child).await {
                Ok(entry) if entry.kind == FileKind::Folder => {}
                Ok(_) => return Err(AppError::Conflict(format!("目标不是普通目录：{child}"))),
                Err(AppError::NotFound(_)) => {
                    self.create_remote_directory(connection_id, &path, segment)
                        .await?;
                    if self.file_details(connection_id, &child).await?.kind != FileKind::Folder {
                        return Err(AppError::Conflict("远程目录已变化".into()));
                    }
                }
                Err(error) => return Err(error),
            }
            path = child;
        }
        Ok(path)
    }
    pub(crate) async fn check_tree_parents(
        &self,
        connection: &str,
        source: &str,
        count: usize,
    ) -> Result<(), AppError> {
        let mut path = source;
        for _ in 0..count {
            path = path
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or("/");
            if self.file_details(connection, path).await?.kind != FileKind::Folder {
                return Err(AppError::Conflict("源目录已变化或是链接".into()));
            }
        }
        Ok(())
    }
    pub(crate) async fn patch_permissions(
        &self,
        connection_id: &str,
        path: &str,
        expected: FileKind,
        patch: PermissionPatch,
    ) -> Result<bool, AppError> {
        patch.validate()?;
        let path = normalize_mutable_remote_path(path, "不允许修改文件系统根目录权限")?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let meta = tokio::time::timeout(SFTP_TIMEOUT, sftp.symlink_metadata(path.clone()))
            .await
            .map_err(|_| AppError::Sftp("权限检查超时".into()))?
            .map_err(remote_error)?;
        if !(meta.file_type().is_file() || meta.file_type().is_dir()) {
            return Ok(false);
        }
        if (expected == FileKind::Folder) != meta.file_type().is_dir() {
            return Err(AppError::Conflict("远程项目类型已变化".into()));
        }
        let mode = meta
            .permissions
            .ok_or_else(|| AppError::Sftp("服务器未提供权限信息".into()))?;
        let next = patch.apply(mode)?;
        if mode & 0o7777 == next {
            return Ok(false);
        }
        let mut attr = FileAttributes::empty();
        attr.permissions = Some(next);
        tokio::time::timeout(SFTP_TIMEOUT, sftp.set_metadata(path, attr))
            .await
            .map_err(|_| AppError::Sftp("修改权限超时".into()))?
            .map_err(remote_error)?;
        Ok(true)
    }
}
