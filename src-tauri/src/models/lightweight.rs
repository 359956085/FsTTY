use super::{SshConnection, TransferJobSummary};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LightweightModePhase {
    Normal,
    Preparing,
    Detached,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightweightTerminalRequest {
    pub runtime_id: String,
    pub connection: SshConnection,
    pub current_path: String,
    pub columns: u32,
    pub rows: u32,
    #[serde(default)]
    pub shell_integration_token: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LightweightSnapshotKind {
    Full,
    Viewport,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginLightweightModeResult {
    pub token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedTerminalSummary {
    pub runtime_id: String,
    pub connection_id: String,
    pub session_id: String,
    pub current_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightweightModeState {
    pub active: bool,
    pub suppress_confirmation: bool,
    pub phase: LightweightModePhase,
    pub terminals: Vec<PreservedTerminalSummary>,
    pub transfer_jobs: Vec<TransferJobSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreservedTerminalAttachment {
    pub runtime_id: String,
    pub connection: SshConnection,
    pub current_path: String,
    pub columns: u32,
    pub rows: u32,
    pub truncated: bool,
    pub shell_integration_token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalResumeEvent {
    Snapshot {
        connection_id: String,
        data: String,
        chunk_index: u32,
        total_chunks: u32,
        truncated: bool,
    },
    Data {
        connection_id: String,
        data: String,
    },
    Disconnected {
        connection_id: String,
        exit_code: Option<u32>,
        message: String,
    },
    Error {
        connection_id: String,
        message: String,
    },
    Ready {
        connection_id: String,
        truncated: bool,
    },
}
