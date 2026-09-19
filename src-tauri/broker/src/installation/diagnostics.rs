use super::CallerMode;
use crate::windows::{security_descriptor, wide};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use time::{macros::format_description, Date, OffsetDateTime};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
    Security::{
        SetFileSecurityW, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::CreateDirectoryW,
    UI::Shell::FOLDERID_ProgramData,
};

const RETENTION_DAYS: i64 = 15;
const LOG_SDDL: &str = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)";
const DATE_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]");
const TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] = format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3][offset_hour sign:mandatory]:[offset_minute]"
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailureReport {
    pub phase: &'static str,
    pub code: &'static str,
    pub message: String,
}

pub struct InstallerEvent<'a> {
    pub operation_id: &'a str,
    pub install_mode: &'a str,
    pub phase: &'a str,
    pub caller_mode: Option<CallerMode>,
    pub session_id: Option<u32>,
    pub target: Option<&'a Path>,
    pub result: &'a str,
    pub code: &'a str,
    pub exit_code: Option<i32>,
    pub rollback: Option<&'a str>,
    pub detail: Option<&'a str>,
    pub elapsed: Duration,
}

pub fn operation_id(value: Option<&str>) -> String {
    value
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .unwrap_or_else(uuid::Uuid::new_v4)
        .to_string()
}

pub fn classify_failure(command: &str, error: &str) -> FailureReport {
    let (phase, code, message) = if error.contains("原调用进程已退出") {
        (
            "caller",
            "caller_exited",
            "原调用进程已退出，请从当前桌面重新启动安装包。",
        )
    } else if error.contains("会话 0")
        || error.contains("系统或服务账号")
        || error.contains("当前登录会话")
        || error.contains("原进程会话")
    {
        (
            "caller",
            "caller_session_rejected",
            "当前账号或会话不支持交互式安装，请在已登录的桌面会话中重试。",
        )
    } else if error.contains("关联令牌")
        || error.contains("令牌状态异常")
        || error.contains("用户身份不一致")
        || error.contains("身份已变化")
        || error.contains("不是本机管理员")
    {
        (
            "caller",
            "caller_identity_mismatch",
            "无法确认原调用用户身份，请从当前桌面重新启动安装或更新。",
        )
    } else if error.contains("签名") || error.contains("验签") {
        (
            "verify",
            "signature_invalid",
            "安装包签名验证失败，请从官方发布页重新下载安装包。",
        )
    } else if error.contains("更新已取消") {
        ("confirm", "update_cancelled", "应用更新已取消。")
    } else if error.contains("超时") {
        (
            "execute",
            "timeout",
            "安装或更新操作超时，请重试并检查系统状态。",
        )
    } else if error.contains("自动恢复失败") || error.contains("恢复材料已保留") {
        (
            "rollback",
            "rollback_failed",
            "部署失败且自动恢复未完成。恢复材料已保留，请查看后台安装日志。",
        )
    } else if error.contains("恢复") {
        (
            "rollback",
            "rollback_failed",
            "自动恢复未完成。恢复材料已保留，请查看后台安装日志。",
        )
    } else if command == "--deploy-desktop" {
        (
            "deploy",
            "deploy_failed",
            "FsTTY 部署未完成。安装工具已按事务状态处理原版本，请查看后台安装日志后重试。",
        )
    } else if command == "--launch-desktop" {
        (
            "launch",
            "launch_failed",
            "安装已完成，但无法启动 FsTTY。请从安装目录或快捷方式手动启动。",
        )
    } else if command == "--desktop-candidates" {
        (
            "caller",
            "caller_validation_failed",
            "无法验证安装调用者，请从当前桌面重新启动安装包。",
        )
    } else if command == "--remove-desktop" {
        (
            "uninstall",
            "uninstall_failed",
            "卸载未完成，请查看后台安装日志后重试。",
        )
    } else if command == "--update" {
        (
            "update",
            "update_failed",
            "应用更新未完成，请查看后台日志后重试。",
        )
    } else {
        (
            "execute",
            "unexpected",
            "安装操作未完成，请查看后台安装日志后重试。",
        )
    };
    FailureReport {
        phase,
        code,
        message: message.into(),
    }
}

pub fn record(event: InstallerEvent<'_>) {
    let _ = record_inner(event);
}

