use std::{
    ffi::OsStr,
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::Path,
    ptr::{null, null_mut},
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{Pipes::*, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::SW_HIDE},
};

pub(super) fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
pub(super) fn error(label: &str) -> String {
    format!("{label}：{}", std::io::Error::last_os_error())
}
pub(super) struct Handle(pub HANDLE);
// Owned kernel handles can be transferred and queried across threads; mutation is
// performed by Windows. The owner closes the handle only after all Arc users exit.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub(super) fn pipe_name(nonce: &str) -> String {
    format!(r"\\.\pipe\FsTTY.Local.{nonce}")
}
pub(super) fn listener(nonce: &str) -> Result<NamedPipeServer, String> {
    let identity = fstty_broker::windows::current_identity()?;
    // Only this user, SYSTEM and elevated administrators may connect. The peer
    // still has to match the exact child process returned by our launch request.
    let sd = fstty_broker::windows::security_descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{})S:(ML;;NW;;;ME)",
        identity.sid
    ))?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .max_instances(1)
            .reject_remote_clients(true)
            .in_buffer_size(65536)
            .out_buffer_size(65536)
            .create_with_security_attributes_raw(
                pipe_name(nonce),
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
    .map_err(|e| format!("无法创建本地终端管道：{e}"))
}

pub(super) fn process_image(process: HANDLE) -> Result<std::path::PathBuf, String> {
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) } == 0 {
        return Err(error("无法验证本地终端进程"));
    }
    Ok(std::path::PathBuf::from(String::from_utf16_lossy(
        &buffer[..size as usize],
    )))
}
pub(super) fn verify_image(process: HANDLE) -> Result<(), String> {
    let actual = process_image(process)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let expected = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if actual != expected {
        return Err("本地终端进程身份不匹配".into());
    }
    Ok(())
}
pub(super) fn verify_client(pipe: &NamedPipeServer, process: &Handle) -> Result<(), String> {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0
        || pid != unsafe { GetProcessId(process.0) }
        || pid == 0
    {
        return Err("本地终端管道调用方不匹配".into());
    }
    verify_image(process.0)
}

pub(super) fn launch(nonce: &str, elevated: bool) -> Result<Handle, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parameters = format!("--local-terminal-host {} {nonce}", std::process::id());
    if elevated {
        let verb = wide("runas");
        let path = wide(&exe);
        let parameters = wide(parameters);
        let mut info: SHELLEXECUTEINFOW = unsafe { zeroed() };
        info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        info.lpVerb = verb.as_ptr();
        info.lpFile = path.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.nShow = SW_HIDE;
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            if unsafe { GetLastError() } == ERROR_CANCELLED {
                return Err("已取消管理员授权，可重新启动".into());
            }
            return Err(error("无法请求管理员授权"));
        }
        if info.hProcess.is_null() {
            return Err("未能取得本地终端进程".into());
        }
        return Ok(Handle(info.hProcess));
    }
    let mut command = wide(format!("{} {parameters}", quote(&exe)));
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let executable = wide(&exe);
    let identity = fstty_broker::windows::current_identity()?;
    let success = if identity.elevated {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(error("无法取得普通权限令牌"));
        }
        let token = Handle(token);
        let mut linked: TOKEN_LINKED_TOKEN = unsafe { zeroed() };
        let mut size = 0;
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenLinkedToken,
                (&mut linked as *mut TOKEN_LINKED_TOKEN).cast(),
                size_of::<TOKEN_LINKED_TOKEN>() as u32,
                &mut size,
            )
        } == 0
            || linked.LinkedToken.is_null()
        {
            return Err("无法取得标准用户令牌，请以普通权限启动 FsTTY".into());
        }
        let linked = Handle(linked.LinkedToken);
        // Fail closed if this is not a limited token; the host checks again.
        let mut elevation: TOKEN_ELEVATION = unsafe { zeroed() };
        if unsafe {
            GetTokenInformation(
                linked.0,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        } == 0
            || elevation.TokenIsElevated != 0
        {
            return Err("标准用户令牌不可用".into());
        }
        unsafe {
            CreateProcessWithTokenW(
                linked.0,
                0,
                executable.as_ptr(),
                command.as_mut_ptr(),
                CREATE_NO_WINDOW,
                null(),
                null(),
                &startup,
                &mut process,
            )
        }
    } else {
        unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_NO_WINDOW,
                null(),
                null(),
                &startup,
                &mut process,
            )
        }
    };
    if success == 0 {
        return Err(error("无法以普通权限启动本地终端"));
    }
    drop(Handle(process.hThread));
    Ok(Handle(process.hProcess))
}

// Executable paths cannot contain quotes. Arguments are fixed shell options or
// UUIDs and are never interpreted by cmd /c or another shell.
pub(super) fn quote(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

pub(super) struct ChildProcess(pub Handle);
impl Drop for ChildProcess {
    fn drop(&mut self) {
        unsafe {
            TerminateProcess(self.0 .0, 1);
        }
    }
}
