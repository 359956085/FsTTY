use crate::models::{AppError, AppSettings, Language, McpGroupPermission};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const STORE_VERSION: u8 = 1;
const STORE_FILE: &str = "settings.v1.json";
const STORE_BACKUP_FILE: &str = "settings.v1.json.bak";
const STORE_TEMP_FILE: &str = "settings.v1.json.tmp";
const MAX_STORE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsStore {
    version: u8,
    #[serde(flatten)]
    settings: AppSettings,
}

impl Default for SettingsStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            settings: default_settings(),
        }
    }
}

pub struct SettingsService {
    settings: AppSettings,
    store_path: PathBuf,
    backup_path: PathBuf,
    temp_path: PathBuf,
    primary_trusted: bool,
}

impl SettingsService {
    pub fn load(app_data_dir: &Path) -> Self {
        let store_path = app_data_dir.join(STORE_FILE);
        let backup_path = app_data_dir.join(STORE_BACKUP_FILE);
        let temp_path = app_data_dir.join(STORE_TEMP_FILE);

        let (store, primary_trusted) = match read_store(&store_path) {
            Ok(Some(store)) => (store, true),
            Ok(None) => match read_store(&backup_path) {
                Ok(Some(store)) => (store, false),
                _ => (SettingsStore::default(), true),
            },
            Err(_) => match read_store(&backup_path) {
                Ok(Some(store)) => (store, false),
                _ => (SettingsStore::default(), false),
            },
        };

        Self {
            settings: store.settings,
            store_path,
            backup_path,
            temp_path,
            primary_trusted,
        }
    }

    pub fn get(&self) -> AppSettings {
        self.settings.clone()
    }

    pub fn reload_mcp_runtime_settings(&mut self) -> Result<(), AppError> {
        // MCP 独立进程需要同步语言和权限；主文件异常时必须失败关闭，不能回退旧授权。
        let store = read_store(&self.store_path)?
            .ok_or_else(|| AppError::Persistence("MCP 权限设置文件不存在".to_owned()))?;
        let permissions = validate_mcp_permissions(store.settings.mcp_group_permissions)
            .map_err(|_| AppError::Persistence("MCP 分组权限数据无效".to_owned()))?;
        self.settings.language = store.settings.language;
        self.settings.mcp_group_permissions = permissions;
        Ok(())
    }

    pub fn set_language(&mut self, language: Language) -> Result<AppSettings, AppError> {
        let mut next = self.settings.clone();
        next.language = language;
        self.replace(next)
    }

    pub fn update(
        &mut self,
        auto_update: bool,
        update_proxy: String,
        allow_remote_clipboard_write: bool,
    ) -> Result<AppSettings, AppError> {
        validate_update_proxy(&update_proxy)?;
        let mut next = self.settings.clone();
        next.auto_update = auto_update;
        next.update_proxy = update_proxy;
        next.allow_remote_clipboard_write = allow_remote_clipboard_write;
        self.replace(next)
    }

    pub fn update_mcp(
        &mut self,
        enabled: bool,
        http_enabled: bool,
        http_port: u16,
        group_permissions: Vec<McpGroupPermission>,
    ) -> Result<AppSettings, AppError> {
        if http_port == 0 {
            return Err(AppError::Validation("MCP HTTP 端口无效".to_owned()));
        }
        let group_permissions = validate_mcp_permissions(group_permissions)?;
        let mut next = self.settings.clone();
        next.mcp_enabled = enabled;
        next.mcp_http_enabled = http_enabled;
        next.mcp_http_port = http_port;
        next.mcp_group_permissions = group_permissions;
        self.replace(next)
    }

    pub fn rename_mcp_group(&mut self, old_name: &str, new_name: &str) -> Result<(), AppError> {
        let mut next = self.settings.clone();
        if let Some(permission) = next
            .mcp_group_permissions
            .iter_mut()
            .find(|permission| permission.group_name == old_name)
        {
            permission.group_name = new_name.to_owned();
            next.mcp_group_permissions = validate_mcp_permissions(next.mcp_group_permissions)?;
            self.replace(next)?;
        }
        Ok(())
    }

    pub fn delete_mcp_group(&mut self, group_name: &str) -> Result<(), AppError> {
        let mut next = self.settings.clone();
        let original_len = next.mcp_group_permissions.len();
        next.mcp_group_permissions
            .retain(|permission| permission.group_name != group_name);
        if next.mcp_group_permissions.len() != original_len {
            self.replace(next)?;
        }
        Ok(())
    }

