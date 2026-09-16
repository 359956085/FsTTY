use crate::windows::{wide, Handle};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::io::FromRawHandle,
    path::{Component, Path, PathBuf},
    ptr::null,
};
use windows_sys::Win32::{
    Foundation::*, Storage::FileSystem::*, System::SystemInformation::GetWindowsDirectoryW,
    UI::Shell::*,
};

use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as native},
    Win32::System::IO::IO_STATUS_BLOCK,
};

fn relative_entry(
    parent: HANDLE,
    name: &str,
    directory: bool,
    create: bool,
) -> crate::Result<Handle> {
    let mut name = wide(name);
    let mut unicode = UNICODE_STRING {
        Length: ((name.len() - 1) * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &mut unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null_mut(),
        SecurityQualityOfService: std::ptr::null_mut(),
    };
    let mut status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut raw = std::ptr::null_mut();
    let result = unsafe {
        native::NtCreateFile(
            &mut raw,
            FILE_READ_ATTRIBUTES | 0x00100000 | if directory { 0 } else { DELETE },
            &attributes,
            &mut status,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 },
            if directory {
                if create {
                    native::FILE_OPEN_IF
                } else {
                    native::FILE_OPEN
                }
            } else {
                native::FILE_CREATE
            },
            native::FILE_OPEN_REPARSE_POINT
                | native::FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    native::FILE_DIRECTORY_FILE
                } else {
                    native::FILE_NON_DIRECTORY_FILE | native::FILE_DELETE_ON_CLOSE
                },
            null(),
            0,
        )
    };
    if result < 0 {
        return Err(format!("无法锁定安装目录项（NTSTATUS {result:#x}）"));
    }
    Ok(Handle(raw))
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(
            b.to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\'),
        )
}

fn child_of(path: &Path, parent: &Path) -> bool {
    let path = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let parent = parent
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    path == parent || path.starts_with(&(parent + "\\"))
}

pub fn validate_desktop_path(path: &Path) -> crate::Result<()> {
    let text = path.to_str().ok_or("安装目录字符无效")?;
    if text.len() > 220
        || !path.is_absolute()
        || text
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '*' | '?'))
    {
        return Err("请选择完整的本地安装目录，长度不得超过 220 字节".into());
    }
    let bytes = text.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || text[2..].contains(':')
    {
        return Err("只能安装到本地固定磁盘的子目录".into());
    }
    if text.replace('/', "\\").split('\\').skip(1).any(|p| {
        p.is_empty()
            || p == "."
            || p == ".."
            || p.ends_with(['.', ' '])
            || matches!(
                p.split('.')
                    .next()
                    .unwrap_or("")
                    .to_ascii_uppercase()
                    .as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
    }) {
        return Err("安装目录含有不安全的路径片段".into());
    }
    if unsafe { GetDriveTypeW(wide(&text[..3]).as_ptr()) } != 3 {
        return Err("只能安装到本地固定磁盘".into());
    }
    let mut windows = vec![0u16; 32768];
    let n = unsafe { GetWindowsDirectoryW(windows.as_mut_ptr(), windows.len() as u32) } as usize;
    if n == 0 || n >= windows.len() {
        return Err("无法验证系统目录".into());
    }
    let system = PathBuf::from(String::from_utf16_lossy(&windows[..n]));
    let program_data = crate::windows::known_folder(&FOLDERID_ProgramData)?;
    let protected = super::protected_directory()?;
    if child_of(path, &system)
        || child_of(path, &program_data)
        || (child_of(path, &protected) && !same_path(path, &protected))
        || same_path(path, &crate::windows::known_folder(&FOLDERID_ProgramFiles)?)
        || same_path(path, &crate::windows::known_folder(&FOLDERID_Profile)?)
        || path.parent().is_some_and(|parent| {
            crate::windows::known_folder(&FOLDERID_UserProfiles)
                .is_ok_and(|profiles| same_path(parent, &profiles))
        })
    {
        return Err("不能安装到系统、用户根目录或受保护服务数据目录".into());
    }
    Ok(())
}

