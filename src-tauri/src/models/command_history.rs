use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub id: String,
    pub command: String,
    pub executed_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryPage {
    pub entries: Vec<CommandHistoryEntry>,
    pub older_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistorySettings {
    pub deduplicate: bool,
    pub entry_count: u64,
    pub duplicate_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryImportResult {
    pub imported_count: u64,
    pub merged_count: u64,
    pub total_count: u64,
}
