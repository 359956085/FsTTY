use crate::{
    protocol::{self, Request, Response, PIPE, SERVICE},
    store::Protector,
};
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    os::windows::io::AsRawHandle,
    path::PathBuf,
    ptr::{null, null_mut},
};
use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Cryptography::*, *},
    System::{Pipes::*, Services::*, Threading::*},
    UI::Shell::*,
};
use zeroize::{Zeroize, Zeroizing};

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn os_error(label: &str) -> String {
    format!("{label}（Windows 错误 {}）", unsafe { GetLastError() })
}

pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
struct ScHandle(SC_HANDLE);
impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseServiceHandle(self.0);
            }
        }
    }
}

pub struct Local(pub *mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

fn token(handle: HANDLE) -> crate::Result<Handle> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token) } == 0 {
        return Err(os_error("无法查询进程身份"));
    }
    Ok(Handle(token))
}
fn token_info(token: HANDLE, kind: TOKEN_INFORMATION_CLASS) -> crate::Result<Vec<usize>> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, kind, null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(os_error("无法查询令牌"));
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token, kind, buffer.as_mut_ptr().cast(), size, &mut size) } == 0
    {
        return Err(os_error("无法读取令牌"));
    }
    Ok(buffer)
}
pub(crate) fn token_identity(token: HANDLE) -> crate::Result<Identity> {
    let info = token_info(token, TokenUser)?;
    let user = unsafe { &*info.as_ptr().cast::<TOKEN_USER>() };
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(os_error("无法读取用户 SID"));
    }
    let memory = Local(text.cast());
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
    drop(memory);
    let info = token_info(token, TokenElevation)?;
    let elevated = unsafe { (*info.as_ptr().cast::<TOKEN_ELEVATION>()).TokenIsElevated != 0 };
    Ok(Identity { sid, elevated })
}
#[derive(Clone)]
pub struct Identity {
    pub sid: String,
    pub elevated: bool,
}
pub fn current_identity() -> crate::Result<Identity> {
    token_identity(token(unsafe { GetCurrentProcess() })?.0)
}

pub fn peer(pipe: &NamedPipeServer) -> crate::Result<Identity> {
    // 模拟身份只在此同步作用域查询；任何异步挂起之前必须恢复服务身份。
    if unsafe { ImpersonateNamedPipeClient(pipe.as_raw_handle()) } == 0 {
        return Err(os_error("无法验证管道调用方"));
    }
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            unsafe {
                RevertToSelf();
            }
        }
    }
    let _revert = Revert;
    let mut raw = null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut raw) } == 0 {
        return Err(os_error("无法读取管道令牌"));
    }
    token_identity(Handle(raw).0)
}

pub fn security_descriptor(sddl: &str) -> crate::Result<Local> {
    let mut raw = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            null_mut(),
        )
    } == 0
    {
        return Err(os_error("无法创建安全描述符"));
    }
    Ok(Local(raw))
}

pub fn listener(first: bool) -> crate::Result<NamedPipeServer> {
    let sid = current_identity()?.sid;
    // 数据、属性读写和同步权限不包含 FILE_CREATE_PIPE_INSTANCE，避免 GENERIC_WRITE 展开该权限。
    let sd = security_descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})(A;;0x12019b;;;AU)S:(ML;;NW;;;ME)"
    ))?;
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .in_buffer_size(65536)
            .out_buffer_size(65536)
            .create_with_security_attributes_raw(PIPE, (&mut sa as *mut SECURITY_ATTRIBUTES).cast())
    }
    .map_err(|_| "无法创建受保护服务管道".into())
}

fn scm(access: u32) -> crate::Result<ScHandle> {
    let h = unsafe { OpenSCManagerW(null(), null(), access) };
    if h.is_null() {
        Err(os_error("无法访问服务管理器"))
    } else {
        Ok(ScHandle(h))
    }
}
fn open_service(access: u32) -> crate::Result<ScHandle> {
    let scm = scm(SC_MANAGER_CONNECT)?;
    let h = unsafe { OpenServiceW(scm.0, wide(SERVICE).as_ptr(), access) };
    if h.is_null() {
        Err("FsTTY 凭据服务尚未安装，请运行 Windows 安装程序".into())
    } else {
        Ok(ScHandle(h))
    }
}

pub(crate) fn service_pid() -> crate::Result<u32> {
    let service = open_service(SERVICE_QUERY_STATUS)?;
    let mut status: SERVICE_STATUS_PROCESS = unsafe { zeroed() };
    let mut needed = 0;
    if unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    } == 0
        || status.dwCurrentState != SERVICE_RUNNING
    {
        return Err("FsTTY 凭据服务未运行，请修复安装后重试".into());
    }
    Ok(status.dwProcessId)
}

