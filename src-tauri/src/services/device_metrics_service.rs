use crate::models::{AppError, DeviceMetricSample, DeviceMetricsSnapshot, DeviceStatus};
use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(10);
const HISTORY_WINDOW_MS: u64 = 10 * 60 * 1_000;
const MAX_HISTORY_SAMPLES: usize = 121;

/// 统计随 GUI 连接存活；窗口只读取快照，不持有或控制采样任务。
pub(super) struct DeviceMetricsMonitor {
    connection_id: String,
    started_at: Instant,
    state: Arc<Mutex<MetricsState>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
struct MetricsState {
    stopped: bool,
    status: Option<DeviceStatus>,
    history: VecDeque<DeviceMetricSample>,
    network_counter: Option<NetworkCounter>,
}

struct NetworkCounter {
    sampled_at_ms: u64,
    received_bytes: u64,
    transmitted_bytes: u64,
}

impl DeviceMetricsMonitor {
    pub(super) fn new(connection_id: String) -> Self {
        Self {
            connection_id,
            started_at: Instant::now(),
            state: Arc::new(Mutex::new(MetricsState::default())),
            task: Mutex::new(None),
        }
    }

    pub(super) fn start<F, Fut>(&self, sample: F) -> bool
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: Future<Output = Result<DeviceStatus, AppError>> + Send,
    {
        self.start_with_timing(sample, SAMPLE_INTERVAL, SAMPLE_TIMEOUT)
    }

    fn start_with_timing<F, Fut>(
        &self,
        mut sample: F,
        interval: Duration,
        timeout: Duration,
    ) -> bool
    where
        F: FnMut() -> Fut + Send + 'static,
        Fut: Future<Output = Result<DeviceStatus, AppError>> + Send,
    {
        let mut task = lock(&self.task);
        if task.is_some() || lock(&self.state).stopped {
            return false;
        }
        let state = self.state.clone();
        let started_at = self.started_at;
        *task = Some(tokio::spawn(async move {
            loop {
                // 整轮包含等待 SSH 句柄、建通道和读取，避免无窗口时请求永久悬挂。
                let status = tokio::time::timeout(timeout, sample())
                    .await
                    .ok()
                    .and_then(Result::ok);
                {
                    let mut state = lock(&state);
                    if state.stopped {
                        return;
                    }
                    state.record(status, elapsed_ms(started_at));
                }
                // 完成后才计时；慢请求和系统唤醒都不会产生重叠或补发采样。
                tokio::time::sleep(interval).await;
            }
        }));
        true
    }

    pub(super) fn snapshot(&self) -> Result<DeviceMetricsSnapshot, AppError> {
        let mut state = lock(&self.state);
        if state.stopped {
            return Err(AppError::NotFound("SSH 连接不存在或已断开".to_owned()));
        }
        let window_end_ms = elapsed_ms(self.started_at);
        state.prune(window_end_ms);
        Ok(DeviceMetricsSnapshot {
            connection_id: self.connection_id.clone(),
            status: state.status.clone(),
            history: state.history.iter().cloned().collect(),
            window_end_ms,
        })
    }

