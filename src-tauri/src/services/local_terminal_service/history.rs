//! Native shell history profiles. Never collect command text in the GUI or logs.
use super::windows::{wide, Handle};
use crate::models::LocalShell;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    UI::Shell::*,
};

pub(super) struct Profile {
    pub path: PathBuf,
    _directories: Vec<Handle>,
    files: Vec<File>,
}

#[cfg(test)]
thread_local! {
    static FIXTURE_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn with_fixture_root<T>(root: &Path, run: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FIXTURE_ROOT.with(|value| value.replace(None));
        }
    }
    FIXTURE_ROOT.with(|value| value.replace(Some(root.to_path_buf())));
    let _reset = Reset;
    run()
}

fn partition(
    sid: &str,
    session: &str,
    shell: LocalShell,
    elevated: bool,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let id = uuid::Uuid::parse_str(session).map_err(|_| "invalid history configuration ID")?;
    Ok(format!(
        "{:x}/{id}/{shell:?}/{}",
        Sha256::digest(sid),
        if elevated {
            "administrator"
        } else {
            "standard"
        }
    ))
}

fn folder(kind: i32) -> Result<PathBuf, String> {
    let mut value = [0u16; 260];
    let result = unsafe { SHGetFolderPathW(null_mut(), kind, null_mut(), 0, value.as_mut_ptr()) };
    if result < 0 {
        return Err(format!(
            "history known-folder lookup failed HRESULT={result:#x}"
        ));
    }
    let end = value.iter().position(|v| *v == 0).unwrap_or(value.len());
    Ok(PathBuf::from(String::from_utf16_lossy(&value[..end])))
}

fn regular(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.is_dir() != directory
    {
        return Err("history path has an unexpected type or reparse point".into());
    }
    Ok(())
}

fn directory(path: &Path, sddl: &str) -> Result<Handle, String> {
    let expected = fstty_broker::windows::security_descriptor(sddl)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: expected.0,
        bInheritHandle: 0,
    };
    let name = wide(path);
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
    regular(path, true)?;
    let (mut owner, mut acl, mut actual) = (null_mut(), null_mut(), null_mut());
    let status = unsafe {
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
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "history directory ACL query: {}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    // Local owns and frees the descriptor returned by GetSecurityInfo.
    let actual = fstty_broker::windows::Local(actual);
    let (mut expected_owner, mut expected_acl) = (null_mut(), null_mut());
    let (mut present, mut defaulted) = (0, 0);
    let valid = unsafe {
        GetSecurityDescriptorOwner(expected.0, &mut expected_owner, &mut defaulted) != 0
            && GetSecurityDescriptorDacl(
                expected.0,
                &mut present,
                &mut expected_acl,
                &mut defaulted,
            ) != 0
            && !owner.is_null()
            && !acl.is_null()
            && EqualSid(owner, expected_owner) != 0
            && (*acl).AclSize == (*expected_acl).AclSize
            && std::slice::from_raw_parts(acl.cast::<u8>(), (*acl).AclSize as usize)
                == std::slice::from_raw_parts(
                    expected_acl.cast::<u8>(),
                    (*expected_acl).AclSize as usize,
                )
    };
    drop(actual);
    if !valid {
        return Err(
            "history directory permissions do not match its owner and privilege partition".into(),
        );
    }
    Ok(handle)
}

