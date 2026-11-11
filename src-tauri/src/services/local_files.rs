use crate::models::{AppError, FileKind, LocalUploadDirectory, LocalUploadEntry};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
static LAST_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LAST_DIRECTORY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
pub(crate) fn last_directory() -> Option<String> {
    LAST_DIRECTORY.lock().ok().and_then(|p| p.clone())
}

pub(crate) fn local_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        value.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}
pub(crate) fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
pub(crate) fn absolute_local(path: &str) -> Result<PathBuf, AppError> {
    if path.is_empty()
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || !Path::new(path).is_absolute()
    {
        return Err(AppError::Validation("本地路径无效".into()));
    }
    Ok(PathBuf::from(path))
}
pub(crate) fn local_entry(path: &Path, metadata: &std::fs::Metadata) -> LocalUploadEntry {
    let kind = if is_link(metadata) {
        FileKind::Symlink
    } else if metadata.is_dir() {
        FileKind::Folder
    } else if metadata.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    LocalUploadEntry {
        name: path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        kind,
        size: metadata.is_file().then_some(metadata.len()),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis().min(u64::MAX as u128) as u64),
    }
}
pub(crate) async fn list_directory(path: &str) -> Result<LocalUploadDirectory, AppError> {
    let generation = LAST_REQUEST.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
    let requested = absolute_local(path)?;
    let path = tokio::fs::canonicalize(&requested)
        .await
        .map_err(|e| AppError::Validation(format!("无法访问本地目录：{e}")))?;
    let mut reader = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| AppError::Validation(format!("无法读取本地目录：{e}")))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| AppError::Validation(format!("无法读取本地目录：{e}")))?
    {
        if entries.len() == 10_000 {
            truncated = true;
            break;
        }
        let metadata = tokio::fs::symlink_metadata(entry.path())
            .await
            .map_err(|e| AppError::Validation(format!("无法读取本地项目信息：{e}")))?;
        entries.push(local_entry(&entry.path(), &metadata));
    }
    entries.sort_by_cached_key(|e| (e.kind != FileKind::Folder, e.name.to_lowercase()));
    if generation == LAST_REQUEST.load(std::sync::atomic::Ordering::Acquire) {
        if let Ok(mut last) = LAST_DIRECTORY.lock() {
            *last = Some(path.to_string_lossy().into_owned());
        }
    }
    Ok(LocalUploadDirectory {
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}
// Anchor once to the explicitly selected destination; reject links in descendants.
pub(crate) async fn ensure_directory(root: &Path, relative: &Path) -> Result<PathBuf, AppError> {
    let metadata = tokio::fs::symlink_metadata(root)
        .await
        .map_err(|e| AppError::Validation(e.to_string()))?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err(AppError::Conflict("本地目标目录已变化".into()));
    }
    let mut path = root.to_owned();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(AppError::Validation("目录路径越界".into()));
        };
        path.push(name);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) if !is_link(&meta) && meta.is_dir() => {}
            Ok(_) => return Err(AppError::Conflict("本地目标不是普通目录".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tokio::fs::create_dir(&path)
                    .await
                    .map_err(|e| AppError::Persistence(format!("无法创建本地目录：{e}")))?;
                let meta = tokio::fs::symlink_metadata(&path)
                    .await
                    .map_err(|e| AppError::Persistence(e.to_string()))?;
                if is_link(&meta) || !meta.is_dir() {
                    return Err(AppError::Conflict("本地目录已变化".into()));
                }
            }
            Err(e) => return Err(AppError::Persistence(format!("无法检查本地目录：{e}"))),
        }
    }
    Ok(path)
}
