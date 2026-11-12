use super::*;
use crate::models::{FileKind, PermissionPatch};
use crate::services::{
    connection_paths::checked_join_remote_path,
    local_files::{absolute_local, ensure_directory, is_link, local_key},
};
use std::path::PathBuf;
const MAX_ITEMS: usize = 10_000;
const MAX_DEPTH: usize = 64;
#[derive(Clone, Debug)]
pub(super) struct TreeItem {
    source: String,
    parts: Vec<String>,
    directory: bool,
}
#[derive(Default)]
pub(super) struct Manifest {
    items: Vec<TreeItem>,
    skipped: u32,
    scanned: usize,
}
fn record(manifest: &mut Manifest, depth: usize) -> Result<(), AppError> {
    manifest.scanned += 1;
    if manifest.scanned > MAX_ITEMS || depth > MAX_DEPTH {
        return Err(AppError::Validation(
            "目录传输最多 10000 个项目、64 层深度".into(),
        ));
    }
    Ok(())
}
fn child_path(root: &Path, parts: &[String]) -> PathBuf {
    parts.iter().fold(root.to_owned(), |p, n| p.join(n))
}
fn under(child: &str, parent: &str, separator: char) -> bool {
    child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|tail| tail.starts_with(separator))
}
fn local_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf> {
    roots.sort_by_key(|p| p.components().count());
    let mut result: Vec<PathBuf> = Vec::new();
    for root in roots {
        let key = local_key(&root);
        if !result
            .iter()
            .any(|p| under(&key, &local_key(p), std::path::MAIN_SEPARATOR))
        {
            result.push(root);
        }
    }
    result
}
pub(super) fn remote_roots(paths: Vec<String>) -> Result<Vec<String>, AppError> {
    let mut roots = paths
        .iter()
        .map(|p| normalize_remote_path(p))
        .collect::<Result<Vec<_>, _>>()?;
    roots.sort_by_key(|p| p.split('/').count());
    let mut result: Vec<String> = Vec::new();
    for root in roots {
        if root == "/" {
            return Err(AppError::Validation("不支持选择远程文件系统根目录".into()));
        }
        if !result.iter().any(|p| under(&root, p, '/')) {
            result.push(root);
        }
    }
    Ok(result)
}
pub(super) async fn scan_local(paths: Vec<String>) -> Result<Manifest, AppError> {
    let mut manifest = Manifest::default();
    let mut roots = Vec::new();
    for source in paths {
        let path = absolute_local(&source)?;
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| AppError::Validation(format!("无法读取上传源：{e}")))?;
        if is_link(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
            record(&mut manifest, 0)?;
            manifest.skipped += 1;
            continue;
        }
        roots.push(
            tokio::fs::canonicalize(path)
                .await
                .map_err(|e| AppError::Validation(e.to_string()))?,
        );
    }
    let mut pending = Vec::new();
    for root in local_roots(roots) {
        let name = root
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| AppError::Validation("上传项目名称无效".into()))?
            .to_owned();
        pending.push((root, vec![name]));
    }
    let mut destinations = HashSet::new();
    while let Some((path, parts)) = pending.pop() {
        record(&mut manifest, parts.len() - 1)?;
        let metadata = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| AppError::Validation(format!("上传项目已变化：{e}")))?;
        if is_link(&metadata) || !(metadata.is_dir() || metadata.is_file()) {
            manifest.skipped += 1;
            continue;
        }
        // Validate every segment before any destination is written.
        let mut remote = "/".to_owned();
        for part in &parts {
            remote = checked_join_remote_path(&remote, part)?;
        }
        let target = parts.join("/");
        #[cfg(windows)]
        let target = target.to_lowercase();
        if !destinations.insert(target) {
            return Err(AppError::Validation("上传项目存在目标名称冲突".into()));
        }
        let directory = metadata.is_dir();
        if directory {
            let mut reader = tokio::fs::read_dir(&path)
                .await
                .map_err(|e| AppError::Validation(format!("无法扫描本地目录：{e}")))?;
            while let Some(child) = reader
                .next_entry()
                .await
                .map_err(|e| AppError::Validation(e.to_string()))?
            {
                if pending.len() + manifest.scanned >= MAX_ITEMS {
                    return Err(AppError::Validation("目录项目超过 10000 个".into()));
                }
                let name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| AppError::Validation("文件名不是有效 Unicode".into()))?;
                let mut child_parts = parts.clone();
                child_parts.push(name);
                pending.push((child.path(), child_parts));
            }
        }
        manifest.items.push(TreeItem {
            source: path.to_string_lossy().into_owned(),
            parts,
            directory,
        });
    }
    Ok(manifest)
}
async fn scan_remote(
    manager: &ConnectionManager,
    connection: &str,
    paths: Vec<String>,
    recursive: bool,
    download: bool,
) -> Result<Manifest, AppError> {
    let mut manifest = Manifest::default();
    let mut pending = Vec::new();
    for path in remote_roots(paths)? {
        let entry = manager.file_details(connection, &path).await?;
        pending.push((entry, Vec::<String>::new()));
    }
    pending.reverse();
    let mut destinations = HashSet::new();
    while let Some((entry, mut parts)) = pending.pop() {
        if parts.is_empty() {
            parts.push(entry.name.clone());
        }
        record(&mut manifest, parts.len() - 1)?;
        if !matches!(entry.kind, FileKind::File | FileKind::Folder) {
            manifest.skipped += 1;
            continue;
        }
        if download
            && parts
                .iter()
                .any(|p| !download_batch::valid_download_name(p))
        {
            return Err(AppError::Validation(format!(
                "名称无法保存到本地：{}",
                entry.path
            )));
        }
        if download {
            let target = parts.join("/");
            #[cfg(windows)]
            let target = target.to_lowercase();
            if !destinations.insert(target) {
                return Err(AppError::Validation("下载项目存在本地名称冲突".into()));
            }
        }
        let directory = entry.kind == FileKind::Folder;
        if directory && recursive {
            for child in manager
                .tree_children(connection, &entry.path)
                .await?
                .into_iter()
                .rev()
            {
                if pending.len() + manifest.scanned >= MAX_ITEMS {
                    return Err(AppError::Validation("目录项目超过 10000 个".into()));
                }
                let mut child_parts = parts.clone();
                child_parts.push(child.name.clone());
                pending.push((child, child_parts));
            }
        }
        manifest.items.push(TreeItem {
            source: entry.path,
            parts,
            directory,
        });
    }
    Ok(manifest)
}
async fn fail(job: &TransferJob, error: AppError) {
    job.update(|s| {
        s.state = TransferJobState::Failed;
        s.message = Some(error.to_string());
        s.active_count = 0;
        s.queued_count = 0;
    })
    .await;
}
pub(super) async fn start_manifest(job: &TransferJob, manifest: &Manifest, phase: &str) {
    job.update(|s| {
        s.details.phase = Some(phase.into());
        s.details.item_total = manifest.scanned as u32;
        s.details.processed_items = manifest.skipped;
        s.skipped = manifest.skipped;
        s.batch_total = manifest.items.iter().filter(|i| !i.directory).count() as u32;
        s.details.total_files = Some(s.batch_total);
        s.details.total_directories =
            Some(manifest.items.iter().filter(|i| i.directory).count() as u32);
        s.queued_count = s.batch_total;
    })
    .await;
}
async fn finish(job: &TransferJob) {
    job.update(|s| {
        s.state = if s.failed > 0
            && s.uploaded
                + s.downloaded
                + s.details.completed_directories
                + s.details.changed_permissions
                == 0
        {
            TransferJobState::Failed
        } else {
            TransferJobState::Completed
        };
        s.active_count = 0;
        s.queued_count = 0;
    })
    .await;
}
async fn item_error(job: &TransferJob, name: &str, error: AppError) {
    job.update(|s| {
        s.failed += 1;
        s.details.processed_items += 1;
        if s.message.is_none() {
            s.message = Some(format!("{name}: {error}"));
        }
    })
    .await;
}
async fn upload_one(
    manager: &ConnectionManager,
    job: &Arc<TransferJob>,
    connection: &str,
    item: &TreeItem,
    parent: &str,
) {
    job.update(|s| {
        s.file_name = item.parts.join("/");
        s.batch_index = s.uploaded + s.failed + 1;
        s.transferred_bytes = 0;
        s.total_bytes = 0;
        s.active_count = 1;
    })
    .await;
    let mut overwrite = false;
    loop {
        if job.cancellation.is_cancelled() {
            return;
        }
        let id = Uuid::new_v4().to_string();
        job.set_active_transfer(Some(id.clone())).await;
        let (reporter, task) = job_reporter(job.clone(), id.clone());
        let result = manager
            .upload_file_reported(connection, &id, &item.source, parent, overwrite, reporter)
            .await;
        let _ = task.await;
        job.set_active_transfer(None).await;
        if job.cancellation.is_cancelled() {
            return;
        }
        match result {
            Ok(()) => {
                job.update(|s| s.uploaded += 1).await;
                break;
            }
            Err(AppError::Conflict(_)) if !overwrite => {
                // A directory or symlink cannot be overwritten as a file.
                let target = checked_join_remote_path(parent, item.parts.last().expect("nonempty"));
                if let Ok(target) = target {
                    if manager
                        .file_details(connection, &target)
                        .await
                        .is_ok_and(|m| m.kind != FileKind::File)
                    {
                        item_error(job, &target, AppError::Conflict("目标类型不匹配".into())).await;
                        return;
                    }
                }
                job.update(|s| s.state = TransferJobState::WaitingForConflict)
                    .await;
                match wait_for_conflict_decision(manager, job, connection).await {
                    TransferConflictDecision::Overwrite => {
                        overwrite = true;
                        job.update(|s| s.state = TransferJobState::Running).await;
                    }
                    TransferConflictDecision::Skip => {
                        job.update(|s| s.skipped += 1).await;
                        break;
                    }
                    TransferConflictDecision::Cancel => {
                        job.cancelled.store(true, Ordering::Release);
                        job.cancellation.cancel();
                        return;
                    }
                }
            }
            Err(error) => {
                item_error(job, &item.source, error).await;
                return;
            }
        }
    }
    job.update(|s| {
        s.details.processed_items += 1;
        s.active_count = 0;
        s.queued_count = s.queued_count.saturating_sub(1);
    })
    .await;
}
pub(super) async fn run_upload_tree(
    manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection: String,
    paths: Vec<String>,
    base: String,
) {
    if job.cancelled.load(Ordering::Acquire) {
        finish_cancelled(&job).await;
        return;
    }
    job.update(|s| s.details.phase = Some("scanning".into()))
        .await;
    let scan = tokio::select! { biased; _=job.cancellation.cancelled()=>{finish_cancelled(&job).await;return;}, result=scan_local(paths)=>result };
    let manifest = match scan {
        Ok(m) => m,
        Err(e) => {
            fail(&job, e).await;
            return;
        }
    };
    start_manifest(&job, &manifest, "transferring").await;
    let mut items = manifest.items;
    items.sort_by_key(|i| (i.parts.len(), !i.directory));
    let mut blocked: Vec<Vec<String>> = Vec::new();
    for item in items {
        if job.cancellation.is_cancelled() {
            finish_cancelled(&job).await;
            return;
        }
        if blocked.iter().any(|prefix| item.parts.starts_with(prefix)) {
            job.update(|s| {
                s.skipped += 1;
                s.details.processed_items += 1;
            })
            .await;
            continue;
        }
        let count = if item.directory {
            item.parts.len()
        } else {
            item.parts.len() - 1
        };
        match manager
            .ensure_upload_directory(&connection, &base, &item.parts[..count])
            .await
        {
            Ok(parent) if !item.directory => {
                // Revalidate source ancestors; never follow a directory replaced with a link.
                let source = Path::new(&item.source);
                let mut valid = true;
                for ancestor in source.ancestors().take(item.parts.len()) {
                    if !matches!(tokio::fs::symlink_metadata(ancestor).await, Ok(m) if !is_link(&m))
                    {
                        valid = false;
                        break;
                    }
                }
                if valid {
                    upload_one(&manager, &job, &connection, &item, &parent).await;
                } else {
                    item_error(
                        &job,
                        &item.source,
                        AppError::Conflict("上传源目录已变化".into()),
                    )
                    .await;
                }
            }
            Ok(_) => {
                job.update(|s| {
                    s.details.completed_directories += 1;
                    s.details.processed_items += 1;
                })
                .await;
            }
            Err(e) => {
                if item.directory {
                    blocked.push(item.parts.clone());
                }
                item_error(&job, &item.source, e).await;
            }
        }
    }
    if job.cancellation.is_cancelled() {
        finish_cancelled(&job).await;
    } else {
        finish(&job).await;
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_permissions(
    manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection: String,
    paths: Vec<String>,
    recursive: bool,
    files: PermissionPatch,
    directories: PermissionPatch,
) {
    job.update(|s| s.details.phase = Some("scanning".into()))
        .await;
    let scan = tokio::select! { _=job.cancellation.cancelled()=>{finish_cancelled(&job).await;return;}, result=scan_remote(&manager,&connection,paths,recursive,false)=>result };
    let manifest = match scan {
        Ok(m) => m,
        Err(e) => {
            fail(&job, e).await;
            return;
        }
    };
    start_manifest(&job, &manifest, "applying").await;
    let mut items = manifest.items;
    items.sort_by_key(|i| (i.directory, std::cmp::Reverse(i.parts.len())));
    for item in items {
        if job.cancellation.is_cancelled() {
            finish_cancelled(&job).await;
            return;
        }
        let patch = if item.directory { directories } else { files };
        job.update(|s| s.file_name = item.source.clone()).await;
        if patch.mask == 0 {
            job.update(|s| {
                s.skipped += 1;
                s.details.processed_items += 1;
            })
            .await;
            continue;
        }
        if let Err(error) = manager
            .check_tree_parents(&connection, &item.source, item.parts.len() - 1)
            .await
        {
            item_error(&job, &item.source, error).await;
            continue;
        }
        let result = manager
            .patch_permissions(
                &connection,
                &item.source,
                if item.directory {
                    FileKind::Folder
                } else {
                    FileKind::File
                },
                patch,
            )
            .await;
        match result {
            Ok(changed) => {
                job.update(|s| {
                    s.details.processed_items += 1;
                    if changed {
                        s.details.changed_permissions += 1;
                    } else {
                        s.skipped += 1;
                    }
                })
                .await;
            }
            Err(e) => item_error(&job, &item.source, e).await,
        }
    }
    if job.cancellation.is_cancelled() {
        finish_cancelled(&job).await;
    } else {
        finish(&job).await;
    }
}
pub(super) async fn run_download_tree(
    manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection: String,
    paths: Vec<String>,
    local: String,
    slots: Arc<Semaphore>,
) {
    job.update(|s| s.details.phase = Some("scanning".into()))
        .await;
    let scan = tokio::select! {biased; _=job.cancellation.cancelled()=>{finish_cancelled(&job).await;return;},result=scan_remote(&manager,&connection,paths,true,true)=>result};
    let manifest = match scan {
        Ok(m) => m,
        Err(e) => {
            fail(&job, e).await;
            return;
        }
    };
    let root = match tokio::fs::canonicalize(&local).await {
        Ok(p) => p,
        Err(e) => {
            fail(&job, AppError::Validation(format!("无法打开下载目标：{e}"))).await;
            return;
        }
    };
    start_manifest(&job, &manifest, "transferring").await;
    let mut items = manifest.items;
    items.sort_by_key(|i| (i.parts.len(), !i.directory));
    let mut blocked: Vec<Vec<String>> = Vec::new();
    let mut targets = Vec::new();
    for item in items {
        if job.cancellation.is_cancelled() {
            finish_cancelled(&job).await;
            return;
        }
        if blocked.iter().any(|p| item.parts.starts_with(p)) {
            job.update(|s| {
                s.skipped += 1;
                s.details.processed_items += 1;
            })
            .await;
            continue;
        }
        let directory_parts = if item.directory {
            &item.parts[..]
        } else {
            &item.parts[..item.parts.len() - 1]
        };
        let relative = child_path(Path::new(""), directory_parts);
        match ensure_directory(&root, &relative).await {
            Ok(_) if item.directory => {
                job.update(|s| {
                    s.details.completed_directories += 1;
                    s.details.processed_items += 1;
                })
                .await;
            }
            Ok(_) => targets.push((
                item.source,
                child_path(&root, &item.parts)
                    .to_string_lossy()
                    .into_owned(),
            )),
            Err(e) => {
                if item.directory {
                    blocked.push(item.parts.clone());
                }
                item_error(&job, &item.source, e).await;
            }
        }
    }
    if targets.is_empty() {
        finish(&job).await;
        return;
    }
    let worker_job = job.clone();
    download_batch::run_download_queue(job, slots, targets, move |index, remote, local| {
        let manager = manager.clone();
        let job = worker_job.clone();
        let connection = connection.clone();
        let root = root.clone();
        async move {
            let path = Path::new(&local);
            let relative = path.parent().and_then(|p| p.strip_prefix(&root).ok());
            if let Some(relative) = relative {
                if let Err(e) = ensure_directory(&root, relative).await {
                    return download_batch::DownloadOutcome::Failed(e.to_string());
                }
            } else {
                return download_batch::DownloadOutcome::Failed("本地目标越界".into());
            }
            let parent_count = path
                .strip_prefix(&root)
                .map(|p| p.components().count().saturating_sub(1))
                .unwrap_or(0);
            if let Err(e) = manager
                .check_tree_parents(&connection, &remote, parent_count)
                .await
            {
                return download_batch::DownloadOutcome::Failed(e.to_string());
            }
            download_batch::download_one(manager, job, connection, index, remote, local).await
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_limits_and_overlapping_roots_are_bounded() {
        let mut m = Manifest {
            scanned: MAX_ITEMS - 1,
            ..Default::default()
        };
        assert!(record(&mut m, MAX_DEPTH).is_ok());
        assert!(record(&mut m, 0).is_err());
        assert!(record(&mut Manifest::default(), MAX_DEPTH + 1).is_err());
        assert_eq!(
            remote_roots(vec!["/a/b".into(), "/a".into(), "/ab".into()]).unwrap(),
            vec!["/a", "/ab"]
        );
        assert!(remote_roots(vec!["/".into()]).is_err());
    }
    #[tokio::test]
    async fn local_scan_preserves_empty_and_hidden_and_deduplicates_roots() {
        let root = std::env::temp_dir().join(format!("fm-scan-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(root.join("empty")).await.unwrap();
        tokio::fs::write(root.join(".hidden"), b"data")
            .await
            .unwrap();
        let m = scan_local(vec![
            root.to_string_lossy().into_owned(),
            root.join(".hidden").to_string_lossy().into_owned(),
        ])
        .await
        .unwrap();
        assert_eq!(m.items.len(), 3);
        assert_eq!(m.items.iter().filter(|i| i.directory).count(), 2);
        assert_eq!(m.items.iter().filter(|i| !i.directory).count(), 1);
        assert!(ensure_directory(&root, Path::new("../outside"))
            .await
            .is_err());
        assert!(ensure_directory(&root, Path::new(".hidden/child"))
            .await
            .is_err());
        let canonical = tokio::fs::canonicalize(&root).await.unwrap();
        assert_eq!(
            canonical.parent(),
            Some(
                tokio::fs::canonicalize(std::env::temp_dir())
                    .await
                    .unwrap()
                    .as_path()
            )
        );
        tokio::fs::remove_dir_all(canonical).await.unwrap();
    }
}
