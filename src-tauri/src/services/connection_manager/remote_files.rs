use super::super::connection_paths::{
    checked_join_remote_path, is_same_or_remote_descendant, normalize_mutable_remote_path,
    normalize_remote_path, remote_parent_path, resolve_remote_child, resolve_remote_move_target,
    validate_remote_name,
};
use super::{open_sftp, ConnectionManager, MAX_REMOTE_SEARCH_BYTES};
use crate::models::{AppError, FileEntry, FileKind};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;
use russh_sftp::protocol::{FilePermissions, FileType as SftpFileType};
use std::{future::Future, io::SeekFrom, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub(super) enum RemoteReadKind {
    Directory,
    File,
}

pub(super) fn map_sftp_read_error(
    error: SftpError,
    kind: RemoteReadKind,
    username: &str,
    fallback: &str,
) -> AppError {
    if matches!(
        error,
        SftpError::Status(ref status) if status.status_code == StatusCode::PermissionDenied
    ) {
        let target = match kind {
            RemoteReadKind::Directory => "目录",
            RemoteReadKind::File => "文件",
        };
        return AppError::Sftp(format!("无法读取{target}：当前账号“{username}”权限不足"));
    }
    AppError::Sftp(fallback.to_owned())
}

pub(super) async fn join_directory_reads<MetadataFuture, DirectoryFuture>(
    metadata: MetadataFuture,
    directory: DirectoryFuture,
) -> (MetadataFuture::Output, DirectoryFuture::Output)
where
    MetadataFuture: Future,
    DirectoryFuture: Future,
{
    tokio::join!(metadata, directory)
}

pub(crate) struct RemoteFileWindow {
    pub(crate) content: Vec<u8>,
    pub(crate) offset: u64,
    pub(crate) file_size: u64,
    pub(crate) starts_at_line_boundary: bool,
    pub(crate) end_of_file: bool,
}

pub(super) fn file_entry_from_remote(entry: russh_sftp::client::fs::DirEntry) -> Option<FileEntry> {
    let name = entry.file_name();
    validate_remote_name(&name).ok()?;
    let path = normalize_remote_path(&entry.path()).ok()?;
    let metadata = entry.metadata();
    let kind = match metadata.file_type() {
        SftpFileType::Dir => FileKind::Folder,
        SftpFileType::File => FileKind::File,
        SftpFileType::Symlink => FileKind::Symlink,
        SftpFileType::Other => FileKind::Other,
    };
    let mode = metadata.permissions.unwrap_or_default();
    let type_prefix = match kind {
        FileKind::Folder => 'd',
        FileKind::File => '-',
        FileKind::Symlink => 'l',
        FileKind::Other => '?',
    };
    let symbolic = FilePermissions::from(mode).to_string();
    Some(FileEntry {
        name,
        path,
        kind,
        size: matches!(kind, FileKind::File).then_some(metadata.len()),
        modified_at: metadata.mtime.map(|value| value as u64 * 1000),
        owner: metadata
            .user
            .or_else(|| metadata.uid.map(|value| value.to_string()))
            .unwrap_or_else(|| "--".to_owned()),
        group: metadata
            .group
            .or_else(|| metadata.gid.map(|value| value.to_string()))
            .unwrap_or_else(|| "--".to_owned()),
        permissions: format!("{type_prefix}{symbolic} ({:03o})", mode & 0o7777),
    })
}

fn file_kind_rank(kind: FileKind) -> u8 {
    match kind {
        FileKind::Folder => 0,
        FileKind::File => 1,
        FileKind::Symlink => 2,
        FileKind::Other => 3,
    }
}

pub(super) fn sort_file_entries(files: &mut Vec<FileEntry>) {
    let mut keyed = files
        .drain(..)
        .map(|entry| (file_kind_rank(entry.kind), entry.name.to_lowercase(), entry))
        .collect::<Vec<_>>();
    keyed.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    files.extend(keyed.into_iter().map(|(_, _, entry)| entry));
}

impl ConnectionManager {
    pub async fn list_files(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, AppError> {
        let path = normalize_remote_path(path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = entry
            .browser_sftp
            .clone()
            .ok_or_else(|| AppError::Sftp("服务器不支持 SFTP".to_owned()))?;
        // 跨境连接的单次往返成本较高；两项互不依赖，应并发请求。
        let (metadata, directory) =
            join_directory_reads(sftp.symlink_metadata(path.clone()), sftp.read_dir(path)).await;
        let metadata = metadata.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::Directory,
                &entry.username,
                "无法读取远程目录信息",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::Validation("不允许进入符号链接目录".to_owned()));
        }
        if !metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程路径不是目录".to_owned()));
        }
        let directory = directory.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::Directory,
                &entry.username,
                "无法读取远程目录",
            )
        })?;
        let mut files = directory
            .filter_map(file_entry_from_remote)
            .collect::<Vec<_>>();
        sort_file_entries(&mut files);
        Ok(files)
    }

    pub async fn create_remote_directory(
        &self,
        connection_id: &str,
        parent_path: &str,
        name: &str,
    ) -> Result<(), AppError> {
        let target = resolve_remote_child(parent_path, name)?;
        let sftp = self.mutable_browser_sftp(connection_id).await?;
        if sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程目录是否存在".to_owned()))?
        {
            return Err(AppError::Conflict("远程目标已存在".to_owned()));
        }
        sftp.create_dir(target)
            .await
            .map_err(|_| AppError::Sftp("无法创建远程目录".to_owned()))
    }

    pub async fn rename_remote_entry(
        &self,
        connection_id: &str,
        path: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let source = normalize_mutable_remote_path(path, "禁止重命名远程根目录")?;
        let parent = remote_parent_path(&source);
        let target = resolve_remote_child(&parent, new_name)?;
        if source == target {
            return Ok(());
        }

        let sftp = self.mutable_browser_sftp(connection_id).await?;
        if sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程重命名目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程目标已存在".to_owned()));
        }
        sftp.rename(source, target)
            .await
            .map_err(|_| AppError::Sftp("无法重命名远程文件".to_owned()))
    }

    pub async fn move_remote_entry(
        &self,
        connection_id: &str,
        source_path: &str,
        target_directory: &str,
    ) -> Result<(), AppError> {
        let (source, target_directory, target) =
            resolve_remote_move_target(source_path, target_directory)?;
        if source == target {
            return Ok(());
        }

        let sftp = self.mutable_browser_sftp(connection_id).await?;
        let source_metadata = sftp
            .symlink_metadata(source.clone())
            .await
            .map_err(|_| AppError::Sftp("无法读取远程移动源".to_owned()))?;
        let target_metadata = sftp
            .symlink_metadata(target_directory.clone())
            .await
            .map_err(|_| AppError::Sftp("无法读取远程目标目录".to_owned()))?;
        if source_metadata.file_type().is_symlink()
            || (!source_metadata.file_type().is_file() && !source_metadata.file_type().is_dir())
        {
            return Err(AppError::Validation("只能移动普通文件或文件夹".to_owned()));
        }
        if target_metadata.file_type().is_symlink() || !target_metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程移动目标不是普通目录".to_owned()));
        }
        if source_metadata.file_type().is_dir()
            && is_same_or_remote_descendant(&target_directory, &source)
        {
            return Err(AppError::Validation(
                "不能将远程文件夹移动到自身或其子目录".to_owned(),
            ));
        }
        if sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程移动目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程目标已存在".to_owned()));
        }

        sftp.rename(source, target)
            .await
            .map_err(|_| AppError::Sftp("无法移动远程条目".to_owned()))
    }

    pub async fn delete_remote_entry(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<(), AppError> {
        let root = normalize_mutable_remote_path(path, "禁止删除远程根目录")?;
        let sftp = self.mutable_browser_sftp(connection_id).await?;
        let mut pending = vec![(root, false)];

        // 后序遍历确保先删除子项，再删除目录；符号链接始终按文件处理。
        while let Some((path, directory_visited)) = pending.pop() {
            if directory_visited {
                sftp.remove_dir(path).await.map_err(|_| {
                    AppError::Sftp("递归删除远程目录失败，部分内容可能已删除".to_owned())
                })?;
                continue;
            }

            let metadata = sftp.symlink_metadata(path.clone()).await.map_err(|_| {
                AppError::Sftp("无法读取远程删除目标，部分内容可能已删除".to_owned())
            })?;
            if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                let directory = sftp.read_dir(path.clone()).await.map_err(|_| {
                    AppError::Sftp("无法读取待删除目录，部分内容可能已删除".to_owned())
                })?;
                pending.push((path.clone(), true));
                for entry in directory {
                    let name = entry.file_name();
                    validate_remote_name(&name).map_err(|_| {
                        AppError::Sftp("待删除目录包含无效文件名，部分内容可能已删除".to_owned())
                    })?;
                    let child = checked_join_remote_path(&path, &name).map_err(|_| {
                        AppError::Sftp("待删除目录路径无效，部分内容可能已删除".to_owned())
                    })?;
                    pending.push((child, false));
                }
            } else {
                sftp.remove_file(path).await.map_err(|_| {
                    AppError::Sftp("删除远程文件失败，部分内容可能已删除".to_owned())
                })?;
            }
        }
        Ok(())
    }

    pub async fn read_remote_file(
        &self,
        connection_id: &str,
        path: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>, AppError> {
        let path = normalize_remote_path(path)?;
        if limit == 0 || limit > 1024 * 1024 {
            return Err(AppError::Validation("远程文件读取大小无效".to_owned()));
        }
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let mut file = sftp.open(path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| AppError::Sftp("无法定位远程文件".to_owned()))?;
        let mut content = vec![0_u8; limit];
        let read = file
            .read(&mut content)
            .await
            .map_err(|_| AppError::Sftp("无法读取远程文件".to_owned()))?;
        content.truncate(read);
        Ok(content)
    }

    pub(crate) async fn read_remote_file_window(
        &self,
        connection_id: &str,
        path: &str,
        offset: u64,
        tail: bool,
        limit: usize,
    ) -> Result<RemoteFileWindow, AppError> {
        let path = normalize_remote_path(path)?;
        if limit == 0 || limit > MAX_REMOTE_SEARCH_BYTES {
            return Err(AppError::Validation(
                "远程文件扫描大小必须在 1 字节到 16 MiB 之间".to_owned(),
            ));
        }
        if tail && offset != 0 {
            return Err(AppError::Validation(
                "尾部扫描不能同时指定起始偏移".to_owned(),
            ));
        }
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = sftp.metadata(path.clone()).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法读取远程文件信息",
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("远程目标不是普通文件".to_owned()));
        }
        let file_size = metadata.len();
        let start = if tail {
            file_size.saturating_sub(limit as u64)
        } else {
            offset.min(file_size)
        };
        let prefix_length = usize::from(start > 0);
        let available = file_size.saturating_sub(start) as usize;
        let content_length = available.min(limit);
        let seek_offset = start.saturating_sub(prefix_length as u64);
        let read_length = content_length.saturating_add(prefix_length);

        let mut file = sftp.open(path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        file.seek(SeekFrom::Start(seek_offset))
            .await
            .map_err(|_| AppError::Sftp("无法定位远程文件".to_owned()))?;
        let mut content = Vec::with_capacity(read_length);
        file.take(read_length as u64)
            .read_to_end(&mut content)
            .await
            .map_err(|_| AppError::Sftp("无法扫描远程文件".to_owned()))?;

        let starts_at_line_boundary = if prefix_length == 0 {
            true
        } else {
            let boundary = content.first().copied() == Some(b'\n');
            if !content.is_empty() {
                content.remove(0);
            }
            boundary
        };
        let end_of_file = start.saturating_add(content.len() as u64) >= file_size;
        Ok(RemoteFileWindow {
            content,
            offset: start,
            file_size,
            starts_at_line_boundary,
            end_of_file,
        })
    }

    pub async fn write_remote_file_atomic(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> Result<(), AppError> {
        let path = normalize_remote_path(path)?;
        let parent = remote_parent_path(&path);
        let temp =
            checked_join_remote_path(&parent, &format!(".fstty-mcp-{}.part", Uuid::new_v4()))?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        if sftp
            .try_exists(path.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }
        let mut file = sftp
            .create(temp.clone())
            .await
            .map_err(|_| AppError::Sftp("无法创建远程临时文件".to_owned()))?;
        if file.write_all(content).await.is_err() || file.shutdown().await.is_err() {
            let _ = sftp.remove_file(temp).await;
            return Err(AppError::Sftp("写入远程文件失败".to_owned()));
        }
        if sftp.rename(temp.clone(), path).await.is_err() {
            let _ = sftp.remove_file(temp).await;
            return Err(AppError::Sftp("提交远程文件失败".to_owned()));
        }
        Ok(())
    }

    async fn mutable_browser_sftp(
        &self,
        connection_id: &str,
    ) -> Result<Arc<SftpSession>, AppError> {
        let entry = self.entry(connection_id).await?;
        if self
            .inner
            .transfers
            .lock()
            .await
            .values()
            .any(|transfer| transfer.connection_id == connection_id)
        {
            return Err(AppError::Busy("当前会话正在传输文件".to_owned()));
        }
        entry
            .browser_sftp
            .clone()
            .ok_or_else(|| AppError::Sftp("服务器不支持 SFTP".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: FileKind) -> FileEntry {
        FileEntry {
            name: name.to_owned(),
            path: format!("/{name}"),
            kind,
            size: None,
            modified_at: None,
            owner: "root".to_owned(),
            group: "root".to_owned(),
            permissions: "--------- (000)".to_owned(),
        }
    }

    #[test]
    fn sorts_directories_first_and_names_case_insensitively() {
        let mut files = vec![
            entry("beta", FileKind::File),
            entry("Zoo", FileKind::Folder),
            entry("alpha", FileKind::File),
            entry("apple", FileKind::Folder),
        ];

        sort_file_entries(&mut files);

        assert_eq!(
            files
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["apple", "Zoo", "alpha", "beta"]
        );
    }
}
