use super::*;
use std::{collections::VecDeque, future::Future, path::Component};
use tokio::{sync::OwnedSemaphorePermit, task::JoinSet};

const MAX_DOWNLOAD_FILES: usize = 10_000;
type DownloadTarget = (String, String);

pub(super) fn download_targets(
    remote_paths: &[String],
    local_directory: &str,
) -> Result<Vec<DownloadTarget>, AppError> {
    if remote_paths.is_empty()
        || remote_paths.len() > MAX_DOWNLOAD_FILES
        || !valid_local_path(local_directory)
    {
        return Err(AppError::Validation("批量下载参数无效".to_owned()));
    }
    let mut names = HashSet::new();
    remote_paths
        .iter()
        .map(|remote_path| {
            let remote_path = normalize_remote_path(remote_path)?;
            let name = remote_path.rsplit('/').next().unwrap_or_default();
            if !valid_download_name(name) {
                return Err(AppError::Validation(format!(
                    "文件名无法保存到本地：{name}"
                )));
            }
            #[cfg(windows)]
            let name_key = name.to_lowercase();
            #[cfg(not(windows))]
            let name_key = name.to_owned();
            if !names.insert(name_key) {
                return Err(AppError::Validation("下载文件的本地名称重复".to_owned()));
            }
            let local_path = Path::new(local_directory).join(name);
            let local_path = local_path
                .to_str()
                .ok_or_else(|| AppError::Validation("本地保存路径无效".to_owned()))?;
            if !valid_local_path(local_path) {
                return Err(AppError::Validation("本地保存路径无效".to_owned()));
            }
            Ok((remote_path, local_path.to_owned()))
        })
        .collect()
}

fn valid_download_name(name: &str) -> bool {
    if name.is_empty() || name.contains(['\\', '/', ':']) || name.chars().any(char::is_control) {
        return false;
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return false;
    }
    #[cfg(windows)]
    {
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if name.ends_with(['.', ' '])
            || name.contains(['<', '>', '"', '|', '?', '*'])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return false;
        }
    }
    true
}

pub(super) async fn acquire_download_slot(
    job: &TransferJob,
    slots: Arc<Semaphore>,
) -> Option<OwnedSemaphorePermit> {
    if job.cancelled.load(Ordering::Acquire) {
        return None;
    }
    let permit = tokio::select! {
        _ = job.cancellation.cancelled() => return None,
        permit = slots.acquire_owned() => permit.ok()?,
    };
    if job.cancelled.load(Ordering::Acquire) {
        return None;
    }
    Some(permit)
}

enum DownloadOutcome {
    Downloaded,
    Skipped,
    Failed(String),
    Cancelled,
}

pub(super) async fn run_download_batch(
    manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection_id: String,
    remote_paths: Vec<String>,
    local_directory: String,
    slots: Arc<Semaphore>,
) {
    let targets = match download_targets(&remote_paths, &local_directory) {
        Ok(targets) => targets,
        Err(error) => {
            job.update(|summary| {
                summary.state = TransferJobState::Failed;
                summary.message = Some(error.to_string());
                summary.queued_count = 0;
            })
            .await;
            return;
        }
    };
    let download_job = job.clone();
    run_download_queue(
        job,
        slots,
        targets,
        move |index, remote_path, local_path| {
            let job = download_job.clone();
            let manager = manager.clone();
            let connection_id = connection_id.clone();
            async move {
                download_one(manager, job, connection_id, index, remote_path, local_path).await
            }
        },
    )
    .await;
}

