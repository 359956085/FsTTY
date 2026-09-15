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
    for name in ["manifest.json", "installer.exe", "claimed"] {
        let path = dir.join(name);
        if path.exists() {
            std::fs::remove_file(path).map_err(|_| "更新正在安装，请稍后重试")?;
        }
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    let manifest = Manifest {
        ticket: ticket.clone(),
        owner: owner.into(),
        signature,
        expires: now()? + 300,
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

pub fn install(ticket: &str) -> crate::Result<()> {
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
            windows::wide(&format!(
                "为用户 {} 安装已验证签名的 FsTTY 更新？\n现有 SSH 连接将中断。",
                manifest.owner
            ))
            .as_ptr(),
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
    use std::os::windows::process::CommandExt;
    std::process::Command::new(&path)
        .arg("/UPDATE")
        .current_dir(&dir)
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| "无法启动已验证的安装程序")?;
    Ok(())
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
}
