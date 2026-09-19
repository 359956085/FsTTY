//! 桌面可迁移，提权程序和安装状态始终留在受保护目录。
mod diagnostics;
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
    Foundation::STILL_ACTIVE,
    Security::*,
    System::{RemoteDesktop::ProcessIdToSessionId, Threading::*},
};

pub use diagnostics::classify_failure;
pub(crate) use diagnostics::{operation_id, record, InstallerEvent};
pub use files::{same_path, validate_desktop_path};
pub use registry::{cleanup_user_registration, repair_user_autostart, user_previous_directories};
pub use transaction::close_desktops;
pub use transaction::{deploy, deploy_with_operation, recover, uninstall};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerMode {
    Standard,
    LinkedStandard,
    AlwaysElevated,
}

impl CallerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::LinkedStandard => "linkedStandard",
            Self::AlwaysElevated => "alwaysElevated",
        }
    }
}

pub struct CallerContext {
    pub(crate) token: Handle,
    pub identity: windows::Identity,
    pub session_id: u32,
    pub mode: CallerMode,
}

#[derive(Clone, Copy)]
struct TokenFacts<'a> {
    sid: &'a str,
    session_id: u32,
    elevated: bool,
    elevation_type: TOKEN_ELEVATION_TYPE,
    service_logon: bool,
    administrator: bool,
}

fn service_or_system_account(sid: &str, service_logon: bool) -> bool {
    service_logon
        || matches!(sid, "S-1-5-18" | "S-1-5-19" | "S-1-5-20")
        || sid.starts_with("S-1-5-80-")
        || sid.starts_with("S-1-5-82-")
}

fn select_caller_mode(
    caller: TokenFacts<'_>,
    linked: Option<TokenFacts<'_>>,
    current_session: u32,
) -> crate::Result<CallerMode> {
    if caller.session_id == 0 || current_session == 0 {
        return Err("会话 0 不允许执行交互式安装".into());
    }
    if caller.session_id != current_session {
        return Err("安装调用者不在当前登录会话".into());
    }
    if service_or_system_account(caller.sid, caller.service_logon) {
        return Err("系统或服务账号不允许执行交互式安装".into());
    }
    if !caller.elevated {
        if caller.elevation_type == TokenElevationTypeFull {
            return Err("调用者令牌状态异常，已拒绝安装".into());
        }
        return Ok(CallerMode::Standard);
    }
    if !caller.administrator {
        return Err("提权调用者不是本机管理员，已拒绝安装".into());
    }
    if caller.elevation_type == TokenElevationTypeFull {
        let linked = linked.ok_or("管理员关联的普通权限令牌不可用")?;
        if linked.sid != caller.sid {
            return Err("管理员关联令牌的用户身份不一致".into());
        }
        if linked.session_id != caller.session_id || linked.session_id != current_session {
            return Err("管理员关联令牌不在当前登录会话".into());
        }
        if linked.elevated || linked.elevation_type != TokenElevationTypeLimited {
            return Err("管理员关联令牌不是预期的普通权限令牌".into());
        }
        if service_or_system_account(linked.sid, linked.service_logon) {
            return Err("系统或服务账号不允许执行交互式安装".into());
        }
        Ok(CallerMode::LinkedStandard)
    } else if caller.elevation_type == TokenElevationTypeDefault {
        Ok(CallerMode::AlwaysElevated)
    } else {
        Err("调用者令牌状态异常，已拒绝安装".into())
    }
}

