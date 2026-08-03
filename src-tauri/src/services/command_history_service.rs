use crate::models::{
    AppError, CommandHistoryEntry, CommandHistoryImportResult, CommandHistoryPage,
    CommandHistorySettings,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::de::{DeserializeSeed, Error as DeError, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::time::Duration;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

const DATABASE_FILE: &str = "command-history.v1.db";
const PAGE_SIZE: usize = 100;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_QUERY_CHARS: usize = 256;

pub struct CommandHistoryService {
    connection: Option<Connection>,
    startup_error: Option<AppError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportEntry {
    command: String,
    executed_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportEntry<'a> {
    command: &'a str,
    executed_at: &'a str,
}

impl CommandHistoryService {
    pub fn load(app_data_dir: &Path) -> Self {
        match open_database(&app_data_dir.join(DATABASE_FILE)) {
            Ok(connection) => Self {
                connection: Some(connection),
                startup_error: None,
            },
            Err(error) => Self {
                connection: None,
                startup_error: Some(error),
            },
        }
    }

    pub fn settings(&self) -> Result<CommandHistorySettings, AppError> {
        settings_from(self.connection()?)
    }

    pub fn update_deduplication(
        &mut self,
        enabled: bool,
    ) -> Result<CommandHistorySettings, AppError> {
        let transaction = self.connection_mut()?.transaction().map_err(db_error)?;
        if enabled {
            // 同命令按执行时间、记录 ID 保留最新项，保证导入旧记录不会覆盖新记录。
            transaction
                .execute(
                    "DELETE FROM command_history AS older
                     WHERE EXISTS (
                       SELECT 1 FROM command_history AS newer
                       WHERE newer.command = older.command
                         AND (newer.executed_at_ms > older.executed_at_ms
                           OR (newer.executed_at_ms = older.executed_at_ms AND newer.id > older.id))
                     )",
                    [],
                )
                .map_err(db_error)?;
        }
        transaction
            .execute(
                "INSERT INTO command_history_settings (key, value) VALUES ('deduplicate', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [if enabled { "1" } else { "0" }],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        self.settings()
    }

    pub fn add(&mut self, command: &str) -> Result<(), AppError> {
        validate_command(command)?;
        let executed_at_ms = now_milliseconds()?;
        let search_text = command.to_lowercase();
        let transaction = self.connection_mut()?.transaction().map_err(db_error)?;
        let deduplicate = deduplicate_from(&transaction)?;
        if deduplicate {
            transaction
                .execute("DELETE FROM command_history WHERE command = ?1", [command])
                .map_err(db_error)?;
        }
        transaction
            .execute(
                "INSERT INTO command_history (command, command_search, executed_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![command, search_text, executed_at_ms],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    }

    pub fn list(
        &self,
        query: &str,
        before_cursor: Option<&str>,
    ) -> Result<CommandHistoryPage, AppError> {
        if query.chars().count() > MAX_QUERY_CHARS || query.chars().any(char::is_control) {
            return Err(AppError::Validation("历史命令搜索内容无效".to_owned()));
        }
        let before = before_cursor.map(parse_cursor).transpose()?;
        let normalized_query = query.trim().to_lowercase();
        let search_pattern = format!("%{}%", escape_like(&normalized_query));
        let connection = self.connection()?;
        let limit = (PAGE_SIZE + 1) as i64;
        let mut entries = Vec::with_capacity(PAGE_SIZE + 1);

        let sql = match (normalized_query.is_empty(), before.is_some()) {
            (true, false) => {
                "SELECT id, command, executed_at_ms FROM command_history
                 ORDER BY executed_at_ms DESC, id DESC LIMIT ?1"
            }
            (true, true) => {
                "SELECT id, command, executed_at_ms FROM command_history
                 WHERE executed_at_ms < ?1 OR (executed_at_ms = ?1 AND id < ?2)
                 ORDER BY executed_at_ms DESC, id DESC LIMIT ?3"
            }
            (false, false) => {
                "SELECT id, command, executed_at_ms FROM command_history
                 WHERE command_search LIKE ?1 ESCAPE '\\'
                 ORDER BY executed_at_ms DESC, id DESC LIMIT ?2"
            }
            (false, true) => {
                "SELECT id, command, executed_at_ms FROM command_history
                 WHERE command_search LIKE ?1 ESCAPE '\\'
                   AND (executed_at_ms < ?2 OR (executed_at_ms = ?2 AND id < ?3))
                 ORDER BY executed_at_ms DESC, id DESC LIMIT ?4"
            }
        };
        let mut statement = connection.prepare(sql).map_err(db_error)?;
        let mut rows = match (normalized_query.is_empty(), before) {
            (true, None) => statement.query([limit]).map_err(db_error)?,
            (true, Some((timestamp, id))) => statement
                .query(params![timestamp, id, limit])
                .map_err(db_error)?,
            (false, None) => statement
                .query(params![search_pattern, limit])
                .map_err(db_error)?,
            (false, Some((timestamp, id))) => statement
                .query(params![search_pattern, timestamp, id, limit])
                .map_err(db_error)?,
        };
        while let Some(row) = rows.next().map_err(db_error)? {
            let id = row.get::<_, i64>(0).map_err(db_error)?;
            let command = row.get::<_, String>(1).map_err(db_error)?;
            let timestamp = row.get::<_, i64>(2).map_err(db_error)?;
            entries.push(CommandHistoryEntry {
                id: id.to_string(),
                command,
                executed_at: format_timestamp(timestamp)?,
            });
        }
        let has_more = entries.len() > PAGE_SIZE;
        entries.truncate(PAGE_SIZE);
        let older_cursor = if has_more {
            entries.last().map(|entry| {
                let timestamp = parse_timestamp(&entry.executed_at).unwrap_or_default();
                format!("{timestamp}:{}", entry.id)
            })
        } else {
            None
        };
        entries.reverse();
        Ok(CommandHistoryPage {
            entries,
            older_cursor,
            has_more,
        })
    }

    pub fn clear(&mut self) -> Result<CommandHistorySettings, AppError> {
        self.connection_mut()?
            .execute("DELETE FROM command_history", [])
            .map_err(db_error)?;
        // VACUUM 失败不应把已经成功的清空操作报告成失败。
        let _ = self
            .connection_mut()?
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
        self.settings()
    }

    pub fn import(&mut self, path: &Path) -> Result<CommandHistoryImportResult, AppError> {
        validate_json_path(path)?;
        let file = File::open(path)
            .map_err(|error| AppError::Persistence(format!("无法打开历史命令文件：{error}")))?;
        let transaction = self.connection_mut()?.transaction().map_err(db_error)?;
        let deduplicate = deduplicate_from(&transaction)?;
        let mut deserializer = serde_json::Deserializer::from_reader(BufReader::new(file));
        let seed = ImportDocumentSeed {
            transaction: &transaction,
            deduplicate,
        };
        let (imported_count, merged_count) = seed
            .deserialize(&mut deserializer)
            .map_err(|error| AppError::Validation(format!("历史命令 JSON 无效：{error}")))?;
        deserializer
            .end()
            .map_err(|error| AppError::Validation(format!("历史命令 JSON 无效：{error}")))?;
        transaction.commit().map_err(db_error)?;
        let total_count = self.settings()?.entry_count;
        Ok(CommandHistoryImportResult {
            imported_count,
            merged_count,
            total_count,
        })
    }

    pub fn export(&self, path: &Path) -> Result<(), AppError> {
        validate_json_path(path)?;
        let parent = path
            .parent()
            .ok_or_else(|| AppError::Validation("历史命令导出路径无效".to_owned()))?;
        fs::create_dir_all(parent)
            .map_err(|error| AppError::Persistence(format!("无法创建导出目录：{error}")))?;
        let temp_path = parent.join(format!(".fstty-history-{}.tmp", Uuid::new_v4()));
        let result = self.write_export(&temp_path);
        if let Err(error) = result {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
        replace_export_file(&temp_path, path)
    }

    fn write_export(&self, path: &Path) -> Result<(), AppError> {
        let file = File::create(path)
            .map_err(|error| AppError::Persistence(format!("无法创建历史命令导出文件：{error}")))?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(b"{\n  \"version\": 1,\n  \"entries\": [")
            .map_err(write_error)?;
        let mut statement = self
            .connection()?
            .prepare(
                "SELECT command, executed_at_ms FROM command_history
                 ORDER BY executed_at_ms ASC, id ASC",
            )
            .map_err(db_error)?;
        let mut rows = statement.query([]).map_err(db_error)?;
        let mut first = true;
        while let Some(row) = rows.next().map_err(db_error)? {
            let command = row.get::<_, String>(0).map_err(db_error)?;
            let timestamp = format_timestamp(row.get::<_, i64>(1).map_err(db_error)?)?;
            if first {
                first = false;
            } else {
                writer.write_all(b",").map_err(write_error)?;
            }
            writer.write_all(b"\n    ").map_err(write_error)?;
            serde_json::to_writer(
                &mut writer,
                &ExportEntry {
                    command: &command,
                    executed_at: &timestamp,
                },
            )
            .map_err(|error| AppError::Persistence(format!("无法序列化历史命令：{error}")))?;
        }
        if !first {
            writer.write_all(b"\n  ").map_err(write_error)?;
        }
        writer.write_all(b"]\n}\n").map_err(write_error)?;
        writer.flush().map_err(write_error)?;
        writer.get_ref().sync_all().map_err(write_error)
    }

    fn connection(&self) -> Result<&Connection, AppError> {
        self.connection.as_ref().ok_or_else(|| {
            self.startup_error
                .clone()
                .unwrap_or_else(|| AppError::Internal("历史命令数据库不可用".to_owned()))
        })
    }

    fn connection_mut(&mut self) -> Result<&mut Connection, AppError> {
        if let Some(error) = self.startup_error.clone() {
            return Err(error);
        }
        self.connection
            .as_mut()
            .ok_or_else(|| AppError::Internal("历史命令数据库不可用".to_owned()))
    }
}

fn open_database(path: &Path) -> Result<Connection, AppError> {
    let connection = Connection::open(path)
        .map_err(|error| AppError::Persistence(format!("无法打开历史命令数据库：{error}")))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    let database_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(db_error)?;
    if database_version > 1 {
        return Err(AppError::Persistence(format!(
            "历史命令数据库版本过新：{database_version}"
        )));
    }
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(db_error)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(db_error)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS command_history (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               command TEXT NOT NULL,
               command_search TEXT NOT NULL,
               executed_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_command_history_time
               ON command_history (executed_at_ms, id);
             CREATE TABLE IF NOT EXISTS command_history_settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             INSERT OR IGNORE INTO command_history_settings (key, value)
               VALUES ('deduplicate', '0');
             PRAGMA user_version = 1;",
        )
        .map_err(db_error)?;
    Ok(connection)
}

fn settings_from(connection: &Connection) -> Result<CommandHistorySettings, AppError> {
    let deduplicate = deduplicate_from(connection)?;
    let (entry_count, unique_count) = connection
        .query_row(
            "SELECT COUNT(*), COUNT(DISTINCT command) FROM command_history",
            [],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
        )
        .map_err(db_error)?;
    Ok(CommandHistorySettings {
        deduplicate,
        entry_count,
        duplicate_count: entry_count.saturating_sub(unique_count),
    })
}

fn deduplicate_from(connection: &Connection) -> Result<bool, AppError> {
    connection
        .query_row(
            "SELECT value FROM command_history_settings WHERE key = 'deduplicate'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)
        .map(|value| value.as_deref() == Some("1"))
}

fn validate_command(command: &str) -> Result<(), AppError> {
    if command.trim().is_empty()
        || command.len() > MAX_COMMAND_BYTES
        || command.chars().any(char::is_control)
    {
        return Err(AppError::Validation("历史命令内容无效".to_owned()));
    }
    Ok(())
}

fn validate_json_path(path: &Path) -> Result<(), AppError> {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err(AppError::Validation(
            "历史命令文件必须使用 .json 扩展名".to_owned(),
        ));
    }
    Ok(())
}

fn now_milliseconds() -> Result<i64, AppError> {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| AppError::Internal("无法生成历史命令时间".to_owned()))
}

fn parse_timestamp(value: &str) -> Result<i64, AppError> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| AppError::Validation("历史命令时间格式无效".to_owned()))?;
    i64::try_from(timestamp.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| AppError::Validation("历史命令时间超出范围".to_owned()))
}

fn format_timestamp(milliseconds: i64) -> Result<String, AppError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
        .map_err(|_| AppError::Persistence("历史命令时间数据无效".to_owned()))?
        .format(&Rfc3339)
        .map_err(|_| AppError::Persistence("无法格式化历史命令时间".to_owned()))
}

fn parse_cursor(cursor: &str) -> Result<(i64, i64), AppError> {
    let (timestamp, id) = cursor
        .split_once(':')
        .ok_or_else(|| AppError::Validation("历史命令游标无效".to_owned()))?;
    let timestamp = timestamp
        .parse::<i64>()
        .map_err(|_| AppError::Validation("历史命令游标无效".to_owned()))?;
    let id = id
        .parse::<i64>()
        .map_err(|_| AppError::Validation("历史命令游标无效".to_owned()))?;
    if timestamp < 0 || id <= 0 {
        return Err(AppError::Validation("历史命令游标无效".to_owned()));
    }
    Ok((timestamp, id))
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn db_error(error: rusqlite::Error) -> AppError {
    AppError::Persistence(format!("历史命令数据库操作失败：{error}"))
}

fn write_error(error: std::io::Error) -> AppError {
    AppError::Persistence(format!("无法写入历史命令文件：{error}"))
}

fn replace_export_file(temp_path: &Path, target_path: &Path) -> Result<(), AppError> {
    let backup_path = target_path.with_extension(format!("json.{}.bak", Uuid::new_v4()));
    let had_target = target_path.exists();
    if had_target {
        fs::rename(target_path, &backup_path)
            .map_err(|error| AppError::Persistence(format!("无法替换导出文件：{error}")))?;
    }
    if let Err(error) = fs::rename(temp_path, target_path) {
        if had_target {
            let _ = fs::rename(&backup_path, target_path);
        }
        return Err(AppError::Persistence(format!("无法提交导出文件：{error}")));
    }
    if had_target {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

struct ImportDocumentSeed<'a> {
    transaction: &'a Transaction<'a>,
    deduplicate: bool,
}

impl<'de> DeserializeSeed<'de> for ImportDocumentSeed<'_> {
    type Value = (u64, u64);

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(ImportDocumentVisitor {
            transaction: self.transaction,
            deduplicate: self.deduplicate,
        })
    }
}

struct ImportDocumentVisitor<'a> {
    transaction: &'a Transaction<'a>,
    deduplicate: bool,
}

impl<'de> Visitor<'de> for ImportDocumentVisitor<'_> {
    type Value = (u64, u64);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("包含 version 和 entries 的历史命令对象")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut version = None;
        let mut counts = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "version" => version = Some(map.next_value::<u8>()?),
                "entries" => {
                    counts = Some(map.next_value_seed(ImportEntriesSeed {
                        transaction: self.transaction,
                        deduplicate: self.deduplicate,
                    })?);
                }
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        if version != Some(1) {
            return Err(A::Error::custom("不支持的历史命令文件版本"));
        }
        counts.ok_or_else(|| A::Error::custom("缺少 entries 字段"))
    }
}

