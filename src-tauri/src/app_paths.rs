use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

const APP_DIRECTORY_NAME: &str = "FsTTY";
const LEGACY_APP_DIRECTORY_NAME: &str = "com.fengshi.fstty";

#[derive(Debug)]
pub struct AppPaths {
    pub app_data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub migration_warnings: Vec<String>,
}

pub fn prepare_app_paths() -> Result<AppPaths, String> {
    prepare_in(&platform_config_root()?)
}

fn platform_config_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "无法确定应用数据目录".to_owned())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join(".config"))
            })
            .ok_or_else(|| "无法确定应用数据目录".to_owned())
    }
}

fn prepare_in(root: &Path) -> Result<AppPaths, String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建应用数据根目录：{error}"))?;
    let lock_path = root.join(".fstty-migration.lock");
    let lock = open_migration_lock(&lock_path)?;
    lock.lock_exclusive()
        .map_err(|error| format!("无法锁定应用数据迁移：{error}"))?;

    let app_data_dir = root.join(APP_DIRECTORY_NAME);
    let legacy_dir = root.join(LEGACY_APP_DIRECTORY_NAME);
    let mut warnings = Vec::new();
    if legacy_dir.exists() {
        migrate_directory(&legacy_dir, &app_data_dir, &mut warnings)?;
    }
    fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("无法创建 FsTTY 应用数据目录：{error}"))?;
    let log_dir = app_data_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建日志目录：{error}"))?;
    let _ = FileExt::unlock(&lock);

    Ok(AppPaths {
        app_data_dir,
        log_dir,
        migration_warnings: warnings,
    })
}

fn open_migration_lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .map_err(|error| format!("无法打开应用数据迁移锁：{error}"))
}

fn migrate_directory(
    source: &Path,
    target: &Path,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if !target.exists() {
        if fs::rename(source, target).is_ok() {
            return Ok(());
        }
        fs::create_dir_all(target).map_err(|error| format!("无法创建迁移目标目录：{error}"))?;
    }
    merge_missing(source, target, warnings)?;
    remove_if_empty(source);
    Ok(())
}

fn merge_missing(source: &Path, target: &Path, warnings: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取旧应用数据：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取旧应用数据项：{error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if !target_path.exists() {
            fs::rename(&source_path, &target_path)
                .map_err(|error| format!("无法迁移 {}：{error}", source_path.display()))?;
            continue;
        }
        if source_path.is_dir() && target_path.is_dir() {
            merge_missing(&source_path, &target_path, warnings)?;
            remove_if_empty(&source_path);
        } else {
            warnings.push(format!(
                "迁移时保留新目录中的冲突项：{}",
                target_path.display()
            ));
        }
    }
    Ok(())
}

fn remove_if_empty(path: &Path) {
    if fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_none()
    {
        let _ = fs::remove_dir(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("fstty-paths-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn 旧目录整体迁移到新目录() {
        let root = temp_root();
        let old = root.join(LEGACY_APP_DIRECTORY_NAME);
        fs::create_dir_all(&old).expect("应创建旧目录");
        fs::write(old.join("settings.v1.json"), "{}").expect("应写入旧设置");

        let paths = prepare_in(&root).expect("迁移应成功");

        assert_eq!(paths.app_data_dir, root.join(APP_DIRECTORY_NAME));
        assert!(paths.app_data_dir.join("settings.v1.json").is_file());
        assert!(paths.log_dir.is_dir());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn 新旧目录冲突时保留新文件并迁移缺失文件() {
        let root = temp_root();
        let old = root.join(LEGACY_APP_DIRECTORY_NAME);
        let new = root.join(APP_DIRECTORY_NAME);
        fs::create_dir_all(&old).expect("应创建旧目录");
        fs::create_dir_all(&new).expect("应创建新目录");
        fs::write(old.join("settings.v1.json"), "old").expect("应写入旧设置");
        fs::write(new.join("settings.v1.json"), "new").expect("应写入新设置");
        fs::write(old.join("sessions.v1.json"), "sessions").expect("应写入旧会话");

        let paths = prepare_in(&root).expect("合并应成功");

        assert_eq!(
            fs::read_to_string(new.join("settings.v1.json")).expect("应读取新设置"),
            "new"
        );
        assert!(new.join("sessions.v1.json").is_file());
        assert_eq!(paths.migration_warnings.len(), 1);
        assert!(old.join("settings.v1.json").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