pub async fn connect() -> crate::Result<NamedPipeClient> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let service_pid = loop {
        match service_pid() {
            Ok(pid) => break pid,
            Err(error) if std::time::Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    };
    let mut pipe = None;
    for _ in 0..30 {
        match open_pipe() {
            Ok(p) => {
                pipe = Some(p);
                break;
            }
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await
            }
            Err(error) => {
                return Err(format!(
                    "无法连接 FsTTY 凭据服务（Windows 错误 {}）",
                    error.raw_os_error().unwrap_or(0)
                ))
            }
        }
    }
    let pipe = pipe.ok_or("FsTTY 凭据服务繁忙")?;
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0
        || pid == 0
        || pid != service_pid
    {
        return Err("管道服务身份不匹配，已拒绝传输凭据".into());
    }
    Ok(pipe)
}

fn open_pipe() -> std::io::Result<NamedPipeClient> {
    // GENERIC_WRITE 会隐含创建服务端实例的权限；客户端仅申请数据读写和同步。
    let raw = unsafe {
        CreateFileW(
            wide(PIPE).as_ptr(),
            0x12019b,
            0,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_IDENTIFICATION | SECURITY_SQOS_PRESENT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    unsafe { NamedPipeClient::from_raw_handle(raw) }
}

pub async fn request(request: &Request) -> crate::Result<Response> {
    let mut pipe = connect().await?;
    protocol::write(&mut pipe, request).await?;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        protocol::read(&mut pipe),
    )
    .await
    .map_err(|_| "服务请求超时，请修复凭据服务")?
    .map_err(|message| format!("{message}；请修复凭据服务，确认使用协议 v2"))?;
    match result {
        Response::Error { message } => Err(message),
        other => Ok(other),
    }
}

pub struct Dpapi;
impl Protector for Dpapi {
    fn seal(&self, bytes: &[u8]) -> crate::Result<Vec<u8>> {
        crypt(bytes, true).map(|v| v.to_vec())
    }
    fn open(&self, bytes: &[u8]) -> crate::Result<Zeroizing<Vec<u8>>> {
        crypt(bytes, false)
    }
}
fn crypt(bytes: &[u8], seal: bool) -> crate::Result<Zeroizing<Vec<u8>>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "凭据过大")?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { zeroed() };
    let ok = unsafe {
        if seal {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("服务凭据加解密失败".into());
    }
    let memory = Local(output.pbData.cast());
    let raw = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let result = Zeroizing::new(raw.to_vec());
    raw.zeroize();
    drop(memory);
    Ok(result)
}

pub(crate) fn known_folder(id: &windows_sys::core::GUID) -> crate::Result<PathBuf> {
    let mut path = null_mut();
    if unsafe { SHGetKnownFolderPath(id, 0, null_mut(), &mut path) } < 0 {
        return Err("无法定位系统目录".into());
    }
    let mut n = 0;
    unsafe {
        while *path.add(n) != 0 {
            n += 1;
        }
    }
    let result = PathBuf::from(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(path, n)
    }));
    unsafe {
        windows_sys::Win32::System::Com::CoTaskMemFree(path.cast());
    }
    Ok(result)
}
pub fn installed_exe() -> crate::Result<PathBuf> {
    Ok(known_folder(&FOLDERID_ProgramFiles)?
        .join("FsTTY")
        .join("fstty-broker.exe"))
}
pub fn data_dir() -> crate::Result<PathBuf> {
    Ok(known_folder(&FOLDERID_ProgramData)?.join("FsTTYBroker"))
}

pub fn protect_path(path: &std::path::Path, sid: &str) -> crate::Result<()> {
    let sd = security_descriptor(&format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})"
    ))?;
    if unsafe {
        windows_sys::Win32::Security::SetFileSecurityW(
            wide(&path.to_string_lossy()).as_ptr(),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            sd.0,
        )
    } == 0
    {
        return Err(os_error("无法保护服务数据目录"));
    }
    Ok(())
}

pub fn elevate(ticket: &str) -> crate::Result<()> {
    elevate_action(ticket, false)
}

pub fn elevate_with_theme(ticket: &str, theme: crate::admin::Theme) -> crate::Result<()> {
    uuid::Uuid::parse_str(ticket).map_err(|_| "管理请求 ID 无效")?;
    launch_admin(&format!("--manage {ticket} --theme {}", theme.argument()))
}

