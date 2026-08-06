use super::{MAX_INLINE_PRIVATE_KEY_BYTES, MAX_PRIVATE_KEY_BYTES};
use crate::models::{AppError, CredentialAction, SessionAuth, SessionAuthInput, StoredSession};
use crate::services::CredentialService;
use russh::keys::{decode_secret_key, load_secret_key};
use std::path::PathBuf;
use tokio::task;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(super) async fn validate_private_key_path(path: &str) -> Result<String, AppError> {
    let candidate = PathBuf::from(path.trim());
    if path.len() > 4096 || !candidate.is_absolute() {
        return Err(AppError::Validation("私钥必须使用有效绝对路径".to_owned()));
    }
    let metadata = tokio::fs::metadata(&candidate)
        .await
        .map_err(|_| AppError::Validation("无法读取私钥文件".to_owned()))?;
    if !metadata.is_file() || metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err(AppError::Validation(
            "私钥必须是小于 1 MiB 的普通文件".to_owned(),
        ));
    }
    let canonical = tokio::fs::canonicalize(candidate)
        .await
        .map_err(|_| AppError::Validation("无法规范化私钥路径".to_owned()))?;
    canonical
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::Validation("私钥路径必须是有效 Unicode".to_owned()))
}

pub(super) async fn validate_private_key_file(
    path: &str,
    passphrase: Option<&str>,
) -> Result<(), AppError> {
    let path = path.to_owned();
    let passphrase = passphrase.map(|value| Zeroizing::new(value.to_owned()));
    task::spawn_blocking(move || {
        load_secret_key(path, passphrase.as_ref().map(|value| value.as_str()))
    })
    .await
    .map_err(|_| AppError::Validation("私钥校验任务失败".to_owned()))?
    .map(|_| ())
    .map_err(|_| AppError::Validation("私钥无法解析或口令错误".to_owned()))
}

pub(super) fn validate_inline_private_key_size(value: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > MAX_INLINE_PRIVATE_KEY_BYTES {
        return Err(AppError::Validation(
            "粘贴私钥不能为空，且不能超过 16384 字节".to_owned(),
        ));
    }
    Ok(())
}

pub(super) async fn validate_inline_private_key(
    private_key: Zeroizing<String>,
    passphrase: Option<&str>,
) -> Result<(), AppError> {
    validate_inline_private_key_size(&private_key)?;
    let passphrase = passphrase.map(|value| Zeroizing::new(value.to_owned()));
    task::spawn_blocking(move || {
        decode_secret_key(
            &private_key,
            passphrase.as_ref().map(|value| value.as_str()),
        )
    })
    .await
    .map_err(|_| AppError::Validation("私钥校验任务失败".to_owned()))?
    .map(|_| ())
    .map_err(|_| AppError::Validation("私钥无法解析或口令错误".to_owned()))
}

pub(super) fn validate_common(
    name: &str,
    host: &str,
    port: u16,
    username: &str,
    group: &str,
    tags: &[String],
) -> Result<(), AppError> {
    validate_text("会话名称", name, 128, false)?;
    validate_text("主机地址", host, 253, false)?;
    validate_text("用户名", username, 128, true)?;
    validate_text("分组", group, 128, true)?;
    if host.chars().any(char::is_whitespace) {
        return Err(AppError::Validation("主机地址不能包含空白字符".to_owned()));
    }
    if port == 0 {
        return Err(AppError::Validation(
            "端口必须在 1 到 65535 之间".to_owned(),
        ));
    }
    if tags.len() > 32 {
        return Err(AppError::Validation("标签不能超过 32 个".to_owned()));
    }
    for tag in tags {
        validate_text("标签", tag, 64, false)?;
    }
    Ok(())
}

// 只限制新写入请求，不收紧存储加载校验，避免旧空账号私钥会话无法启动应用。
pub(super) fn validate_auth_username(
    username: &str,
    auth: &SessionAuthInput,
) -> Result<(), AppError> {
    if matches!(auth, SessionAuthInput::PrivateKey { .. }) && username.trim().is_empty() {
        return Err(AppError::Validation("私钥认证必须填写账号".to_owned()));
    }
    Ok(())
}

pub(super) async fn validate_password_username(
    username: &str,
    auth: &SessionAuthInput,
    action: &CredentialAction,
    old: Option<&StoredSession>,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    if !matches!(auth, SessionAuthInput::Password) || !username.trim().is_empty() {
        return Ok(());
    }
    let password_present = match action {
        CredentialAction::Replace { value } | CredentialAction::UseOnce { value } => {
            !value.is_empty()
        }
        CredentialAction::Preserve => {
            if let Some(old_session) =
                old.filter(|session| matches!(session.auth, SessionAuth::Password))
            {
                credentials.get(&old_session.id).await?.is_some()
            } else {
                false
            }
        }
        CredentialAction::Clear => false,
    };
    if password_present {
        return Err(AppError::Validation(
            "填写密码时必须同时填写账号".to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn validate_text(
    label: &str,
    value: &str,
    max_length: usize,
    allow_empty: bool,
) -> Result<(), AppError> {
    let trimmed = value.trim();
    if (!allow_empty && trimmed.is_empty())
        || trimmed.len() > max_length
        || trimmed.chars().any(char::is_control)
    {
        return Err(AppError::Validation(format!("{label}无效")));
    }
    Ok(())
}

pub(super) fn validate_id(value: &str) -> Result<(), AppError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| AppError::Validation("会话 ID 无效".to_owned()))
}
