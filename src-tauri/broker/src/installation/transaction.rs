use super::{
    files::{self, DirectoryLock},
    registry, Installation,
};
use crate::windows;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    old: Option<Installation>,
    target: PathBuf,
    existing: [bool; 3],
    database: bool,
    registration: registry::Snapshot,
}
const NAMES: [&str; 3] = ["fstty.exe", "fstty-broker.exe", "uninstall.exe"];

fn authority() -> crate::Result<(PathBuf, File)> {
    if !windows::current_identity()?.elevated {
        return Err("安装操作需要管理员权限".into());
    }
    let root = super::protected_directory()?;
    files::create_public_directory(&root)?;
    let state = super::state_directory()?;
    files::create_public_directory(&state)?;
    crate::paths::verify_tree(&state, "", false)?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(state.join("operation.lock"))
        .map_err(|_| "无法打开安装锁")?;
    lock.try_lock_exclusive()
        .map_err(|_| "已有安装或卸载操作正在进行")?;
    Ok((state, lock))
}
fn atomic_json(path: &Path, value: &impl Serialize) -> crate::Result<()> {
    let temporary = path.with_extension("pending");
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法生成安装记录")?;
    let mut file = File::create(&temporary).map_err(|_| "无法暂存安装记录")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法保存安装记录")?;
    drop(file);
    // 受保护父目录保证临时文件不能被普通用户替换。
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            windows::wide(&temporary.to_string_lossy()).as_ptr(),
            windows::wide(&path.to_string_lossy()).as_ptr(),
            windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("无法提交安装记录".into());
    }
    Ok(())
}
fn backup(state: &Path, index: usize, bytes: &[u8]) -> crate::Result<()> {
    let mut file =
        File::create(state.join(format!("rollback-{index}.bin"))).map_err(|_| "无法备份旧程序")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法提交旧程序备份".into())
}
fn cleanup(state: &Path) -> crate::Result<()> {
    for name in [
        "transaction.json",
        "rollback-0.bin",
        "rollback-1.bin",
        "rollback-2.bin",
    ] {
        let path = state.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|_| "升级成功，但恢复材料清理失败，请重试修复安装")?;
        }
    }
    Ok(())
}
fn health() -> crate::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "无法检查服务状态")?;
    runtime.block_on(async {
        for _ in 0..50 {
            if matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    windows::request(&crate::protocol::Request::Status)
                )
                .await,
                Ok(Ok(crate::protocol::Response::Ready { version }))
                    if version == crate::protocol::VERSION
            ) {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Err("新服务未能通过协议健康检查".into())
    })
}
fn service_command(command: &str) -> crate::Result<()> {
    use std::os::windows::process::CommandExt;
    let exe = windows::installed_exe()?;
    crate::paths::verify(&exe, "", false)?;
    let status = std::process::Command::new(exe)
        .arg(command)
        .current_dir(super::protected_directory()?)
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .status()
        .map_err(|_| "无法启动受保护服务管理工具")?;
    if status.success() {
        Ok(())
    } else {
        Err("服务管理操作失败".into())
    }
}

fn recover_locked(state: &Path) -> crate::Result<()> {
    let path = state.join("transaction.json");
    if !path.exists() {
        return Ok(());
    }
    let journal: Journal =
        serde_json::from_slice(&fs::read(&path).map_err(|_| "无法读取恢复记录")?)
            .map_err(|_| "恢复记录损坏，请保留材料并修复安装")?;
    if let Some(old) = &journal.old {
        old.validate()?;
    }
    windows::stop(false)?;
    let desktop = DirectoryLock::open(&journal.target, false)?;
    let service = DirectoryLock::open(&super::protected_directory()?, false)?;
    for (index, name) in NAMES.iter().enumerate() {
        let directory = if index == 0 { &desktop } else { &service };
        if journal.existing[index] {
            let mut target = directory.file(name)?;
            target.replace(
                &fs::read(state.join(format!("rollback-{index}.bin")))
                    .map_err(|_| "缺少旧程序恢复材料")?,
            )?;
        } else {
            directory.file_for_delete(name)?.delete()?;
        }
    }
    if journal.existing[1] {
        service_command(if journal.database {
            "--restore-upgrade"
        } else {
            "--install"
        })?;
        health()?;
    } else {
        windows::stop(true)?;
    }
    if let Some(old) = journal.old {
        atomic_json(&state.join("active.json"), &old)?;
        registry::register(&old)?;
    } else {
        if state.join("active.json").exists() {
            fs::remove_file(state.join("active.json")).map_err(|_| "无法恢复旧安装状态")?;
        }
        registry::restore(&journal.registration)?;
    }
    cleanup(state)
}

