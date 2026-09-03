use super::connection_manager::TransferReporter;
use super::connection_paths::normalize_remote_path;
use super::ConnectionManager;
use crate::models::{
    AppError, StartTransferJobRequest, TransferConflictDecision, TransferEvent,
    TransferJobDirection, TransferJobEvent, TransferJobState, TransferJobSummary,
};
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::{watch, Mutex, Notify};
use uuid::Uuid;

const MAX_JOBS: usize = 256;
const MAX_UPLOAD_FILES: usize = 256;

struct TransferJob {
    summary: Mutex<TransferJobSummary>,
    channel: Mutex<Option<Channel<TransferJobEvent>>>,
    active_transfer_id: Mutex<Option<String>>,
    decision: Mutex<Option<TransferConflictDecision>>,
    decision_notify: Notify,
    cancelled: Arc<AtomicBool>,
}

impl TransferJob {
    fn new(summary: TransferJobSummary) -> Self {
        Self {
            summary: Mutex::new(summary),
            channel: Mutex::new(None),
            active_transfer_id: Mutex::new(None),
            decision: Mutex::new(None),
            decision_notify: Notify::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    async fn snapshot(&self) -> TransferJobSummary {
        self.summary.lock().await.clone()
    }

    async fn update(&self, update: impl FnOnce(&mut TransferJobSummary)) {
        // 摘要更新与事件发送持同一顺序锁，防止旧状态晚于完成状态到达新窗口。
        let mut summary = self.summary.lock().await;
        update(&mut summary);
        let snapshot = summary.clone();
        let mut channel = self.channel.lock().await;
        if channel.as_ref().is_some_and(|channel| {
            channel
                .send(TransferJobEvent::Updated {
                    job: snapshot.clone(),
                })
                .is_err()
        }) {
            *channel = None;
        }
    }

    async fn attach(
        &self,
        channel: Channel<TransferJobEvent>,
    ) -> Result<TransferJobSummary, AppError> {
        // 与 update 保持“摘要 → 通道”的加锁顺序，避免安装通道时漏掉最终状态。
        let summary = self.summary.lock().await;
        let mut current_channel = self.channel.lock().await;
        let snapshot = summary.clone();
        channel
            .send(TransferJobEvent::Updated {
                job: snapshot.clone(),
            })
            .map_err(|_| AppError::Connection("后台传输通道已关闭".to_owned()))?;
        *current_channel = Some(channel);
        Ok(snapshot)
    }

    async fn set_active_transfer(&self, transfer_id: Option<String>) {
        *self.active_transfer_id.lock().await = transfer_id;
    }

    async fn apply_progress(&self, transfer_id: &str, event: TransferEvent) {
        let active_transfer = self.active_transfer_id.lock().await;
        if active_transfer.as_deref() != Some(transfer_id) {
            return;
        }
        let (transferred_bytes, total_bytes, cancelled) = match event {
            TransferEvent::Progress {
                transferred_bytes,
                total_bytes,
                ..
            }
            | TransferEvent::Completed {
                transferred_bytes,
                total_bytes,
                ..
            } => (transferred_bytes, total_bytes, false),
            TransferEvent::Cancelled {
                transferred_bytes,
                total_bytes,
                ..
            } => (transferred_bytes, total_bytes, true),
        };
        if cancelled {
            self.cancelled.store(true, Ordering::Release);
        }
        self.update(|summary| {
            if summary.state.is_terminal() {
                return;
            }
            summary.transferred_bytes = summary.transferred_bytes.max(transferred_bytes);
            summary.total_bytes = total_bytes;
            if cancelled {
                summary.state = TransferJobState::Cancelled;
            }
        })
        .await;
    }
}

#[derive(Clone, Default)]
pub struct TransferJobService {
    jobs: Arc<Mutex<HashMap<String, Arc<TransferJob>>>>,
}

impl TransferJobService {
    pub async fn start(
        &self,
        connection_manager: ConnectionManager,
        request: StartTransferJobRequest,
    ) -> Result<TransferJobSummary, AppError> {
        let (runtime_id, connection_id, direction, file_name, batch_total) =
            validate_request(&connection_manager, &request).await?;
        let job_id = Uuid::new_v4().to_string();
        let summary = TransferJobSummary {
            job_id: job_id.clone(),
            runtime_id,
            connection_id,
            direction,
            file_name,
            batch_index: 1,
            batch_total,
            transferred_bytes: 0,
            total_bytes: 0,
            state: TransferJobState::Running,
            message: None,
            uploaded: 0,
            skipped: 0,
            failed: 0,
        };
        let job = Arc::new(TransferJob::new(summary.clone()));
        {
            let mut jobs = self.jobs.lock().await;
            if jobs.len() >= MAX_JOBS {
                return Err(AppError::Busy("后台传输任务过多".to_owned()));
            }
            for existing in jobs.values() {
                let existing = existing.snapshot().await;
                if !existing.state.is_terminal()
                    && (existing.runtime_id == summary.runtime_id
                        || existing.connection_id == summary.connection_id)
                {
                    return Err(AppError::Busy("当前会话已有文件传输".to_owned()));
                }
            }
            jobs.insert(job_id, job.clone());
        }

        tauri::async_runtime::spawn(async move {
            match request {
                StartTransferJobRequest::UploadBatch {
                    connection_id,
                    local_paths,
                    remote_directory,
                    ..
                } => {
                    run_upload_batch(
                        connection_manager,
                        job,
                        connection_id,
                        local_paths,
                        remote_directory,
                    )
                    .await;
                }
                StartTransferJobRequest::Download {
                    connection_id,
                    remote_path,
                    local_path,
                    ..
                } => {
                    run_download(
                        connection_manager,
                        job,
                        connection_id,
                        remote_path,
                        local_path,
                    )
                    .await;
                }
            }
        });
        Ok(summary)
    }

    pub async fn attach(
        &self,
        job_id: &str,
        channel: Channel<TransferJobEvent>,
    ) -> Result<TransferJobSummary, AppError> {
        let job = self
            .jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("后台传输任务不存在".to_owned()))?;
        job.attach(channel).await
    }

    pub async fn resolve_conflict(
        &self,
        job_id: &str,
        decision: TransferConflictDecision,
    ) -> Result<(), AppError> {
        let job = self
            .jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("后台传输任务不存在".to_owned()))?;
        let mut pending = job.decision.lock().await;
        let summary = job.summary.lock().await;
        if summary.state != TransferJobState::WaitingForConflict || pending.is_some() {
            return Err(AppError::Conflict("后台传输任务未等待冲突处理".to_owned()));
        }
        drop(summary);
        *pending = Some(decision);
        drop(pending);
        job.decision_notify.notify_one();
        Ok(())
    }

