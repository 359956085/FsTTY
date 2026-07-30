use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use time::{macros::format_description, Date, OffsetDateTime};

const LOG_RETENTION_DAYS: i64 = 15;
const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const LOG_DATE_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]");
const LOG_TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3][offset_hour sign:mandatory]:[offset_minute]"
    );
const MANAGED_PREFIXES: [&str; 2] = ["fstty", "mcp-audit"];

pub struct DailyLogWriter {
    directory: PathBuf,
    prefix: &'static str,
    active_date: Option<Date>,
    shard: usize,
    size: u64,
    file: Option<File>,
}

impl DailyLogWriter {
    pub fn new(directory: impl Into<PathBuf>, prefix: &'static str) -> Self {
        Self {
            directory: directory.into(),
            prefix,
            active_date: None,
            shard: 0,
            size: 0,
            file: None,
        }
    }

    pub fn write_line(&mut self, line: &[u8]) -> io::Result<()> {
        self.ensure_file(line.len() as u64 + 1)?;
        if let Some(file) = self.file.as_mut() {
            file.write_all(line)?;
            file.write_all(b"\n")?;
            file.flush()?;
            self.size += line.len() as u64 + 1;
        }
        Ok(())
    }

    fn ensure_file(&mut self, incoming: u64) -> io::Result<()> {
        let date = local_date();
        if self.active_date != Some(date) {
            self.file = None;
            self.active_date = Some(date);
            self.shard = 0;
            fs::create_dir_all(&self.directory)?;
            cleanup_expired_logs(&self.directory, date)?;
            self.open_last_shard(date)?;
        }
        if self.size > 0 && self.size.saturating_add(incoming) > LOG_MAX_BYTES {
            self.shard += 1;
            self.open_shard(date)?;
        }
        Ok(())
    }

    fn open_last_shard(&mut self, date: Date) -> io::Result<()> {
        loop {
            let path = self.shard_path(date);
            let size = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            if size < LOG_MAX_BYTES || !path.exists() {
                self.open_shard(date)?;
                return Ok(());
            }
            self.shard += 1;
        }
    }

    fn open_shard(&mut self, date: Date) -> io::Result<()> {
        let path = self.shard_path(date);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    fn shard_path(&self, date: Date) -> PathBuf {
        let date = date.format(LOG_DATE_FORMAT).unwrap_or_default();
        let name = if self.shard == 0 {
            format!("{}-{date}.log", self.prefix)
        } else {
            format!("{}-{date}-{:02}.log", self.prefix, self.shard)
        };
        self.directory.join(name)
    }
}

impl Write for DailyLogWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.ensure_file(buffer.len() as u64)?;
        if let Some(file) = self.file.as_mut() {
            file.write_all(buffer)?;
            self.size += buffer.len() as u64;
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map(File::flush).unwrap_or(Ok(()))
    }
}

pub fn prepare_log_directory(app_data_dir: &Path, log_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(log_dir).map_err(|error| format!("无法创建日志目录：{error}"))?;
    migrate_legacy_audit_logs(app_data_dir, log_dir)?;
    cleanup_expired_logs(log_dir, local_date()).map_err(|error| format!("无法清理旧日志：{error}"))
}

pub fn tauri_plugin<R: tauri::Runtime>(log_dir: PathBuf) -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{fern, Target, TargetKind};
    let output = fern::Output::writer(Box::new(DailyLogWriter::new(log_dir, "fstty")), "\n");
    let dispatch = fern::Dispatch::new().chain(output);
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .level(log::LevelFilter::Info)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .target(Target::new(TargetKind::Dispatch(dispatch)))
        .build()
}

pub fn init_stdio(log_dir: PathBuf) -> Result<(), String> {
    use tauri_plugin_log::fern;
    fern::Dispatch::new()
        .level(log::LevelFilter::Info)
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} [{}] {}",
                local_timestamp(),
                record.level(),
                message
            ))
        })
        .chain(fern::Output::writer(
            Box::new(DailyLogWriter::new(log_dir, "fstty")),
            "\n",
        ))
        .apply()
        .map_err(|error| format!("无法初始化日志：{error}"))
}