pub fn elevate_update(ticket: &str) -> crate::Result<()> {
    elevate_action(ticket, true)
}

fn elevate_action(ticket: &str, update: bool) -> crate::Result<()> {
    uuid::Uuid::parse_str(ticket).map_err(|_| "管理请求 ID 无效")?;
    launch_admin(&format!(
        "{} {ticket}",
        if update { "--update" } else { "--manage" }
    ))
}

pub fn repair() -> crate::Result<()> {
    launch_admin("--repair")
}

fn launch_admin(arguments: &str) -> crate::Result<()> {
    let exe = installed_exe()?;
    crate::paths::verify(exe.parent().ok_or("安装目录无效")?, "", false)?;
    crate::paths::verify(&exe, "", false)?;
    let verb = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let directory = wide(&exe.parent().ok_or("安装目录无效")?.to_string_lossy());
    let args = wide(arguments);
    let mut info: SHELLEXECUTEINFOW = unsafe { zeroed() };
    info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpDirectory = directory.as_ptr();
    info.lpParameters = args.as_ptr();
    info.nShow = 1;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err("安全管理操作已取消或无法启动".into());
    }
    let process = Handle(info.hProcess);
    if unsafe { WaitForSingleObject(process.0, 300_000) } != WAIT_OBJECT_0 {
        return Err("安全管理操作超时".into());
    }
    let mut code = 1;
    unsafe {
        GetExitCodeProcess(process.0, &mut code);
    }
    if code != 0 {
        return Err("安全管理操作未完成".into());
    }
    Ok(())
}

pub fn install() -> crate::Result<()> {
    if !current_identity()?.elevated {
        return Err("安装服务需要管理员权限".into());
    }
    let expected = installed_exe()?;
    crate::paths::verify(expected.parent().ok_or("安装目录无效")?, "", false)?;
    crate::paths::verify(&expected, "", false)?;
    if std::env::current_exe()
        .map_err(|_| "无法定位程序")?
        .canonicalize()
        .map_err(|_| "无法定位程序")?
        != expected
            .canonicalize()
            .map_err(|_| "请先安装到 Program Files\\FsTTY")?
    {
        return Err("服务只能从受保护的安装目录注册".into());
    }
    let manager = scm(SC_MANAGER_CREATE_SERVICE)?;
    let command = wide(&format!("\"{}\" --service", expected.display()));
    let name = wide(SERVICE);
    let account = wide(r"NT SERVICE\FsTTYBroker");
    let handle = unsafe {
        CreateServiceW(
            manager.0,
            name.as_ptr(),
            name.as_ptr(),
            SERVICE_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_NORMAL,
            command.as_ptr(),
            null(),
            null_mut(),
            null(),
            account.as_ptr(),
            null(),
        )
    };
    let service = if handle.is_null() {
        open_service(SERVICE_ALL_ACCESS)?
    } else {
        ScHandle(handle)
    };
    if unsafe {
        ChangeServiceConfigW(
            service.0,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_NORMAL,
            command.as_ptr(),
            null(),
            null_mut(),
            null(),
            account.as_ptr(),
            null(),
            null(),
        )
    } == 0
    {
        return Err(os_error("无法配置服务"));
    }
    let mut sid_type = SERVICE_SID_INFO {
        dwServiceSidType: SERVICE_SID_TYPE_UNRESTRICTED,
    };
    if unsafe {
        ChangeServiceConfig2W(
            service.0,
            SERVICE_CONFIG_SERVICE_SID_INFO,
            (&mut sid_type as *mut SERVICE_SID_INFO).cast(),
        )
    } == 0
    {
        return Err(os_error("无法配置服务身份"));
    }
    let sd = security_descriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;LC;;;AU)")?;
    if unsafe { SetServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION, sd.0) } == 0 {
        return Err(os_error("无法保护服务配置"));
    }
    let sid = service_sid()?;
    let dir = data_dir()?;
    crate::paths::create_data_dir(&dir, &sid)?;
    if unsafe { StartServiceW(service.0, 0, null()) } == 0
        && unsafe { GetLastError() } != ERROR_SERVICE_ALREADY_RUNNING
    {
        return Err(os_error("无法启动服务"));
    }
    drop(service);
    for _ in 0..100 {
        if service_pid().is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("凭据服务未能启动，请修复安装".into())
}