    pub(super) fn stop(&self) -> Option<JoinHandle<()>> {
        let mut task = lock(&self.task);
        let handle = task.take();
        if let Some(handle) = &handle {
            handle.abort();
        }
        // 先标记停止再清空；即使旧请求恰好完成，也不能重新填入已断开的缓存。
        *lock(&self.state) = MetricsState {
            stopped: true,
            ..MetricsState::default()
        };
        handle
    }
}

impl Drop for DeviceMetricsMonitor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

impl MetricsState {
    fn record(&mut self, status: Option<DeviceStatus>, sampled_at_ms: u64) {
        if self.stopped {
            return;
        }
        if self
            .history
            .back()
            .is_some_and(|sample| sample.sampled_at_ms >= sampled_at_ms)
        {
            self.network_counter = None;
            return;
        }
        let network_counter = status.as_ref().and_then(|status| {
            Some(NetworkCounter {
                sampled_at_ms,
                received_bytes: status.network_received_bytes?,
                transmitted_bytes: status.network_transmitted_bytes?,
            })
        });
        let rates = network_counter
            .as_ref()
            .zip(self.network_counter.as_ref())
            .and_then(|(current, previous)| {
                let elapsed = current.sampled_at_ms.checked_sub(previous.sampled_at_ms)?;
                if elapsed == 0 {
                    return None;
                }
                let received = current
                    .received_bytes
                    .checked_sub(previous.received_bytes)?;
                let transmitted = current
                    .transmitted_bytes
                    .checked_sub(previous.transmitted_bytes)?;
                Some((
                    received as f64 * 1_000.0 / elapsed as f64,
                    transmitted as f64 * 1_000.0 / elapsed as f64,
                ))
            });
        self.history.push_back(DeviceMetricSample {
            sampled_at_ms,
            cpu_percent: status
                .as_ref()
                .and_then(|value| value.cpu_percent)
                .map(|value| value.min(100)),
            memory_percent: status
                .as_ref()
                .and_then(|value| value.memory_percent)
                .map(|value| value.min(100)),
            network_download_bytes_per_second: rates.map(|(download, _)| download),
            network_upload_bytes_per_second: rates.map(|(_, upload)| upload),
        });
        self.network_counter = network_counter;
        // 失败只留下曲线断点，保留上一份设备信息，不改动终端连接状态或错误。
        if let Some(status) = status {
            self.status = Some(status);
        }
        self.prune(sampled_at_ms);
    }