fn migrate_legacy_audit_logs(app_data_dir: &Path, log_dir: &Path) -> Result<(), String> {
    for index in 0..=3 {
        let name = if index == 0 {
            "mcp-audit.jsonl".to_owned()
        } else {
            format!("mcp-audit.jsonl.{index}")
        };
        let source = app_data_dir.join(name);
        if !source.is_file() {
            continue;
        }
        let date = source
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(system_time_to_date)
            .unwrap_or_else(local_date);
        let date = date.format(LOG_DATE_FORMAT).unwrap_or_default();
        let mut suffix = index;
        loop {
            let target = log_dir.join(format!("mcp-audit-{date}-legacy-{suffix:02}.log"));
            if !target.exists() {
                fs::rename(&source, target)
                    .map_err(|error| format!("无法迁移旧 MCP 审计日志：{error}"))?;
                break;
            }
            suffix += 1;
        }
    }
    Ok(())
}

fn cleanup_expired_logs(directory: &Path, today: Date) -> io::Result<()> {
    let cutoff = today - time::Duration::days(LOG_RETENTION_DAYS - 1);
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(date) = managed_log_date(&path) else {
            continue;
        };
        if date < cutoff {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn managed_log_date(path: &Path) -> Option<Date> {
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(".log") {
        return None;
    }
    let prefix = MANAGED_PREFIXES
        .iter()
        .find(|prefix| name.starts_with(&format!("{prefix}-")))?;
    let start = prefix.len() + 1;
    let date = name.get(start..start + 10)?;
    Date::parse(date, LOG_DATE_FORMAT).ok()
}

fn local_date() -> Date {
    OffsetDateTime::now_local()
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
        .date()
}

pub fn local_timestamp() -> String {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    now.format(LOG_TIMESTAMP_FORMAT)
        .unwrap_or_else(|_| now.to_string())
}

fn system_time_to_date(time: std::time::SystemTime) -> Date {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| OffsetDateTime::from_unix_timestamp(duration.as_secs() as i64).ok())
        .map(|time| time.date())
        .unwrap_or_else(local_date)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("fstty-logs-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn 只清理超过十五天的受管日志() {
        let directory = temp_dir();
        fs::create_dir_all(&directory).expect("应创建目录");
        fs::write(directory.join("fstty-2026-07-15.log"), "old").expect("应写入旧日志");
        fs::write(directory.join("mcp-audit-2026-07-16.log"), "keep").expect("应写入边界日志");
        fs::write(directory.join("user-2020-01-01.log"), "keep").expect("应写入用户文件");

        cleanup_expired_logs(
            &directory,
            Date::from_calendar_date(2026, time::Month::July, 30).expect("日期应有效"),
        )
        .expect("清理应成功");

        assert!(!directory.join("fstty-2026-07-15.log").exists());
        assert!(directory.join("mcp-audit-2026-07-16.log").exists());
        assert!(directory.join("user-2020-01-01.log").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 写入器统一使用日志后缀() {
        let directory = temp_dir();
        let mut writer = DailyLogWriter::new(&directory, "fstty");
        writer.write_line(b"hello").expect("写入应成功");
        let files = fs::read_dir(&directory)
            .expect("应读取目录")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with("fstty-"));
        assert!(files[0].ends_with(".log"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 达到十兆后创建新分片且仍使用日志后缀() {
        let directory = temp_dir();
        let mut writer = DailyLogWriter::new(&directory, "fstty");
        writer
            .write_all(&vec![b'x'; LOG_MAX_BYTES as usize])
            .expect("应写满首个分片");
        writer.write_line(b"next").expect("应创建第二个分片");
        let files = fs::read_dir(&directory)
            .expect("应读取目录")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|name| name.ends_with(".log")));
        assert!(files.iter().any(|name| name.contains("-01.log")));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 旧审计日志迁移到日志目录并统一后缀() {
        let app_data_dir = temp_dir();
        let log_dir = app_data_dir.join("logs");
        fs::create_dir_all(&app_data_dir).expect("应创建应用数据目录");
        fs::write(
            app_data_dir.join("mcp-audit.jsonl"),
            "{\"result\":\"success\"}",
        )
        .expect("应写入旧审计日志");

        prepare_log_directory(&app_data_dir, &log_dir).expect("日志迁移应成功");

        let path = fs::read_dir(&log_dir)
            .expect("应读取日志目录")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("mcp-audit-")
                            && name.contains("-legacy-")
                            && name.ends_with(".log")
                    })
            })
            .expect("应生成历史审计日志");
        assert_eq!(
            fs::read_to_string(path).expect("应读取迁移日志"),
            "{\"result\":\"success\"}"
        );
        assert!(!app_data_dir.join("mcp-audit.jsonl").exists());
        let _ = fs::remove_dir_all(app_data_dir);
    }
}