// 调用者进程保持存活到安装结束；不从环境变量猜测 UAC 前的用户。
pub fn caller_context(pid: u32) -> crate::Result<CallerContext> {
    if pid == 0 {
        return Err("缺少原调用用户进程".into());
    }
    let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
    if process.0.is_null() {
        return Err("原调用进程已退出，请重新启动安装包".into());
    }
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(process.0, &mut exit_code) } == 0
        || exit_code != STILL_ACTIVE as u32
    {
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
    let identity = windows::token_identity(token.0)?;
    let service_logon = windows::token_has_group(token.0, "S-1-5-6")?;
    let administrator = windows::token_has_group(token.0, "S-1-5-32-544")?;
    let token_session = windows::token_session_id(token.0)?;
    if token_session != caller_session {
        return Err("调用者令牌不在原进程会话".into());
    }
    let elevation_type = windows::token_elevation_type(token.0)?;
    let linked = if identity.elevated && elevation_type == TokenElevationTypeFull {
        Some(windows::token_linked_token(token.0)?)
    } else {
        None
    };
    let linked_identity = linked
        .as_ref()
        .map(|token| windows::token_identity(token.0))
        .transpose()?;
    let linked_session = linked
        .as_ref()
        .map(|token| windows::token_session_id(token.0))
        .transpose()?;
    let linked_elevation_type = linked
        .as_ref()
        .map(|token| windows::token_elevation_type(token.0))
        .transpose()?;
    let linked_service_logon = linked
        .as_ref()
        .map(|token| windows::token_has_group(token.0, "S-1-5-6"))
        .transpose()?;
    let linked_facts = linked_identity
        .as_ref()
        .zip(linked_session)
        .zip(linked_elevation_type)
        .zip(linked_service_logon)
        .map(
            |(((identity, session_id), elevation_type), service_logon)| TokenFacts {
                sid: &identity.sid,
                session_id,
                elevated: identity.elevated,
                elevation_type,
                service_logon,
                administrator: false,
            },
        );
    let mode = select_caller_mode(
        TokenFacts {
            sid: &identity.sid,
            session_id: caller_session,
            elevated: identity.elevated,
            elevation_type,
            service_logon,
            administrator,
        },
        linked_facts,
        current_session,
    )?;
    let (token, identity) = match (mode, linked, linked_identity) {
        (CallerMode::LinkedStandard, Some(token), Some(identity)) => (token, identity),
        _ => (token, identity),
    };
    Ok(CallerContext {
        token,
        identity,
        session_id: caller_session,
        mode,
    })
}

pub fn candidates(pid: u32) -> crate::Result<Vec<PathBuf>> {
    let caller = caller_context(pid)?;
    candidates_for_context(&caller)
}

pub(super) fn candidates_for_context(caller: &CallerContext) -> crate::Result<Vec<PathBuf>> {
    if let Some(record) = read()? {
        return Ok(vec![record.directory]);
    }
    registry::candidates(caller.token.0)
}

