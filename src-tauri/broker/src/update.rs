use crate::{
    paths,
    protocol::{self, Request, Response},
    windows,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    os::windows::fs::OpenOptionsExt,
    path::Path,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use windows_sys::Win32::{Storage::FileSystem::*, UI::WindowsAndMessaging::*};

const MAX_INSTALLER: u64 = 256 * 1024 * 1024;
static UPLOAD: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct Manifest {
    ticket: String,
    owner: String,
    signature: String,
    expires: u64,
    #[serde(default)]
    caller_pid: u32,
}
fn now() -> crate::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| "系统时间无效".into())
}

fn verify(bytes: &[u8], signature: &str) -> crate::Result<()> {
    verify_with_key(bytes, signature, env!("FSTTY_RELEASE_PUBLIC_KEY"))
}

fn verify_with_key(bytes: &[u8], signature: &str, key: &str) -> crate::Result<()> {
    let decode = |value: &str| -> crate::Result<String> {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(|_| "发布签名编码无效")?,
        )
        .map_err(|_| "发布签名编码无效".into())
    };
    if key.is_empty() {
        return Err("此构建没有发布验证公钥，请使用官方安装程序更新".into());
    }
    let key = minisign_verify::PublicKey::decode(&decode(key)?).map_err(|_| "发布公钥无效")?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|_| "发布签名无效")?;
    key.verify(bytes, &signature, false)
        .map_err(|_| "更新包发布签名验证失败".into())
}

pub async fn receive(
    pipe: &mut tokio::net::windows::named_pipe::NamedPipeServer,
    owner: &str,
    size: u64,
    signature: String,
) -> crate::Result<()> {
    if size == 0 || size > MAX_INSTALLER || signature.len() > 4096 {
        return Err("更新包超过大小限制".into());
    }
    let _guard = UPLOAD
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .try_lock()
        .map_err(|_| "已有更新正在暂存")?;
    let dir = windows::data_dir()?.join("update");
    let sid = windows::service_sid()?;
    if !dir.exists() {
        std::fs::create_dir(&dir).map_err(|_| "无法创建更新暂存目录")?;
    }
    paths::verify_tree(&dir, &sid, true)?;
    let metadata = dir.join("manifest.json");
    if metadata.exists() {
        let previous: Manifest =
            serde_json::from_slice(&std::fs::read(&metadata).map_err(|_| "无法读取更新状态")?)
                .map_err(|_| "更新状态损坏")?;
        if previous.expires > now()? {
            return Err("已有待确认更新，请完成更新或五分钟后重试".into());
        }
    }
    for name in ["installer.exe", "claimed", "manifest.json"] {
        let path = dir.join(name);
        if path.exists() {
            std::fs::remove_file(path).map_err(|_| "更新正在安装，请稍后重试")?;
        }
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    use std::os::windows::io::AsRawHandle;
    let mut caller_pid = 0;
    if unsafe {
        windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
            pipe.as_raw_handle(),
            &mut caller_pid,
        )
    } == 0
    {
        return Err("无法保留更新调用者身份".into());
    }
    let manifest = Manifest {
        ticket: ticket.clone(),
        owner: owner.into(),
        signature,
        expires: now()? + 300,
        caller_pid,
    };
    std::fs::write(
        &metadata,
        serde_json::to_vec(&manifest).map_err(|_| "无法保存更新状态")?,
    )
    .map_err(|_| "无法保存更新状态")?;
    protocol::write(
        pipe,
        &Response::Ready {
            version: protocol::VERSION,
        },
    )
    .await?;
    let installer = dir.join("installer.exe");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&installer)
        .await
        .map_err(|_| "无法暂存更新包")?;
    let mut limited = pipe.take(size);
    let copied = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::io::copy(&mut limited, &mut file),
    )
    .await
    .map_err(|_| "更新传输超时")?
    .map_err(|_| "更新传输中断")?;
    if copied != size {
        return Err("更新包不完整".into());
    }
    file.flush().await.map_err(|_| "无法保存更新包")?;
    file.sync_all().await.map_err(|_| "无法提交更新包")?;
    drop(file);
    let bytes = tokio::fs::read(&installer)
        .await
        .map_err(|_| "无法验证更新包")?;
    verify(&bytes, &manifest.signature)?;
    verify_version(&installer)?;
    protocol::write(limited.into_inner(), &Response::Staged { ticket }).await
}

