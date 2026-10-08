use super::startup_errors as startup;
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
    startup::failure(label, std::io::Error::last_os_error())
}

fn token_elevation_type(token: HANDLE) -> Result<TOKEN_ELEVATION_TYPE, std::io::Error> {
    let mut value = 0;
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token,
            TokenElevationType,
            (&mut value as *mut TOKEN_ELEVATION_TYPE).cast(),
            size_of::<TOKEN_ELEVATION_TYPE>() as u32,
            &mut size,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(value)
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
    let identity = fstty_broker::windows::current_identity()
        .map_err(|e| startup::security("pipe-identity", e))?;
    // Only this user, SYSTEM and elevated administrators may connect. The peer
    // still has to match the exact child process returned by our launch request.
    let sd = fstty_broker::windows::security_descriptor(&format!(
        "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{})S:(ML;;NW;;;ME)",
        identity.sid
    ))
    .map_err(|e| startup::failure("pipe-security-descriptor", e))?;
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
    .map_err(|e| startup::failure("pipe-listener", e))
}

pub(super) fn process_image(process: HANDLE) -> Result<std::path::PathBuf, String> {
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) } == 0 {
        return Err(startup::security(
            "process-image-query",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(std::path::PathBuf::from(String::from_utf16_lossy(
        &buffer[..size as usize],
    )))
}
pub(super) fn verify_image(process: HANDLE) -> Result<(), String> {
    let actual = process_image(process)?
        .canonicalize()
        .map_err(|e| startup::security("process-image-path", e))?;
    let expected = std::env::current_exe()
        .map_err(|e| startup::security("current-image", e))?
        .canonicalize()
        .map_err(|e| startup::security("current-image-path", e))?;
    if actual != expected {
        return Err(startup::security("process-image", "image mismatch"));
    }
    Ok(())
}
pub(super) fn verify_client(pipe: &NamedPipeServer, process: &Handle) -> Result<(), String> {
    let mut pid = 0;
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return Err(startup::security(
            "pipe-client-query",
            std::io::Error::last_os_error(),
        ));
    }
    if pid != unsafe { GetProcessId(process.0) } || pid == 0 {
        return Err(startup::security("pipe-client", "PID mismatch"));
    }
    verify_image(process.0)
}

pub(super) fn launch(nonce: &str, elevated: bool) -> Result<Handle, String> {
    let exe = std::env::current_exe().map_err(|e| startup::failure("host-image", e))?;
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
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_CANCELLED as i32) {
                return Err(startup::diagnostic(
                    startup::ADMIN_CANCELLED,
                    "runas-cancelled",
                    error,
                ));
            }
            return Err(startup::diagnostic(startup::ADMIN_FAILED, "runas", error));
        }
        if info.hProcess.is_null() {
            return Err(startup::failure("runas-process", "missing process handle"));
        }
        return Ok(Handle(info.hProcess));
    }
    let mut command = wide(format!("{} {parameters}", quote(&exe)));
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
    let executable = wide(&exe);
    let identity = fstty_broker::windows::current_identity()
        .map_err(|e| startup::diagnostic(startup::PERMISSION, "launch-identity", e))?;
    let success = if identity.elevated {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(startup::diagnostic(
                startup::PERMISSION,
                "process-token",
                std::io::Error::last_os_error(),
            ));
        }
        let token = Handle(token);
        let mut linked: TOKEN_LINKED_TOKEN = unsafe { zeroed() };
        let mut size = 0;
        let linked_result = unsafe {
            GetTokenInformation(
                token.0,
                TokenLinkedToken,
                (&mut linked as *mut TOKEN_LINKED_TOKEN).cast(),
                size_of::<TOKEN_LINKED_TOKEN>() as u32,
                &mut size,
            )
        };
        if linked_result == 0 || linked.LinkedToken.is_null() {
            // Preserve the original API error before the read-only type query.
            let detail = if linked_result == 0 {
                std::io::Error::last_os_error().to_string()
            } else {
                "missing linked token".into()
            };
            return Err(startup::standard_token_failure(
                token_elevation_type(token.0),
                detail,
            ));
        }
        let linked = Handle(linked.LinkedToken);
        // Fail closed if this is not a limited token; the host checks again.
        let mut elevation: TOKEN_ELEVATION = unsafe { zeroed() };
        let validation = unsafe {
            GetTokenInformation(
                linked.0,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            )
        };
        if validation == 0 || elevation.TokenIsElevated != 0 {
            let detail = if validation == 0 {
                std::io::Error::last_os_error().to_string()
            } else {
                "linked token is elevated".into()
            };
            return Err(startup::diagnostic(
                startup::PERMISSION,
                "linked-token-validation",
                detail,
            ));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_token_does_not_claim_standard_rights_are_unavailable() {
        let result = token_elevation_type(null_mut());
        assert!(result.is_err());
        assert_eq!(
            startup::report(startup::standard_token_failure(
                result,
                "linked query failed"
            )),
            startup::PERMISSION
        );
    }

    #[test]
    #[ignore = "Requires an isolated Windows environment with an elevated default token"]
    fn standard_launch_without_linked_token_fails_before_creating_host() {
        assert!(fstty_broker::windows::current_identity().unwrap().elevated);
        let mut token = null_mut();
        assert_ne!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
            0
        );
        let token = Handle(token);
        assert_eq!(
            token_elevation_type(token.0).unwrap(),
            TokenElevationTypeDefault
        );
        match launch(&uuid::Uuid::new_v4().to_string(), false) {
            Err(message) => assert_eq!(startup::report(message), startup::NO_STANDARD_TOKEN),
            Ok(_) => panic!("ordinary launch unexpectedly created a host"),
        }
    }
}
