use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: Language,
    #[serde(default)]
    pub theme: ThemePreference,
    pub auto_update: bool,
    #[serde(default)]
    pub update_source: UpdateSourcePreference,
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
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum UpdateSourcePreference {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "cnb")]
    Cnb,
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
    pub file_transfer: bool,
    #[serde(default)]
    pub command_execute: bool,
    #[serde(default)]
    pub file_write: bool,
    #[serde(default)]
    pub file_delete: bool,
    #[serde(default)]
    pub command_policy: McpCommandPolicy,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandPolicy {
    pub enabled: bool,
    pub mode: McpCommandPolicyMode,
    pub allow_rules: Vec<McpCommandRule>,
    pub exclude_rules: Vec<McpCommandRule>,
}

impl<'de> Deserialize<'de> for McpCommandPolicy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PolicyWire {
            #[serde(default)]
            enabled: bool,
            #[serde(default)]
            mode: McpCommandPolicyMode,
            #[serde(default)]
            allow_rules: Option<Vec<McpCommandRule>>,
            #[serde(default)]
            exclude_rules: Option<Vec<McpCommandRule>>,
            #[serde(default)]
            rules: Option<Vec<McpCommandRule>>,
        }

        let wire = PolicyWire::deserialize(deserializer)?;
        if wire.rules.is_some() && (wire.allow_rules.is_some() || wire.exclude_rules.is_some()) {
            return Err(D::Error::custom("高级命令策略不能同时包含新旧规则字段"));
        }
        let mut policy = Self {
            enabled: wire.enabled,
            mode: wire.mode,
            allow_rules: wire.allow_rules.unwrap_or_default(),
            exclude_rules: wire.exclude_rules.unwrap_or_default(),
        };
        if let Some(rules) = wire.rules {
            match policy.mode {
                McpCommandPolicyMode::Allow => policy.allow_rules = rules,
                McpCommandPolicyMode::Exclude => policy.exclude_rules = rules,
            }
        }
        Ok(policy)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpCommandPolicyMode {
    #[default]
    Allow,
    Exclude,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandRule {
    pub match_type: McpCommandMatchType,
    pub pattern: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpCommandMatchType {
    Exact,
    Glob,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl ShortcutBinding {
    fn new(code: &str, ctrl: bool, alt: bool, shift: bool) -> Self {
        Self {
            code: code.to_owned(),
            ctrl,
            alt,
            shift,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub terminal_copy: ShortcutBinding,
    pub terminal_paste: ShortcutBinding,
    pub command_history: ShortcutBinding,
    pub command_history_search: ShortcutBinding,
}

impl Default for ShortcutSettings {
    fn default() -> Self {
        Self {
            terminal_copy: ShortcutBinding::new("KeyC", true, false, false),
            terminal_paste: ShortcutBinding::new("KeyV", true, false, false),
            command_history: ShortcutBinding::new("KeyH", true, false, true),
            command_history_search: ShortcutBinding::new("KeyF", true, false, false),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Language {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 旧单名单按原模式迁入对应名单() {
        let allow = serde_json::from_str::<McpCommandPolicy>(
            r#"{"enabled":true,"mode":"allow","rules":[{"matchType":"exact","pattern":"pwd"}]}"#,
        )
        .expect("应读取旧白名单");
        assert_eq!(allow.allow_rules.len(), 1);
        assert!(allow.exclude_rules.is_empty());

        let exclude = serde_json::from_str::<McpCommandPolicy>(
            r#"{"enabled":true,"mode":"exclude","rules":[{"matchType":"glob","pattern":"rm *"}]}"#,
        )
        .expect("应读取旧黑名单");
        assert!(exclude.allow_rules.is_empty());
        assert_eq!(exclude.exclude_rules.len(), 1);
    }

    #[test]
    fn 新旧规则字段不能混用() {
        assert!(serde_json::from_str::<McpCommandPolicy>(
            r#"{"mode":"allow","rules":[],"allowRules":[],"excludeRules":[]}"#,
        )
        .is_err());
    }
}