pub fn export_candidates(pid: u32) -> crate::Result<()> {
    let operation_id = diagnostics::operation_id(None);
    let started = std::time::Instant::now();
    let mut caller_mode = None;
    let mut session_id = None;
    let result: crate::Result<()> = (|| -> crate::Result<()> {
        let caller = caller_context(pid)?;
        caller_mode = Some(caller.mode);
        session_id = Some(caller.session_id);
        let candidates = candidates_for_context(&caller)?;
        let exe = std::env::current_exe().map_err(|_| "无法定位安装工具")?;
        let directory = exe.parent().ok_or("安装工具目录无效")?;
        crate::paths::verify(directory, "", false)?;
        let mut content = format!(
            "[installation]\r\ncount={}\r\nregistered={}\r\ncallerMode={}\r\nsession={}\r\noperationId={}\r\n",
            candidates.len(),
            u8::from(read()?.is_some()),
            caller.mode.as_str(),
            caller.session_id,
            operation_id,
        );
        for (index, path) in candidates.iter().enumerate() {
            content.push_str(&format!("path{index}={}\r\n", path.display()));
        }
        let bytes = std::iter::once(0xfeffu16)
            .chain(content.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        std::fs::write(directory.join("candidates.ini"), bytes)
            .map_err(|_| "无法写入安装候选目录".to_owned())
    })();
    let (result_name, code, detail) = match &result {
        Ok(()) => ("success", "ok", None),
        Err(error) => {
            let failure = diagnostics::classify_failure("--desktop-candidates", error);
            ("failure", failure.code, Some(error.as_str()))
        }
    };
    diagnostics::record(diagnostics::InstallerEvent {
        operation_id: &operation_id,
        install_mode: "bootstrap",
        phase: "caller",
        caller_mode,
        session_id,
        target: None,
        result: result_name,
        code,
        exit_code: Some(if result.is_ok() { 0 } else { 1 }),
        rollback: None,
        detail,
        elapsed: started.elapsed(),
    });
    result
}

pub fn report_error(command: &str, error: &str) {
    let result = (|| -> crate::Result<()> {
        if !windows::current_identity()?.elevated {
            return Ok(());
        }
        let exe = std::env::current_exe().map_err(|_| "无法定位安装工具")?;
        let directory = exe.parent().ok_or("安装工具目录无效")?;
        crate::paths::verify(directory, "", false)?;
        let failure = diagnostics::classify_failure(command, error);
        let content = format!(
            "[result]\r\nerror={}\r\nphase={}\r\ncode={}\r\n",
            failure.message.replace(['\r', '\n'], " "),
            failure.phase,
            failure.code,
        );
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
    let operation_id = diagnostics::operation_id(None);
    launch_desktop_with_operation(pid, &operation_id)
}

pub fn launch_desktop_with_operation(pid: u32, requested_operation_id: &str) -> crate::Result<()> {
    let operation_id = diagnostics::operation_id(Some(requested_operation_id));
    let started = std::time::Instant::now();
    let mut caller_mode = None;
    let mut session_id = None;
    let mut target = None;
    let result = (|| {
        let caller = caller_context(pid)?;
        caller_mode = Some(caller.mode);
        session_id = Some(caller.session_id);
        let record = read()?.ok_or("尚未安装桌面")?;
        target = Some(record.directory.clone());
        launch_with_token(&record, &caller.token)
    })();
    let (result_name, code, detail) = match &result {
        Ok(()) => ("success", "ok", None),
        Err(error) => {
            let failure = diagnostics::classify_failure("--launch-desktop", error);
            ("failure", failure.code, Some(error.as_str()))
        }
    };
    diagnostics::record(diagnostics::InstallerEvent {
        operation_id: &operation_id,
        install_mode: "launch",
        phase: "launch",
        caller_mode,
        session_id,
        target: target.as_deref(),
        result: result_name,
        code,
        exit_code: Some(if result.is_ok() { 0 } else { 1 }),
        rollback: None,
        detail,
        elapsed: started.elapsed(),
    });
    result
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

    fn facts<'a>(
        sid: &'a str,
        session_id: u32,
        elevated: bool,
        elevation_type: TOKEN_ELEVATION_TYPE,
    ) -> TokenFacts<'a> {
        TokenFacts {
            sid,
            session_id,
            elevated,
            elevation_type,
            service_logon: false,
            administrator: elevated,
        }
    }

    #[test]
    fn 普通令牌直接沿用且完整管理员使用关联普通令牌() {
        let sid = "S-1-5-21-1000";
        assert_eq!(
            select_caller_mode(facts(sid, 2, false, TokenElevationTypeLimited), None, 2).unwrap(),
            CallerMode::Standard
        );
        assert_eq!(
            select_caller_mode(
                facts(sid, 2, true, TokenElevationTypeFull),
                Some(facts(sid, 2, false, TokenElevationTypeLimited)),
                2
            )
            .unwrap(),
            CallerMode::LinkedStandard
        );
    }

    #[test]
    fn 无拆分令牌的管理员进入兼容模式() {
        assert_eq!(
            select_caller_mode(
                facts("S-1-5-21-1000-500", 3, true, TokenElevationTypeDefault),
                None,
                3
            )
            .unwrap(),
            CallerMode::AlwaysElevated
        );
    }

    #[test]
    fn 关联令牌必须保持同一用户会话且未提权() {
        let sid = "S-1-5-21-1000";
        let caller = facts(sid, 2, true, TokenElevationTypeFull);
        assert!(select_caller_mode(
            caller,
            Some(facts("S-1-5-21-2000", 2, false, TokenElevationTypeLimited)),
            2
        )
        .is_err());
        assert!(select_caller_mode(
            caller,
            Some(facts(sid, 4, false, TokenElevationTypeLimited)),
            2
        )
        .is_err());
        assert!(
            select_caller_mode(caller, Some(facts(sid, 2, true, TokenElevationTypeFull)), 2)
                .is_err()
        );
        assert!(select_caller_mode(
            caller,
            Some(facts(sid, 2, false, TokenElevationTypeDefault)),
            2
        )
        .is_err());
    }

    #[test]
    fn 系统服务账号会话零及跨会话均被拒绝() {
        for sid in [
            "S-1-5-18",
            "S-1-5-19",
            "S-1-5-20",
            "S-1-5-80-123",
            "S-1-5-82-123",
        ] {
            assert!(
                select_caller_mode(facts(sid, 2, true, TokenElevationTypeDefault), None, 2)
                    .is_err()
            );
        }
        let mut service = facts("S-1-5-21-1000", 2, true, TokenElevationTypeDefault);
        service.service_logon = true;
        assert!(select_caller_mode(service, None, 2).is_err());
        let mut non_admin = facts("S-1-5-21-1000", 2, true, TokenElevationTypeDefault);
        non_admin.administrator = false;
        assert!(select_caller_mode(non_admin, None, 2).is_err());
        assert!(select_caller_mode(
            facts("S-1-5-21-1000", 0, true, TokenElevationTypeDefault),
            None,
            0
        )
        .is_err());
        assert!(select_caller_mode(
            facts("S-1-5-21-1000", 2, false, TokenElevationTypeLimited),
            None,
            3
        )
        .is_err());
    }
}
