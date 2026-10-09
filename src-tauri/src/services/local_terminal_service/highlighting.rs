#[cfg(windows)]
use crate::models::LocalShell;

pub(super) const POWERSHELL: &str = include_str!("highlight/powershell.ps1");
pub(super) const CLINK_LUA: &str = include_str!("highlight/clink.lua");
pub(super) const CLINK_SETTINGS: &str = include_str!("highlight/clink_settings");
#[cfg(windows)]
pub(super) const INPUTRC: &str = include_str!("highlight/inputrc");
pub(super) const CLINK_EXE: &[u8] =
    include_bytes!("../../../vendor/clink-1.9.34/bin/clink_x64.exe");
pub(super) const CLINK_DLL: &[u8] =
    include_bytes!("../../../vendor/clink-1.9.34/bin/clink_dll_x64.dll");

fn valid_token(token: &str) -> bool {
    uuid::Uuid::parse_str(token).is_ok()
}

// Read only our bounded startup markers. Never collect or log shell text.
pub(super) struct StageObserver {
    prefix: Vec<u8>,
    matched: usize,
    stage: Vec<u8>,
    collecting: bool,
    warned: bool,
}
impl StageObserver {
    pub(super) fn new(token: Option<&str>) -> Self {
        Self {
            prefix: token
                .filter(|value| valid_token(value))
                .map(|value| format!("\x1b]777;fstty-highlight:{value}:failed:").into_bytes())
                .unwrap_or_default(),
            matched: 0,
            stage: Vec::new(),
            collecting: false,
            warned: false,
        }
    }
    pub(super) fn observe(&mut self, bytes: &[u8]) -> Option<&'static str> {
        if self.prefix.is_empty() || self.warned {
            return None;
        }
        for &byte in bytes {
            if self.collecting {
                if byte == 7 {
                    let result = self.failure_stage();
                    self.stage.clear();
                    self.collecting = false;
                    if result.is_some() {
                        self.warned = true;
                        return result;
                    }
                } else if self.stage.len() < 32 && (byte.is_ascii_lowercase() || byte == b'-') {
                    self.stage.push(byte);
                } else {
                    self.stage.clear();
                    self.collecting = false;
                }
            } else if byte == self.prefix[self.matched] {
                self.matched += 1;
                if self.matched == self.prefix.len() {
                    self.matched = 0;
                    self.collecting = true;
                }
            } else {
                self.matched = usize::from(byte == self.prefix[0]);
            }
        }
        None
    }
    fn failure_stage(&self) -> Option<&'static str> {
        match self.stage.as_slice() {
            b"clink-inject" => Some("clink-inject"),
            b"custom-line-editor" => Some("custom-line-editor"),
            b"psreadline-import" => Some("psreadline-import"),
            b"psreadline-colors" => Some("psreadline-colors"),
            b"psreadline-security" => Some("psreadline-security"),
            b"psreadline-phases" => Some("psreadline-phases"),
            _ => None,
        }
    }
}