    fn prune(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(HISTORY_WINDOW_MS);
        while self
            .history
            .front()
            .is_some_and(|sample| sample.sampled_at_ms < cutoff)
            || self.history.len() > MAX_HISTORY_SAMPLES
        {
            self.history.pop_front();
        }
    }
}

fn elapsed_ms(started_at: Instant) -> u64 {
    started_at
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use tokio::sync::{mpsc, oneshot, Barrier};

    fn status(cpu: u8, received: u64, transmitted: u64) -> DeviceStatus {
        DeviceStatus {
            session_id: "session".to_owned(),
            available: true,
            os: Some("Linux".to_owned()),
            architecture: None,
            uptime_seconds: None,
            cpu_percent: Some(cpu),
            cpu_cores: Some(4),
            memory_percent: Some(50),
            memory_used_gb: Some(1.0),
            memory_total_gb: Some(2.0),
            disk_percent: None,
            disk_used_gb: None,
            disk_total_gb: None,
            network_received_bytes: Some(received),
            network_transmitted_bytes: Some(transmitted),
        }
    }

    #[test]
    fn history_keeps_ten_minutes_including_the_boundary() {
        let mut state = MetricsState::default();
        for index in 0..=121 {
            state.record(Some(status(20, index, index)), index * 5_000);
        }
        assert_eq!(state.history.len(), 121);
        assert_eq!(state.history.front().unwrap().sampled_at_ms, 5_000);
        assert_eq!(state.history.back().unwrap().sampled_at_ms, 605_000);
        state.prune(1_205_001);
        assert!(state.history.is_empty());
    }

    #[test]
    fn history_also_enforces_the_sample_count_limit() {
        let mut state = MetricsState::default();
        for sampled_at_ms in 0..1_000 {
            state.record(Some(status(20, 0, 0)), sampled_at_ms);
        }
        assert_eq!(state.history.len(), MAX_HISTORY_SAMPLES);
        assert_eq!(state.history.front().unwrap().sampled_at_ms, 879);
    }

    #[test]
    fn network_rates_use_monotonic_elapsed_time_and_integer_deltas() {
        let mut state = MetricsState::default();
        state.record(Some(status(20, u64::MAX - 5_000, u64::MAX - 10_000)), 1_000);
        assert_eq!(state.history[0].network_download_bytes_per_second, None);
        state.record(Some(status(25, u64::MAX, u64::MAX)), 6_000);
        assert_eq!(
            state.history[1].network_download_bytes_per_second,
            Some(1_000.0)
        );
        assert_eq!(
            state.history[1].network_upload_bytes_per_second,
            Some(2_000.0)
        );
    }

    #[test]
    fn counter_reset_restarts_the_baseline_without_negative_rates() {
        let mut state = MetricsState::default();
        state.record(Some(status(20, 10_000, 20_000)), 1_000);
        state.record(Some(status(20, 10, 20)), 6_000);
        assert_eq!(state.history[1].network_download_bytes_per_second, None);
        assert_eq!(state.history[1].network_upload_bytes_per_second, None);
        state.record(Some(status(20, 5_010, 10_020)), 11_000);
        assert_eq!(
            state.history[2].network_download_bytes_per_second,
            Some(1_000.0)
        );
        assert_eq!(
            state.history[2].network_upload_bytes_per_second,
            Some(2_000.0)
        );
    }

    #[test]
    fn failure_records_a_gap_and_resets_network_baseline() {
        let mut state = MetricsState::default();
        state.record(Some(status(25, 1_000, 2_000)), 1_000);
        state.record(None, 6_000);
        assert_eq!(
            state.history[1],
            DeviceMetricSample {
                sampled_at_ms: 6_000,
                cpu_percent: None,
                memory_percent: None,
                network_download_bytes_per_second: None,
                network_upload_bytes_per_second: None,
            }
        );
        assert_eq!(state.status.as_ref().unwrap().cpu_percent, Some(25));
        state.record(Some(status(30, 11_000, 22_000)), 11_000);
        assert_eq!(state.history[2].cpu_percent, Some(30));
        assert_eq!(state.history[2].network_download_bytes_per_second, None);
    }

    #[test]
    fn missing_fields_stay_missing_and_percentages_are_bounded() {
        let mut state = MetricsState::default();
        let mut partial = status(255, 0, 0);
        partial.memory_percent = None;
        partial.network_received_bytes = None;
        state.record(Some(partial), 1_000);
        assert_eq!(state.history[0].cpu_percent, Some(100));
        assert_eq!(state.history[0].memory_percent, None);
        assert!(state.network_counter.is_none());
    }

    #[test]
    fn duplicate_or_backwards_timestamps_never_append_stale_samples() {
        let mut state = MetricsState::default();
        state.record(Some(status(20, 100, 100)), 1_000);
        state.record(Some(status(90, 200, 200)), 1_000);
        state.record(Some(status(80, 300, 300)), 999);
        assert_eq!(state.history.len(), 1);
        assert_eq!(state.status.as_ref().unwrap().cpu_percent, Some(20));
        state.record(Some(status(30, 400, 400)), 6_000);
        assert_eq!(state.history[1].network_download_bytes_per_second, None);
    }

    #[test]
    fn snapshot_reads_do_not_start_sampling_or_reset_the_clock() {
        let mut monitor = DeviceMetricsMonitor::new("connection".to_owned());
        monitor.started_at = Instant::now() - Duration::from_secs(900);
        {
            let mut state = lock(&monitor.state);
            state.record(Some(status(20, 0, 0)), 1);
            state.record(Some(status(30, 0, 0)), 899_000);
        }
        let first = monitor.snapshot().unwrap();
        let restored = monitor.snapshot().unwrap();
        assert_eq!(restored.connection_id, "connection");
        assert_eq!(restored.history.len(), 1);
        assert_eq!(restored.history, first.history);
        assert!(restored.window_end_ms >= 900_000);
        assert!(restored.window_end_ms >= first.window_end_ms);
        assert!(lock(&monitor.task).is_none());
    }

    #[test]
    fn stop_clears_all_state_and_rejects_late_results() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        lock(&monitor.state).record(Some(status(25, 100, 200)), 0);
        assert!(monitor.stop().is_none());
        {
            let mut state = lock(&monitor.state);
            state.record(Some(status(80, 300, 400)), 5_000);
            assert!(state.history.is_empty());
            assert!(state.status.is_none());
            assert!(state.network_counter.is_none());
        }
        assert!(matches!(monitor.snapshot(), Err(AppError::NotFound(_))));
        assert!(monitor.stop().is_none());
    }

