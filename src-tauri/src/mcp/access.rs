use super::MAX_COMMAND_BYTES;
use crate::models::{AppError, AppSettings, Language, McpGroupPermission, StoredSession};
use crate::services::AppState;
use rmcp::ErrorData as McpError;
use serde_json::{json, Value};
use std::fmt::{Display, Formatter};

pub(super) fn current_mcp_settings(state: &AppState) -> Result<AppSettings, AppError> {
    let mut settings = state
        .settings_service
        .lock()
        .map_err(|_| AppError::Internal("设置服务锁定失败".to_owned()))?;
    settings.reload_mcp_runtime_settings()?;
    Ok(settings.get())
}

#[derive(Clone, Copy)]
pub(crate) enum Permission {
    Access,
    FileRead,
    FileTransfer,
    Command,
    FileWrite,
    FileDelete,
}

impl Permission {
    fn allowed(self, permission: &McpGroupPermission) -> bool {
        match self {
            // 分组已通过 enabled 过滤；访问权限直接包含会话发现和状态读取。
            Self::Access => true,
            Self::FileRead => permission.file_read,
            Self::FileTransfer => permission.file_transfer,
            Self::Command => permission.command_execute,
            Self::FileWrite => permission.file_write,
            Self::FileDelete => permission.file_delete,
        }
    }
}

#[derive(Debug)]
pub(crate) enum McpAccessError {
    NotFound(String),
    Forbidden(String),
    Internal(String),
    UnsupportedSyntax {
        message: String,
        kind: crate::mcp_command_policy::UnsupportedShellSyntaxKind,
    },
}

impl Display for McpAccessError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(message) | Self::Forbidden(message) | Self::Internal(message) => {
                formatter.write_str(message)
            }
            Self::UnsupportedSyntax { message, .. } => formatter.write_str(message),
        }
    }
}

pub(crate) async fn authorized_session(
    state: &AppState,
    session_id: &str,
    required: Permission,
) -> Result<StoredSession, McpAccessError> {
    authorized_session_context(state, session_id, required)
        .await
        .map(|(session, _, _)| session)
}

pub(super) async fn authorized_command_session(
    state: &AppState,
    session_id: &str,
    command: &str,
) -> Result<StoredSession, McpAccessError> {
    let (session, access, language) =
        authorized_session_context(state, session_id, Permission::Command).await?;
    match crate::mcp_command_policy::evaluate_command_policy(&access.command_policy, command) {
        crate::mcp_command_policy::CommandPolicyDecision::Allowed => {}
        crate::mcp_command_policy::CommandPolicyDecision::Denied => {
            return Err(McpAccessError::Forbidden(localized_access_error(
                &language,
                AccessIssue::CommandPolicyDenied,
            )));
        }
        crate::mcp_command_policy::CommandPolicyDecision::UnsupportedSyntax(kind) => {
            return Err(McpAccessError::UnsupportedSyntax {
                message: localized_unsupported_syntax_error(&language, kind),
                kind,
            });
        }
    }
    Ok(session)
}

pub(super) async fn authorized_session_context(
    state: &AppState,
    session_id: &str,
    required: Permission,
) -> Result<(StoredSession, McpGroupPermission, Language), McpAccessError> {
    let settings =
        current_mcp_settings(state).map_err(|error| McpAccessError::Internal(error.to_string()))?;
    if !settings.mcp_enabled {
        return Err(McpAccessError::Forbidden(localized_access_error(
            &settings.language,
            AccessIssue::ServiceDisabled,
        )));
    }
    let session = state
        .session_service
        .lock()
        .await
        .find(session_id)
        .map_err(|error| match error {
            AppError::NotFound(message) => McpAccessError::NotFound(message),
            error => McpAccessError::Internal(error.to_string()),
        })?;
    let access = state
        .mcp_command_policy_service
        .lock()
        .map_err(|_| McpAccessError::Internal("MCP 策略服务锁定失败".to_owned()))?
        .permission(&session.group)
        .map_err(|error| McpAccessError::Internal(error.to_string()))?
        .filter(|permission| permission.enabled)
        .ok_or_else(|| {
            McpAccessError::Forbidden(localized_access_error(
                &settings.language,
                AccessIssue::GroupDisabled,
            ))
        })?;
    if !required.allowed(&access) {
        return Err(McpAccessError::Forbidden(localized_access_error(
            &settings.language,
            AccessIssue::PermissionDenied,
        )));
    }
    Ok((session, access, settings.language))
}