    pub fn set_ignored_update_version(&mut self, version: String) -> Result<AppSettings, AppError> {
        validate_release_version(&version)?;
        let mut next = self.settings.clone();
        next.ignored_update_version = Some(version);
        self.replace(next)
    }

    fn replace(&mut self, next: AppSettings) -> Result<AppSettings, AppError> {
        let previous = std::mem::replace(&mut self.settings, next);
        if let Err(error) = self.persist() {
            self.settings = previous;
            return Err(error);
        }
        Ok(self.settings.clone())
    }

    fn persist(&mut self) -> Result<(), AppError> {
        fs::create_dir_all(
            self.store_path
                .parent()
                .ok_or_else(|| AppError::Persistence("设置存储目录无效".to_owned()))?,
        )
        .map_err(|_| AppError::Persistence("无法创建设置存储目录".to_owned()))?;
        let content = serde_json::to_vec_pretty(&SettingsStore {
            version: STORE_VERSION,
            settings: self.settings.clone(),
        })
        .map_err(|_| AppError::Persistence("无法序列化设置数据".to_owned()))?;
        let mut temp = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&self.temp_path)
            .map_err(|_| AppError::Persistence("无法写入设置临时文件".to_owned()))?;
        temp.write_all(&content)
            .and_then(|_| temp.sync_all())
            .map_err(|_| AppError::Persistence("无法同步设置临时文件".to_owned()))?;
        drop(temp);

        if self.store_path.exists() {
            if self.primary_trusted {
                let _ = fs::remove_file(&self.backup_path);
                fs::rename(&self.store_path, &self.backup_path)
                    .map_err(|_| AppError::Persistence("无法备份设置数据".to_owned()))?;
            } else {
                fs::remove_file(&self.store_path)
                    .map_err(|_| AppError::Persistence("无法替换损坏的设置数据".to_owned()))?;
            }
        }
        if fs::rename(&self.temp_path, &self.store_path).is_err() {
            if !self.store_path.exists() && self.backup_path.exists() {
                let _ = fs::copy(&self.backup_path, &self.store_path);
            }
            return Err(AppError::Persistence("无法提交设置数据".to_owned()));
        }
        self.primary_trusted = true;
        Ok(())
    }
}

fn default_settings() -> AppSettings {
    AppSettings {
        language: Language::ZhCn,
        auto_update: true,
        update_proxy: String::new(),
        allow_remote_clipboard_write: true,
        ignored_update_version: None,
        mcp_enabled: false,
        mcp_http_enabled: false,
        mcp_http_port: 37_653,
        mcp_group_permissions: Vec::new(),
    }
}

fn validate_mcp_permissions(
    permissions: Vec<McpGroupPermission>,
) -> Result<Vec<McpGroupPermission>, AppError> {
    if permissions.len() > 100 {
        return Err(AppError::Validation("MCP 分组权限数量过多".to_owned()));
    }
    let mut result = Vec::with_capacity(permissions.len());
    for permission in permissions {
        let name = permission.group_name.trim();
        if name.is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
            return Err(AppError::Validation("MCP 分组名称无效".to_owned()));
        }
        if result
            .iter()
            .any(|current: &McpGroupPermission| current.group_name == name)
        {
            return Err(AppError::Validation("MCP 分组权限重复".to_owned()));
        }
        result.push(McpGroupPermission {
            group_name: name.to_owned(),
            ..permission
        });
    }
    Ok(result)
}

fn validate_release_version(version: &str) -> Result<(), AppError> {
    let parts = version.split('.').collect::<Vec<_>>();
    let valid = version.len() <= 64
        && !version.chars().any(char::is_control)
        && parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.chars().all(|character| character.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
                && part.parse::<u64>().is_ok()
        });
    if !valid {
        return Err(AppError::Validation("忽略的更新版本无效".to_owned()));
    }
    Ok(())
}

fn validate_update_proxy(update_proxy: &str) -> Result<(), AppError> {
    if update_proxy.len() > 512
        || update_proxy.chars().any(char::is_control)
        || (!update_proxy.is_empty()
            && !["http://", "https://", "socks5://"]
                .iter()
                .any(|prefix| update_proxy.starts_with(prefix)))
    {
        return Err(AppError::Validation("更新代理地址无效".to_owned()));
    }
    Ok(())
}

