use crate::logging::{local_timestamp, DailyLogWriter};
use fs2::FileExt;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone)]
pub struct McpAuditService {
    writer: Arc<Mutex<DailyLogWriter>>,
}

impl McpAuditService {
    pub fn new(log_directory: &Path) -> Self {
        Self {
            writer: Arc::new(Mutex::new(DailyLogWriter::new(log_directory, "mcp-audit"))),
        }
    }

    pub fn record(
        &self,
        transport: &str,
        tool: &str,
        session_id: Option<&str>,
        result: &str,
        duration: Duration,
        input: Option<&Value>,
    ) {
        let Ok(mut writer) = self.writer.lock() else {
            return;
        };
        let level = if result == "success" { "INFO" } else { "ERROR" };
        let session_id = session_id
            .map(quote_log_string)
            .unwrap_or_else(|| "none".to_owned());
        let mut line = format!(
            "{} [{level}] MCP client=mcp-client transport={transport} tool={tool} sessionId={session_id} result={result} durationMs={}",
            local_timestamp(),
            duration.as_millis()
        );
        if let Some(input) = input {
            line.push_str(" input: ");
            line.push_str(&format_audit_input(input));
        }
        let _ = writer.write_line(line.as_bytes());
    }
}

fn format_audit_input(input: &Value) -> String {
    let mut fields = Vec::new();
    flatten_audit_value("", input, &mut fields);
    if fields.is_empty() {
        "none".to_owned()
    } else {
        fields.sort_unstable();
        fields.join(", ")
    }
}

fn flatten_audit_value(prefix: &str, value: &Value, fields: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let key = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_audit_value(&key, value, fields);
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter().enumerate() {
                flatten_audit_value(&format!("{prefix}[{index}]"), value, fields);
            }
        }
        Value::String(value) => fields.push(format!("{prefix}={}", quote_log_string(value))),
        Value::Number(value) => fields.push(format!("{prefix}={value}")),
        Value::Bool(value) => fields.push(format!("{prefix}={value}")),
        Value::Null => fields.push(format!("{prefix}=null")),
    }
}

fn quote_log_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(escaped, "\\u{:04X}", character as u32);
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

pub struct McpOperationLock {
    file: File,
}

impl Drop for McpOperationLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[derive(Clone)]
pub struct McpOperationLockService {
    directory: PathBuf,
}

impl McpOperationLockService {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            directory: app_data_dir.join("mcp-locks"),
        }
    }

    pub fn try_lock(&self, session_id: &str) -> Result<McpOperationLock, String> {
        fs::create_dir_all(&self.directory).map_err(|_| "无法创建 MCP 操作锁目录")?;
        let safe_name = session_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(self.directory.join(format!("{safe_name}.lock")))
            .map_err(|_| "无法打开 MCP 操作锁")?;
        file.try_lock_exclusive()
            .map_err(|_| "当前会话正由另一个 MCP 操作占用")?;
        Ok(McpOperationLock { file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同一会话的跨实例操作锁互斥() {
        let directory =
            std::env::temp_dir().join(format!("fstty-mcp-lock-{}", uuid::Uuid::new_v4()));
        let first = McpOperationLockService::new(&directory);
        let second = McpOperationLockService::new(&directory);
        let guard = first.try_lock("session-a").expect("首次加锁应成功");
        assert!(second.try_lock("session-a").is_err());
        drop(guard);
        assert!(second.try_lock("session-a").is_ok());
        let _ = fs::remove_dir_all(directory);
    }

    fn read_audit_log(directory: &Path) -> String {
        let path = fs::read_dir(directory)
            .expect("应读取审计目录")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("mcp-audit-") && name.ends_with(".log"))
            })
            .expect("应生成审计日志");
        fs::read_to_string(path).expect("应读取审计日志")
    }

    #[test]
    fn 审计日志使用常规文本格式并按结果设置级别() {
        let directory =
            std::env::temp_dir().join(format!("fstty-mcp-audit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("应创建测试目录");
        let service = McpAuditService::new(&directory);
        service.record(
            "stdio",
            "execute_command",
            Some("session-a"),
            "success",
            Duration::from_millis(12),
            None,
        );
        service.record(
            "http",
            "read_remote_file",
            Some("session\n\"b"),
            "error",
            Duration::from_millis(7),
            Some(&serde_json::json!({
                "path": "/tmp/a\nlog",
                "offset": 2,
                "flags": [true, false]
            })),
        );

        let content = read_audit_log(&directory);
        let lines = content.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0][0..29].len(), 29);
        assert!(lines[0].contains(
            "[INFO] MCP client=mcp-client transport=stdio tool=execute_command sessionId=\"session-a\" result=success durationMs=12"
        ));
        assert!(!lines[0].contains("input:"));
        assert!(lines[1].contains("[ERROR] MCP client=mcp-client transport=http"));
        assert!(lines[1].contains("sessionId=\"session\\n\\\"b\""));
        assert!(lines[1]
            .contains("input: flags[0]=true, flags[1]=false, offset=2, path=\"/tmp/a\\nlog\""));
        assert!(serde_json::from_str::<serde_json::Value>(lines[0]).is_err());
        let _ = fs::remove_dir_all(directory);
    }
}
