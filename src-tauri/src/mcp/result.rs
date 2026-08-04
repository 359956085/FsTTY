use rmcp::{model::*, ErrorData as McpError};
use serde::Serialize;
use serde_json::json;

pub(super) fn json_result(value: &impl Serialize) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_owned()),
    )])
}

pub(super) fn structured_json_result(value: &impl Serialize) -> CallToolResult {
    let structured_content = serde_json::to_value(value).unwrap_or_else(|_| json!({}));
    let mut result = json_result(value);
    result.structured_content = Some(structured_content);
    result
}

pub(super) fn transfer_link_result(
    resource: Resource,
    message: String,
    structured_content: serde_json::Value,
) -> CallToolResult {
    let mut result = CallToolResult::success(vec![
        ContentBlock::resource_link(resource),
        ContentBlock::text(message),
    ]);
    result.structured_content = Some(structured_content);
    result
}

pub(super) fn remote_file_name(remote_path: &str) -> Result<String, McpError> {
    remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| McpError::invalid_params("远程文件路径无效", None))
}

pub(super) fn tool_error(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.to_owned())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 结构化结果同时提供文本和结构化内容() {
        let result = structured_json_result(&json!({"ok": true}));
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.structured_content, Some(json!({"ok": true})));
    }

    #[test]
    fn 远程文件名拒绝目录路径() {
        assert_eq!(
            remote_file_name("/tmp/file.txt").expect("文件名应有效"),
            "file.txt"
        );
        assert!(remote_file_name("/tmp/").is_err());
    }
}
