use super::{files, Installation};
use crate::windows::wide;
use std::{
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows_sys::Win32::{Foundation::*, Security::*, System::Registry::*};

const PRODUCT: &str = r"Software\fengshi\FsTTY";
const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\FsTTY";
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUES: [&str; 7] = [
    "DisplayName",
    "Publisher",
    "DisplayVersion",
    "InstallLocation",
    "DisplayIcon",
    "UninstallString",
    "MainBinaryName",
];

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct Snapshot {
    product: Option<String>,
    uninstall: Vec<Option<String>>,
}
pub(super) fn snapshot() -> Snapshot {
    Snapshot {
        product: read(HKEY_LOCAL_MACHINE, PRODUCT, ""),
        uninstall: VALUES
            .iter()
            .map(|name| read(HKEY_LOCAL_MACHINE, UNINSTALL, name))
            .collect(),
    }
}
pub(super) fn restore(snapshot: &Snapshot) -> crate::Result<()> {
    if snapshot.uninstall.len() != VALUES.len() {
        return Err("安装登记备份无效".into());
    }
    for (path, name, old) in std::iter::once((PRODUCT, "", &snapshot.product)).chain(
        VALUES
            .iter()
            .zip(&snapshot.uninstall)
            .map(|(name, value)| (UNINSTALL, *name, value)),
    ) {
        if let Some(value) = old {
            write(HKEY_LOCAL_MACHINE, path, name, value)?;
        } else if let Ok(key) = open(HKEY_LOCAL_MACHINE, path, KEY_SET_VALUE, false) {
            let code = unsafe { RegDeleteValueW(key.0, wide(name).as_ptr()) };
            if code != ERROR_SUCCESS && code != ERROR_FILE_NOT_FOUND {
                return Err("无法恢复旧安装登记".into());
            }
        }
    }
    Ok(())
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn open(root: HKEY, path: &str, access: u32, create: bool) -> crate::Result<Key> {
    let mut raw = null_mut();
    let status = if create {
        unsafe {
            RegCreateKeyExW(
                root,
                wide(path).as_ptr(),
                0,
                null_mut(),
                0,
                access | KEY_WOW64_64KEY,
                std::ptr::null(),
                &mut raw,
                null_mut(),
            )
        }
    } else {
        unsafe {
            RegOpenKeyExW(
                root,
                wide(path).as_ptr(),
                0,
                access | KEY_WOW64_64KEY,
                &mut raw,
            )
        }
    };
    if status != ERROR_SUCCESS {
        return Err("无法访问安装登记".into());
    }
    Ok(Key(raw))
}
fn read(root: HKEY, path: &str, name: &str) -> Option<String> {
    let key = open(root, path, KEY_QUERY_VALUE, false).ok()?;
    let mut bytes = vec![0u16; 32768];
    let mut size = (bytes.len() * 2) as u32;
    let mut kind = 0;
    if unsafe {
        RegQueryValueExW(
            key.0,
            wide(name).as_ptr(),
            null_mut(),
            &mut kind,
            bytes.as_mut_ptr().cast(),
            &mut size,
        )
    } != ERROR_SUCCESS
        || kind != REG_SZ
        || size < 2
    {
        return None;
    }
    String::from_utf16(&bytes[..size as usize / 2 - 1]).ok()
}
fn write(root: HKEY, path: &str, name: &str, value: &str) -> crate::Result<()> {
    let key = open(root, path, KEY_SET_VALUE, true)?;
    let data = wide(value);
    if unsafe {
        RegSetValueExW(
            key.0,
            wide(name).as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    } != ERROR_SUCCESS
    {
        return Err("无法保存安装登记".into());
    }
    Ok(())
}

fn collect(root: HKEY, result: &mut Vec<PathBuf>) {
    for candidate in [
        read(root, PRODUCT, ""),
        read(root, UNINSTALL, "InstallLocation"),
    ]
    .into_iter()
    .flatten()
    {
        let path = PathBuf::from(candidate.trim_matches('"'));
        if files::validate_desktop_path(&path).is_ok()
            && files::product(&path.join("fstty.exe"))
                .is_ok_and(|(name, _)| name.eq_ignore_ascii_case("FsTTY"))
            && !result.iter().any(|p| files::same_path(p, &path))
        {
            result.push(path);
        }
    }
}

pub fn user_previous_directories() -> crate::Result<Vec<PathBuf>> {
    if crate::windows::current_identity()?.elevated {
        return Err("请以普通权限读取当前用户的旧安装登记".into());
    }
    let mut result = Vec::new();
    collect(HKEY_CURRENT_USER, &mut result);
    Ok(result)
}

pub(super) fn candidates(token: HANDLE) -> crate::Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    collect(HKEY_LOCAL_MACHINE, &mut result);
    if unsafe { ImpersonateLoggedOnUser(token) } == 0 {
        return Err("无法读取原用户的旧安装记录".into());
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
    let mut current = null_mut();
    if unsafe { RegOpenCurrentUser(KEY_READ, &mut current) } != ERROR_SUCCESS {
        return Err("无法打开原用户安装登记".into());
    }
    let current = Key(current);
    collect(current.0, &mut result);
    Ok(result)
}

pub(super) fn register(record: &Installation) -> crate::Result<()> {
    let directory = record.directory.to_string_lossy();
    write(HKEY_LOCAL_MACHINE, PRODUCT, "", &directory)?;
    for (name, value) in [
        ("DisplayName", "FsTTY".into()),
        ("Publisher", "fengshi".into()),
        ("DisplayVersion", record.version.clone()),
        ("InstallLocation", directory.into_owned()),
        (
            "DisplayIcon",
            record
                .directory
                .join("fstty.exe")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "UninstallString",
            format!(
                "\"{}\"",
                super::protected_directory()?
                    .join("uninstall.exe")
                    .display()
            ),
        ),
        ("MainBinaryName", "fstty.exe".into()),
    ] {
        write(HKEY_LOCAL_MACHINE, UNINSTALL, name, &value)?;
    }
    Ok(())
}
pub(super) fn unregister() -> crate::Result<()> {
    for path in [UNINSTALL, PRODUCT] {
        let parent = path.rsplit_once('\\').ok_or("注册表路径无效")?;
        if let Ok(key) = open(HKEY_LOCAL_MACHINE, parent.0, KEY_WRITE, false) {
            let code = unsafe { RegDeleteTreeW(key.0, wide(parent.1).as_ptr()) };
            if code != ERROR_SUCCESS && code != ERROR_FILE_NOT_FOUND {
                return Err("无法清理机器安装登记".into());
            }
        }
    }
    Ok(())
}

// 此函数只由普通用户桌面调用，绝不替另一管理员修改其用户配置。
pub fn repair_user_autostart(record: &Installation) -> crate::Result<()> {
    if crate::windows::current_identity()?.elevated {
        return Err("请以普通权限启动桌面以修复用户入口".into());
    }
    if let Some(command) = read(HKEY_CURRENT_USER, RUN, "FsTTY") {
        let next = record.directory.join("fstty.exe");
        if record
            .previous_directories
            .iter()
            .any(|p| is_exact_command(&command, &p.join("fstty.exe")))
        {
            write(
                HKEY_CURRENT_USER,
                RUN,
                "FsTTY",
                &format!("\"{}\"", next.display()),
            )?;
        } else if !is_exact_command(&command, &next) {
            return Err("开机启动使用自定义命令，请在设置中重新启用开机启动".into());
        }
    }
    Ok(())
}

pub fn cleanup_user_registration(record: &Installation) -> crate::Result<()> {
    if crate::windows::current_identity()?.elevated {
        return Err("请以普通权限清理当前用户的旧安装登记".into());
    }
    if let Some(old) = read(HKEY_CURRENT_USER, UNINSTALL, "InstallLocation") {
        if record
            .previous_directories
            .iter()
            .chain(std::iter::once(&record.directory))
            .any(|p| files::same_path(p, Path::new(old.trim_matches('"'))))
            && read(HKEY_CURRENT_USER, UNINSTALL, "DisplayName").as_deref() == Some("FsTTY")
        {
            let parent = open(
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                KEY_WRITE,
                false,
            )?;
            if unsafe { RegDeleteTreeW(parent.0, wide("FsTTY").as_ptr()) } != ERROR_SUCCESS {
                return Err("无法清理旧用户卸载登记".into());
            }
        }
    }
    Ok(())
}
fn is_exact_command(command: &str, path: &Path) -> bool {
    files::same_path(Path::new(command.trim_matches('"')), path)
}
