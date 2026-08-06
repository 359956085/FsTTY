use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateSource {
    Cnb,
    GitHub,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub body: Option<String>,
    pub date: Option<String>,
    pub source: AppUpdateSource,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppUpdateProgress {
    Started { total_bytes: Option<u64> },
    Progress { chunk_bytes: u64 },
    Finished,
}
