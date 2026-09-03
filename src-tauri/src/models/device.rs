use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub session_id: String,
    pub available: bool,
    pub os: Option<String>,
    pub architecture: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub cpu_percent: Option<u8>,
    pub cpu_cores: Option<u16>,
    pub memory_percent: Option<u8>,
    pub memory_used_gb: Option<f64>,
    pub memory_total_gb: Option<f64>,
    pub disk_percent: Option<u8>,
    pub disk_used_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    pub network_received_bytes: Option<u64>,
    pub network_transmitted_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMetricSample {
    pub sampled_at_ms: u64,
    pub cpu_percent: Option<u8>,
    pub memory_percent: Option<u8>,
    pub network_download_bytes_per_second: Option<f64>,
    pub network_upload_bytes_per_second: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMetricsSnapshot {
    pub connection_id: String,
    pub status: Option<DeviceStatus>,
    pub history: Vec<DeviceMetricSample>,
    // 与样本使用同一个 Rust 单调时钟，不能与 WebView 的 performance.now 混用。
    pub window_end_ms: u64,
}