fn verify_version(path: &Path) -> crate::Result<()> {
    let path = windows::wide(&path.to_string_lossy());
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    if size == 0 || size > 1024 * 1024 {
        return Err("更新包版本资源无效".into());
    }
    let mut data = vec![0u8; size as usize];
    let mut value = std::ptr::null_mut();
    let mut length = 0;
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0
        || unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                windows::wide("\\").as_ptr(),
                &mut value,
                &mut length,
            )
        } == 0
        || (length as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
    {
        return Err("无法验证更新版本".into());
    }
    let value = unsafe { std::ptr::read_unaligned(value.cast::<VS_FIXEDFILEINFO>()) };
    let version = (
        value.dwFileVersionMS >> 16,
        value.dwFileVersionMS & 0xffff,
        value.dwFileVersionLS >> 16,
    );
    let current = (
        env!("CARGO_PKG_VERSION_MAJOR").parse::<u32>().unwrap(),
        env!("CARGO_PKG_VERSION_MINOR").parse::<u32>().unwrap(),
        env!("CARGO_PKG_VERSION_PATCH").parse::<u32>().unwrap(),
    );
    if value.dwSignature != 0xfeef04bd || version <= current {
        return Err("更新版本未高于已安装服务，拒绝降级或重放".into());
    }
    Ok(())
}

pub async fn stage(bytes: &[u8], signature: String) -> crate::Result<String> {
    let mut pipe = windows::connect().await?;
    protocol::write(
        &mut pipe,
        &Request::BeginUpdate {
            size: bytes.len() as u64,
            signature,
        },
    )
    .await?;
    match protocol::read(&mut pipe).await? {
        Response::Ready { .. } => {}
        Response::Error { message } => return Err(message),
        _ => return Err("更新暂存响应无效".into()),
    }
    pipe.write_all(bytes).await.map_err(|_| "更新包传输失败")?;
    match protocol::read(&mut pipe).await? {
        Response::Staged { ticket } => Ok(ticket),
        Response::Error { message } => Err(message),
        _ => Err("更新暂存失败".into()),
    }
}

pub async fn release(ticket: &str) -> crate::Result<()> {
    uuid::Uuid::parse_str(ticket).map_err(|_| "更新请求无效")?;
    let mut pipe = windows::connect().await?;
    protocol::write(
        &mut pipe,
        &Request::ReleaseUpdate {
            ticket: ticket.into(),
        },
    )
    .await?;
    match protocol::read(&mut pipe).await? {
        Response::Complete => Ok(()),
        Response::Error { message } => Err(message),
        _ => Err("更新票据释放响应无效".into()),
    }
}

pub async fn release_for_owner(owner: &str, ticket: &str) -> crate::Result<()> {
    uuid::Uuid::parse_str(ticket).map_err(|_| "更新请求无效")?;
    let _guard = UPLOAD
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    let dir = windows::data_dir()?.join("update");
    paths::verify_tree(&dir, &windows::service_sid()?, true)?;
    expire_ticket(&dir.join("manifest.json"), owner, ticket)
}

