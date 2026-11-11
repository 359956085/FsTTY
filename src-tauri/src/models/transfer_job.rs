use super::PermissionPatch;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StartTransferJobRequest {
    Permissions {
        runtime_id: String,
        connection_id: String,
        paths: Vec<String>,
        recursive: bool,
        file_patch: PermissionPatch,
        directory_patch: PermissionPatch,
    },
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
    DownloadBatch {
        runtime_id: String,
        connection_id: String,
        remote_paths: Vec<String>,
        local_directory: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferJobDirection {
    Permissions,
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
    #[serde(flatten)]
    pub details: FileJobDetails,
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
    pub downloaded: u32,
    pub active_count: u32,
    pub queued_count: u32,
    pub conflict_id: Option<String>,
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

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJobDetails {
    pub phase: Option<String>,
    pub item_total: u32,
    pub processed_items: u32,
    pub completed_directories: u32,
    pub changed_permissions: u32,
}