async fn run_download_queue<F, Fut>(
    job: Arc<TransferJob>,
    slots: Arc<Semaphore>,
    targets: Vec<DownloadTarget>,
    download: F,
) where
    F: Fn(usize, String, String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = DownloadOutcome> + Send,
{
    let queue = Arc::new(Mutex::new(
        targets.into_iter().enumerate().collect::<VecDeque<_>>(),
    ));
    let download = Arc::new(download);
    let mut workers = JoinSet::new();
    for _ in 0..MAX_CONCURRENT_DOWNLOADS {
        let job = job.clone();
        let slots = slots.clone();
        let queue = queue.clone();
        let download = download.clone();
        workers.spawn(async move {
            loop {
                let Some(_permit) = acquire_download_slot(&job, slots.clone()).await else {
                    return;
                };
                let Some((index, (remote_path, local_path))) = queue.lock().await.pop_front()
                else {
                    return;
                };
                let name = remote_file_name(&remote_path);
                job.update(|summary| {
                    summary.queued_count = summary.queued_count.saturating_sub(1);
                    summary.active_count += 1;
                    if summary.conflict_id.is_none() {
                        summary.file_name = name.clone();
                    }
                })
                .await;
                let outcome = if job.cancelled.load(Ordering::Acquire) {
                    DownloadOutcome::Cancelled
                } else {
                    download(index, remote_path, local_path).await
                };
                job.update(|summary| {
                    summary.active_count = summary.active_count.saturating_sub(1);
                    match outcome {
                        DownloadOutcome::Downloaded => summary.downloaded += 1,
                        DownloadOutcome::Skipped => summary.skipped += 1,
                        DownloadOutcome::Failed(error) => {
                            summary.failed += 1;
                            summary
                                .message
                                .get_or_insert_with(|| format!("{name}: {error}"));
                        }
                        DownloadOutcome::Cancelled => {}
                    }
                    summary.batch_index =
                        (summary.downloaded + summary.skipped + summary.failed).max(1);
                })
                .await;
            }
        });
    }
    let mut worker_failed = false;
    while let Some(result) = workers.join_next().await {
        if let Err(error) = result {
            worker_failed = true;
            job.cancelled.store(true, Ordering::Release);
            job.cancellation.cancel();
            job.decision_notify.notify_one();
            job.update(|summary| {
                summary.failed += 1;
                summary.message = Some(format!("下载任务异常：{error}"));
            })
            .await;
        }
    }
    if job.cancelled.load(Ordering::Acquire) && !worker_failed {
        finish_cancelled(&job).await;
    } else {
        job.update(|summary| {
            summary.active_count = 0;
            summary.queued_count = 0;
            summary.conflict_id = None;
            summary.state = if worker_failed || summary.failed == summary.batch_total {
                TransferJobState::Failed
            } else {
                TransferJobState::Completed
            };
            if summary.skipped > 0 || summary.failed > 0 {
                summary.message = Some(format!(
                    "下载结束：成功 {}，跳过 {}，失败 {}{}",
                    summary.downloaded,
                    summary.skipped,
                    summary.failed,
                    summary
                        .message
                        .as_ref()
                        .map(|message| format!("；{message}"))
                        .unwrap_or_default()
                ));
            }
        })
        .await;
    }
}

async fn download_one(
    manager: ConnectionManager,
    job: Arc<TransferJob>,
    connection_id: String,
    index: usize,
    remote_path: String,
    local_path: String,
) -> DownloadOutcome {
    let mut overwrite = false;
    loop {
        if job.cancelled.load(Ordering::Acquire) {
            return DownloadOutcome::Cancelled;
        }
        let transfer_id = Uuid::new_v4().to_string();
        job.batch_transfers
            .lock()
            .await
            .insert(transfer_id.clone(), index);
        let (reporter, task) = batch_reporter(job.clone(), transfer_id.clone());
        let result = manager
            .download_file_reported(
                &connection_id,
                &transfer_id,
                &remote_path,
                &local_path,
                overwrite,
                reporter,
            )
            .await;
        let _ = task.await;
        job.batch_transfers.lock().await.remove(&transfer_id);
        if job.cancelled.load(Ordering::Acquire) {
            return DownloadOutcome::Cancelled;
        }
        match result {
            Ok(()) => return DownloadOutcome::Downloaded,
            Err(AppError::Conflict(_)) if !overwrite => {
                let decision = resolve_batch_conflict(
                    &manager,
                    &job,
                    &connection_id,
                    &remote_path,
                    &transfer_id,
                )
                .await;
                match decision {
                    TransferConflictDecision::Overwrite => overwrite = true,
                    TransferConflictDecision::Skip => return DownloadOutcome::Skipped,
                    TransferConflictDecision::Cancel => {
                        job.cancelled.store(true, Ordering::Release);
                        job.cancellation.cancel();
                        return DownloadOutcome::Cancelled;
                    }
                }
            }
            Err(error) => return DownloadOutcome::Failed(error.to_string()),
        }
    }
}

async fn resolve_batch_conflict(
    manager: &ConnectionManager,
    job: &TransferJob,
    connection_id: &str,
    remote_path: &str,
    conflict_id: &str,
) -> TransferConflictDecision {
    // 同一批次一次只展示一个覆盖确认；其他文件仍可继续下载。
    let _conflict = job.batch_conflict.lock().await;
    if job.cancelled.load(Ordering::Acquire) {
        return TransferConflictDecision::Cancel;
    }
    job.update(|summary| {
        summary.state = TransferJobState::WaitingForConflict;
        summary.file_name = remote_file_name(remote_path);
        summary.conflict_id = Some(conflict_id.to_owned());
    })
    .await;
    let decision = wait_for_conflict_decision(manager, job, connection_id).await;
    job.update(|summary| {
        summary.conflict_id = None;
    })
    .await;
    decision
}

fn batch_reporter(
    job: Arc<TransferJob>,
    transfer_id: String,
) -> (TransferReporter, tauri::async_runtime::JoinHandle<()>) {
    let cancellation = job.cancelled.clone();
    let (sender, mut receiver) = watch::channel(None);
    let task = tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            let event = receiver.borrow_and_update().clone();
            if let Some(event) = event {
                apply_batch_progress(&job, &transfer_id, event).await;
            }
        }
    });
    (
        TransferReporter::new(move |event| {
            sender.send_replace(Some(event));
        })
        .with_cancellation(cancellation),
        task,
    )
}