fn expire_ticket(metadata: &Path, owner: &str, ticket: &str) -> crate::Result<()> {
    let mut manifest: Manifest =
        serde_json::from_slice(&std::fs::read(metadata).map_err(|_| "更新状态不可用")?)
            .map_err(|_| "更新状态无效")?;
    if manifest.ticket != ticket || manifest.owner != owner {
        return Err("更新请求已失效".into());
    }
    manifest.expires = 0;
    let pending = metadata.with_extension("pending");
    std::fs::write(
        &pending,
        serde_json::to_vec(&manifest).map_err(|_| "无法保存更新状态")?,
    )
    .map_err(|_| "无法保存更新状态")?;
    if unsafe {
        MoveFileExW(
            windows::wide(&pending.to_string_lossy()).as_ptr(),
            windows::wide(&metadata.to_string_lossy()).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("无法释放更新票据".into());
    }
    Ok(())
}

pub fn install(ticket: &str) -> crate::Result<()> {
    let operation_id = crate::installation::operation_id(Some(ticket));
    let started = std::time::Instant::now();
    let mut caller_mode = None;
    let mut session_id = None;
    let mut validated_owner = None;
    let result = install_inner(
        ticket,
        &mut caller_mode,
        &mut session_id,
        &mut validated_owner,
    );
    let (phase, result_name, code, detail) = match &result {
        Ok(()) => ("installer_complete", "success", "ok", None),
        Err(error) => {
            let failure = crate::installation::classify_failure("--update", error);
            (failure.phase, "failure", failure.code, Some(error.as_str()))
        }
    };
    crate::installation::record(crate::installation::InstallerEvent {
        operation_id: &operation_id,
        install_mode: "update",
        phase,
        caller_mode,
        session_id,
        target: None,
        result: result_name,
        code,
        exit_code: Some(if result.is_ok() { 0 } else { 1 }),
        rollback: None,
        detail,
        elapsed: started.elapsed(),
    });
    let release_error = if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        let mut failure = None;
        for attempt in 0..3 {
            match runtime.block_on(release(ticket)) {
                Ok(()) => break,
                Err(error) if attempt == 2 => failure = Some(error),
                Err(_) => std::thread::sleep(Duration::from_secs(1)),
            }
        }
        failure
    } else {
        Some("无法启动更新票据清理".into())
    };
    if let Some(error) = release_error {
        let fallback = validated_owner.as_ref().map(|owner| {
            let metadata = windows::data_dir()?.join("update").join("manifest.json");
            expire_ticket(&metadata, owner, ticket)
        });
        if !matches!(fallback, Some(Ok(()))) {
            let detail = format!("服务释放失败：{error}；直接释放结果：{fallback:?}");
            crate::installation::record(crate::installation::InstallerEvent {
                operation_id: &operation_id,
                install_mode: "update",
                phase: "ticket_release",
                caller_mode,
                session_id,
                target: None,
                result: "failure",
                code: "ticket_release_failed",
                exit_code: Some(1),
                rollback: None,
                detail: Some(&detail),
                elapsed: started.elapsed(),
            });
        }
    }
    result
}

fn install_inner(
    ticket: &str,
    caller_mode: &mut Option<crate::installation::CallerMode>,
    session_id: &mut Option<u32>,
    validated_owner: &mut Option<String>,
) -> crate::Result<()> {
    if !windows::current_identity()?.elevated {
        return Err("更新需要管理员权限".into());
    }
    uuid::Uuid::parse_str(ticket).map_err(|_| "更新请求无效")?;
    let dir = windows::data_dir()?.join("update");
    paths::verify_tree(&dir, &windows::service_sid()?, true)?;
    let mut meta = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(dir.join("manifest.json"))
        .map_err(|_| "更新状态不可用")?;
    let mut text = String::new();
    (&mut meta)
        .take(8192)
        .read_to_string(&mut text)
        .map_err(|_| "更新状态无效")?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|_| "更新状态无效")?;
    if manifest.ticket != ticket || manifest.expires < now()? {
        return Err("更新请求已失效".into());
    }
    let caller = crate::installation::caller_context(manifest.caller_pid)?;
    *caller_mode = Some(caller.mode);
    *session_id = Some(caller.session_id);
    if caller.identity.sid != manifest.owner {
        return Err("更新调用者身份已变化，请重新检查更新".into());
    }
    *validated_owner = Some(manifest.owner.clone());
    let path = dir.join("installer.exe");
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .map_err(|_| "更新包不可用")?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_INSTALLER + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "更新包读取失败")?;
    if bytes.len() as u64 > MAX_INSTALLER {
        return Err("更新包过大".into());
    }
    // 提权端独立验签，且持有禁止写入和删除的句柄直到启动受保护安装包。
    verify(&bytes, &manifest.signature)?;
    verify_version(&path)?;
    let accepted = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            windows::wide(update_confirmation(caller.mode)).as_ptr(),
            windows::wide("FsTTY 安全更新").as_ptr(),
            MB_YESNO | MB_ICONQUESTION,
        )
    } == IDYES;
    if !accepted {
        return Err("更新已取消".into());
    }
    let _claimed = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join("claimed"))
        .map_err(|_| "更新请求已使用")?;
    let status = installer_command(&path, &dir, manifest.caller_pid)
        .status()
        .map_err(|_| "无法运行已验证的安装程序")?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "安装程序未完成（退出码：{}），请查看后台安装日志后重试",
            status.code().unwrap_or(-1)
        ))
    }
}

