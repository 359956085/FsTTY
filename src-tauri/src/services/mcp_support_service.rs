use fs2::FileExt;
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const AUDIT_MAX_BYTES: u64 = 10 * 1024 * 1024;
const AUDIT_BACKUPS: usize = 3;

#[derive(Clone)]
pub struct McpAuditService {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecord<'a> {
    timestamp_ms: u128,
    client: &'a str,
    transport: &'a str,
    tool: &'a str,
    session_id: Option<&'a str>,
    result: &'a str,
    duration_ms: u128,
}

impl McpAuditService {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            path: app_data_dir.join("mcp-audit.jsonl"),
            write_lock: Arc::new(Mutex::new(())),
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
        let Ok(_guard) = self.write_lock.lock() else {
            return;
        };
        if rotate_if_needed(&self.path).is_err() {
            return;
        }
        let record = AuditRecord {
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
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
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn rotate_if_needed(path: &Path) -> std::io::Result<()> {
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) < AUDIT_MAX_BYTES {
        return Ok(());
    }
    let backup_path = |index: usize| PathBuf::from(format!("{}.{}", path.display(), index));
    let _ = fs::remove_file(backup_path(AUDIT_BACKUPS));
    for index in (1..AUDIT_BACKUPS).rev() {
        let source = backup_path(index);
        if source.exists() {
            fs::rename(source, backup_path(index + 1))?;
        }
    }
    if path.exists() {
        fs::rename(path, backup_path(1))?;
    }
    Ok(())
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
        let content =
            fs::read_to_string(directory.join("mcp-audit.jsonl")).expect("应写入审计日志");
        assert!(content.contains("\"tool\":\"execute_command\""));
        assert!(!content.contains("rm -rf"));
        let _ = fs::remove_dir_all(directory);
    }
}
