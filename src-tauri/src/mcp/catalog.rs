use crate::models::Language;
use serde::Serialize;

#[derive(Debug)]
pub(super) struct GuidePermission {
    key: &'static str,
    zh_name: &'static str,
    en_name: &'static str,
    tools: &'static [&'static str],
    zh_warning: Option<&'static str>,
    en_warning: Option<&'static str>,
}

pub(super) const GUIDE_PERMISSIONS: &[GuidePermission] = &[
    GuidePermission {
        key: "enabled",
        zh_name: "访问",
        en_name: "Access",
        tools: &["list_sessions", "get_device_status"],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "fileRead",
        zh_name: "远程文件读取",
        en_name: "Remote file read",
        tools: &[
            "list_remote_files",
            "read_remote_file",
            "search_remote_file",
        ],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "fileTransfer",
        zh_name: "文件传输",
        en_name: "File transfer",
        tools: &[
            "upload_local_file",
            "download_remote_file",
            "create_remote_file_upload_link",
            "create_remote_file_download_link",
        ],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "fileWrite",
        zh_name: "文件编辑",
        en_name: "File editing",
        tools: &[
            "write_remote_file",
            "create_remote_directory",
            "rename_remote_entry",
            "move_remote_entry",
        ],
        zh_warning: None,
        en_warning: None,
    },
    GuidePermission {
        key: "fileDelete",
        zh_name: "文件删除",
        en_name: "File deletion",
        tools: &["delete_remote_entry"],
        zh_warning: Some("文件删除属于破坏性操作，远程删除无法撤销。"),
        en_warning: Some("File deletion is destructive and cannot be undone remotely."),
    },
    GuidePermission {
        key: "commandExecute",
        zh_name: "命令执行",
        en_name: "Command execution",
        tools: &["get_command_policy", "execute_command"],
        zh_warning: Some("命令执行属于高风险权限，可绕过文件编辑和删除限制。"),
        en_warning: Some(
            "Command execution is high risk and can bypass file editing and deletion restrictions.",
        ),
    },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPermissionCatalogEntry {
    permission_key: &'static str,
    tools: &'static [&'static str],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionGuideEntry {
    permission_key: &'static str,
    permission_name: &'static str,
    tools: &'static [&'static str],
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionGuideResponse {
    pub(super) locale: &'static str,
    pub(super) settings_path: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) target_tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) permission_key: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) permission_name: Option<&'static str>,
    pub(super) steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) warning: Option<&'static str>,
    pub(super) permissions: Vec<PermissionGuideEntry>,
}

impl GuidePermission {
    fn name(&self, language: &Language) -> &'static str {
        if matches!(language, Language::EnUs) {
            self.en_name
        } else {
            self.zh_name
        }
    }

    fn warning(&self, language: &Language) -> Option<&'static str> {
        if matches!(language, Language::EnUs) {
            self.en_warning
        } else {
            self.zh_warning
        }
    }
}

pub(crate) fn permission_catalog() -> Vec<McpPermissionCatalogEntry> {
    GUIDE_PERMISSIONS
        .iter()
        .map(|permission| McpPermissionCatalogEntry {
            permission_key: permission.key,
            tools: permission.tools,
        })
        .collect()
}

pub(super) fn guide_permission_for_tool(tool_name: &str) -> Option<&'static GuidePermission> {
    GUIDE_PERMISSIONS
        .iter()
        .find(|permission| permission.tools.contains(&tool_name))
}

pub(super) fn supported_guide_tools() -> Vec<&'static str> {
    GUIDE_PERMISSIONS
        .iter()
        .flat_map(|permission| permission.tools.iter().copied())
        .collect()
}

