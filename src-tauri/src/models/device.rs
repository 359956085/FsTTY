use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub session_id: String,
    pub ip: String,
    pub username: String,
    pub os: String,
    pub uptime: String,
    pub cpu_percent: u8,
    pub memory_percent: u8,
    pub disk_percent: u8,
    pub services: Vec<ServiceStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub name: String,
    pub state: String,
    pub port: u16,
}