pub(super) fn command_policy_response(session_id: &str, access: &McpGroupPermission) -> Value {
    let policy = &access.command_policy;
    let empty_rules: &[crate::models::McpCommandRule] = &[];
    let (effective_mode, rules, match_decision, no_match_decision) = if !policy.enabled {
        ("unrestricted", empty_rules, "allow", "allow")
    } else {
        match policy.mode {
            crate::models::McpCommandPolicyMode::Allow => {
                ("allow", policy.allow_rules.as_slice(), "allow", "deny")
            }
            crate::models::McpCommandPolicyMode::Exclude => {
                ("exclude", policy.exclude_rules.as_slice(), "deny", "allow")
            }
        }
    };
    json!({
        "sessionId": session_id,
        "groupName": access.group_name,
        "scope": "mcpCommandPolicyOnly",
        "executionRechecksPolicy": true,
        "advancedPolicy": {
            "enabled": policy.enabled,
            "effectiveMode": effective_mode,
            "rules": rules,
            "matchDecision": match_decision,
            "noMatchDecision": no_match_decision,
            "matching": {
                "target": "eachCommandSegment",
                "caseSensitive": true,
                "trimOuterWhitespace": true,
                "globWildcards": ["*", "?"],
                "globEscapes": ["\\*", "\\?", "\\\\"]
            }
        },
        "shellSyntax": crate::mcp_command_policy::shell_syntax_capabilities(policy.enabled),
        "commandInput": {
            "emptyAllowed": false,
            "maxBytes": MAX_COMMAND_BYTES
        }
    })
}

pub(super) fn permission<'a>(
    permissions: &'a [McpGroupPermission],
    group: &str,
) -> Option<&'a McpGroupPermission> {
    permissions
        .iter()
        .find(|permission| permission.group_name == group && permission.enabled)
}

#[derive(Clone, Copy)]
pub(super) enum AccessIssue {
    ServiceDisabled,
    GroupDisabled,
    PermissionDenied,
    CommandPolicyDenied,
}

pub(super) fn localized_access_error(language: &Language, issue: AccessIssue) -> String {
    let message = match (language, issue) {
        (Language::ZhCn, AccessIssue::ServiceDisabled) => "MCP 服务未启用。",
        (Language::ZhCn, AccessIssue::GroupDisabled) => "当前分组未授权。",
        (Language::ZhCn, AccessIssue::PermissionDenied) => "当前工具未获得分组权限。",
        (Language::ZhCn, AccessIssue::CommandPolicyDenied) => "当前命令被高级命令策略拒绝。",
        (Language::EnUs, AccessIssue::ServiceDisabled) => "The MCP service is disabled.",
        (Language::EnUs, AccessIssue::GroupDisabled) => {
            "The current session group is not authorized."
        }
        (Language::EnUs, AccessIssue::PermissionDenied) => {
            "The current tool is not authorized for this session group."
        }
        (Language::EnUs, AccessIssue::CommandPolicyDenied) => {
            "The command was denied by the advanced command policy."
        }
    };
    let hint = if matches!(issue, AccessIssue::CommandPolicyDenied) {
        if matches!(language, Language::EnUs) {
            "Call get_command_policy to inspect the current rules."
        } else {
            "请调用 get_command_policy 查询当前规则。"
        }
    } else if matches!(language, Language::EnUs) {
        "Call get_permission_guide with the current tool name for setup instructions."
    } else {
        "请使用当前工具名调用 get_permission_guide 获取设置步骤。"
    };
    if matches!(language, Language::EnUs) {
        format!("{message} {hint}")
    } else {
        format!("{message}{hint}")
    }
}

pub(super) fn localized_unsupported_syntax_error(
    language: &Language,
    kind: crate::mcp_command_policy::UnsupportedShellSyntaxKind,
) -> String {
    if matches!(language, Language::EnUs) {
        format!(
            "The advanced policy does not support this Shell syntax ({}); split the command using error.data.",
            kind.as_str()
        )
    } else {
        format!(
            "高级策略不支持此 Shell 语法（{}）；请按 error.data 拆分命令。",
            kind.as_str()
        )
    }
}

pub(super) fn mcp_error(error: AppError) -> McpError {
    McpError::internal_error(error.to_string(), None)
}

pub(super) fn mcp_access_error(error: McpAccessError) -> McpError {
    match error {
        McpAccessError::Internal(message) => McpError::internal_error(message, None),
        McpAccessError::NotFound(message) | McpAccessError::Forbidden(message) => {
            McpError::invalid_request(message, None)
        }
        McpAccessError::UnsupportedSyntax { message, kind } => McpError::invalid_request(
            message,
            Some(crate::mcp_command_policy::unsupported_shell_syntax_data(
                kind,
            )),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission() -> McpGroupPermission {
        McpGroupPermission {
            group_name: "生产".to_owned(),
            enabled: true,
            session_read: false,
            file_read: true,
            file_transfer: false,
            command_execute: false,
            file_write: true,
            file_delete: false,
            command_policy: Default::default(),
        }
    }

    #[test]
    fn 访问包含会话和状态且传输保持独立() {
        let mut access = permission();
        assert!(Permission::Access.allowed(&access));
        assert!(!Permission::FileTransfer.allowed(&access));
        access.file_transfer = true;
        assert!(Permission::FileTransfer.allowed(&access));
    }
}
