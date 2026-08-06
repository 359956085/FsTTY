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