fn read_store(path: &Path) -> Result<Option<SettingsStore>, AppError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AppError::Persistence("无法读取设置数据".to_owned())),
    };
    if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES {
        return Err(AppError::Persistence("设置文件无效".to_owned()));
    }
    let content =
        fs::read(path).map_err(|_| AppError::Persistence("无法读取设置数据".to_owned()))?;
    let store = serde_json::from_slice::<SettingsStore>(&content)
        .map_err(|_| AppError::Persistence("设置数据格式无效".to_owned()))?;
    if store.version != STORE_VERSION {
        return Err(AppError::Persistence("设置存储版本无效".to_owned()));
    }
    validate_update_proxy(&store.settings.update_proxy)?;
    Ok(Some(store))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("fstty-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("无法创建测试目录");
        directory
    }

    fn mcp_permission(command_execute: bool) -> McpGroupPermission {
        McpGroupPermission {
            group_name: "生产".to_owned(),
            enabled: true,
            session_read: true,
            file_read: true,
            command_execute,
            file_write: false,
            file_delete: false,
        }
    }

    #[test]
    fn uses_defaults_and_restores_persisted_settings() {
        let directory = test_directory("settings-persist");
        let mut service = SettingsService::load(&directory);
        assert_eq!(service.get(), default_settings());

        service
            .update(false, "http://127.0.0.1:7890".to_owned(), false)
            .expect("保存更新设置失败");
        service.set_language(Language::EnUs).expect("保存语言失败");
        service
            .set_ignored_update_version("0.5.0".to_owned())
            .expect("保存忽略版本失败");

        let restored = SettingsService::load(&directory).get();
        assert_eq!(restored.language, Language::EnUs);
        assert!(!restored.auto_update);
        assert_eq!(restored.update_proxy, "http://127.0.0.1:7890");
        assert!(!restored.allow_remote_clipboard_write);
        assert_eq!(restored.ignored_update_version.as_deref(), Some("0.5.0"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn persists_mcp_group_permissions() {
        let directory = test_directory("settings-mcp-permissions");
        let mut service = SettingsService::load(&directory);
        let permission = mcp_permission(false);

        service
            .update_mcp(true, true, 37_653, vec![permission.clone()])
            .expect("保存 MCP 设置失败");

        let restored = SettingsService::load(&directory).get();
        assert!(restored.mcp_enabled);
        assert!(restored.mcp_http_enabled);
        assert_eq!(restored.mcp_group_permissions, vec![permission]);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 热加载跨设置实例授予和撤销权限() {
        let directory = test_directory("settings-mcp-hot-reload");
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(false)])
            .expect("保存初始 MCP 权限失败");
        let mut reader = SettingsService::load(&directory);

        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(true)])
            .expect("授予命令权限失败");
        reader
            .reload_mcp_runtime_settings()
            .expect("热加载授权失败");
        assert!(reader.get().mcp_group_permissions[0].command_execute);

        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(false)])
            .expect("撤销命令权限失败");
        reader
            .reload_mcp_runtime_settings()
            .expect("热加载撤权失败");
        assert!(!reader.get().mcp_group_permissions[0].command_execute);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 热加载只替换分组权限和语言() {
        let directory = test_directory("settings-mcp-hot-reload-scope");
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(false)])
            .expect("保存初始 MCP 权限失败");
        let mut reader = SettingsService::load(&directory);
        reader.settings.language = Language::EnUs;
        reader.settings.mcp_enabled = false;
        reader.settings.mcp_http_enabled = false;
        reader.settings.mcp_http_port = 40_000;
        reader.settings.update_proxy = "socks5://127.0.0.1:7890".to_owned();

        writer
            .update_mcp(true, true, 45_678, vec![mcp_permission(true)])
            .expect("保存新 MCP 权限失败");
        reader
            .reload_mcp_runtime_settings()
            .expect("热加载权限失败");
        let settings = reader.get();
        assert!(settings.mcp_group_permissions[0].command_execute);
        assert_eq!(settings.language, Language::ZhCn);
        assert!(!settings.mcp_enabled);
        assert!(!settings.mcp_http_enabled);
        assert_eq!(settings.mcp_http_port, 40_000);
        assert_eq!(settings.update_proxy, "socks5://127.0.0.1:7890");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 热加载异常时不回退备份或旧授权() {
        let directory = test_directory("settings-mcp-hot-reload-fail-closed");
        let mut writer = SettingsService::load(&directory);
        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(true)])
            .expect("保存初始 MCP 权限失败");
        let mut reader = SettingsService::load(&directory);
        writer
            .update_mcp(true, true, 37_653, vec![mcp_permission(false)])
            .expect("保存撤权设置失败");
        reader
            .reload_mcp_runtime_settings()
            .expect("热加载撤权失败");

        fs::remove_file(directory.join(STORE_FILE)).expect("无法移除主设置文件");
        assert!(reader.reload_mcp_runtime_settings().is_err());
        assert!(!reader.get().mcp_group_permissions[0].command_execute);

        fs::write(directory.join(STORE_FILE), b"damaged").expect("无法写入损坏设置");
        assert!(reader.reload_mcp_runtime_settings().is_err());
        assert!(!reader.get().mcp_group_permissions[0].command_execute);

        let mut invalid_settings = writer.get();
        invalid_settings.mcp_group_permissions = vec![mcp_permission(true), mcp_permission(false)];
        fs::write(
            directory.join(STORE_FILE),
            serde_json::to_vec_pretty(&SettingsStore {
                version: STORE_VERSION,
                settings: invalid_settings,
            })
            .expect("无法序列化重复权限"),
        )
        .expect("无法写入重复权限");
        assert!(reader.reload_mcp_runtime_settings().is_err());
        assert!(!reader.get().mcp_group_permissions[0].command_execute);

        let mut invalid_name = mcp_permission(true);
        invalid_name.group_name = "\n".to_owned();
        let mut invalid_settings = writer.get();
        invalid_settings.mcp_group_permissions = vec![invalid_name];
        fs::write(
            directory.join(STORE_FILE),
            serde_json::to_vec_pretty(&SettingsStore {
                version: STORE_VERSION,
                settings: invalid_settings,
            })
            .expect("无法序列化非法分组"),
        )
        .expect("无法写入非法分组");
        assert!(reader.reload_mcp_runtime_settings().is_err());
        assert!(!reader.get().mcp_group_permissions[0].command_execute);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn loads_legacy_settings_with_remote_clipboard_enabled() {
        let directory = test_directory("settings-legacy-clipboard");
        fs::write(
            directory.join(STORE_FILE),
            br#"{
  "version": 1,
  "language": "zh-CN",
  "autoUpdate": true,
  "updateProxy": ""
}"#,
        )
        .expect("无法写入旧设置文件");

        let restored = SettingsService::load(&directory).get();
        assert!(restored.allow_remote_clipboard_write);
        assert_eq!(restored.ignored_update_version, None);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn restores_backup_and_replaces_damaged_primary() {
        let directory = test_directory("settings-backup");
        let mut service = SettingsService::load(&directory);
        service
            .set_language(Language::EnUs)
            .expect("保存第一版设置失败");
        service
            .update(false, String::new(), true)
            .expect("保存第二版设置失败");
        fs::write(directory.join(STORE_FILE), b"damaged").expect("无法损坏主设置文件");

        let mut recovered = SettingsService::load(&directory);
        assert_eq!(recovered.get().language, Language::EnUs);
        assert!(recovered.get().auto_update);
        recovered
            .update(false, "socks5://127.0.0.1:7890".to_owned(), true)
            .expect("无法替换损坏的设置文件");
        assert_eq!(
            SettingsService::load(&directory).get().update_proxy,
            "socks5://127.0.0.1:7890"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn falls_back_to_defaults_when_all_files_are_damaged() {
        let directory = test_directory("settings-damaged");
        fs::write(directory.join(STORE_FILE), b"damaged").expect("无法写入损坏主文件");
        fs::write(directory.join(STORE_BACKUP_FILE), b"damaged").expect("无法写入损坏备份");

        let mut recovered = SettingsService::load(&directory);
        assert_eq!(recovered.get(), default_settings());
        recovered
            .set_language(Language::EnUs)
            .expect("无法修复损坏的设置文件");
        assert_eq!(
            SettingsService::load(&directory).get().language,
            Language::EnUs
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_invalid_proxy_without_changing_memory() {
        let directory = test_directory("settings-proxy");
        let mut service = SettingsService::load(&directory);

        assert!(service
            .update(true, "ftp://127.0.0.1".to_owned(), true)
            .is_err());
        assert_eq!(service.get(), default_settings());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_invalid_ignored_version_without_changing_memory() {
        let directory = test_directory("settings-ignored-version");
        let mut service = SettingsService::load(&directory);

        assert!(service
            .set_ignored_update_version("v0.5.0".to_owned())
            .is_err());
        assert_eq!(service.get(), default_settings());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rolls_back_memory_when_persistence_fails() {
        let directory = test_directory("settings-rollback");
        let mut service = SettingsService::load(&directory);
        let blocked_path = directory.join("blocked-temp");
        fs::create_dir_all(&blocked_path).expect("无法创建阻断目录");
        service.temp_path = blocked_path;

        assert!(service.set_language(Language::EnUs).is_err());
        assert_eq!(service.get(), default_settings());
        let _ = fs::remove_dir_all(directory);
    }
}