pub fn recover() -> crate::Result<()> {
    let (state, _lock) = authority()?;
    recover_locked(&state)
}

pub fn deploy(directory: &Path, caller: u32, update: bool) -> crate::Result<()> {
    let (state, _lock) = authority()?;
    recover_locked(&state)?;
    let old = super::read()?;
    let caller_token = super::caller_token(caller)?;
    if update
        && old
            .as_ref()
            .is_none_or(|r| !files::same_path(&r.directory, directory))
    {
        return Err("在线更新必须使用已登记的有效安装目录".into());
    }
    let mut previous = super::candidates(caller)?;
    if let Some(record) = &old {
        previous.extend(record.previous_directories.clone());
    }
    previous.retain(|p| !files::same_path(p, directory));
    previous.dedup_by(|a, b| files::same_path(a, b));
    let source = std::env::current_exe().map_err(|_| "无法定位安装工具")?;
    let staging = source.parent().ok_or("安装暂存目录无效")?;
    crate::paths::verify(staging.parent().ok_or("暂存目录无效")?, "", false)?;
    crate::paths::verify_tree(staging, "", false)?;
    if files::same_path(staging, &super::protected_directory()?) {
        return Err("必须从安装包的独立受保护暂存目录部署".into());
    }
    let (product, version) = files::product(&staging.join("fstty.exe"))?;
    if product != "FsTTY" || !same_version(&version, env!("CARGO_PKG_VERSION")) {
        return Err("桌面与服务安装包版本不匹配".into());
    }
    if let Some(old) = &old {
        if version_numbers(&old.version)? > version_numbers(env!("CARGO_PKG_VERSION"))? {
            return Err("已安装版本更新，拒绝降级".into());
        }
    }
    let payloads = NAMES
        .iter()
        .map(|name| fs::read(staging.join(name)).map_err(|_| "安装包文件不完整".to_owned()))
        .collect::<crate::Result<Vec<_>>>()?;
    if payloads
        .iter()
        .any(|data| data.len() < 2 || &data[..2] != b"MZ")
    {
        return Err("安装包程序格式无效".into());
    }
    let desktop = DirectoryLock::open(directory, true)?;
    if directory.join("fstty.exe").exists() {
        let (name, old_version) = files::product(&directory.join("fstty.exe"))?;
        if !name.eq_ignore_ascii_case("FsTTY") {
            return Err("存在其他产品的 fstty.exe，拒绝覆盖".into());
        }
        if version_numbers(&old_version)? > version_numbers(env!("CARGO_PKG_VERSION"))? {
            return Err("目标目录中的版本更新，拒绝降级".into());
        }
    }
    let mut close_paths = previous.clone();
    close_paths.push(directory.to_path_buf());
    close_desktops(&close_paths)?;
    let service = DirectoryLock::open(&super::protected_directory()?, false)?;
    let mut application = desktop.file("fstty.exe")?;
    if application.existed {
        let (name, _) = files::product(&directory.join("fstty.exe"))?;
        if !name.eq_ignore_ascii_case("FsTTY") {
            return Err("存在其他产品的 fstty.exe，拒绝覆盖".into());
        }
    }
    let database = windows::data_dir()?.join("credentials.v1.db").exists();
    let was_running = windows::service_pid().is_ok();
    windows::prepare_upgrade()?;
    let result = (|| {
        let mut broker = service.file("fstty-broker.exe")?;
        let mut uninstaller = service.file("uninstall.exe")?;
        let mut targets = [&mut application, &mut broker, &mut uninstaller];
        let existing = [targets[0].existed, targets[1].existed, targets[2].existed];
        for (index, target) in targets.iter_mut().enumerate() {
            backup(&state, index, &target.bytes()?)?;
        }
        atomic_json(
            &state.join("transaction.json"),
            &Journal {
                old: old.clone(),
                target: directory.to_path_buf(),
                existing,
                database,
                registration: registry::snapshot(),
            },
        )?;
        for (target, payload) in targets.iter_mut().zip(&payloads) {
            target.replace(payload)?;
        }
        drop(broker);
        drop(uninstaller);
        service_command("--install")?;
        health()?;
        let record = Installation {
            schema: 1,
            directory: directory.to_path_buf(),
            version: env!("CARGO_PKG_VERSION").into(),
            sha256: format!("{:x}", Sha256::digest(&payloads[0])),
            generation: uuid::Uuid::new_v4().to_string(),
            files: vec!["fstty.exe".into()],
            previous_directories: previous,
        };
        record.validate()?;
        registry::register(&record)?;
        atomic_json(&state.join("active.json"), &record)?;
        Ok(())
    })();
    drop(application);
    drop(desktop);
    if let Err(error) = result {
        if state.join("transaction.json").exists() {
            recover_locked(&state).map_err(|restore| {
                format!("{error}；自动恢复失败：{restore}。恢复材料已保留，请重新运行安装包。")
            })?;
        } else if was_running {
            windows::resume_upgrade()?;
        }
        return Err(error);
    }
    // 清理失败不回滚已经通过验证并提交的安装。
    cleanup(&state)?;
    if update {
        super::launch_with_token(&super::read()?.ok_or("缺少安装记录")?, &caller_token)?;
    }
    Ok(())
}