pub(crate) fn mcp_agent_prompt() -> String {
    let tool_groups = GUIDE_PERMISSIONS
        .iter()
        .filter(|permission| !permission.tools.is_empty())
        .map(|permission| {
            format!(
                "- {} ({}): {}",
                permission.en_name,
                permission.key,
                permission.tools.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<!-- fstty:begin -->

Use FsTTY MCP:
- Call list_sessions first to discover available sessions.
- Use get_device_status for status; list_remote_files, read_remote_file, and search_remote_file for files and logs.
- Before execute_command, call get_command_policy for the session; obey its active rules and shellSyntax. Chains are checked per segment; split unsupported syntax. sh -c, bash -c, and eval arguments are not recursively checked.
- get_permission_guide returns FsTTY permission setup steps for a tool.
- stdio local transfers require MCP client Roots. HTTP transfers use create_remote_file_upload_link or create_remote_file_download_link; links expire after five minutes.
- Host-key and credential issues are handled in FsTTY.
- Tool parameters are defined by live MCP tool schemas.

Permission and tool mapping:
{tool_groups}
- Guide: get_permission_guide

<!-- fstty:end -->"#
    )
}

fn permission_guide_entry(
    permission: &'static GuidePermission,
    language: &Language,
) -> PermissionGuideEntry {
    PermissionGuideEntry {
        permission_key: permission.key,
        permission_name: permission.name(language),
        tools: permission.tools,
        warning: permission.warning(language),
    }
}

pub(super) fn permission_guide_response(
    language: &Language,
    tool_name: Option<String>,
) -> Result<PermissionGuideResponse, String> {
    let target_permission = tool_name
        .as_deref()
        .map(|tool_name| {
            guide_permission_for_tool(tool_name)
                .ok_or_else(|| permission_guide_unknown_tool(language))
        })
        .transpose()?;
    let english = matches!(language, Language::EnUs);
    let settings_path = if english {
        "Settings > MCP"
    } else {
        "设置 > MCP"
    };
    let mut steps = if english {
        vec![
            "Open Settings > MCP in FsTTY.".to_owned(),
            "Find the group that contains the target session.".to_owned(),
            "Enable Access.".to_owned(),
        ]
    } else {
        vec![
            "打开 FsTTY 的“设置 > MCP”。".to_owned(),
            "找到目标会话所属分组。".to_owned(),
            "开启“访问”。".to_owned(),
        ]
    };
    match target_permission {
        Some(permission) if permission.key != "enabled" => {
            steps.push(if english {
                format!("Enable {}.", permission.name(language))
            } else {
                format!("开启“{}”。", permission.name(language))
            });
        }
        Some(_) => {}
        None => steps.push(if english {
            "Enable the permissions required by the task.".to_owned()
        } else {
            "按任务需要开启对应权限。".to_owned()
        }),
    }
    steps.push(if english {
        "Select Save MCP settings.".to_owned()
    } else {
        "点击“保存 MCP 设置”。".to_owned()
    });
    let permissions = match target_permission {
        Some(permission) if permission.key == "enabled" => {
            vec![permission_guide_entry(permission, language)]
        }
        Some(permission) => vec![
            permission_guide_entry(&GUIDE_PERMISSIONS[0], language),
            permission_guide_entry(permission, language),
        ],
        None => GUIDE_PERMISSIONS
            .iter()
            .map(|permission| permission_guide_entry(permission, language))
            .collect(),
    };
    Ok(PermissionGuideResponse {
        locale: if english { "en-US" } else { "zh-CN" },
        settings_path,
        target_tool: tool_name,
        permission_key: target_permission.map(|permission| permission.key),
        permission_name: target_permission.map(|permission| permission.name(language)),
        steps,
        warning: target_permission.and_then(|permission| permission.warning(language)),
        permissions,
    })
}

fn permission_guide_unknown_tool(language: &Language) -> String {
    let tools = supported_guide_tools().join(", ");
    if matches!(language, Language::EnUs) {
        format!("Unknown tool. Supported tools: {tools}")
    } else {
        format!("未知工具。支持的工具：{tools}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_catalog_covers_each_tool_once() {
        let mut tools = supported_guide_tools();
        let total = tools.len();
        tools.sort_unstable();
        tools.dedup();

        assert_eq!(tools.len(), total);
        assert!(tools.contains(&"search_remote_file"));
        assert!(tools.contains(&"get_command_policy"));
        assert_eq!(
            guide_permission_for_tool("download_remote_file").map(|entry| entry.key),
            Some("fileTransfer")
        );
        assert_eq!(
            guide_permission_for_tool("get_device_status").map(|entry| entry.key),
            Some("enabled")
        );
        assert_eq!(permission_catalog().len(), GUIDE_PERMISSIONS.len());
    }
}
