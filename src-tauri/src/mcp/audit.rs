use crate::services::McpAuditService;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Instant;

pub(super) struct AuditGuard {
    service: McpAuditService,
    transport: &'static str,
    tool: &'static str,
    session_id: Option<String>,
    started: Instant,
    succeeded: bool,
    input: Option<Value>,
}

impl AuditGuard {
    pub(super) fn new(
        service: McpAuditService,
        transport: &'static str,
        tool: &'static str,
        session_id: Option<String>,
        input: Option<Value>,
    ) -> Self {
        Self {
            service,
            transport,
            tool,
            session_id,
            started: Instant::now(),
            succeeded: false,
            input,
        }
    }

    pub(super) fn succeed(mut self) {
        self.succeeded = true;
    }
}

impl Drop for AuditGuard {
    fn drop(&mut self) {
        self.service.record(
            self.transport,
            self.tool,
            self.session_id.as_deref(),
            if self.succeeded { "success" } else { "error" },
            self.started.elapsed(),
            self.input.as_ref(),
        );
    }
}

pub(super) fn write_file_audit_input(
    session_id: &str,
    path: &str,
    content: &str,
    base64: bool,
) -> Value {
    // 文件正文可能包含密钥或大段源码，只保留可核对内容一致性的摘要。
    let content_sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    json!({
        "sessionId": session_id,
        "path": path,
        "contentOmitted": true,
        "contentBytes": content.len(),
        "contentSha256": content_sha256,
        "base64": base64,
    })
}

pub(super) fn command_audit_input(session_id: &str, command: &str, timeout_seconds: u64) -> Value {
    // 命令本身可能携带口令、令牌或业务数据，只记录审计所需的大小和超时。
    json!({
        "sessionId": session_id,
        "commandOmitted": true,
        "commandBytes": command.len(),
        "timeoutSeconds": timeout_seconds,
    })
}

pub(super) fn redact_audit_value(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            for (key, value) in &mut object {
                if is_sensitive_audit_key(key) {
                    *value = Value::String("[已隐藏]".to_owned());
                } else {
                    *value = redact_audit_value(std::mem::take(value));
                }
            }
            Value::Object(object)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(redact_audit_value).collect()),
        other => other,
    }
}

fn is_sensitive_audit_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "password",
        "passphrase",
        "credential",
        "privatekey",
        "secret",
        "token",
    ]
    .iter()
    .any(|part| key.contains(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recursively_hides_sensitive_audit_fields() {
        let value = redact_audit_value(json!({
            "command": "visible",
            "password": "secret-password",
            "nested": {
                "passphrase": "secret-passphrase",
                "items": [{"token": "secret-token"}],
            },
        }));
        let serialized = value.to_string();

        assert_eq!(value["command"], "visible");
        assert_eq!(value["password"], "[已隐藏]");
        assert_eq!(value["nested"]["passphrase"], "[已隐藏]");
        assert_eq!(value["nested"]["items"][0]["token"], "[已隐藏]");
        assert!(!serialized.contains("secret-password"));
        assert!(!serialized.contains("secret-passphrase"));
        assert!(!serialized.contains("secret-token"));
    }

    #[test]
    fn command_audit_does_not_record_command_text() {
        let value = command_audit_input("session-1", "curl -H token=secret", 60);

        assert_eq!(value["commandOmitted"], true);
        assert_eq!(value["commandBytes"], 20);
        assert!(!value.to_string().contains("secret"));
    }
}