struct ImportEntriesSeed<'a> {
    transaction: &'a Transaction<'a>,
    deduplicate: bool,
}

impl<'de> DeserializeSeed<'de> for ImportEntriesSeed<'_> {
    type Value = (u64, u64);

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(ImportEntriesVisitor {
            transaction: self.transaction,
            deduplicate: self.deduplicate,
        })
    }
}

struct ImportEntriesVisitor<'a> {
    transaction: &'a Transaction<'a>,
    deduplicate: bool,
}

impl<'de> Visitor<'de> for ImportEntriesVisitor<'_> {
    type Value = (u64, u64);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("历史命令数组")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut imported_count = 0_u64;
        let mut merged_count = 0_u64;
        while let Some(entry) = sequence.next_element::<ImportEntry>()? {
            validate_command(&entry.command).map_err(A::Error::custom)?;
            let timestamp = parse_timestamp(&entry.executed_at).map_err(A::Error::custom)?;
            if self.deduplicate {
                let existing_timestamp = self
                    .transaction
                    .query_row(
                        "SELECT executed_at_ms FROM command_history WHERE command = ?1
                         ORDER BY executed_at_ms DESC, id DESC LIMIT 1",
                        [&entry.command],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(A::Error::custom)?;
                if existing_timestamp.is_some() {
                    merged_count += 1;
                }
                // 导入旧备份时保留库中更新的执行记录，避免历史时间倒退。
                if existing_timestamp.is_some_and(|existing| existing >= timestamp) {
                    imported_count += 1;
                    continue;
                }
                self.transaction
                    .execute(
                        "DELETE FROM command_history WHERE command = ?1",
                        [&entry.command],
                    )
                    .map_err(A::Error::custom)?;
            }
            self.transaction
                .execute(
                    "INSERT INTO command_history (command, command_search, executed_at_ms)
                     VALUES (?1, ?2, ?3)",
                    params![entry.command, entry.command.to_lowercase(), timestamp],
                )
                .map_err(A::Error::custom)?;
            imported_count += 1;
        }
        Ok((imported_count, merged_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (std::path::PathBuf, CommandHistoryService) {
        let directory = std::env::temp_dir().join(format!("fstty-history-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("应创建测试目录");
        let service = CommandHistoryService::load(&directory);
        (directory, service)
    }

    #[test]
    fn 添加分页搜索与游标顺序正确() {
        let (directory, mut service) = service();
        for index in 0..105 {
            service
                .add(&format!("echo {index}"))
                .expect("应添加历史命令");
        }
        let latest = service.list("", None).expect("应读取最新页");
        assert_eq!(latest.entries.len(), 100);
        assert!(latest.has_more);
        assert_eq!(
            latest.entries.last().expect("应有最新项").command,
            "echo 104"
        );
        let older = service
            .list("", latest.older_cursor.as_deref())
            .expect("应读取更早页");
        assert_eq!(older.entries.len(), 5);
        assert_eq!(older.entries.first().expect("应有最旧项").command, "echo 0");
        let search = service.list("ECHO 10", None).expect("搜索应忽略大小写");
        assert!(search
            .entries
            .iter()
            .all(|entry| entry.command.contains("10")));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 开启去重立即保留最新项且后续添加幂等() {
        let (directory, mut service) = service();
        service.add("pwd").expect("应添加命令");
        service.add("pwd").expect("应保留重复");
        assert_eq!(service.settings().expect("应读取设置").duplicate_count, 1);
        let settings = service.update_deduplication(true).expect("应开启去重");
        assert_eq!(settings.entry_count, 1);
        assert_eq!(settings.duplicate_count, 0);
        service.add("pwd").expect("去重添加应成功");
        assert_eq!(service.settings().expect("应读取设置").entry_count, 1);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 导入失败整批回滚且导出不包含设置() {
        let (directory, mut service) = service();
        service.add("before").expect("应添加初始命令");
        let invalid = directory.join("invalid.json");
        fs::write(
            &invalid,
            r#"{"version":1,"entries":[{"command":"ok","executedAt":"2026-08-03T00:00:00Z"},{"command":"bad\nline","executedAt":"2026-08-03T00:00:00Z"}]}"#,
        )
        .expect("应写入导入文件");
        assert!(service.import(&invalid).is_err());
        assert_eq!(service.settings().expect("应读取设置").entry_count, 1);

        let exported = directory.join("export.json");
        service.export(&exported).expect("应导出历史");
        let content = fs::read_to_string(exported).expect("应读取导出文件");
        assert!(content.contains("\"command\":\"before\""));
        assert!(!content.contains("deduplicate"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 清空保留去重设置() {
        let (directory, mut service) = service();
        service.update_deduplication(true).expect("应开启去重");
        service.add("ls").expect("应添加命令");
        let settings = service.clear().expect("应清空历史");
        assert!(settings.deduplicate);
        assert_eq!(settings.entry_count, 0);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 数据库启用_wal_并拒绝未来版本() {
        let (directory, service) = service();
        let journal_mode = service
            .connection()
            .expect("应打开数据库")
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .expect("应读取日志模式");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        drop(service);

        let path = directory.join(DATABASE_FILE);
        let connection = Connection::open(&path).expect("应重开数据库");
        connection
            .pragma_update(None, "user_version", 2)
            .expect("应设置未来版本");
        drop(connection);
        assert!(CommandHistoryService::load(&directory).settings().is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 去重导入不会让旧记录覆盖新记录() {
        let (directory, mut service) = service();
        service.update_deduplication(true).expect("应开启去重");
        service.add("pwd").expect("应添加最新命令");
        let path = directory.join("old.json");
        fs::write(
            &path,
            r#"{"version":1,"entries":[{"command":"pwd","executedAt":"2020-01-01T00:00:00Z"}]}"#,
        )
        .expect("应写入导入文件");
        let result = service.import(&path).expect("应导入旧备份");
        assert_eq!(result.imported_count, 1);
        assert_eq!(result.merged_count, 1);
        let page = service.list("", None).expect("应读取历史");
        assert!(
            parse_timestamp(&page.entries[0].executed_at).expect("时间应有效") > 1_577_836_800_000
        );
        let _ = fs::remove_dir_all(directory);
    }
}