    #[test]
    fn new_connections_never_reuse_an_old_connections_history() {
        let old = DeviceMetricsMonitor::new("old".to_owned());
        lock(&old.state).record(Some(status(90, 1_000, 2_000)), 0);
        let new = DeviceMetricsMonitor::new("new".to_owned());
        let restored = new.snapshot().unwrap();
        assert_eq!(restored.connection_id, "new");
        assert!(restored.history.is_empty());
        assert!(restored.status.is_none());
    }

    struct PendingSample {
        started_at: Instant,
        result: oneshot::Sender<Result<DeviceStatus, AppError>>,
        dropped: oneshot::Receiver<()>,
    }

    struct SampleDropSignal(Option<oneshot::Sender<()>>);

    impl Drop for SampleDropSignal {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    type SampleFuture = Pin<Box<dyn Future<Output = Result<DeviceStatus, AppError>> + Send>>;

    fn controlled_source() -> (
        impl FnMut() -> SampleFuture + Send,
        mpsc::UnboundedReceiver<PendingSample>,
    ) {
        let (requests, receiver) = mpsc::unbounded_channel();
        let sample = move || {
            let requests = requests.clone();
            Box::pin(async move {
                let (result, response) = oneshot::channel();
                let (dropped, drop_signal) = oneshot::channel();
                let _guard = SampleDropSignal(Some(dropped));
                requests
                    .send(PendingSample {
                        started_at: Instant::now(),
                        result,
                        dropped: drop_signal,
                    })
                    .unwrap();
                response
                    .await
                    .unwrap_or_else(|_| Err(AppError::Connection("测试采样已取消".to_owned())))
            }) as SampleFuture
        };
        (sample, receiver)
    }

    async fn next_request(requests: &mut mpsc::UnboundedReceiver<PendingSample>) -> PendingSample {
        tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn wait_for_samples(monitor: &DeviceMetricsMonitor, count: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while lock(&monitor.state).history.len() < count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn samples_immediately_and_keeps_running_without_any_snapshot_reader() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        let (source, mut requests) = controlled_source();
        let interval = Duration::from_millis(25);
        assert!(monitor.start_with_timing(source, interval, SAMPLE_TIMEOUT));
        let first = next_request(&mut requests).await;
        let completed_at = Instant::now();
        first.result.send(Ok(status(20, 1_000, 2_000))).unwrap();
        let second = next_request(&mut requests).await;
        assert!(second.started_at.duration_since(completed_at) >= interval);
        second.result.send(Ok(status(40, 2_000, 4_000))).unwrap();
        wait_for_samples(&monitor, 2).await;
        let restored = monitor.snapshot().unwrap();
        assert_eq!(restored.history.len(), 2);
        assert_eq!(restored.history[0].cpu_percent, Some(20));
        assert_eq!(restored.history[1].cpu_percent, Some(40));
        let _ = monitor.stop().unwrap().await;
    }

    #[tokio::test]
    async fn slow_sampling_does_not_overlap_or_queue_catch_up_requests() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        let (source, mut requests) = controlled_source();
        monitor.start_with_timing(source, Duration::from_millis(10), SAMPLE_TIMEOUT);
        let request = next_request(&mut requests).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(requests.try_recv().is_err());
        assert!(monitor.snapshot().unwrap().history.is_empty());
        let task = monitor.stop().unwrap();
        assert!(task.await.unwrap_err().is_cancelled());
        request.dropped.await.unwrap();
    }