fn checked(handle: HANDLE, directory: bool) -> crate::Result<()> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (!directory
            && (info.nNumberOfLinks != 1 || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0))
    {
        return Err("安装路径不能包含重解析点、硬链接或类型不匹配的文件".into());
    }
    Ok(())
}

// 从磁盘根目录逐层持有不可删除的句柄，直到最后一次文件写入结束。
pub struct DirectoryLock {
    _handles: Vec<Handle>,
    _guard: Handle,
    pub path: PathBuf,
}
impl DirectoryLock {
    pub fn open(path: &Path, create: bool) -> crate::Result<Self> {
        validate_desktop_path(path)?;
        let mut current = PathBuf::new();
        let mut handles: Vec<Handle> = Vec::new();
        for component in path.components() {
            current.push(component);
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            if let Some(parent) = handles.last() {
                // 相对已验证句柄打开子目录，不重新解析可写父路径。
                let handle = relative_entry(
                    parent.0,
                    &component.as_os_str().to_string_lossy(),
                    true,
                    create,
                )?;
                checked(handle.0, true)?;
                handles.push(handle);
                continue;
            }
            let raw = unsafe {
                CreateFileW(
                    wide(&current.to_string_lossy()).as_ptr(),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    std::ptr::null_mut(),
                )
            };
            if raw == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "安装目录被占用或无法锁定：{}（Windows 错误 {}）",
                    current.display(),
                    unsafe { GetLastError() }
                ));
            }
            let handle = Handle(raw);
            checked(handle.0, true)?;
            handles.push(handle);
        }
        // 不可删除的哨兵保持末级目录非空，阻止将其改成重解析点。
        let guard = relative_entry(
            handles.last().ok_or("目录锁缺失")?.0,
            &format!(".fstty-directory-lock-{}", uuid::Uuid::new_v4()),
            false,
            true,
        )?;
        for handle in &handles {
            checked(handle.0, true)?;
        }
        Ok(Self {
            _handles: handles,
            _guard: guard,
            path: path.to_path_buf(),
        })
    }
    pub fn file(&self, name: &str) -> crate::Result<LockedFile<'_>> {
        self.open_file(name, false)
    }
    pub fn file_for_delete(&self, name: &str) -> crate::Result<LockedFile<'_>> {
        self.open_file(name, true)
    }
    fn open_file(&self, name: &str, delete: bool) -> crate::Result<LockedFile<'_>> {
        if !matches!(name, "fstty.exe" | "fstty-broker.exe" | "uninstall.exe") {
            return Err("未登记的安装文件".into());
        }
        let path = self.path.join(name);
        let raw = unsafe {
            CreateFileW(
                wide(&path.to_string_lossy()).as_ptr(),
                // 只读锁仍禁止外部改写与删除，且兼容系统版本资源读取器。
                GENERIC_READ | if delete { DELETE } else { 0 },
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
                return Ok(LockedFile {
                    file: None,
                    directory: self,
                    path,
                    existed: false,
                });
            }
            return Err(format!(
                "{} 被占用或无法安全打开，请退出旧程序后重试",
                path.display()
            ));
        }
        let handle = Handle(raw);
        checked(handle.0, false)?;
        let raw = handle.0;
        std::mem::forget(handle);
        Ok(LockedFile {
            file: Some(unsafe { File::from_raw_handle(raw) }),
            directory: self,
            path,
            existed: true,
        })
    }
}

