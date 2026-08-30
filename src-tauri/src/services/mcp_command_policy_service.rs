use crate::mcp_command_policy::normalize_policy;
use crate::models::{
    AppError, McpCommandMatchType, McpCommandPolicy, McpCommandPolicyMode, McpCommandRule,
    McpGroupPermission,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::fs;
use std::path::Path;
use std::time::Duration;

const DATABASE_FILE: &str = "mcp-command-policy.v1.db";
const DATABASE_VERSION: i64 = 2;
const LEGACY_MIGRATION_KEY: &str = "legacySettingsMigrated";
const MAX_GROUPS: usize = 100;

pub struct McpCommandPolicyService {
    connection: Option<Connection>,
    startup_error: Option<AppError>,
}

impl McpCommandPolicyService {
    pub fn load(app_data_dir: &Path, legacy: Vec<McpGroupPermission>) -> Self {
        let result = fs::create_dir_all(app_data_dir)
            .map_err(|error| AppError::Persistence(format!("无法创建 MCP 策略数据库目录：{error}")))
            .and_then(|_| open_database(&app_data_dir.join(DATABASE_FILE)))
            .and_then(|mut connection| {
                migrate_legacy(&mut connection, legacy)?;
                Ok(connection)
            });
        match result {
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

    pub fn list_permissions(&self) -> Result<Vec<McpGroupPermission>, AppError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction().map_err(db_error)?;
        let mut statement = transaction
            .prepare(
                "SELECT group_name, enabled, session_read, file_read, file_transfer,
                        command_execute, file_write, file_delete, policy_enabled, policy_mode
                 FROM mcp_group_permissions ORDER BY rowid",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, bool>(7)?,
                    row.get::<_, bool>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(db_error)?;
        let mut permissions = Vec::new();
        for row in rows {
            let (
                group_name,
                enabled,
                session_read,
                file_read,
                file_transfer,
                command_execute,
                file_write,
                file_delete,
                policy_enabled,
                policy_mode,
            ) = row.map_err(db_error)?;
            permissions.push(McpGroupPermission {
                command_policy: McpCommandPolicy {
                    enabled: policy_enabled,
                    mode: parse_mode(&policy_mode)?,
                    allow_rules: load_rules(
                        &transaction,
                        &group_name,
                        McpCommandPolicyMode::Allow,
                    )?,
                    exclude_rules: load_rules(
                        &transaction,
                        &group_name,
                        McpCommandPolicyMode::Exclude,
                    )?,
                },
                group_name,
                enabled,
                session_read,
                file_read,
                file_transfer,
                command_execute,
                file_write,
                file_delete,
            });
        }
        drop(statement);
        transaction.commit().map_err(db_error)?;
        Ok(permissions)
    }

    pub fn permission(&self, group_name: &str) -> Result<Option<McpGroupPermission>, AppError> {
        let connection = self.connection()?;
        let transaction = connection.unchecked_transaction().map_err(db_error)?;
        let row = transaction
            .query_row(
                "SELECT enabled, session_read, file_read, file_transfer, command_execute,
                        file_write, file_delete, policy_enabled, policy_mode
                 FROM mcp_group_permissions WHERE group_name = ?1",
                [group_name],
                |row| {
                    Ok((
                        row.get::<_, bool>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, bool>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, bool>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some((
            enabled,
            session_read,
            file_read,
            file_transfer,
            command_execute,
            file_write,
            file_delete,
            policy_enabled,
            policy_mode,
        )) = row
        else {
            transaction.commit().map_err(db_error)?;
            return Ok(None);
        };
        let permission = McpGroupPermission {
            group_name: group_name.to_owned(),
            enabled,
            session_read,
            file_read,
            file_transfer,
            command_execute,
            file_write,
            file_delete,
            command_policy: McpCommandPolicy {
                enabled: policy_enabled,
                mode: parse_mode(&policy_mode)?,
                allow_rules: load_rules(&transaction, group_name, McpCommandPolicyMode::Allow)?,
                exclude_rules: load_rules(&transaction, group_name, McpCommandPolicyMode::Exclude)?,
            },
        };
        transaction.commit().map_err(db_error)?;
        Ok(Some(permission))
    }

    pub fn replace_all(
        &mut self,
        permissions: Vec<McpGroupPermission>,
    ) -> Result<Vec<McpGroupPermission>, AppError> {
        let permissions = normalize_permissions(permissions)?;
        let transaction = self.connection_mut()?.transaction().map_err(db_error)?;
        transaction
            .execute("DELETE FROM mcp_group_permissions", [])
            .map_err(db_error)?;
        for permission in &permissions {
            insert_permission(&transaction, permission)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(permissions)
    }

    pub fn rename_group(&mut self, old_name: &str, new_name: &str) -> Result<(), AppError> {
        validate_group_name(new_name)?;
        self.connection_mut()?
            .execute(
                "UPDATE mcp_group_permissions SET group_name = ?2 WHERE group_name = ?1",
                params![old_name, new_name.trim()],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn delete_group(&mut self, group_name: &str) -> Result<(), AppError> {
        self.connection_mut()?
            .execute(
                "DELETE FROM mcp_group_permissions WHERE group_name = ?1",
                [group_name],
            )
            .map_err(db_error)?;
        Ok(())
    }

    fn connection(&self) -> Result<&Connection, AppError> {
        self.connection.as_ref().ok_or_else(|| {
            self.startup_error
                .clone()
                .unwrap_or_else(database_unavailable)
        })
    }

    fn connection_mut(&mut self) -> Result<&mut Connection, AppError> {
        self.connection.as_mut().ok_or_else(|| {
            self.startup_error
                .clone()
                .unwrap_or_else(database_unavailable)
        })
    }
}

fn open_database(path: &Path) -> Result<Connection, AppError> {
    let mut connection = Connection::open(path).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    let version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(db_error)?;
    if version > DATABASE_VERSION {
        return Err(AppError::Persistence(format!(
            "FsTTY MCP 代理版本错配：当前代理仅支持策略数据库 schema v{DATABASE_VERSION}，数据库为 schema v{version}。请关闭并重新打开 Agent；若仍失败，请在 FsTTY 设置中重新执行 MCP 一键配置。"
        )));
    }
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(db_error)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(db_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(db_error)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS mcp_policy_metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS mcp_group_permissions (
               group_name TEXT PRIMARY KEY,
               enabled INTEGER NOT NULL,
               session_read INTEGER NOT NULL,
               file_read INTEGER NOT NULL,
               file_transfer INTEGER NOT NULL DEFAULT 0,
               command_execute INTEGER NOT NULL,
               file_write INTEGER NOT NULL,
               file_delete INTEGER NOT NULL,
               policy_enabled INTEGER NOT NULL,
               policy_mode TEXT NOT NULL CHECK(policy_mode IN ('allow', 'exclude'))
             );
             CREATE TABLE IF NOT EXISTS mcp_command_rules (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               group_name TEXT NOT NULL,
               list_mode TEXT NOT NULL CHECK(list_mode IN ('allow', 'exclude')),
               position INTEGER NOT NULL,
               match_type TEXT NOT NULL CHECK(match_type IN ('exact', 'glob')),
               pattern TEXT NOT NULL,
               FOREIGN KEY(group_name) REFERENCES mcp_group_permissions(group_name)
                 ON DELETE CASCADE ON UPDATE CASCADE,
               UNIQUE(group_name, list_mode, match_type, pattern)
             );
             CREATE INDEX IF NOT EXISTS idx_mcp_command_rules_group_mode_position
               ON mcp_command_rules(group_name, list_mode, position);",
        )
        .map_err(db_error)?;
    // GUI 与 stdio 可能并发启动；写事务保证只执行一次结构迁移。
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let current_version = transaction
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(db_error)?;
    if current_version == 1 {
        // 新权限默认关闭，避免升级后扩大既有分组的上传或下载能力。
        transaction
            .execute(
                "ALTER TABLE mcp_group_permissions
                 ADD COLUMN file_transfer INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(db_error)?;
    }
    if current_version < DATABASE_VERSION {
        transaction
            .pragma_update(None, "user_version", DATABASE_VERSION)
            .map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)?;
    Ok(connection)
}

fn migrate_legacy(
    connection: &mut Connection,
    legacy: Vec<McpGroupPermission>,
) -> Result<(), AppError> {
    // 先取得写事务，避免主程序与 stdio 进程并发首次启动时重复迁移。
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let migrated = transaction
        .query_row(
            "SELECT value FROM mcp_policy_metadata WHERE key = ?1",
            [LEGACY_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    if migrated {
        transaction.commit().map_err(db_error)?;
        return Ok(());
    }
    let legacy = normalize_permissions(legacy)?;
    let existing = transaction
        .query_row("SELECT COUNT(*) FROM mcp_group_permissions", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(db_error)?;
    if existing == 0 {
        for permission in &legacy {
            insert_permission(&transaction, permission)?;
        }
    }
    transaction
        .execute(
            "INSERT INTO mcp_policy_metadata (key, value) VALUES (?1, '1')",
            [LEGACY_MIGRATION_KEY],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn normalize_permissions(
    permissions: Vec<McpGroupPermission>,
) -> Result<Vec<McpGroupPermission>, AppError> {
    if permissions.len() > MAX_GROUPS {
        return Err(AppError::Validation("MCP 分组权限数量过多".to_owned()));
    }
    let mut result = Vec::with_capacity(permissions.len());
    for permission in permissions {
        validate_group_name(&permission.group_name)?;
        let group_name = permission.group_name.trim().to_owned();
        if result
            .iter()
            .any(|current: &McpGroupPermission| current.group_name == group_name)
        {
            return Err(AppError::Validation("MCP 分组权限重复".to_owned()));
        }
        result.push(McpGroupPermission {
            group_name,
            command_policy: normalize_policy(permission.command_policy)?,
            ..permission
        });
    }
    Ok(result)
}

fn validate_group_name(name: &str) -> Result<(), AppError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return Err(AppError::Validation("MCP 分组名称无效".to_owned()));
    }
    Ok(())
}

fn insert_permission(
    transaction: &Transaction<'_>,
    permission: &McpGroupPermission,
) -> Result<(), AppError> {
    transaction
        .execute(
            "INSERT INTO mcp_group_permissions (
               group_name, enabled, session_read, file_read, file_transfer, command_execute,
               file_write, file_delete, policy_enabled, policy_mode
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                permission.group_name,
                permission.enabled,
                permission.session_read,
                permission.file_read,
                permission.file_transfer,
                permission.command_execute,
                permission.file_write,
                permission.file_delete,
                permission.command_policy.enabled,
                mode_name(permission.command_policy.mode),
            ],
        )
        .map_err(db_error)?;
    insert_rules(
        transaction,
        &permission.group_name,
        McpCommandPolicyMode::Allow,
        &permission.command_policy.allow_rules,
    )?;
    insert_rules(
        transaction,
        &permission.group_name,
        McpCommandPolicyMode::Exclude,
        &permission.command_policy.exclude_rules,
    )
}

fn insert_rules(
    transaction: &Transaction<'_>,
    group_name: &str,
    mode: McpCommandPolicyMode,
    rules: &[McpCommandRule],
) -> Result<(), AppError> {
    for (position, rule) in rules.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO mcp_command_rules (
                   group_name, list_mode, position, match_type, pattern
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    group_name,
                    mode_name(mode),
                    position as i64,
                    match_type_name(rule.match_type),
                    rule.pattern,
                ],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

fn load_rules(
    connection: &Connection,
    group_name: &str,
    mode: McpCommandPolicyMode,
) -> Result<Vec<McpCommandRule>, AppError> {
    let mut statement = connection
        .prepare(
            "SELECT match_type, pattern FROM mcp_command_rules
             WHERE group_name = ?1 AND list_mode = ?2 ORDER BY position, id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![group_name, mode_name(mode)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?;
    let mut rules = Vec::new();
    for row in rows {
        let (match_type, pattern) = row.map_err(db_error)?;
        rules.push(McpCommandRule {
            match_type: parse_match_type(&match_type)?,
            pattern,
        });
    }
    Ok(rules)
}

fn mode_name(mode: McpCommandPolicyMode) -> &'static str {
    match mode {
        McpCommandPolicyMode::Allow => "allow",
        McpCommandPolicyMode::Exclude => "exclude",
    }
}

fn parse_mode(value: &str) -> Result<McpCommandPolicyMode, AppError> {
    match value {
        "allow" => Ok(McpCommandPolicyMode::Allow),
        "exclude" => Ok(McpCommandPolicyMode::Exclude),
        _ => Err(AppError::Persistence("MCP 策略模式无效".to_owned())),
    }
}

fn match_type_name(match_type: McpCommandMatchType) -> &'static str {
    match match_type {
        McpCommandMatchType::Exact => "exact",
        McpCommandMatchType::Glob => "glob",
    }
}

fn parse_match_type(value: &str) -> Result<McpCommandMatchType, AppError> {
    match value {
        "exact" => Ok(McpCommandMatchType::Exact),
        "glob" => Ok(McpCommandMatchType::Glob),
        _ => Err(AppError::Persistence("MCP 命令匹配类型无效".to_owned())),
    }
}

fn database_unavailable() -> AppError {
    AppError::Persistence("MCP 策略数据库不可用".to_owned())
}

fn db_error(error: rusqlite::Error) -> AppError {
    AppError::Persistence(format!("MCP 策略数据库操作失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn directory(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("fstty-policy-db-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("应创建测试目录");
        path
    }

    fn rule(pattern: &str) -> McpCommandRule {
        McpCommandRule {
            match_type: McpCommandMatchType::Exact,
            pattern: pattern.to_owned(),
        }
    }

    fn permission(name: &str) -> McpGroupPermission {
        McpGroupPermission {
            group_name: name.to_owned(),
            enabled: true,
            session_read: true,
            file_read: true,
            file_transfer: false,
            command_execute: true,
            file_write: false,
            file_delete: false,
            command_policy: McpCommandPolicy {
                enabled: true,
                mode: McpCommandPolicyMode::Allow,
                allow_rules: vec![rule("pwd")],
                exclude_rules: vec![rule("rm -rf /")],
            },
        }
    }

    #[test]
    fn 数据库启用wal并双向保存规则() {
        let path = directory("roundtrip");
        let mut service = McpCommandPolicyService::load(&path, Vec::new());
        service
            .replace_all(vec![permission("生产")])
            .expect("应保存策略");
        let restored = service.list_permissions().expect("应读取策略");
        assert_eq!(restored, vec![permission("生产")]);
        let mode = service
            .connection()
            .expect("数据库应可用")
            .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .expect("应读取日志模式");
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        let busy_timeout = service
            .connection()
            .expect("数据库应可用")
            .pragma_query_value(None, "busy_timeout", |row| row.get::<_, i64>(0))
            .expect("应读取锁等待时间");
        assert_eq!(busy_timeout, 5_000);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn 每份名单允许一千条且没有跨分组规则总数限制() {
        let path = directory("limits");
        let mut service = McpCommandPolicyService::load(&path, Vec::new());
        let build = |name: &str| {
            let mut permission = permission(name);
            permission.command_policy.allow_rules = (0..1_000)
                .map(|index| rule(&format!("allow-{name}-{index}")))
                .collect();
            permission.command_policy.exclude_rules = (0..1_000)
                .map(|index| rule(&format!("exclude-{name}-{index}")))
                .collect();
            permission
        };
        service
            .replace_all(vec![build("一"), build("二")])
            .expect("跨分组不应限制规则总数");
        assert_eq!(
            service
                .permission("二")
                .expect("应读取策略")
                .expect("应存在分组")
                .command_policy
                .exclude_rules
                .len(),
            1_000
        );
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn 拒绝未来数据库版本() {
        let path = directory("future-version");
        let database_path = path.join(DATABASE_FILE);
        let connection = Connection::open(&database_path).expect("应创建数据库");
        connection
            .pragma_update(None, "user_version", DATABASE_VERSION + 1)
            .expect("应写入未来版本");
        drop(connection);
        let before = fs::read(&database_path).expect("应读取未来版本数据库");

        let service = McpCommandPolicyService::load(&path, Vec::new());
        let error = service
            .list_permissions()
            .expect_err("未来版本必须拒绝读取");
        let message = error.to_string();
        assert!(message.contains(&format!("schema v{DATABASE_VERSION}")));
        assert!(message.contains(&format!("schema v{}", DATABASE_VERSION + 1)));
        assert!(message.contains("重新打开 Agent"));
        assert!(message.contains("MCP 一键配置"));
        assert_eq!(
            fs::read(&database_path).expect("应再次读取未来版本数据库"),
            before
        );
        let connection = Connection::open(&database_path).expect("未来版本数据库应保持可打开");
        let version = connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .expect("应读取未修改的版本");
        assert_eq!(version, DATABASE_VERSION + 1);
        drop(connection);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn v1数据库升级后传输默认关闭且保留规则() {
        let path = directory("v1-transfer-migration");
        let database_path = path.join(DATABASE_FILE);
        let connection = Connection::open(&database_path).expect("应创建旧数据库");
        connection
            .execute_batch(
                "PRAGMA user_version = 1;
                 CREATE TABLE mcp_group_permissions (
                   group_name TEXT PRIMARY KEY,
                   enabled INTEGER NOT NULL,
                   session_read INTEGER NOT NULL,
                   file_read INTEGER NOT NULL,
                   command_execute INTEGER NOT NULL,
                   file_write INTEGER NOT NULL,
                   file_delete INTEGER NOT NULL,
                   policy_enabled INTEGER NOT NULL,
                   policy_mode TEXT NOT NULL
                 );
                 CREATE TABLE mcp_command_rules (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   group_name TEXT NOT NULL,
                   list_mode TEXT NOT NULL,
                   position INTEGER NOT NULL,
                   match_type TEXT NOT NULL,
                   pattern TEXT NOT NULL
                 );
                 INSERT INTO mcp_group_permissions VALUES
                   ('生产', 1, 0, 1, 1, 1, 0, 1, 'allow');
                 INSERT INTO mcp_command_rules
                   (group_name, list_mode, position, match_type, pattern)
                   VALUES ('生产', 'allow', 0, 'exact', 'pwd');",
            )
            .expect("应写入 v1 数据库");
        drop(connection);

        let service = McpCommandPolicyService::load(&path, Vec::new());
        let restored = service
            .permission("生产")
            .expect("升级后应可读取")
            .expect("权限应保留");
        assert!(!restored.session_read);
        assert!(restored.file_read);
        assert!(restored.file_write);
        assert!(!restored.file_transfer);
        assert_eq!(restored.command_policy.allow_rules, vec![rule("pwd")]);
        let version = service
            .connection()
            .expect("数据库应可用")
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .expect("应读取版本");
        assert_eq!(version, DATABASE_VERSION);
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn 旧设置迁移幂等且数据库已有内容时不覆盖() {
        let path = directory("migration");
        let service = McpCommandPolicyService::load(&path, vec![permission("旧分组")]);
        assert_eq!(
            service.list_permissions().expect("应读取迁移结果"),
            vec![permission("旧分组")]
        );
        drop(service);
        let service = McpCommandPolicyService::load(&path, vec![permission("新分组")]);
        assert_eq!(
            service.list_permissions().expect("应读取既有结果"),
            vec![permission("旧分组")]
        );
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn 同名单拒绝重复但跨名单允许相同规则() {
        let path = directory("duplicates");
        let mut service = McpCommandPolicyService::load(&path, Vec::new());
        let mut valid = permission("生产");
        valid.command_policy.exclude_rules = vec![rule("pwd")];
        service.replace_all(vec![valid]).expect("跨名单重复应允许");

        let mut invalid = permission("生产");
        invalid.command_policy.allow_rules.push(rule("pwd"));
        assert!(service.replace_all(vec![invalid]).is_err());
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn 分组重命名和删除同步规则() {
        let path = directory("groups");
        let mut service = McpCommandPolicyService::load(&path, Vec::new());
        service
            .replace_all(vec![permission("旧名")])
            .expect("应保存策略");
        service.rename_group("旧名", "新名").expect("应重命名");
        assert!(service.permission("旧名").expect("应查询").is_none());
        assert!(service.permission("新名").expect("应查询").is_some());
        service.delete_group("新名").expect("应删除");
        assert!(service.list_permissions().expect("应查询").is_empty());
        let _ = fs::remove_dir_all(path);
    }
}
