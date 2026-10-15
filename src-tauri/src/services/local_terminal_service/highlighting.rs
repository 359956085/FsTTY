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
    pub(super) fn history(token: Option<&str>) -> Self {
        let mut observer = Self::new(None);
        observer.prefix = token
            .filter(|v| valid_token(v))
            .map(|v| format!("\x1b]777;fstty-history:{v}:").into_bytes())
            .unwrap_or_default();
        observer
    }
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
            b"failed" => Some("history-initialization"),
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

pub(super) fn powershell_arguments(
    token: Option<&str>,
    elevated: bool,
    history: Option<&std::path::Path>,
    history_token: Option<&str>,
    command_token: Option<&str>,
) -> Result<String, String> {
    use base64::Engine;
    if token.is_some_and(|v| !valid_token(v))
        || history_token.is_some_and(|v| !valid_token(v))
        || command_token.is_some_and(|v| !valid_token(v))
    {
        return Err("invalid highlight token".into());
    }
    let script = POWERSHELL
        .replace("__TOKEN__", token.unwrap_or_default())
        .replace("__HISTORY_TOKEN__", history_token.unwrap_or_default())
        .replace("__COMMAND_TOKEN__", command_token.unwrap_or_default())
        .replace(
            "__HISTORY_PATH__",
            &base64::engine::general_purpose::STANDARD.encode(
                history
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .as_bytes(),
            ),
        )
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
    use crate::models::{LocalHighlightInfo, LocalHistoryInfo};
    use crate::services::local_terminal_service::history::Profile;
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
        pub history: Option<LocalHistoryInfo>,
        pub commands_failed: bool,
        _lease: Option<Lease>,
        _profile: Option<Profile>,
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
    fn lease(elevated: bool) -> Result<Lease, String> {
        let (parent, root) = if elevated {
            let (path, handle) = protected_root()?;
            (path, Some(handle))
        } else {
            (std::env::temp_dir(), None)
        };
        let directory = parent.join(format!("fstty-clink-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        Ok(Lease {
            directory,
            files: Vec::new(),
            root,
        })
    }
    fn clink(
        token: Option<&str>,
        history_token: Option<&str>,
        elevated: bool,
        profile: Option<&Profile>,
        command_token: Option<&str>,
    ) -> Result<Lease, String> {
        let mut lease = lease(elevated)?;
        write_locked(&mut lease, "clink_x64.exe", CLINK_EXE)?;
        write_locked(&mut lease, "clink_dll_x64.dll", CLINK_DLL)?;
        let settings = CLINK_SETTINGS.replace("history.save = True", "history.save = False");
        write_locked(&mut lease, "clink_settings", settings.as_bytes())?;
        write_locked(&mut lease, ".inputrc", INPUTRC.as_bytes())?;
        write_locked(
            &mut lease,
            "fstty.lua",
            CLINK_LUA
                .replace("__TOKEN__", token.unwrap_or_default())
                .replace("__HISTORY_TOKEN__", history_token.unwrap_or_default())
                .replace("__COMMAND_TOKEN__", command_token.unwrap_or_default())
                .as_bytes(),
        )?;
        // ASCII batch contents plus Unicode environment expansion preserve non-ASCII paths.
        std::env::set_var("FSTTY_CLINK_EXE", lease.directory.join("clink_x64.exe"));
        std::env::set_var("FSTTY_CLINK_DIR", &lease.directory);
        std::env::set_var(
            "FSTTY_CLINK_PROFILE",
            profile
                .map(|v| v.path.as_path())
                .unwrap_or(&lease.directory),
        );
        std::env::set_var("CLINK_INPUTRC", lease.directory.join(".inputrc"));
        std::env::set_var("FSTTY_CLINK_INIT", lease.directory.join("init.cmd"));
        let warning = format!(
            "{}{}{}",
            command_token
                .map(|t| format!("\x1b]777;fstty-global:{t}:unavailable\x07"))
                .unwrap_or_default(),
            token
                .map(|t| format!("\x1b]777;fstty-highlight:{t}:failed:clink-inject\x07"))
                .unwrap_or_default(),
            history_token
                .map(|t| format!("\x1b]777;fstty-history:{t}:failed\x07"))
                .unwrap_or_default()
        );
        let bootstrap = format!("@echo off\r\n\"%FSTTY_CLINK_EXE%\" inject --quiet --nolog --profile \"%FSTTY_CLINK_PROFILE%\" --scripts \"%FSTTY_CLINK_DIR%\"\r\nif errorlevel 2 echo {warning}\r\n@echo on\r\n");
        write_locked(&mut lease, "init.cmd", bootstrap.as_bytes())?;
        Ok(lease)
    }
    pub(crate) fn prepare(
        shell: LocalShell,
        native: &str,
        token: Option<&str>,
        elevated: bool,
        session: Option<&str>,
        history_token: Option<&str>,
        command_token: Option<&str>,
    ) -> Prepared {
        let mut profile = session.and_then(|id| {
            match Profile::prepare(id, shell, elevated).and_then(|mut profile| {
                if shell == LocalShell::Cmd {
                    profile.install("clink_settings", CLINK_SETTINGS.as_bytes())?;
                    profile.install(".inputrc", INPUTRC.as_bytes())?;
                }
                profile.data_file(match shell {
                    LocalShell::Cmd => "clink_history",
                    LocalShell::Powershell => "powershell_history.txt",
                    LocalShell::GitBash => "bash_history",
                })?;
                Ok(profile)
            }) {
                Ok(profile) => Some(profile),
                Err(error) => {
                    crate::logging::record_local_terminal_host_failure(&format!(
                        "local-history prepare shell={shell:?}: {error}"
                    ));
                    None
                }
            }
        });
        let history_path = profile.as_ref().map(|v| {
            v.path.join(match shell {
                LocalShell::Cmd => "clink_history",
                LocalShell::Powershell => "powershell_history.txt",
                LocalShell::GitBash => "bash_history",
            })
        });
        let mut history = history_token.map(|t| LocalHistoryInfo {
            token: t.into(),
            persistent: profile.is_some(),
        });
        let result = if token.is_some_and(|v| !valid_token(v))
            || history_token.is_some_and(|v| !valid_token(v))
            || command_token.is_some_and(|v| !valid_token(v))
        {
            Err("invalid highlight token".into())
        } else {
            match shell {
                LocalShell::Powershell => powershell_arguments(
                    token,
                    elevated,
                    history_path.as_deref(),
                    history_token,
                    command_token,
                )
                .map(|arguments| (arguments, None)),
                LocalShell::Cmd => clink(
                    token,
                    history_token,
                    elevated,
                    profile.as_ref(),
                    command_token,
                )
                .map(|lease| ("/d /k \"%FSTTY_CLINK_INIT%\"".into(), Some(lease))),
                LocalShell::GitBash => {
                    lease(elevated).and_then(|mut lease| {
                        // Encode paths as data, never as user command text.
                        let path = history_path
                            .as_ref()
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .unwrap_or_default();
                        let quoted = format!("'{}'", path.replace('\'', "'\\''"));
                        let script = include_str!("highlight/bash.sh")
                            .replace("__HISTORY_TOKEN__", history_token.unwrap_or_default())
                            .replace("__COMMAND_TOKEN__", command_token.unwrap_or_default())
                            .replace("__HISTORY_PATH__", &quoted);
                        write_locked(&mut lease, "history.sh", script.as_bytes())?;
                        let arguments = format!(
                            "--noprofile --rcfile {} -i",
                            super::super::windows::quote(&lease.directory.join("history.sh"))
                        );
                        Ok((arguments, Some(lease)))
                    })
                }
            }
        };
        match result {
            Ok((arguments, lease)) => Prepared {
                arguments,
                commands_failed: false,
                info: token.map(|token| LocalHighlightInfo {
                    token: token.into(),
                    failed: false,
                }),
                history,
                _lease: lease,
                _profile: profile,
            },
            Err(error) => {
                crate::logging::record_local_terminal_host_failure(&format!(
                    "local-shell initialization shell={shell:?}: {error}"
                ));
                if let Some(history) = &mut history {
                    history.persistent = false;
                }
                profile.take();
                let arguments = if shell == LocalShell::GitBash {
                    // If the controlled rc file cannot be created, do not let
                    // Bash open or overwrite the external terminal's history.
                    std::env::set_var("HISTFILE", "");
                    "--noprofile --norc -i".into()
                } else {
                    native.into()
                };
                Prepared {
                    arguments,
                    commands_failed: command_token.is_some(),
                    info: token.map(|token| LocalHighlightInfo {
                        token: token.into(),
                        failed: true,
                    }),
                    history,
                    _lease: None,
                    _profile: None,
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
        let args = powershell_arguments(Some(&token), false, None, None, None).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(args.split_whitespace().last().unwrap())
            .unwrap();
        let (code_units, remainder) = bytes.as_chunks::<2>();
        assert!(
            remainder.is_empty(),
            "UTF-16 input must contain complete code units"
        );
        let decoded = String::from_utf16(
            &code_units
                .iter()
                .map(|v| u16::from_le_bytes(*v))
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
        assert!(powershell_arguments(Some("x'; Remove-Item"), false, None, None, None).is_err());
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
    fn history_diagnostics_are_independent_bounded_nonce_checked_and_once_only() {
        let token = uuid::Uuid::new_v4().to_string();
        let mut observer = StageObserver::history(Some(&token));
        assert_eq!(
            observer.observe(
                format!("\x1b]777;fstty-history:{token}:{}\x07", "x".repeat(100000)).as_bytes()
            ),
            None
        );
        assert_eq!(
            observer.observe(
                format!("\x1b]777;fstty-history:{}:failed\x07", uuid::Uuid::new_v4()).as_bytes()
            ),
            None
        );
        let message = format!("\x1b]777;fstty-history:{token}:failed\x07");
        let found: Vec<_> = message
            .bytes()
            .filter_map(|byte| observer.observe(&[byte]))
            .collect();
        assert_eq!(found, ["history-initialization"]);
        assert_eq!(observer.observe(message.as_bytes()), None);
        assert!(observer.stage.is_empty());
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
        assert!(CLINK_SETTINGS.contains("history.save = True"));
        assert!(CLINK_SETTINGS.contains("history.shared = True"));
        assert!(!CLINK_LUA.contains("onfilterinput"));
    }
}
