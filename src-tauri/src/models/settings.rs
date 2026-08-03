use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: Language,
    pub auto_update: bool,
    pub update_proxy: String,
    #[serde(default = "default_allow_remote_clipboard_write")]
    pub allow_remote_clipboard_write: bool,
    #[serde(default)]
    pub record_mcp_tool_inputs: bool,
    #[serde(default)]
    pub ignored_update_version: Option<String>,
    #[serde(default)]
    pub mcp_enabled: bool,
    #[serde(default)]
    pub mcp_http_enabled: bool,
    #[serde(default = "default_mcp_http_port")]
    pub mcp_http_port: u16,
    #[serde(default)]
    pub mcp_group_permissions: Vec<McpGroupPermission>,
}

fn default_allow_remote_clipboard_write() -> bool {
    true
}

fn default_mcp_http_port() -> u16 {
    37_653
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGroupPermission {
    pub group_name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_enabled")]
    pub session_read: bool,
    #[serde(default = "default_enabled")]
    pub file_read: bool,
    #[serde(default)]
    pub command_execute: bool,
    #[serde(default)]
    pub file_write: bool,
    #[serde(default)]
    pub file_delete: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Language {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}