impl Profile {
    pub fn prepare(session: &str, shell: LocalShell, elevated: bool) -> Result<Self, String> {
        let identity = fstty_broker::windows::current_identity()?;
        if identity.elevated != elevated {
            return Err("history token privilege mismatch".into());
        }
        let suffix = partition(&identity.sid, session, shell, elevated)?;
        let parent = folder(if elevated {
            CSIDL_COMMON_APPDATA as i32
        } else {
            CSIDL_LOCAL_APPDATA as i32
        })?;
        #[cfg(test)]
        let parent = FIXTURE_ROOT
            .with(|value| value.borrow().clone())
            .unwrap_or(parent);
        for ancestor in parent.ancestors() {
            regular(ancestor, true)?;
        }
        let sddl = if elevated {
            "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)".into()
        } else {
            format!(
                "O:{0}G:{0}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;{0})",
                identity.sid
            )
        };
        let mut path = parent;
        let mut directories = Vec::new();
        for component in std::iter::once("FsTTYLocalHistory").chain(suffix.split('/')) {
            path.push(component);
            directories.push(directory(&path, &sddl)?);
        }
        // Profiles contain native data and our fixed settings, never executable scripts.
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            regular(&entry.path(), false)?;
            let file = OpenOptions::new()
                .read(true)
                // Query links without requesting data access: Clink can hold an
                // active session history file exclusively in another tab.
                .access_mode(0)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(entry.path())
                .map_err(|e| e.to_string())?;
            let mut information = unsafe { std::mem::zeroed() };
            use std::os::windows::io::AsRawHandle;
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            if information.nNumberOfLinks != 1 {
                return Err("history file has unexpected links".into());
            }
        }
        Ok(Self {
            path,
            _directories: directories,
            files: Vec::new(),
        })
    }

    pub fn install(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let path = self.path.join(name);
        // A first-launch writer excludes readers until the complete fixed file is synced.
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| e.to_string())?;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    || error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut file = None;
        for _ in 0..40 {
            match OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
            {
                Ok(value) => {
                    file = Some(value);
                    break;
                }
                Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {
                    std::thread::sleep(std::time::Duration::from_millis(25))
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        let mut file = file.ok_or("history settings initialization timed out")?;
        regular(&path, false)?;
        let mut actual = Vec::new();
        (&mut file)
            .take(bytes.len() as u64 + 1)
            .read_to_end(&mut actual)
            .map_err(|e| e.to_string())?;
        if actual != bytes {
            return Err("history fixed settings verification failed".into());
        }
        self.files.push(file);
        Ok(())
    }

    pub fn data_file(&self, name: &str) -> Result<PathBuf, String> {
        let path = self.path.join(name);
        let mut file = None;
        for _ in 0..40 {
            match OpenOptions::new()
                .append(true)
                .create(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
            {
                Ok(value) => {
                    file = Some(value);
                    break;
                }
                Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        let file = file.ok_or("history file remained busy (Windows error 32)")?;
        regular(&path, false)?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_files_survive_drop_and_allow_simultaneous_profiles_without_overwrite() {
        let root =
            std::env::temp_dir().join(format!("fstty-history-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let elevated = fstty_broker::windows::current_identity().unwrap().elevated;
        let id = uuid::Uuid::new_v4().to_string();
        with_fixture_root(&root, || {
            let mut first = Profile::prepare(&id, LocalShell::Cmd, elevated).unwrap();
            first
                .install("clink_settings", b"fixed fixture settings")
                .unwrap();
            let path = first.data_file("clink_history").unwrap();
            fs::write(&path, "echo 中文 & special\n").unwrap();
            // Clink's active per-process file may be exclusively open.
            let exclusive = OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(0)
                .open(first.path.join("active~"))
                .unwrap();
            let mut second = Profile::prepare(&id, LocalShell::Cmd, elevated).unwrap();
            second
                .install("clink_settings", b"fixed fixture settings")
                .unwrap();
            assert_eq!(second.path, first.path);
            assert!(second.install("clink_settings", b"changed").is_err());
            drop(exclusive);
            drop(first);
            drop(second);
            let reopened = Profile::prepare(&id, LocalShell::Cmd, elevated).unwrap();
            assert_eq!(
                fs::read_to_string(reopened.data_file("clink_history").unwrap()).unwrap(),
                "echo 中文 & special\n"
            );
            assert_ne!(
                reopened.path,
                Profile::prepare(&id, LocalShell::GitBash, elevated)
                    .unwrap()
                    .path
            );
            let powershell = Profile::prepare(&id, LocalShell::Powershell, elevated).unwrap();
            let native = powershell.data_file("powershell_history.txt").unwrap();
            let writer = OpenOptions::new()
                .write(true)
                .share_mode(FILE_SHARE_READ)
                .open(&native)
                .unwrap();
            let other_tab = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(100));
                drop(writer);
            });
            assert_eq!(
                powershell.data_file("powershell_history.txt").unwrap(),
                native
            );
            other_tab.join().unwrap();
        });
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_links_and_uncontrolled_existing_directory_without_removing_data() {
        let root =
            std::env::temp_dir().join(format!("fstty-history-links-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let elevated = fstty_broker::windows::current_identity().unwrap().elevated;
        let id = uuid::Uuid::new_v4().to_string();
        with_fixture_root(&root, || {
            let profile = Profile::prepare(&id, LocalShell::Cmd, elevated).unwrap();
            let path = profile.data_file("clink_history").unwrap();
            fs::write(&path, b"original").unwrap();
            let other = root.join("outside-link");
            fs::hard_link(&path, &other).unwrap();
            drop(profile);
            assert!(Profile::prepare(&id, LocalShell::Cmd, elevated).is_err());
            assert_eq!(fs::read(&other).unwrap(), b"original");
        });
        fs::remove_dir_all(&root).unwrap();
        fs::create_dir_all(root.join("FsTTYLocalHistory")).unwrap();
        with_fixture_root(&root, || {
            assert!(Profile::prepare(&id, LocalShell::Cmd, elevated).is_err())
        });
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profiles_are_stable_and_separate_user_configuration_shell_and_rights() {
        let id = uuid::Uuid::new_v4().to_string();
        let key = partition("S-1-5-21-1", &id, LocalShell::Cmd, false).unwrap();
        assert_eq!(
            key,
            partition("S-1-5-21-1", &id, LocalShell::Cmd, false).unwrap()
        );
        for other in [
            partition("S-1-5-21-2", &id, LocalShell::Cmd, false).unwrap(),
            partition(
                "S-1-5-21-1",
                &uuid::Uuid::new_v4().to_string(),
                LocalShell::Cmd,
                false,
            )
            .unwrap(),
            partition("S-1-5-21-1", &id, LocalShell::Powershell, false).unwrap(),
            partition("S-1-5-21-1", &id, LocalShell::Cmd, true).unwrap(),
        ] {
            assert_ne!(key, other);
        }
        assert!(partition("S-1-5-21-1", "../escape", LocalShell::Cmd, false).is_err());
    }
}