fn record_inner(event: InstallerEvent<'_>) -> crate::Result<()> {
    let operation_id = uuid::Uuid::parse_str(event.operation_id)
        .map_err(|_| "安装日志操作 ID 无效")?
        .to_string();
    let directory = log_directory()?;
    ensure_log_directory(&directory)?;
    let now = local_now();
    let _ = cleanup_expired_logs(&directory, now.date());
    let date = now.date().format(DATE_FORMAT).unwrap_or_default();
    let path = directory.join(format!("installer-{date}-{operation_id}.log"));
    ensure_log_file(&path)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|_| "无法打开安装日志")?;
    let timestamp = now
        .format(TIMESTAMP_FORMAT)
        .unwrap_or_else(|_| now.to_string());
    let mut fields = vec![
        format!("timestamp={}", quote(&timestamp)),
        format!("version={}", quote(env!("CARGO_PKG_VERSION"))),
        format!("operation_id={operation_id}"),
        format!("mode={}", quote(event.install_mode)),
        format!("phase={}", quote(event.phase)),
        format!("elapsed_ms={}", event.elapsed.as_millis()),
        format!("result={}", quote(event.result)),
        format!("code={}", quote(event.code)),
    ];
    if let Some(mode) = event.caller_mode {
        fields.push(format!("caller_mode={}", mode.as_str()));
    }
    if let Some(session) = event.session_id {
        fields.push(format!("session={session}"));
    }
    if let Some(target) = event.target {
        fields.push(format!("target={}", quote(&target.to_string_lossy())));
    }
    if let Some(exit_code) = event.exit_code {
        fields.push(format!("exit_code={exit_code}"));
    }
    if let Some(rollback) = event.rollback {
        fields.push(format!("rollback={}", quote(rollback)));
    }
    if let Some(detail) = event.detail {
        let detail = if event.code == "signature_invalid" {
            "signature verification failed".to_owned()
        } else {
            redact(detail)
        };
        fields.push(format!("detail={}", quote(&detail)));
    }
    writeln!(file, "{}", fields.join(" ")).map_err(|_| "无法写入安装日志".into())
}

fn log_directory() -> crate::Result<PathBuf> {
    Ok(crate::windows::known_folder(&FOLDERID_ProgramData)?
        .join("FsTTY")
        .join("logs"))
}

fn ensure_log_directory(directory: &Path) -> crate::Result<()> {
    let root = directory.parent().ok_or("安装日志目录无效")?;
    create_secure_directory(root)?;
    create_secure_directory(directory)
}

fn create_secure_directory(path: &Path) -> crate::Result<()> {
    let descriptor = security_descriptor(LOG_SDDL)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let created = unsafe { CreateDirectoryW(wide(&path.to_string_lossy()).as_ptr(), &attributes) };
    if created == 0 {
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            return Err("无法创建安装日志目录".into());
        }
        crate::paths::verify(path, "", false)?;
    }
    apply_log_acl(path)?;
    crate::paths::verify(path, "", false)
}

fn ensure_log_file(path: &Path) -> crate::Result<()> {
    let existed = path.exists();
    if existed {
        crate::paths::verify(path, "", false)?;
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| "无法创建安装日志")?;
    }
    apply_log_acl(path)?;
    crate::paths::verify(path, "", false)
}

fn apply_log_acl(path: &Path) -> crate::Result<()> {
    let descriptor = security_descriptor(LOG_SDDL)?;
    if unsafe {
        SetFileSecurityW(
            wide(&path.to_string_lossy()).as_ptr(),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        )
    } == 0
    {
        return Err("无法保护安装日志权限".into());
    }
    Ok(())
}

fn cleanup_expired_logs(directory: &Path, today: Date) -> crate::Result<()> {
    cleanup_expired_logs_impl(directory, today, true).map_err(|_| "无法清理过期安装日志".into())
}