pub struct LockedFile<'a> {
    file: Option<File>,
    directory: &'a DirectoryLock,
    path: PathBuf,
    pub existed: bool,
}
impl LockedFile<'_> {
    pub fn bytes(&mut self) -> crate::Result<Vec<u8>> {
        if self.file.is_none() && !self.existed {
            return Ok(Vec::new());
        }
        let file = self.file.as_mut().ok_or("目标文件已经关闭")?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| "无法读取旧程序")?;
        let mut data = Vec::new();
        file.take(512 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "无法读取旧程序")?;
        if data.len() > 512 * 1024 * 1024 {
            return Err("旧程序超过允许大小".into());
        }
        Ok(data)
    }
    pub fn replace(&mut self, bytes: &[u8]) -> crate::Result<()> {
        use std::os::windows::io::AsRawHandle;
        // Windows 允许给已打开的文件增加硬链接，因此绝不原地改写旧文件。
        let temporary = self
            .directory
            .path
            .join(format!(".fstty-install-{}.tmp", uuid::Uuid::new_v4()));
        let raw = unsafe {
            CreateFileW(
                wide(&temporary.to_string_lossy()).as_ptr(),
                GENERIC_READ | GENERIC_WRITE | DELETE,
                FILE_SHARE_READ,
                null(),
                CREATE_NEW,
                FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err("无法创建新的程序文件".into());
        }
        let mut replacement = unsafe { File::from_raw_handle(raw) };
        let result = (|| {
            replacement
                .write_all(bytes)
                .and_then(|_| replacement.sync_all())
                .map_err(|_| "无法写入新程序文件")?;
            let name = wide(&self.path.to_string_lossy());
            // Win32 转换绝对路径时会读取终止符；长度字段仍不包含终止符。
            let size = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
            let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
            unsafe {
                (*info).Anonymous.ReplaceIfExists = true;
                (*info).RootDirectory = std::ptr::null_mut();
                (*info).FileNameLength = ((name.len() - 1) * 2) as u32;
                std::ptr::copy_nonoverlapping(
                    name.as_ptr(),
                    (*info).FileName.as_mut_ptr(),
                    name.len(),
                );
            }
            drop(self.file.take());
            // 源文件由句柄指定，目标父目录全程锁定；替换只移除目录项，不写入旧硬链接对象。
            let result = unsafe {
                SetFileInformationByHandle(
                    replacement.as_raw_handle(),
                    FileRenameInfo,
                    info.cast(),
                    size as u32,
                )
            };
            if result == 0 {
                return Err(format!(
                    "程序文件原子替换失败（Windows 错误 {}），请保留恢复材料并重试",
                    unsafe { GetLastError() }
                ));
            }
            Ok(())
        })();
        if result.is_err() {
            let delete = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe {
                SetFileInformationByHandle(
                    replacement.as_raw_handle(),
                    FileDispositionInfo,
                    (&delete as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of_val(&delete) as u32,
                );
            }
        } else {
            self.file = Some(replacement);
        }
        result
    }
    pub fn delete(&mut self) -> crate::Result<()> {
        use std::os::windows::io::AsRawHandle;
        if self.file.is_none() && !self.existed {
            return Ok(());
        }
        let file = self.file.as_ref().ok_or("目标文件已经关闭")?;
        checked(file.as_raw_handle(), false)?;
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
        {
            return Err("无法删除已登记程序文件".into());
        }
        Ok(())
    }
}

pub fn create_public_directory(path: &Path) -> crate::Result<()> {
    let sd = crate::windows::security_descriptor(
        "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)",
    )?;
    let sa = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(&path.to_string_lossy()).as_ptr(), &sa) } == 0
        && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
    {
        return Err("无法创建受保护安装目录".into());
    }
    crate::paths::verify(path, "", false)
}