    #[tokio::test]
    async fn timeout_drops_the_whole_request_records_a_gap_and_recovers() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        let (source, mut requests) = controlled_source();
        monitor.start_with_timing(
            source,
            Duration::from_millis(25),
            Duration::from_millis(100),
        );
        let expired = next_request(&mut requests).await;
        tokio::time::timeout(Duration::from_secs(2), expired.dropped)
            .await
            .unwrap()
            .unwrap();
        wait_for_samples(&monitor, 1).await;
        assert_eq!(monitor.snapshot().unwrap().history[0].cpu_percent, None);
        assert!(expired.result.send(Ok(status(90, 0, 0))).is_err());
        let recovered = next_request(&mut requests).await;
        recovered.result.send(Ok(status(30, 10, 20))).unwrap();
        wait_for_samples(&monitor, 2).await;
        assert_eq!(monitor.snapshot().unwrap().history[1].cpu_percent, Some(30));
        let _ = monitor.stop().unwrap().await;
    }

    #[tokio::test]
    async fn failed_requests_retry_without_resetting_previous_history() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        let (source, mut requests) = controlled_source();
        monitor.start_with_timing(source, Duration::from_millis(10), SAMPLE_TIMEOUT);
        next_request(&mut requests)
            .await
            .result
            .send(Ok(status(20, 0, 0)))
            .unwrap();
        next_request(&mut requests)
            .await
            .result
            .send(Err(AppError::Connection("测试读取失败".to_owned())))
            .unwrap();
        next_request(&mut requests)
            .await
            .result
            .send(Ok(status(40, 50, 100)))
            .unwrap();
        wait_for_samples(&monitor, 3).await;
        let history = monitor.snapshot().unwrap().history;
        assert_eq!(
            history
                .iter()
                .map(|sample| sample.cpu_percent)
                .collect::<Vec<_>>(),
            [Some(20), None, Some(40)]
        );
        let _ = monitor.stop().unwrap().await;
    }

    #[tokio::test]
    async fn concurrent_starts_create_exactly_one_task() {
        let monitor = Arc::new(DeviceMetricsMonitor::new("connection".to_owned()));
        let barrier = Arc::new(Barrier::new(8));
        let mut starters = Vec::new();
        for _ in 0..8 {
            let monitor = monitor.clone();
            let barrier = barrier.clone();
            starters.push(tokio::spawn(async move {
                barrier.wait().await;
                monitor.start(|| async { Ok(status(20, 0, 0)) })
            }));
        }
        let mut started = 0;
        for task in starters {
            started += usize::from(task.await.unwrap());
        }
        assert_eq!(started, 1);
        wait_for_samples(&monitor, 1).await;
        let _ = monitor.stop().unwrap().await;
        assert!(!monitor.start(|| async { Ok(status(30, 0, 0)) }));
    }

    #[tokio::test]
    async fn stop_wins_over_a_late_success_and_is_idempotent() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        let (source, mut requests) = controlled_source();
        monitor.start(source);
        let pending = next_request(&mut requests).await;
        pending.result.send(Ok(status(90, 100, 100))).unwrap();
        let _ = monitor.stop().unwrap().await;
        pending.dropped.await.unwrap();
        assert!(monitor.stop().is_none());
        assert!(lock(&monitor.state).history.is_empty());
        assert!(lock(&monitor.state).status.is_none());
        assert!(!monitor.start(|| async { Ok(status(30, 0, 0)) }));
    }

    #[tokio::test]
    async fn dropping_the_connection_monitor_cancels_its_inflight_request() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        let (source, mut requests) = controlled_source();
        monitor.start(source);
        let pending = next_request(&mut requests).await;
        let task = lock(&monitor.task).as_ref().unwrap().abort_handle();
        drop(monitor);
        tokio::time::timeout(Duration::from_secs(2), pending.dropped)
            .await
            .unwrap()
            .unwrap();
        assert!(task.is_finished());
        assert!(pending.result.send(Ok(status(90, 0, 0))).is_err());
    }

    #[tokio::test]
    async fn stop_cancels_the_sleep_between_samples() {
        let monitor = DeviceMetricsMonitor::new("connection".to_owned());
        monitor.start(|| async { Ok(status(20, 0, 0)) });
        wait_for_samples(&monitor, 1).await;
        let task = monitor.stop().unwrap();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(monitor.snapshot().is_err());
    }
}