async fn apply_batch_progress(job: &TransferJob, transfer_id: &str, event: TransferEvent) {
    let Some(index) = job.batch_transfers.lock().await.get(transfer_id).copied() else {
        return;
    };
    let (bytes, total, cancelled) = match event {
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
        job.cancelled.store(true, Ordering::Release);
        job.cancellation.cancel();
        job.decision_notify.notify_one();
    }
    let mut progress = job.batch_progress.lock().await;
    let current = progress.entry(index).or_default();
    current.0 = current.0.max(bytes);
    current.1 = total;
    let (bytes, total) = progress.values().fold(
        (0_u64, 0_u64),
        |(bytes, total), (file_bytes, file_total)| {
            (
                bytes.saturating_add(*file_bytes),
                total.saturating_add(*file_total),
            )
        },
    );
    job.update(|summary| {
        if !summary.state.is_terminal() {
            summary.transferred_bytes = bytes;
            summary.total_bytes = total;
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::mpsc;

    fn download_job(total: u32) -> Arc<TransferJob> {
        Arc::new(TransferJob::new(TransferJobSummary {
            job_id: Uuid::new_v4().to_string(),
            runtime_id: Uuid::new_v4().to_string(),
            connection_id: Uuid::new_v4().to_string(),
            direction: TransferJobDirection::Download,
            file_name: "0.txt".to_owned(),
            batch_index: 1,
            batch_total: total,
            transferred_bytes: 0,
            total_bytes: 0,
            state: TransferJobState::Running,
            message: None,
            uploaded: 0,
            downloaded: 0,
            skipped: 0,
            failed: 0,
            active_count: 0,
            queued_count: total,
            conflict_id: None,
        }))
    }

    fn targets(total: usize) -> Vec<DownloadTarget> {
        (0..total)
            .map(|index| (format!("/test/{index}.txt"), format!("unused-{index}")))
            .collect()
    }

    #[tokio::test]
    async fn 七个文件仅启动五个并在空位出现时按顺序补位且失败不阻断队列() {
        let job = download_job(7);
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
        let gate = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (started, mut starts) = mpsc::unbounded_channel();
        let worker_gate = gate.clone();
        let worker_peak = peak.clone();
        let runner = tokio::spawn(run_download_queue(
            job.clone(),
            slots,
            targets(7),
            move |index, _, _| {
                let gate = worker_gate.clone();
                let active = active.clone();
                let peak = worker_peak.clone();
                let started = started.clone();
                async move {
                    let count = active.fetch_add(1, Ordering::AcqRel) + 1;
                    peak.fetch_max(count, Ordering::AcqRel);
                    started.send(index).unwrap();
                    gate.acquire().await.unwrap().forget();
                    active.fetch_sub(1, Ordering::AcqRel);
                    if index == 1 {
                        DownloadOutcome::Failed("permission denied".to_owned())
                    } else {
                        DownloadOutcome::Downloaded
                    }
                }
            },
        ));
        let mut first = Vec::new();
        for _ in 0..5 {
            first.push(
                tokio::time::timeout(Duration::from_secs(2), starts.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        first.sort_unstable();
        assert_eq!(first, vec![0, 1, 2, 3, 4]);
        assert!(
            tokio::time::timeout(Duration::from_millis(80), starts.recv())
                .await
                .is_err()
        );
        let snapshot = job.snapshot().await;
        assert_eq!((snapshot.active_count, snapshot.queued_count), (5, 2));
        gate.add_permits(1);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), starts.recv())
                .await
                .unwrap(),
            Some(5)
        );
        assert_eq!(job.snapshot().await.queued_count, 1);
        gate.add_permits(6);
        tokio::time::timeout(Duration::from_secs(2), runner)
            .await
            .unwrap()
            .unwrap();
        let snapshot = job.snapshot().await;
        assert_eq!(
            (
                snapshot.downloaded,
                snapshot.failed,
                snapshot.queued_count,
                snapshot.active_count
            ),
            (6, 1, 0, 0)
        );
        assert_eq!(snapshot.state, TransferJobState::Completed);
        assert_eq!(peak.load(Ordering::Acquire), 5);
    }

    #[tokio::test]
    async fn 多个会话共享五个下载名额() {
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
        let gate = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (started, mut starts) = mpsc::unbounded_channel();
        let mut runners = Vec::new();
        for _ in 0..2 {
            let gate = gate.clone();
            let active = active.clone();
            let peak = peak.clone();
            let started = started.clone();
            runners.push(tokio::spawn(run_download_queue(
                download_job(6),
                slots.clone(),
                targets(6),
                move |_, _, _| {
                    let gate = gate.clone();
                    let active = active.clone();
                    let peak = peak.clone();
                    let started = started.clone();
                    async move {
                        peak.fetch_max(active.fetch_add(1, Ordering::AcqRel) + 1, Ordering::AcqRel);
                        started.send(()).unwrap();
                        gate.acquire().await.unwrap().forget();
                        active.fetch_sub(1, Ordering::AcqRel);
                        DownloadOutcome::Downloaded
                    }
                },
            )));
        }
        for _ in 0..5 {
            tokio::time::timeout(Duration::from_secs(2), starts.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(80), starts.recv())
                .await
                .is_err()
        );
        gate.add_permits(12);
        for runner in runners {
            tokio::time::timeout(Duration::from_secs(2), runner)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(peak.load(Ordering::Acquire), 5);
    }

    #[tokio::test]
    async fn 取消批次会停止活动文件且不会启动排队文件() {
        let job = download_job(7);
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
        let (started, mut starts) = mpsc::unbounded_channel();
        let worker_job = job.clone();
        let runner = tokio::spawn(run_download_queue(
            job.clone(),
            slots.clone(),
            targets(7),
            move |index, _, _| {
                let started = started.clone();
                let job = worker_job.clone();
                async move {
                    started.send(index).unwrap();
                    job.cancellation.cancelled().await;
                    DownloadOutcome::Cancelled
                }
            },
        ));
        for _ in 0..5 {
            tokio::time::timeout(Duration::from_secs(2), starts.recv())
                .await
                .unwrap()
                .unwrap();
        }
        job.cancelled.store(true, Ordering::Release);
        job.cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(2), runner)
            .await
            .unwrap()
            .unwrap();
        assert!(starts.recv().await.is_none());
        let snapshot = job.snapshot().await;
        assert_eq!(snapshot.state, TransferJobState::Cancelled);
        assert_eq!(
            (
                snapshot.active_count,
                snapshot.queued_count,
                snapshot.failed
            ),
            (0, 0, 0)
        );
        assert_eq!(slots.available_permits(), 5);
    }

    #[tokio::test]
    async fn 取消等待其他批次的任务能立即退出且不占用下载名额() {
        let job = download_job(7);
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
        let held = slots.clone().acquire_many_owned(5).await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let runner = tokio::spawn(run_download_queue(
            job.clone(),
            slots.clone(),
            targets(7),
            move |_, _, _| {
                worker_calls.fetch_add(1, Ordering::AcqRel);
                async { DownloadOutcome::Downloaded }
            },
        ));
        job.cancelled.store(true, Ordering::Release);
        job.cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(2), runner)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 0);
        assert_eq!(job.snapshot().await.state, TransferJobState::Cancelled);
        drop(held);
        assert_eq!(slots.available_permits(), 5);
    }

    #[tokio::test]
    async fn 进度汇总所有文件且迟到进度和终态不会回退() {
        let job = download_job(2);
        job.batch_transfers
            .lock()
            .await
            .extend([("one".to_owned(), 0), ("two".to_owned(), 1)]);
        let event = |id: &str, bytes, total| TransferEvent::Progress {
            transfer_id: id.to_owned(),
            transferred_bytes: bytes,
            total_bytes: total,
        };
        apply_batch_progress(&job, "one", event("one", 50, 100)).await;
        apply_batch_progress(&job, "two", event("two", 30, 50)).await;
        apply_batch_progress(&job, "one", event("one", 10, 100)).await;
        let snapshot = job.snapshot().await;
        assert_eq!(
            (snapshot.transferred_bytes, snapshot.total_bytes),
            (80, 150)
        );
        job.batch_transfers.lock().await.remove("one");
        apply_batch_progress(&job, "one", event("one", 100, 100)).await;
        job.update(|summary| summary.state = TransferJobState::Completed)
            .await;
        apply_batch_progress(&job, "two", event("two", 50, 50)).await;
        assert_eq!(job.snapshot().await.transferred_bytes, 80);
    }

    #[tokio::test]
    async fn 同时出现的覆盖冲突逐个确认且批次进度不改变冲突标识() {
        let job = download_job(7);
        let manager = ConnectionManager::new(&std::env::temp_dir());
        let service = TransferJobService::default();
        service
            .jobs
            .lock()
            .await
            .insert(job.snapshot().await.job_id.clone(), job.clone());
        let (events, mut updates) = mpsc::unbounded_channel();
        job.attach(Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                events
                    .send(serde_json::from_str::<serde_json::Value>(&json).unwrap())
                    .unwrap();
            }
            Ok(())
        }))
        .await
        .unwrap();
        let mut tasks = Vec::new();
        for id in ["first", "second"] {
            let job = job.clone();
            let manager = manager.clone();
            tasks.push(tokio::spawn(async move {
                resolve_batch_conflict(&manager, &job, "unused", &format!("/{id}.txt"), id).await
            }));
        }
        let mut seen = HashSet::new();
        for decision in [
            TransferConflictDecision::Skip,
            TransferConflictDecision::Overwrite,
        ] {
            let conflict = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    let event = updates.recv().await.unwrap();
                    let job = &event["job"];
                    if job["state"] == "waitingForConflict"
                        && job["conflictId"]
                            .as_str()
                            .is_some_and(|id| !seen.contains(id))
                    {
                        break job.clone();
                    }
                }
            })
            .await
            .unwrap();
            seen.insert(conflict["conflictId"].as_str().unwrap().to_owned());
            job.update(|summary| {
                summary.batch_index = 3;
                summary.downloaded = 3;
            })
            .await;
            assert_eq!(
                job.snapshot().await.conflict_id.as_deref(),
                conflict["conflictId"].as_str()
            );
            service
                .resolve_conflict(conflict["jobId"].as_str().unwrap(), decision)
                .await
                .unwrap();
        }
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(seen.len(), 2);
        assert_eq!(job.snapshot().await.conflict_id, None);
    }

    #[test]
    fn 本地目标拒绝路径逃逸重复名称和无效批次但保留中文及空格() {
        let directory = std::env::temp_dir().join("fstty downloads");
        let directory = directory.to_str().unwrap();
        let targets = download_targets(&["/srv/测试 文件.txt".to_owned()], directory).unwrap();
        assert_eq!(
            Path::new(&targets[0].1).parent(),
            Some(Path::new(directory))
        );
        for paths in [
            vec![],
            vec!["/".to_owned()],
            vec!["/srv/..\\escape.txt".to_owned()],
            vec!["/srv/C:escape.txt".to_owned()],
            vec!["/one/same.txt".to_owned(), "/two/same.txt".to_owned()],
        ] {
            assert!(download_targets(&paths, directory).is_err());
        }
        assert!(download_targets(&["/srv/file.txt".to_owned()], "relative").is_err());
        #[cfg(windows)]
        for name in [
            "CON",
            "nul.txt",
            "COM1.txt",
            "LPT9",
            "file.",
            "file ",
            "ads:secret",
        ] {
            assert!(download_targets(&[format!("/srv/{name}")], directory).is_err());
        }
    }
}