fn cleanup_expired_logs_impl(directory: &Path, today: Date, verify: bool) -> std::io::Result<()> {
    let cutoff = today - time::Duration::days(RETENTION_DAYS - 1);
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let Some(date) = managed_log_date(&path) else {
            continue;
        };
        if date >= cutoff {
            continue;
        }
        if verify && crate::paths::verify(&path, "", false).is_err() {
            continue;
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

fn managed_log_date(path: &Path) -> Option<Date> {
    let name = path.file_name()?.to_str()?;
    let tail = name.strip_prefix("installer-")?;
    let date = tail.get(..10)?;
    let operation_id = tail.get(11..)?.strip_suffix(".log")?;
    if !tail.get(10..)?.starts_with('-') || uuid::Uuid::parse_str(operation_id).is_err() {
        return None;
    }
    Date::parse(date, DATE_FORMAT).ok()
}

fn local_now() -> OffsetDateTime {
    OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc())
}

fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\r', '\n', '\t'], " ")
    )
}

fn redact(value: &str) -> String {
    let mut value = redact_sids(value);
    let mut search_from = 0;
    while let Some(relative) = value[search_from..].find("://") {
        let scheme_end = search_from + relative + 3;
        let authority_end = value[scheme_end..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '/' | '?' | '#')
            })
            .map(|offset| scheme_end + offset)
            .unwrap_or(value.len());
        let Some(at) = value[scheme_end..authority_end].rfind('@') else {
            search_from = authority_end.min(value.len());
            if search_from == value.len() {
                break;
            }
            continue;
        };
        let at = scheme_end + at;
        value.replace_range(scheme_end..at, "<redacted>");
        search_from = scheme_end + "<redacted>@".len();
    }
    value
}

fn redact_sids(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find("S-1-") {
        output.push_str(&rest[..index]);
        output.push_str("<sid>");
        let sid = &rest[index..];
        let length = sid
            .char_indices()
            .take_while(|(_, character)| {
                character.is_ascii_digit() || *character == '-' || *character == 'S'
            })
            .map(|(index, character)| index + character.len_utf8())
            .last()
            .unwrap_or(4);
        rest = &sid[length..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 错误分类提供稳定阶段代码和友好文本() {
        let exited = classify_failure("--deploy-desktop", "原调用进程已退出，请重试");
        assert_eq!(exited.phase, "caller");
        assert_eq!(exited.code, "caller_exited");
        let rollback = classify_failure("--deploy-desktop", "部署失败；自动恢复失败：5");
        assert_eq!(rollback.phase, "rollback");
        assert_eq!(rollback.code, "rollback_failed");
        let unknown = classify_failure("--other", "Windows 错误 5");
        assert_eq!(unknown.code, "unexpected");
        assert!(!unknown.message.contains('5'));
    }

    #[test]
    fn 日志会脱敏代理凭据和完整_sid() {
        let value =
            redact("proxy=https://user:secret@example.com/a owner=S-1-5-21-123-456-789-1001");
        assert!(!value.contains("user:secret"));
        assert!(!value.contains("S-1-5-21"));
        assert!(value.contains("<redacted>@example.com"));
        assert!(value.contains("<sid>"));
    }

    #[test]
    fn 日志_acl_只给普通用户读取执行权限() {
        assert!(LOG_SDDL.contains("(A;OICI;FA;;;SY)"));
        assert!(LOG_SDDL.contains("(A;OICI;FA;;;BA)"));
        assert!(LOG_SDDL.contains("(A;OICI;GRGX;;;BU)"));
        assert!(!LOG_SDDL.contains("(A;OICI;FA;;;BU)"));
    }

    #[test]
    fn 只清理十五天以前的安装日志() {
        let directory =
            std::env::temp_dir().join(format!("fstty-installer-logs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("installer-2026-09-04-00000000-0000-0000-0000-000000000001.log"),
            "old",
        )
        .unwrap();
        fs::write(
            directory.join("installer-2026-09-05-00000000-0000-0000-0000-000000000002.log"),
            "keep",
        )
        .unwrap();
        fs::write(directory.join("other-2020-01-01.log"), "keep").unwrap();
        let today = Date::from_calendar_date(2026, time::Month::September, 19).unwrap();
        cleanup_expired_logs_impl(&directory, today, false).unwrap();
        assert!(!directory
            .join("installer-2026-09-04-00000000-0000-0000-0000-000000000001.log")
            .exists());
        assert!(directory
            .join("installer-2026-09-05-00000000-0000-0000-0000-000000000002.log")
            .exists());
        assert!(directory.join("other-2020-01-01.log").exists());
        let _ = fs::remove_dir_all(directory);
    }
}