pub fn service_sid() -> crate::Result<String> {
    let account = wide(r"NT SERVICE\FsTTYBroker");
    let mut sid_size = 0;
    let mut domain_size = 0;
    let mut usage = 0;
    unsafe {
        LookupAccountNameW(
            null(),
            account.as_ptr(),
            null_mut(),
            &mut sid_size,
            null_mut(),
            &mut domain_size,
            &mut usage,
        );
    }
    let mut sid = vec![0u8; sid_size as usize];
    let mut domain = vec![0u16; domain_size as usize];
    if unsafe {
        LookupAccountNameW(
            null(),
            account.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut sid_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut usage,
        )
    } == 0
    {
        return Err(os_error("无法定位服务账号"));
    }
    let mut sid_text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid.as_mut_ptr().cast(), &mut sid_text) } == 0 {
        return Err(os_error("无法转换服务 SID"));
    }
    let memory = Local(sid_text.cast());
    let mut n = 0;
    unsafe {
        while *sid_text.add(n) != 0 {
            n += 1;
        }
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_text, n) });
    drop(memory);
    Ok(sid)
}

pub fn stop(remove: bool) -> crate::Result<()> {
    if !current_identity()?.elevated {
        return Err("管理服务需要管理员权限".into());
    }
    let service = match open_service(SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE) {
        Ok(service) => service,
        Err(_) if unsafe { GetLastError() } == ERROR_SERVICE_DOES_NOT_EXIST => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut status: SERVICE_STATUS = unsafe { zeroed() };
    unsafe {
        ControlService(service.0, SERVICE_CONTROL_STOP, &mut status);
    }
    for _ in 0..100 {
        if unsafe { QueryServiceStatus(service.0, &mut status) } == 0
            || status.dwCurrentState == SERVICE_STOPPED
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if status.dwCurrentState != SERVICE_STOPPED {
        return Err("服务仍在停止，不能替换程序".into());
    }
    if remove && unsafe { DeleteService(service.0) } == 0 {
        return Err(os_error("无法卸载服务"));
    }
    Ok(())
}

pub fn protect_process() -> crate::Result<()> {
    let sid = current_identity()?.sid;
    let sd = security_descriptor(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})"))?;
    if unsafe { SetKernelObjectSecurity(GetCurrentProcess(), DACL_SECURITY_INFORMATION, sd.0) } == 0
    {
        return Err(os_error("无法保护服务进程"));
    }
    Ok(())
}

pub fn prepare_upgrade() -> crate::Result<()> {
    if !current_identity()?.elevated {
        return Err("准备升级需要管理员权限".into());
    }
    let install_dir = installed_exe()?
        .parent()
        .ok_or("安装目录无效")?
        .to_path_buf();
    crate::paths::verify_tree(&install_dir, "", false)?;
    let dir = data_dir()?;
    if dir.exists() {
        crate::paths::verify_tree(&dir, &service_sid()?, true)?;
    }
    let was_running = service_pid().is_ok();
    stop(false)?;
    let result = (|| {
        let db = dir.join("credentials.v1.db");
        if db.exists() {
            // 服务停止后恢复未完成事务，再备份仅含密文的数据库。
            drop(crate::store::Store::open(&db, Box::new(Dpapi))?);
            std::fs::copy(&db, dir.join("credentials.rollback.db"))
                .map_err(|_| "无法备份服务数据库")?;
        }
        Ok(())
    })();
    if result.is_err() && was_running {
        resume_upgrade().map_err(|error| format!("备份失败，且旧服务无法恢复：{error}"))?;
    }
    result
}

pub fn resume_upgrade() -> crate::Result<()> {
    if !current_identity()?.elevated {
        return Err("恢复服务需要管理员权限".into());
    }
    let exe = installed_exe()?;
    crate::paths::verify_tree(exe.parent().ok_or("安装目录无效")?, "", false)?;
    let service = open_service(SERVICE_START | SERVICE_QUERY_STATUS)?;
    if unsafe { StartServiceW(service.0, 0, null()) } == 0
        && unsafe { GetLastError() } != ERROR_SERVICE_ALREADY_RUNNING
    {
        return Err(os_error("无法恢复旧服务"));
    }
    for _ in 0..100 {
        if service_pid().is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("旧服务未能恢复，请修复安装".into())
}

pub fn restore_upgrade() -> crate::Result<()> {
    stop(false)?;
    let dir = data_dir()?;
    crate::paths::verify_tree(&dir, &service_sid()?, true)?;
    let backup = dir.join("credentials.rollback.db");
    if backup.exists() {
        let journal = dir.join("credentials.v1.db-journal");
        if journal.exists() {
            std::fs::remove_file(journal).map_err(|_| "无法恢复数据库日志")?;
        }
        std::fs::copy(backup, dir.join("credentials.v1.db")).map_err(|_| "无法恢复服务数据库")?;
    }
    install()
}