pub(super) fn powershell_arguments(token: &str, elevated: bool) -> Result<String, String> {
    use base64::Engine;
    if !valid_token(token) {
        return Err("invalid highlight token".into());
    }
    let script = POWERSHELL
        .replace("__TOKEN__", token)
        .replace("__ELEVATED__", if elevated { "$true" } else { "$false" });
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    Ok(format!(
        "-NoLogo -NoExit -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(windows)]
pub(super) use platform::prepare;

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::models::LocalHighlightInfo;
    use crate::services::local_terminal_service::windows::{wide, Handle};
    use std::{
        fs::{self, File, OpenOptions},
        io::{Read, Write},
        mem::size_of,
        os::windows::fs::{MetadataExt, OpenOptionsExt},
        path::PathBuf,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::*,
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
        UI::Shell::*,
    };

    pub(crate) struct Prepared {
        pub arguments: String,
        pub info: Option<LocalHighlightInfo>,
        _lease: Option<Lease>,
    }
    struct Lease {
        directory: PathBuf,
        files: Vec<File>,
        root: Option<Handle>,
    }
    impl Drop for Lease {
        fn drop(&mut self) {
            self.files.clear();
            // This directory is freshly created by this host, never a user path.
            if let Err(error) = fs::remove_dir_all(&self.directory) {
                log::warn!("local-highlight cleanup: {error}");
            }
            self.root.take();
        }
    }
    struct Descriptor(*mut core::ffi::c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn protected_root() -> Result<(PathBuf, Handle), String> {
        let mut directory = [0u16; 260];
        if unsafe {
            SHGetFolderPathW(
                null_mut(),
                CSIDL_COMMON_APPDATA as i32,
                null_mut(),
                0,
                directory.as_mut_ptr(),
            )
        } < 0
        {
            return Err("ProgramData lookup failed".into());
        }
        let end = directory
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(directory.len());
        let parent = PathBuf::from(String::from_utf16_lossy(&directory[..end]));
        if fs::symlink_metadata(&parent)
            .map_err(|e| e.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("ProgramData is a reparse point".into());
        }
        let root = parent.join("FsTTYClinkHost");
        let mut descriptor = null_mut();
        let sddl = wide("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let descriptor = Descriptor(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let name = wide(&root);
        if unsafe { CreateDirectoryW(name.as_ptr(), &attributes) } == 0
            && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let handle = Handle(unsafe {
            CreateFileW(
                name.as_ptr(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        });
        if handle.0 == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if fs::symlink_metadata(&root)
            .map_err(|e| e.to_string())?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("highlight root is a reparse point".into());
        }
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut actual = null_mut();
        if unsafe {
            GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut actual,
            )
        } != ERROR_SUCCESS
        {
            return Err("highlight root ACL query failed".into());
        }
        let _actual = Descriptor(actual);
        let mut expected_owner = null_mut();
        let mut expected_acl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        unsafe {
            if GetSecurityDescriptorOwner(descriptor.0, &mut expected_owner, &mut defaulted) == 0
                || GetSecurityDescriptorDacl(
                    descriptor.0,
                    &mut present,
                    &mut expected_acl,
                    &mut defaulted,
                ) == 0
                || owner.is_null()
                || acl.is_null()
                || EqualSid(owner, expected_owner) == 0
                || (*acl).AclSize != (*expected_acl).AclSize
                || std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize)
                    != std::slice::from_raw_parts(
                        expected_acl.cast::<u8>(),
                        (*expected_acl).AclSize as usize,
                    )
            {
                return Err("highlight root is not administrator protected".into());
            }
        }
        Ok((root, handle))
    }
    fn write_locked(lease: &mut Lease, name: &str, contents: &[u8]) -> Result<(), String> {
        let path = lease.directory.join(name);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_READ)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(contents)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut loaded = Vec::new();
        file.read_to_end(&mut loaded).map_err(|e| e.to_string())?;
        if loaded != contents {
            return Err("embedded component verification failed".into());
        }
        lease.files.push(file);
        Ok(())
    }
    fn clink(token: &str, elevated: bool) -> Result<Lease, String> {
        let (parent, root) = if elevated {
            let (path, handle) = protected_root()?;
            (path, Some(handle))
        } else {
            (std::env::temp_dir(), None)
        };
        let directory = parent.join(format!("fstty-clink-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let mut lease = Lease {
            directory,
            files: Vec::new(),
            root,
        };
        write_locked(&mut lease, "clink_x64.exe", CLINK_EXE)?;
        write_locked(&mut lease, "clink_dll_x64.dll", CLINK_DLL)?;
        let settings = format!(
            "{CLINK_SETTINGS}\nclink.path = {}\n",
            lease.directory.display()
        );
        write_locked(&mut lease, "clink_settings", settings.as_bytes())?;
        write_locked(&mut lease, ".inputrc", INPUTRC.as_bytes())?;
        write_locked(
            &mut lease,
            "fstty.lua",
            CLINK_LUA.replace("__TOKEN__", token).as_bytes(),
        )?;
        // ASCII batch contents plus Unicode environment expansion preserve non-ASCII paths.
        std::env::set_var("FSTTY_CLINK_EXE", lease.directory.join("clink_x64.exe"));
        std::env::set_var("FSTTY_CLINK_DIR", &lease.directory);
        std::env::set_var("FSTTY_CLINK_INIT", lease.directory.join("init.cmd"));
        let bootstrap = format!("@echo off\r\n\"%FSTTY_CLINK_EXE%\" inject --quiet --nolog --profile \"%FSTTY_CLINK_DIR%\" --scripts \"%FSTTY_CLINK_DIR%\"\r\nif errorlevel 2 echo \x1b]777;fstty-highlight:{token}:failed:clink-inject\x07\r\n@echo on\r\n");
        write_locked(&mut lease, "init.cmd", bootstrap.as_bytes())?;
        Ok(lease)
    }
    pub(crate) fn prepare(
        shell: LocalShell,
        native: &str,
        token: Option<&str>,
        elevated: bool,
    ) -> Prepared {
        let Some(token) = token else {
            return Prepared {
                arguments: native.into(),
                info: None,
                _lease: None,
            };
        };
        let result = if !valid_token(token) {
            Err("invalid highlight token".into())
        } else {
            match shell {
                LocalShell::Powershell => {
                    powershell_arguments(token, elevated).map(|arguments| (arguments, None))
                }
                LocalShell::Cmd => clink(token, elevated)
                    .map(|lease| ("/d /k \"%FSTTY_CLINK_INIT%\"".into(), Some(lease))),
                LocalShell::GitBash => {
                    return Prepared {
                        arguments: native.into(),
                        info: None,
                        _lease: None,
                    }
                }
            }
        };
        match result {
            Ok((arguments, lease)) => Prepared {
                arguments,
                info: Some(LocalHighlightInfo {
                    token: token.into(),
                    failed: false,
                }),
                _lease: lease,
            },
            Err(error) => {
                crate::logging::record_local_terminal_host_failure(&format!(
                    "local-highlight prepare shell={shell:?}: {error}"
                ));
                Prepared {
                    arguments: native.into(),
                    info: Some(LocalHighlightInfo {
                        token: token.into(),
                        failed: true,
                    }),
                    _lease: None,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    #[test]
    fn initialization_is_unicode_structured_and_does_not_change_policy_or_profiles() {
        let token = uuid::Uuid::new_v4().to_string();
        let args = powershell_arguments(&token, false).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(args.split_whitespace().last().unwrap())
            .unwrap();
        let decoded = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(decoded.contains(&token));
        assert!(!args.contains("ExecutionPolicy"));
        assert!(!args.contains("NoProfile"));
        assert!(decoded.contains("Parameters.ContainsKey('Colors')"));
        assert!(decoded.contains("-TokenKind"));
        assert!(decoded.contains("custom-line-editor"));
        assert!(!decoded.contains("Write-Output $line"));
        assert!(powershell_arguments("x'; Remove-Item", false).is_err());
    }
    #[test]
    fn startup_diagnostics_accept_only_nonce_and_known_stage_and_remain_bounded() {
        let token = uuid::Uuid::new_v4().to_string();
        let mut observer = StageObserver::new(Some(&token));
        assert_eq!(observer.observe(&vec![b'x'; 100000]), None);
        assert_eq!(observer.observe(b"password terminal output"), None);
        let message = format!("\x1b]777;fstty-highlight:{token}:failed:psreadline-import\x07");
        let mut results = Vec::new();
        for byte in message.bytes() {
            if let Some(stage) = observer.observe(&[byte]) {
                results.push(stage);
            }
        }
        assert_eq!(results, vec!["psreadline-import"]);
        assert_eq!(observer.observe(message.as_bytes()), None);
        assert!(observer.stage.is_empty());
        let mut other = StageObserver::new(Some(&uuid::Uuid::new_v4().to_string()));
        assert_eq!(other.observe(message.as_bytes()), None);
    }

    #[test]
    fn bundled_clink_hashes_and_isolation_defaults_are_pinned() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            format!("{:x}", Sha256::digest(CLINK_EXE)),
            "98972133fd6c9f357469ee39ccc85c20a5773d931d575a808c02317b64543be1"
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(CLINK_DLL)),
            "850af7f5ae83ccf09e17f663d032c060e82a5b968c35df14fdb2c97fe6f35d93"
        );
        assert!(CLINK_SETTINGS.contains("clink.autoupdate = off"));
        assert!(CLINK_SETTINGS.contains("history.save = False"));
        assert!(!CLINK_LUA.contains("onfilterinput"));
    }
}