    pub async fn acknowledge(&self, job_id: &str) -> Result<(), AppError> {
        let job = self
            .jobs
            .lock()
            .await
            .get(job_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("后台传输任务不存在".to_owned()))?;
        if !job.snapshot().await.state.is_terminal() {
            return Err(AppError::Busy("后台传输任务尚未结束".to_owned()));
        }
        self.jobs.lock().await.remove(job_id);
        Ok(())
    }

    pub async fn cancel(&self, connection_manager: &ConnectionManager, id: &str) -> bool {
        let jobs = self.jobs.lock().await.values().cloned().collect::<Vec<_>>();
        for job in jobs {
            let summary = job.snapshot().await;
            let active_transfer_id = job.active_transfer_id.lock().await.clone();
            if summary.job_id == id || active_transfer_id.as_deref() == Some(id) {
                job.cancelled.store(true, Ordering::Release);
                job.decision_notify.notify_one();
                if let Some(transfer_id) = active_transfer_id {
                    let _ = connection_manager.cancel_transfer(&transfer_id).await;
                }
                return true;
            }
        }
        false
    }

    pub async fn cancel_connection(
        &self,
        connection_manager: &ConnectionManager,
        connection_id: &str,
    ) {
        let jobs = self.jobs.lock().await.values().cloned().collect::<Vec<_>>();
        for job in jobs {
            let summary = job.snapshot().await;
            if summary.connection_id == connection_id {
                let job_id = summary.job_id;
                let _ = self.cancel(connection_manager, &job_id).await;
                self.jobs.lock().await.remove(&job_id);
            }
        }
    }

    pub async fn cleanup_orphans(
        &self,
        connection_manager: &ConnectionManager,
        valid_runtime_ids: &[String],
    ) {
        let valid = valid_runtime_ids.iter().cloned().collect::<HashSet<_>>();
        let jobs = self.jobs.lock().await.values().cloned().collect::<Vec<_>>();
        for job in jobs {
            let summary = job.snapshot().await;
            if valid.contains(&summary.runtime_id) {
                continue;
            }
            let _ = self.cancel(connection_manager, &summary.job_id).await;
            self.jobs.lock().await.remove(&summary.job_id);
        }
    }

