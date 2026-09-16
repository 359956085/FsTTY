use serde::Serialize;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationStatus {
    pub directory: Option<String>,
    pub issues: Vec<String>,
    pub restart_agent: bool,
}
static STATUS: std::sync::Mutex<InstallationStatus> = std::sync::Mutex::new(InstallationStatus {
    directory: None,
    issues: Vec::new(),
    restart_agent: false,
});
pub fn status() -> InstallationStatus {
    STATUS.lock().map(|s| s.clone()).unwrap_or_default()
}

pub fn repair(app_data: &std::path::Path) -> InstallationStatus {
    repair_impl(app_data, false)
}
pub fn retry(app_data: &std::path::Path) -> InstallationStatus {
    repair_impl(app_data, true)
}
fn repair_impl(app_data: &std::path::Path, force: bool) -> InstallationStatus {
    let Ok(mut cached) = STATUS.lock() else {
        return InstallationStatus::default();
    };
    #[cfg(windows)]
    {
        let result = repair_windows(app_data, force);
        *cached = result.clone();
        result
    }
    #[cfg(not(windows))]
    {
        let _ = (app_data, force);
        *cached = InstallationStatus::default();
        cached.clone()
    }
}

#[cfg(windows)]
fn repair_windows(app_data: &std::path::Path, force: bool) -> InstallationStatus {
    let mut result = InstallationStatus::default();
    let mut record = match std::env::current_exe()
        .map_err(|_| "无法定位当前程序".to_owned())
        .and_then(|exe| fstty_broker::installation::check_desktop(&exe))
    {
        Ok(Some(record)) => record,
        Ok(None) => return result,
        Err(error) => {
            result.issues.push(error);
            return result;
        }
    };
    result.directory = Some(record.directory.display().to_string());
    let marker = app_data.join("installation-generation");
    if !force
        && std::fs::read_to_string(&marker).is_ok_and(|generation| generation == record.generation)
    {
        return result;
    }
    match fstty_broker::installation::user_previous_directories() {
        Ok(previous) => {
            for path in previous {
                if !fstty_broker::installation::same_path(&path, &record.directory)
                    && !record
                        .previous_directories
                        .iter()
                        .any(|old| fstty_broker::installation::same_path(old, &path))
                {
                    record.previous_directories.push(path);
                }
            }
        }
        Err(error) => result.issues.push(error),
    }
    if let Err(error) = fstty_broker::installation::repair_user_autostart(&record) {
        result.issues.push(error);
    }
    if let Err(error) = repair_shortcuts(&record) {
        result.issues.push(error);
    }
    match crate::mcp_runtime::prepare(app_data, &record.directory.join("fstty.exe")) {
        Ok(_) => result.restart_agent = true,
        Err(error) => result.issues.push(error),
    }
    result
        .issues
        .extend(crate::local_agent_setup::repair_installation_paths(
            &record.previous_directories,
            &record.directory,
        ));
    if result.issues.is_empty() {
        if let Err(error) = fstty_broker::installation::cleanup_user_registration(&record) {
            result.issues.push(error);
        }
    }
    if result.issues.is_empty() {
        if let Err(error) = std::fs::write(marker, &record.generation) {
            result.issues.push(format!("无法保存入口修复状态：{error}"));
        }
    }
    result
}

#[cfg(windows)]
fn repair_shortcuts(record: &fstty_broker::installation::Installation) -> Result<(), String> {
    use windows::{
        core::{Interface, PCWSTR, PWSTR},
        Win32::{System::Com::*, UI::Shell::*},
    };
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "无法初始化快捷方式修复")?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        for folder in [&FOLDERID_Desktop, &FOLDERID_Programs] {
            let known = SHGetKnownFolderPath(folder, KF_FLAG_DEFAULT, None)
                .map_err(|_| "无法定位用户快捷方式")?;
            let directory = known.to_string().map_err(|_| "快捷方式目录字符无效");
            CoTaskMemFree(Some(known.0.cast()));
            let directory = std::path::PathBuf::from(directory?);
            for shortcut in [
                directory.join("FsTTY.lnk"),
                directory.join("FsTTY").join("FsTTY.lnk"),
            ] {
                if !shortcut.exists() {
                    continue;
                }
                let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| "无法打开快捷方式")?;
                let file: IPersistFile = shell.cast().map_err(|_| "无法读取快捷方式")?;
                let path = fstty_broker::windows::wide(&shortcut.to_string_lossy());
                file.Load(PCWSTR(path.as_ptr()), STGM_READWRITE)
                    .map_err(|_| "无法读取用户快捷方式")?;
                let mut target = [0u16; 32768];
                shell
                    .GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                    .map_err(|_| "无法读取快捷方式目标")?;
                let target = PWSTR(target.as_mut_ptr())
                    .to_string()
                    .map_err(|_| "快捷方式目标无效")?;
                if record.previous_directories.iter().any(|old| {
                    fstty_broker::installation::same_path(
                        &old.join("fstty.exe"),
                        std::path::Path::new(&target),
                    )
                }) {
                    let next = fstty_broker::windows::wide(
                        &record.directory.join("fstty.exe").to_string_lossy(),
                    );
                    shell
                        .SetPath(PCWSTR(next.as_ptr()))
                        .map_err(|_| "无法更新快捷方式目标")?;
                    let working = fstty_broker::windows::wide(&record.directory.to_string_lossy());
                    shell
                        .SetWorkingDirectory(PCWSTR(working.as_ptr()))
                        .map_err(|_| "无法更新快捷方式目录")?;
                    file.Save(PCWSTR(path.as_ptr()), true)
                        .map_err(|_| "无法保存快捷方式")?;
                }
            }
        }
    }
    Ok(())
}