fn installer_command(path: &Path, directory: &Path, caller_pid: u32) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new(path);
    command
        .arg("/S")
        .arg("/UPDATE")
        .arg(format!("/CALLERPID={caller_pid}"))
        .current_dir(directory)
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    command
}

fn update_confirmation(mode: crate::installation::CallerMode) -> &'static str {
    match mode {
        crate::installation::CallerMode::AlwaysElevated => {
            "安装已验证签名的 FsTTY 更新？\n现有 SSH 连接将中断。当前会话没有普通权限令牌，更新完成后 FsTTY 仍会以管理员权限运行。"
        }
        crate::installation::CallerMode::Standard
        | crate::installation::CallerMode::LinkedStandard => {
            "安装已验证签名的 FsTTY 更新？\n现有 SSH 连接将中断，更新完成后 FsTTY 将以当前用户的普通权限运行。"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 验签拒绝篡改内容无公钥及伪造签名() {
        // 使用 minisign-verify 上游公开测试向量，不使用发布私钥。
        let public="untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature="untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
        let encode = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        let public = encode(public);
        let signature = encode(signature);
        assert!(verify_with_key(b"test", &signature, &public).is_ok());
        assert!(verify_with_key(b"Test", &signature, &public).is_err());
        assert!(verify_with_key(b"test", "invalid", &public).is_err());
        assert!(verify_with_key(b"test", &signature, "").is_err());
    }

    #[test]
    fn 更新确认不显示_sid_且说明最终权限() {
        let standard = update_confirmation(crate::installation::CallerMode::LinkedStandard);
        assert!(standard.contains("普通权限"));
        assert!(!standard.contains("S-1-"));
        let elevated = update_confirmation(crate::installation::CallerMode::AlwaysElevated);
        assert!(elevated.contains("管理员权限"));
        assert!(!elevated.contains("S-1-"));
    }

    #[test]
    fn 只释放匹配调用者与票据的暂存更新() {
        let directory = std::env::temp_dir().join(format!("fstty-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let metadata = directory.join("manifest.json");
        let ticket = uuid::Uuid::new_v4().to_string();
        let manifest = Manifest {
            ticket: ticket.clone(),
            owner: "S-1-5-21-test".into(),
            signature: "test".into(),
            expires: 300,
            caller_pid: 42,
        };
        std::fs::write(&metadata, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(expire_ticket(&metadata, "S-1-5-21-other", &ticket).is_err());
        assert!(expire_ticket(
            &metadata,
            &manifest.owner,
            &uuid::Uuid::new_v4().to_string()
        )
        .is_err());
        let unchanged: Manifest =
            serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(unchanged.expires, 300);
        expire_ticket(&metadata, &manifest.owner, &ticket).unwrap();
        let released: Manifest =
            serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
        assert_eq!(released.ticket, ticket);
        assert_eq!(released.expires, 0);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn 更新安装器同时收到静默与更新参数() {
        let command = installer_command(Path::new(r"C:\test\setup.exe"), Path::new(r"C:\test"), 42);
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments, ["/S", "/UPDATE", "/CALLERPID=42"]);
    }
}