    pub async fn summaries(&self) -> Vec<TransferJobSummary> {
        let jobs = self.jobs.lock().await.values().cloned().collect::<Vec<_>>();
        let mut summaries = Vec::with_capacity(jobs.len());
        for job in jobs {
            summaries.push(job.snapshot().await);
        }
        summaries.sort_by(|left, right| left.job_id.cmp(&right.job_id));
        summaries
    }

    pub async fn shutdown(&self, connection_manager: &ConnectionManager) {
        let jobs = self.jobs.lock().await.values().cloned().collect::<Vec<_>>();
        for job in &jobs {
            let summary = job.snapshot().await;
            let _ = self.cancel(connection_manager, &summary.job_id).await;
        }

        // 给 SFTP 循环留出清理临时文件的时间；超时后仍必须允许进程退出。
        let cleaned = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let mut all_terminal = true;
                for job in &jobs {
                    all_terminal &= job.snapshot().await.state.is_terminal();
                }
                if all_terminal {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .is_ok();
        if !cleaned {
            log::warn!("退出前等待后台传输清理超时");
        }
        self.jobs.lock().await.clear();
    }
}

async fn validate_request(
    connection_manager: &ConnectionManager,
    request: &StartTransferJobRequest,
) -> Result<(String, String, TransferJobDirection, String, u32), AppError> {
    let (runtime_id, connection_id, direction, file_name, batch_total) = match request {
        StartTransferJobRequest::UploadBatch {
            runtime_id,
            connection_id,
            local_paths,
            remote_directory,
        } => {
            if local_paths.is_empty()
                || local_paths.len() > MAX_UPLOAD_FILES
                || local_paths.iter().any(|path| !valid_local_path(path))
            {
                return Err(AppError::Validation("上传批次参数无效".to_owned()));
            }
            normalize_remote_path(remote_directory)?;
            (
                runtime_id,
                connection_id,
                TransferJobDirection::Upload,
                local_file_name(&local_paths[0]),
                local_paths.len() as u32,
            )
        }
        StartTransferJobRequest::Download {
            runtime_id,
            connection_id,
            remote_path,
            local_path,
        } => {
            if !valid_local_path(local_path) {
                return Err(AppError::Validation("下载任务参数无效".to_owned()));
            }
            normalize_remote_path(remote_path)?;
            (
                runtime_id,
                connection_id,
                TransferJobDirection::Download,
                remote_file_name(remote_path),
                1,
            )
        }
    };
    if Uuid::parse_str(runtime_id).is_err() || Uuid::parse_str(connection_id).is_err() {
        return Err(AppError::Validation("后台传输任务标识无效".to_owned()));
    }
    connection_manager.session_id(connection_id).await?;
    Ok((
        runtime_id.clone(),
        connection_id.clone(),
        direction,
        file_name,
        batch_total,
    ))
}

fn valid_local_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 32 * 1024
        && Path::new(path).is_absolute()
        && !path.chars().any(char::is_control)
}

async fn run_upload_batch(
    connection_manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection_id: String,
    local_paths: Vec<String>,
    remote_directory: String,
) {
    for (index, local_path) in local_paths.iter().enumerate() {
        if job.cancelled.load(Ordering::Acquire) {
            finish_cancelled(&job).await;
            return;
        }
        let file_name = local_file_name(local_path);
        job.update(|summary| {
            summary.file_name = file_name.clone();
            summary.batch_index = index as u32 + 1;
            summary.transferred_bytes = 0;
            summary.total_bytes = 0;
            summary.state = TransferJobState::Running;
            summary.message = None;
        })
        .await;

        let mut overwrite = false;
        loop {
            let transfer_id = Uuid::new_v4().to_string();
            job.set_active_transfer(Some(transfer_id.clone())).await;
            let (reporter, progress_task) = job_reporter(job.clone(), transfer_id.clone());
            let result = connection_manager
                .upload_file_reported(
                    &connection_id,
                    &transfer_id,
                    local_path,
                    &remote_directory,
                    overwrite,
                    reporter,
                )
                .await;
            let _ = progress_task.await;
            job.set_active_transfer(None).await;
            if job.cancelled.load(Ordering::Acquire) {
                finish_cancelled(&job).await;
                return;
            }
            match result {
                Ok(()) => {
                    job.update(|summary| summary.uploaded += 1).await;
                    break;
                }
                Err(AppError::Conflict(_)) if !overwrite => {
                    job.update(|summary| summary.state = TransferJobState::WaitingForConflict)
                        .await;
                    match wait_for_conflict_decision(&connection_manager, &job, &connection_id)
                        .await
                    {
                        TransferConflictDecision::Overwrite => {
                            overwrite = true;
                            job.update(|summary| summary.state = TransferJobState::Running)
                                .await;
                        }
                        TransferConflictDecision::Skip => {
                            job.update(|summary| summary.skipped += 1).await;
                            break;
                        }
                        TransferConflictDecision::Cancel => {
                            finish_cancelled(&job).await;
                            return;
                        }
                    }
                }
                Err(error) => {
                    job.update(|summary| {
                        summary.failed += 1;
                        summary.message = Some(error.to_string());
                    })
                    .await;
                    break;
                }
            }
        }
    }
    job.update(|summary| {
        summary.state = TransferJobState::Completed;
        if summary.skipped > 0 || summary.failed > 0 {
            summary.message = Some(format!(
                "上传结束：成功 {}，跳过 {}，失败 {}",
                summary.uploaded, summary.skipped, summary.failed
            ));
        }
    })
    .await;
}