pub fn product(path: &Path) -> crate::Result<(String, String)> {
    let path = wide(&path.to_string_lossy());
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    if size == 0 || size > 1024 * 1024 {
        return Err("目录中存在无法识别的同名程序，拒绝覆盖".into());
    }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return Err("无法识别程序版本".into());
    }
    let query = |key: &str| -> crate::Result<String> {
        let mut value = std::ptr::null_mut();
        let mut len = 0;
        if unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                wide(key).as_ptr(),
                &mut value,
                &mut len,
            )
        } == 0
            || len == 0
        {
            return Err("程序版本信息缺失".into());
        }
        Ok(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(value.cast::<u16>(), len as usize - 1)
        }))
    };
    for translation in ["040904b0", "040904e4", "000004b0"] {
        if let (Ok(name), Ok(version)) = (
            query(&format!("\\StringFileInfo\\{translation}\\ProductName")),
            query(&format!("\\StringFileInfo\\{translation}\\ProductVersion")),
        ) {
            return Ok((name, version));
        }
    }
    Err("程序缺少可识别的产品信息".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 拒绝设备网络路径和目录穿越() {
        for path in [
            r"C:\",
            r"\\server\share\FsTTY",
            r"\\?\C:\Apps\FsTTY",
            r"C:\Apps\..\Windows",
            r"C:\Apps\name.",
            r"C:\Apps\CON",
            r"C:\Apps\a:stream",
        ] {
            assert!(validate_desktop_path(Path::new(path)).is_err(), "{path}");
        }
    }
    #[test]
    fn 路径比较忽略大小写但保留目录边界() {
        assert!(same_path(
            Path::new(r"D:\Apps\FsTTY"),
            Path::new("d:/apps/fstty")
        ));
        assert!(!child_of(
            Path::new(r"D:\Apps-other"),
            Path::new(r"D:\Apps")
        ));
    }

    #[test]
    fn 硬链接目标拒绝写入且不改变原文件() {
        let root =
            std::env::temp_dir().join(format!("fstty-install-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let original = root.join("original");
        std::fs::write(&original, b"keep").unwrap();
        std::fs::hard_link(&original, root.join("fstty.exe")).unwrap();
        let directory = DirectoryLock::open(&root, false).unwrap();
        assert!(directory.file("fstty.exe").is_err());
        assert_eq!(std::fs::read(&original).unwrap(), b"keep");
        drop(directory);
        std::fs::remove_file(root.join("fstty.exe")).unwrap();
        std::fs::remove_file(original).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn 持有目录时不能重命名父目录且文件占用不截断() {
        let root =
            std::env::temp_dir().join(format!("fstty-install-test-{}", uuid::Uuid::new_v4()));
        let target = root.join("desktop");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("fstty.exe"), b"old").unwrap();
        let directory = DirectoryLock::open(&target, false).unwrap();
        let mut executable = directory.file("fstty.exe").unwrap();
        assert!(std::fs::rename(&root, root.with_extension("moved")).is_err());
        assert!(directory.file_for_delete("fstty.exe").is_err());
        assert_eq!(executable.bytes().unwrap(), b"old");
        std::fs::hard_link(target.join("fstty.exe"), root.join("racing-link")).unwrap();
        executable.replace(b"new").unwrap();
        drop(executable);
        drop(directory);
        assert_eq!(std::fs::read(target.join("fstty.exe")).unwrap(), b"new");
        assert_eq!(std::fs::read(root.join("racing-link")).unwrap(), b"old");
        std::fs::remove_file(root.join("racing-link")).unwrap();
        std::fs::remove_file(target.join("fstty.exe")).unwrap();
        std::fs::remove_dir(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn 拒绝已有联接且锁定后不能将空目录变成联接() {
        fn junction(path: &Path, destination: &Path) -> bool {
            let handle = Handle(unsafe {
                CreateFileW(
                    wide(&path.to_string_lossy()).as_ptr(),
                    GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    std::ptr::null_mut(),
                )
            });
            assert_ne!(handle.0, INVALID_HANDLE_VALUE);
            let mut destination = wide(&format!("\\??\\{}", destination.display()));
            let length = ((destination.len() - 1) * 2) as u16;
            destination.push(0);
            let mut data = Vec::new();
            data.extend_from_slice(&0xa0000003u32.to_le_bytes());
            data.extend_from_slice(&(8 + destination.len() as u16 * 2).to_le_bytes());
            data.extend_from_slice(&0u16.to_le_bytes());
            for value in [0, length, length + 2, 0] {
                data.extend_from_slice(&value.to_le_bytes());
            }
            for value in destination {
                data.extend_from_slice(&value.to_le_bytes());
            }
            let mut returned = 0;
            unsafe {
                windows_sys::Win32::System::IO::DeviceIoControl(
                    handle.0,
                    0x900a4,
                    data.as_ptr().cast(),
                    data.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                ) != 0
            }
        }
        let root =
            std::env::temp_dir().join(format!("fstty-install-test-{}", uuid::Uuid::new_v4()));
        let target = root.join("desktop");
        let outside = root.join("outside");
        let existing = root.join("existing");
        for path in [&target, &outside, &existing] {
            std::fs::create_dir_all(path).unwrap();
        }
        assert!(junction(&existing, &outside));
        assert!(DirectoryLock::open(&existing, false).is_err());
        std::fs::remove_dir(existing).unwrap();
        let directory = DirectoryLock::open(&target, false).unwrap();
        let guard = std::fs::read_dir(&target)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(std::fs::remove_file(&guard).is_err());
        assert!(!junction(&target, &outside));
        drop(directory);
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
        for path in [target, outside, root] {
            std::fs::remove_dir(path).unwrap();
        }
    }

    #[test]
    fn 首次安装检查不创建空程序且支持随后提交() {
        let root =
            std::env::temp_dir().join(format!("fstty-install-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let directory = DirectoryLock::open(&root, false).unwrap();
        let mut executable = directory.file("fstty.exe").unwrap();
        assert!(!executable.existed);
        assert!(executable.bytes().unwrap().is_empty());
        assert!(!root.join("fstty.exe").exists());
        executable.replace(b"new").unwrap();
        drop(executable);
        drop(directory);
        assert_eq!(std::fs::read(root.join("fstty.exe")).unwrap(), b"new");
        std::fs::remove_file(root.join("fstty.exe")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn 不同长度中文目录支持连续原子覆盖() {
        let root =
            std::env::temp_dir().join(format!("fstty-install-test-{}", uuid::Uuid::new_v4()));
        for length in 0..8 {
            let path = root.join(format!("新版 桌面{}", "测".repeat(length)));
            let directory = DirectoryLock::open(&path, true).unwrap();
            for _ in 0..8 {
                let mut executable = directory.file("fstty.exe").unwrap();
                executable.replace(b"new").unwrap();
            }
            directory
                .file_for_delete("fstty.exe")
                .unwrap()
                .delete()
                .unwrap();
            drop(directory);
            std::fs::remove_dir(path).unwrap();
        }
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn 识别构建产物的产品与版本但不执行程序() {
        let executable = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/debug/fstty.exe");
        if executable.exists() {
            let (name, version) = product(&executable).unwrap();
            assert_eq!(name, "FsTTY");
            assert!(version.starts_with(env!("CARGO_PKG_VERSION")));
        }
    }

    #[test]
    fn 锁定旧程序仍可读取版本但不能改写或删除() {
        let mut system = vec![0u16; 32768];
        let length = unsafe { GetWindowsDirectoryW(system.as_mut_ptr(), system.len() as u32) };
        assert!(length > 0 && (length as usize) < system.len());
        let source = PathBuf::from(String::from_utf16_lossy(&system[..length as usize]))
            .join("System32/cmd.exe");
        let version_size = |path: &Path| unsafe {
            GetFileVersionInfoSizeW(wide(&path.to_string_lossy()).as_ptr(), std::ptr::null_mut())
        };
        let root =
            std::env::temp_dir().join(format!("fstty-install-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("fstty.exe");
        std::fs::copy(source, &path).unwrap();
        let expected = version_size(&path);
        assert!(expected > 0);
        let directory = DirectoryLock::open(&root, false).unwrap();
        let executable = directory.file("fstty.exe").unwrap();
        assert_eq!(version_size(&path), expected);
        let mut version = vec![0u8; expected as usize];
        assert_ne!(
            unsafe {
                GetFileVersionInfoW(
                    wide(&path.to_string_lossy()).as_ptr(),
                    0,
                    expected,
                    version.as_mut_ptr().cast(),
                )
            },
            0
        );
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::remove_file(&path).is_err());
        drop(executable);
        let mut executable = directory.file_for_delete("fstty.exe").unwrap();
        executable.delete().unwrap();
        drop(executable);
        drop(directory);
        assert!(!path.exists());
        std::fs::remove_dir(root).unwrap();
    }
}
