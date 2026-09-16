//! 桌面可迁移，提权程序和安装状态始终留在受保护目录。
mod files;
mod registry;
mod transaction;

use crate::windows::{self, wide, Handle};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Security::*,
    System::{RemoteDesktop::ProcessIdToSessionId, Threading::*},
};

pub use files::{same_path, validate_desktop_path};
pub use registry::{cleanup_user_registration, repair_user_autostart, user_previous_directories};
pub use transaction::close_desktops;
pub use transaction::{deploy, recover, uninstall};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    pub schema: u32,
    pub directory: PathBuf,
    pub version: String,
    pub sha256: String,
    pub generation: String,
    pub files: Vec<String>,
    pub previous_directories: Vec<PathBuf>,
}

impl Installation {
    fn validate(&self) -> crate::Result<()> {
        if self.schema != 1
            || self.files != ["fstty.exe"]
            || uuid::Uuid::parse_str(&self.generation).is_err()
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("安装记录损坏，请重新安装修复".into());
        }
        validate_desktop_path(&self.directory)?;
        for path in &self.previous_directories {
            validate_desktop_path(path)?;
        }
        Ok(())
    }
}

pub fn protected_directory() -> crate::Result<PathBuf> {
    Ok(windows::installed_exe()?
        .parent()
        .ok_or("服务目录无效")?
        .to_path_buf())
}

fn state_directory() -> crate::Result<PathBuf> {
    Ok(protected_directory()?.join("installation"))
}

pub fn read() -> crate::Result<Option<Installation>> {
    let root = protected_directory()?;
    let state = state_directory()?;
    let path = state.join("active.json");
    if !path.try_exists().map_err(|_| "无法读取安装记录")? {
        return Ok(None);
    }
    for item in [&root, &state, &path] {
        crate::paths::verify(item, "", false)?;
    }
    let record: Installation =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "无法读取安装记录")?)
            .map_err(|_| "安装记录损坏，请重新安装修复")?;
    record.validate()?;
    Ok(Some(record))
}

pub fn check_desktop(executable: &Path) -> crate::Result<Option<Installation>> {
    let record = read()?;
    if let Some(record) = &record {
        if !same_path(executable, &record.directory.join("fstty.exe")) {
            return Err(format!(
                "这份 FsTTY 已不是当前安装。请启动 {}。",
                record.directory.join("fstty.exe").display()
            ));
        }
        if record.version != env!("CARGO_PKG_VERSION") {
            return Err("桌面与安装版本不匹配，请重新运行当前安装包修复".into());
        }
    }
    Ok(record)
}

// 调用者进程保持存活到安装结束；不从环境变量猜测 UAC 前的用户。
pub fn caller_token(pid: u32) -> crate::Result<Handle> {
    if pid == 0 {
        return Err("缺少原调用用户进程".into());
    }
    let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
    if process.0.is_null() {
        return Err("原调用进程已退出，请重新启动安装包".into());
    }
    let mut caller_session = 0;
    let mut current_session = 0;
    if unsafe { ProcessIdToSessionId(pid, &mut caller_session) } == 0
        || unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session) } == 0
        || caller_session != current_session
    {
        return Err("安装调用者不在当前登录会话".into());
    }
    let mut raw = null_mut();
    if unsafe {
        OpenProcessToken(
            process.0,
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
            &mut raw,
        )
    } == 0
    {
        return Err("无法读取原调用用户令牌".into());
    }
    let token = Handle(raw);
    if windows::token_identity(token.0)?.elevated {
        return Err("请从普通权限桌面启动安装包，以保留原用户身份".into());
    }
    Ok(token)
}

pub fn candidates(pid: u32) -> crate::Result<Vec<PathBuf>> {
    if let Some(record) = read()? {
        return Ok(vec![record.directory]);
    }
    let token = caller_token(pid)?;
    registry::candidates(token.0)
}

pub fn export_candidates(pid: u32) -> crate::Result<()> {
    let candidates = candidates(pid)?;
    let exe = std::env::current_exe().map_err(|_| "无法定位安装工具")?;
    let directory = exe.parent().ok_or("安装工具目录无效")?;
    crate::paths::verify(directory, "", false)?;
    let mut content = format!(
        "[installation]\r\ncount={}\r\nregistered={}\r\n",
        candidates.len(),
        u8::from(read()?.is_some())
    );
    for (index, path) in candidates.iter().enumerate() {
        content.push_str(&format!("path{index}={}\r\n", path.display()));
    }
    let bytes = std::iter::once(0xfeffu16)
        .chain(content.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    std::fs::write(directory.join("candidates.ini"), bytes)
        .map_err(|_| "无法写入安装候选目录".into())
}

pub fn report_error(error: &str) {
    let result = (|| -> crate::Result<()> {
        if !windows::current_identity()?.elevated {
            return Ok(());
        }
        let exe = std::env::current_exe().map_err(|_| "无法定位安装工具")?;
        let directory = exe.parent().ok_or("安装工具目录无效")?;
        crate::paths::verify(directory, "", false)?;
        let content = format!("[result]\r\nerror={}\r\n", error.replace(['\r', '\n'], " "));
        let bytes = std::iter::once(0xfeffu16)
            .chain(content.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        std::fs::write(directory.join("installer-result.ini"), bytes)
            .map_err(|_| "无法保存安装结果".into())
    })();
    let _ = result;
}

pub fn launch_desktop(pid: u32) -> crate::Result<()> {
    let record = read()?.ok_or("尚未安装桌面")?;
    let token = caller_token(pid)?;
    launch_with_token(&record, &token)
}

pub(super) fn launch_with_token(record: &Installation, token: &Handle) -> crate::Result<()> {
    let mut primary = null_mut();
    if unsafe {
        DuplicateTokenEx(
            token.0,
            TOKEN_ALL_ACCESS,
            std::ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
    } == 0
    {
        return Err("无法保留原用户身份启动桌面".into());
    }
    let primary = Handle(primary);
    let mut environment = null_mut();
    if unsafe {
        windows_sys::Win32::System::Environment::CreateEnvironmentBlock(
            &mut environment,
            primary.0,
            0,
        )
    } == 0
    {
        return Err("无法创建原用户环境".into());
    }
    let exe = record.directory.join("fstty.exe");
    let mut command = wide(&format!("\"{}\"", exe.display()));
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        CreateProcessWithTokenW(
            primary.0,
            LOGON_WITH_PROFILE,
            wide(&exe.to_string_lossy()).as_ptr(),
            command.as_mut_ptr(),
            CREATE_UNICODE_ENVIRONMENT,
            environment,
            wide(&record.directory.to_string_lossy()).as_ptr(),
            &startup,
            &mut process,
        )
    };
    unsafe {
        windows_sys::Win32::System::Environment::DestroyEnvironmentBlock(environment);
    }
    if ok == 0 {
        return Err("安装成功，但无法以原用户身份启动桌面，请手动打开快捷方式".into());
    }
    drop(Handle(process.hThread));
    drop(Handle(process.hProcess));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 安装清单拒绝任意路径和未知格式() {
        let mut value = Installation {
            schema: 1,
            directory: PathBuf::from(r"D:\Apps\FsTTY"),
            version: "1.4.0".into(),
            sha256: "0".repeat(64),
            generation: uuid::Uuid::new_v4().to_string(),
            files: vec!["../secret".into()],
            previous_directories: vec![],
        };
        assert!(value.validate().is_err());
        value.files = vec!["fstty.exe".into()];
        value.schema = 2;
        assert!(value.validate().is_err());
    }
}