async fn run_download(
    connection_manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection_id: String,
    remote_path: String,
    local_path: String,
) {
    let mut overwrite = false;
    loop {
        if job.cancelled.load(Ordering::Acquire) {
            finish_cancelled(&job).await;
            return;
        }
        let transfer_id = Uuid::new_v4().to_string();
        job.set_active_transfer(Some(transfer_id.clone())).await;
        let (reporter, progress_task) = job_reporter(job.clone(), transfer_id.clone());
        let result = connection_manager
            .download_file_reported(
                &connection_id,
                &transfer_id,
                &remote_path,
                &local_path,
                overwrite,
                reporter,
            )
            .await;
        let _ = progress_task.await;
        job.set_active_transfer(None).await;
        if job.cancelled.load(Ordering::Acquire) {
            finish_cancelled(&job).await;
            return;
        }
        match result {
            Ok(()) => {
                job.update(|summary| summary.state = TransferJobState::Completed)
                    .await;
                return;
            }
            Err(AppError::Conflict(_)) if !overwrite => {
                job.update(|summary| summary.state = TransferJobState::WaitingForConflict)
                    .await;
                match wait_for_conflict_decision(&connection_manager, &job, &connection_id).await {
                    TransferConflictDecision::Overwrite => {
                        overwrite = true;
                        job.update(|summary| summary.state = TransferJobState::Running)
                            .await;
                    }
                    TransferConflictDecision::Skip | TransferConflictDecision::Cancel => {
                        finish_cancelled(&job).await;
                        return;
                    }
                }
            }
            Err(error) => {
                job.update(|summary| {
                    summary.state = TransferJobState::Failed;
                    summary.message = Some(error.to_string());
                    summary.failed = 1;
                })
                .await;
                return;
            }
        }
    }
}

fn job_reporter(
    job: Arc<TransferJob>,
    transfer_id: String,
) -> (TransferReporter, tauri::async_runtime::JoinHandle<()>) {
    // 进度只保留最新值，单一消费者按序更新；任务结束前等待最终进度入账。
    let cancellation = job.cancelled.clone();
    let (sender, mut receiver) = watch::channel(None);
    let task = tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            let event = receiver.borrow_and_update().clone();
            if let Some(event) = event {
                job.apply_progress(&transfer_id, event).await;
            }
        }
    });
    let reporter = TransferReporter::new(move |event| {
        sender.send_replace(Some(event));
    })
    .with_cancellation(cancellation);
    (reporter, task)
}

async fn wait_for_conflict_decision(
    connection_manager: &ConnectionManager,
    job: &TransferJob,
    connection_id: &str,
) -> TransferConflictDecision {
    loop {
        if job.cancelled.load(Ordering::Acquire) {
            return TransferConflictDecision::Cancel;
        }
        let mut pending = job.decision.lock().await;
        if let Some(decision) = pending.take() {
            // 与决策提交使用同一加锁顺序，原子离开等待态，防止迟到决策污染下一批次。
            job.summary.lock().await.state = TransferJobState::Running;
            return decision;
        }
        drop(pending);
        tokio::select! {
            _ = job.decision_notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if connection_manager.session_id(connection_id).await.is_err() {
                    return TransferConflictDecision::Cancel;
                }
            }
        }
    }
}

async fn finish_cancelled(job: &TransferJob) {
    job.update(|summary| summary.state = TransferJobState::Cancelled)
        .await;
}

fn local_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("文件")
        .to_owned()
}

