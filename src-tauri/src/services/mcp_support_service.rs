use crate::logging::{local_timestamp, DailyLogWriter};
use fs2::FileExt;
use serde::Serialize;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecord<'a> {
    timestamp: String,
    client: &'a str,
    transport: &'a str,
    tool: &'a str,
    session_id: Option<&'a str>,
    result: &'a str,
    duration_ms: u128,
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
    ) {
        let Ok(mut writer) = self.writer.lock() else {
            return;
        };
        let record = AuditRecord {
            timestamp: local_timestamp(),
            client: "mcp-client",
            transport,
            tool,
            session_id,
            result,
            duration_ms: duration.as_millis(),
        };
        let Ok(line) = serde_json::to_string(&record) else {
            return;
        };
        let _ = writer.write_line(line.as_bytes());
    }
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

    #[test]
    fn 审计日志不写入命令或文件正文() {
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
        );
        let path = fs::read_dir(&directory)
            .expect("应读取审计目录")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("mcp-audit-") && name.ends_with(".log"))
            })
            .expect("应生成审计日志");
        let content = fs::read_to_string(path).expect("应读取审计日志");
        let record: serde_json::Value =
            serde_json::from_str(content.trim()).expect("日志应为 JSON");
        let timestamp = record["timestamp"].as_str().expect("应包含格式化时间");
        assert_eq!(timestamp.len(), 29);
        assert_eq!(&timestamp[4..5], "-");
        assert_eq!(&timestamp[10..11], "T");
        assert!(record.get("timestampMs").is_none());
        assert!(content.contains("\"tool\":\"execute_command\""));
        assert!(!content.contains("rm -rf"));
        let _ = fs::remove_dir_all(directory);
    }
}
