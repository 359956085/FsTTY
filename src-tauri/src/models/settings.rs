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
    pub ignored_update_version: Option<String>,
}

fn default_allow_remote_clipboard_write() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Language {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}