fn remote_file_name(path: &str) -> String {
    path.rsplit('/')
        .find(|name| !name.is_empty())
        .unwrap_or("文件")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(state: TransferJobState) -> TransferJobSummary {
        TransferJobSummary {
            job_id: Uuid::new_v4().to_string(),
            runtime_id: Uuid::new_v4().to_string(),
            connection_id: Uuid::new_v4().to_string(),
            direction: TransferJobDirection::Upload,
            file_name: "report.txt".to_owned(),
            batch_index: 1,
            batch_total: 1,
            transferred_bytes: 0,
            total_bytes: 10,
            state,
            message: None,
            uploaded: 0,
            skipped: 0,
            failed: 0,
        }
    }

    #[test]
    fn 文件名只保留末段且不暴露完整路径() {
        assert_eq!(local_file_name(r"C:\secret\report.txt"), "report.txt");
        assert_eq!(remote_file_name("/home/private/data.bin"), "data.bin");
    }

    #[tokio::test]
    async fn 完成任务确认前保留且确认后删除() {
        let service = TransferJobService::default();
        let summary = summary(TransferJobState::Completed);
        service.jobs.lock().await.insert(
            summary.job_id.clone(),
            Arc::new(TransferJob::new(summary.clone())),
        );

        assert_eq!(service.summaries().await.len(), 1);
        service
            .acknowledge(&summary.job_id)
            .await
            .expect("完成任务应允许确认");
        assert!(service.summaries().await.is_empty());
    }

    #[tokio::test]
    async fn 运行任务不能提前确认() {
        let service = TransferJobService::default();
        let summary = summary(TransferJobState::Running);
        service.jobs.lock().await.insert(
            summary.job_id.clone(),
            Arc::new(TransferJob::new(summary.clone())),
        );

        assert!(service.acknowledge(&summary.job_id).await.is_err());
        assert_eq!(service.summaries().await.len(), 1);
    }

    #[tokio::test]
    async fn 同一冲突只接受一次决定() {
        let service = TransferJobService::default();
        let summary = summary(TransferJobState::WaitingForConflict);
        service.jobs.lock().await.insert(
            summary.job_id.clone(),
            Arc::new(TransferJob::new(summary.clone())),
        );

        service
            .resolve_conflict(&summary.job_id, TransferConflictDecision::Overwrite)
            .await
            .expect("首次决定应成功");
        assert!(service
            .resolve_conflict(&summary.job_id, TransferConflictDecision::Skip)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn 恢复结束时移除孤立传输并发出取消() {
        let service = TransferJobService::default();
        let summary = summary(TransferJobState::WaitingForConflict);
        let job = Arc::new(TransferJob::new(summary.clone()));
        service
            .jobs
            .lock()
            .await
            .insert(summary.job_id.clone(), job.clone());
        let manager = ConnectionManager::new(&std::env::temp_dir());

        service.cleanup_orphans(&manager, &[]).await;

        assert!(job.cancelled.load(Ordering::Acquire));
        assert!(service.summaries().await.is_empty());
    }

    #[tokio::test]
    async fn 无窗口时进度继续更新且恢复取得最终结果() {
        let job = Arc::new(TransferJob::new(summary(TransferJobState::Running)));
        job.set_active_transfer(Some("transfer".to_owned())).await;
        let (reporter, task) = job_reporter(job.clone(), "transfer".to_owned());
        for transferred_bytes in 0..100 {
            reporter.emit(TransferEvent::Progress {
                transfer_id: "transfer".to_owned(),
                transferred_bytes,
                total_bytes: 100,
            });
        }
        reporter.emit(TransferEvent::Completed {
            transfer_id: "transfer".to_owned(),
            transferred_bytes: 100,
            total_bytes: 100,
        });
        drop(reporter);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("进度消费者应排空")
            .expect("进度任务应完成");
        job.update(|summary| summary.state = TransferJobState::Completed)
            .await;
        let restored = job
            .attach(Channel::new(|_| Ok(())))
            .await
            .expect("应恢复通道");
        assert_eq!(restored.transferred_bytes, 100);
        assert_eq!(restored.state, TransferJobState::Completed);
    }

    #[tokio::test]
    async fn 已关闭的窗口通道不影响后台状态() {
        let job = TransferJob::new(summary(TransferJobState::Running));
        *job.channel.lock().await = Some(Channel::new(|_| Err(tauri::Error::WindowNotFound)));
        job.update(|summary| summary.transferred_bytes = 5).await;
        assert!(job.channel.lock().await.is_none());
        job.update(|summary| summary.state = TransferJobState::Completed)
            .await;
        assert_eq!(job.snapshot().await.state, TransferJobState::Completed);
    }

    #[tokio::test]
    async fn 迟到进度不能回退字节或覆盖其他传输和终态() {
        let job = TransferJob::new(summary(TransferJobState::Running));
        job.set_active_transfer(Some("new".to_owned())).await;
        let progress = |id: &str, transferred_bytes| TransferEvent::Progress {
            transfer_id: id.to_owned(),
            transferred_bytes,
            total_bytes: 10,
        };
        job.apply_progress("new", progress("new", 8)).await;
        job.apply_progress("new", progress("new", 2)).await;
        job.apply_progress("old", progress("old", 10)).await;
        assert_eq!(job.snapshot().await.transferred_bytes, 8);
        job.update(|summary| summary.state = TransferJobState::Completed)
            .await;
        job.apply_progress("new", progress("new", 9)).await;
        assert_eq!(job.snapshot().await.transferred_bytes, 8);
        assert_eq!(job.snapshot().await.state, TransferJobState::Completed);
    }

    #[tokio::test]
    async fn 冲突可跨窗口等待且每批决定只消费一次() {
        let directory = std::env::temp_dir().join(format!("fstty-job-{}", Uuid::new_v4()));
        let manager = ConnectionManager::new(&directory);
        let service = TransferJobService::default();
        let summary = summary(TransferJobState::WaitingForConflict);
        let job = Arc::new(TransferJob::new(summary.clone()));
        service
            .jobs
            .lock()
            .await
            .insert(summary.job_id.clone(), job.clone());
        for decision in [
            TransferConflictDecision::Overwrite,
            TransferConflictDecision::Skip,
        ] {
            job.update(|summary| summary.state = TransferJobState::WaitingForConflict)
                .await;
            service
                .resolve_conflict(&summary.job_id, decision)
                .await
                .expect("应提交决定");
            assert_eq!(
                wait_for_conflict_decision(&manager, &job, &summary.connection_id).await,
                decision
            );
            assert!(job.decision.lock().await.is_none());
            assert_eq!(job.snapshot().await.state, TransferJobState::Running);
        }
        job.update(|summary| summary.state = TransferJobState::WaitingForConflict)
            .await;
        assert!(service.cancel(&manager, &summary.job_id).await);
        assert_eq!(
            wait_for_conflict_decision(&manager, &job, &summary.connection_id).await,
            TransferConflictDecision::Cancel
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 冲突等待期间连接消失会结束等待() {
        let directory = std::env::temp_dir().join(format!("fstty-job-{}", Uuid::new_v4()));
        let manager = ConnectionManager::new(&directory);
        let job = TransferJob::new(summary(TransferJobState::WaitingForConflict));
        let decision = tokio::time::timeout(
            Duration::from_secs(2),
            wait_for_conflict_decision(&manager, &job, "missing"),
        )
        .await
        .expect("失效连接不能无限等待冲突");
        assert_eq!(decision, TransferConflictDecision::Cancel);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 开始前取消不会接触文件且上传下载都保留取消结果() {
        let directory = std::env::temp_dir().join(format!("fstty-job-{}", Uuid::new_v4()));
        let manager = ConnectionManager::new(&directory);
        for direction in [TransferJobDirection::Upload, TransferJobDirection::Download] {
            let job = Arc::new(TransferJob::new(summary(TransferJobState::Running)));
            job.cancelled.store(true, Ordering::Release);
            match direction {
                TransferJobDirection::Upload => {
                    run_upload_batch(
                        manager.clone(),
                        job.clone(),
                        "missing".to_owned(),
                        vec!["unused".to_owned()],
                        "/".to_owned(),
                    )
                    .await
                }
                TransferJobDirection::Download => {
                    run_download(
                        manager.clone(),
                        job.clone(),
                        "missing".to_owned(),
                        "/unused".to_owned(),
                        "unused".to_owned(),
                    )
                    .await
                }
            }
            assert_eq!(job.snapshot().await.state, TransferJobState::Cancelled);
            assert_eq!(job.snapshot().await.failed, 0);
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn 任务入口拒绝相对路径控制字符和超长路径() {
        assert!(!valid_local_path("relative.txt"));
        assert!(!valid_local_path(""));
        assert!(!valid_local_path("/tmp/file\n"));
        assert!(!valid_local_path(&format!("/{}", "a".repeat(32 * 1024))));
    }
}
