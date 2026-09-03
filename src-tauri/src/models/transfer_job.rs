use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StartTransferJobRequest {
    UploadBatch {
        runtime_id: String,
        connection_id: String,
        local_paths: Vec<String>,
        remote_directory: String,
    },
    Download {
        runtime_id: String,
        connection_id: String,
        remote_path: String,
        local_path: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferJobDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferJobState {
    Running,
    WaitingForConflict,
    Completed,
    Cancelled,
    Failed,
}

impl TransferJobState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJobSummary {
    pub job_id: String,
    pub runtime_id: String,
    pub connection_id: String,
    pub direction: TransferJobDirection,
    pub file_name: String,
    pub batch_index: u32,
    pub batch_total: u32,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub state: TransferJobState,
    pub message: Option<String>,
    pub uploaded: u32,
    pub skipped: u32,
    pub failed: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferConflictDecision {
    Overwrite,
    Skip,
    Cancel,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferJobEvent {
    Updated { job: TransferJobSummary },
}