pub fn uninstall() -> crate::Result<()> {
    let (state, _lock) = authority()?;
    recover_locked(&state)?;
    let record = super::read()?.ok_or("没有有效安装记录，拒绝猜测卸载目标")?;
    close_desktops(std::slice::from_ref(&record.directory))?;
    let desktop = DirectoryLock::open(&record.directory, false)?;
    let mut app = desktop.file_for_delete("fstty.exe")?;
    windows::stop(true)?;
    app.delete()?;
    registry::unregister()?;
    fs::remove_file(state.join("active.json")).map_err(|_| "无法清理有效安装记录")?;
    Ok(())
}

fn version_numbers(version: &str) -> crate::Result<Vec<u32>> {
    let mut parts = version
        .split('.')
        .map(|s| s.parse::<u32>().map_err(|_| "程序版本格式无效".to_owned()))
        .collect::<crate::Result<Vec<_>>>()?;
    if parts.len() < 3 || parts.len() > 4 {
        return Err("程序版本格式无效".into());
    }
    parts.resize(4, 0);
    Ok(parts)
}
fn same_version(a: &str, b: &str) -> bool {
    matches!((version_numbers(a), version_numbers(b)), (Ok(a), Ok(b)) if a == b)
}

pub fn close_desktops(directories: &[PathBuf]) -> crate::Result<()> {
    use windows_sys::Win32::{
        Foundation::*,
        System::{Diagnostics::ToolHelp::*, Threading::*},
        UI::WindowsAndMessaging::*,
    };
    let snapshot = windows::Handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) });
    if snapshot.0 == INVALID_HANDLE_VALUE {
        return Err("无法检查运行中的桌面进程".into());
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    let mut processes = Vec::new();
    while more {
        let process = windows::Handle(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | 0x00100000,
                0,
                entry.th32ProcessID,
            )
        });
        if !process.0.is_null() {
            let mut path = vec![0u16; 32768];
            let mut count = path.len() as u32;
            if unsafe { QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut count) }
                != 0
            {
                let path = PathBuf::from(String::from_utf16_lossy(&path[..count as usize]));
                if directories
                    .iter()
                    .any(|directory| files::same_path(&directory.join("fstty.exe"), &path))
                {
                    processes.push(process);
                }
            }
        }
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    if !processes.is_empty()
        && unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                windows::wide(
                    "继续将关闭旧 FsTTY，正在进行的 SSH 连接和传输任务会中断。是否继续？",
                )
                .as_ptr(),
                windows::wide("FsTTY 安装确认").as_ptr(),
                MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
            )
        } != IDOK
    {
        return Err("用户取消关闭旧桌面，安装未继续".into());
    }
    for process in processes {
        if unsafe { TerminateProcess(process.0, 0) } == 0
            || unsafe { WaitForSingleObject(process.0, 10000) } != WAIT_OBJECT_0
        {
            return Err("旧桌面未能退出，安装已停止".into());
        }
    }
    Ok(())
}
