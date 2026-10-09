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
    #[serde(default)]
    pub local_highlight_state: Option<LocalHighlightSnapshot>,
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
    pub local_highlight_state: Option<LocalHighlightSnapshot>,
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

// Display metadata contains no terminal input or output text.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalHighlightSnapshot {
    pub version: u8,
    pub token: String,
    pub ready: bool,
    pub phase: LocalHighlightPhase,
    pub directory: Option<LocalHighlightDirectory>,
    pub spans: Vec<LocalHighlightSpan>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalHighlightPhase {
    Prompt,
    Input,
    Execute,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalHighlightDirectory {
    Cmd,
    Powershell,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalHighlightSpan {
    pub line: u32,
    pub start: u32,
    pub end: u32,
    pub kind: LocalHighlightKind,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalHighlightKind {
    Error,
    Warning,
    Directory,
}
impl LocalHighlightSnapshot {
    pub fn valid_for(&self, connection: &SshConnection) -> bool {
        self.version == 1
            && uuid::Uuid::parse_str(&self.token).is_ok()
            && connection
                .local
                .as_ref()
                .filter(|local| local.shell != super::LocalShell::GitBash)
                .and_then(|local| local.highlight.as_ref())
                .is_some_and(|info| info.token == self.token)
            && self.spans.len() <= 2000
            && self
                .spans
                .iter()
                .all(|span| span.line < 11000 && span.start < span.end && span.end <= 8192)
    }
}

#[cfg(test)]
mod highlight_tests {
    use super::*;
    #[test]
    fn metadata_is_bounded_connection_specific_and_cannot_contain_shell_text() {
        let token = uuid::Uuid::new_v4().to_string();
        let connection: SshConnection = serde_json::from_value(serde_json::json!({
            "connectionId": uuid::Uuid::new_v4().to_string(), "sessionId": uuid::Uuid::new_v4().to_string(),
            "homePath": "C:\\Test", "sftpAvailable": false,
            "local": { "shell":"cmd", "label":"CMD", "elevated":false, "highlight": { "token":token, "failed":false } }
        })).unwrap();
        let value = serde_json::json!({ "version":1, "token":token, "ready":true, "phase":"execute", "directory":null,
            "spans":[{ "line":3, "start":0, "end":5, "kind":"error" }] });
        let mut snapshot: LocalHighlightSnapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(snapshot.valid_for(&connection));
        snapshot.spans[0].end = 9000;
        assert!(!snapshot.valid_for(&connection));
        snapshot.spans[0].end = 5;
        snapshot.token = uuid::Uuid::new_v4().to_string();
        assert!(!snapshot.valid_for(&connection));
        let mut contaminated = value;
        contaminated["command"] = serde_json::json!("must never be persisted here");
        assert!(serde_json::from_value::<LocalHighlightSnapshot>(contaminated).is_err());
        snapshot.token = token;
        let mut ssh = connection.clone();
        ssh.local = None;
        assert!(!snapshot.valid_for(&ssh));
        let mut bash = connection;
        bash.local.as_mut().unwrap().shell = super::super::LocalShell::GitBash;
        assert!(!snapshot.valid_for(&bash));
    }
}
