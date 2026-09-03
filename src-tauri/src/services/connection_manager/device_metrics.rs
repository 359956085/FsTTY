use super::*;
use crate::models::DeviceMetricsSnapshot;
use crate::services::DeviceService;

#[cfg(test)]
mod tests;

impl ConnectionManager {
    pub(crate) async fn device_metrics_snapshot(
        &self,
        connection_id: &str,
    ) -> Result<DeviceMetricsSnapshot, AppError> {
        let entry = self.entry(connection_id).await?;
        let metrics = entry
            .device_metrics
            .as_ref()
            .ok_or_else(|| AppError::NotFound("SSH 连接不存在或已断开".to_owned()))?;
        metrics.snapshot()
    }

    pub(super) async fn start_device_metrics(&self, connection_id: &str) {
        let Ok(entry) = self.entry(connection_id).await else {
            return;
        };
        if self.inner.device_metrics_stopped.load(Ordering::Acquire) {
            return;
        }
        let Some(metrics) = &entry.device_metrics else {
            return;
        };
        // 任务不能强持有整个连接表，否则连接表、采样任务形成循环引用。
        let manager = Arc::downgrade(&self.inner);
        let connection_id = connection_id.to_owned();
        metrics.start(move || {
            let manager = manager.upgrade();
            let connection_id = connection_id.clone();
            async move {
                let inner = manager
                    .ok_or_else(|| AppError::NotFound("SSH 连接不存在或已断开".to_owned()))?;
                DeviceService
                    .status(&ConnectionManager { inner }, &connection_id)
                    .await
            }
        });
    }

    pub(crate) async fn shutdown_device_metrics(&self) {
        self.inner
            .device_metrics_stopped
            .store(true, Ordering::Release);
        let tasks: Vec<_> = self
            .inner
            .registry
            .read()
            .await
            .connections
            .values()
            .filter_map(|entry| {
                entry
                    .device_metrics
                    .as_ref()
                    .and_then(DeviceMetricsMonitor::stop)
            })
            .collect();
        // 先全部取消再等待析构，退出时不再保留采样请求和 SSH 通道。
        for task in tasks {
            let _ = task.await;
        }
    }
}
