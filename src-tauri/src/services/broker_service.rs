use crate::models::{AppError, PrivateKeySource, SessionAuth, StoredSession};
use fstty_broker::{
    protocol::{Change, Profile, Request, Response, Secrets, Target},
    windows,
};
use zeroize::Zeroizing;

static APPROVAL_THEME: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub fn set_approval_theme(theme: crate::models::ThemePreference) {
    use crate::models::ThemePreference;
    APPROVAL_THEME.store(
        match theme {
            ThemePreference::System => 0,
            ThemePreference::Light => 1,
            ThemePreference::Dark => 2,
        },
        std::sync::atomic::Ordering::Relaxed,
    );
}

fn approval_theme() -> fstty_broker::admin::Theme {
    use fstty_broker::admin::Theme;
    match APPROVAL_THEME.load(std::sync::atomic::Ordering::Relaxed) {
        1 => Theme::Light,
        2 => Theme::Dark,
        _ => Theme::system(),
    }
}

fn error(message: String) -> AppError {
    AppError::Credential(message)
}
pub fn target(session: &StoredSession) -> Target {
    Target {
        id: session.id.clone(),
        host: session.host.clone(),
        port: session.port,
        username: session.username.clone(),
        private_key: matches!(session.auth, SessionAuth::PrivateKey { .. }),
    }
}
pub async fn profiles() -> Result<Vec<Profile>, AppError> {
    match windows::request(&Request::List).await.map_err(error)? {
        Response::Profiles { profiles } => Ok(profiles),
        _ => Err(error("服务响应无效".into())),
    }
}
async fn approve(request: Request) -> Result<(), AppError> {
    let ticket = match windows::request(&request).await.map_err(error)? {
        Response::Staged { ticket } => ticket,
        _ => return Err(error("服务审批响应无效".into())),
    };
    let managed = ticket.clone();
    let theme = approval_theme();
    let result = tokio::task::spawn_blocking(move || windows::elevate_with_theme(&managed, theme))
        .await
        .map_err(|_| error("安全窗口启动失败".into()))?
        .map_err(error);
    if result.is_err() {
        let _ = windows::request(&Request::Cancel { ticket }).await;
    }
    result
}
pub async fn configure(target: Target, replace_secret: bool) -> Result<Profile, AppError> {
    let id = target.id.clone();
    approve(Request::Stage {
        change: Change::Configure {
            target,
            replace_secret,
        },
    })
    .await?;
    let mut profile = profiles()
        .await?
        .into_iter()
        .find(|p| p.target.id == id)
        .ok_or_else(|| error("托管会话保存失败".into()))?;
    clear_legacy(&id).await?;
    windows::request(&Request::CleanupComplete {
        id,
        revision: profile.revision,
    })
    .await
    .map_err(error)?;
    profile.cleanup_pending = false;
    Ok(profile)
}
pub async fn delete(id: &str) -> Result<(), AppError> {
    approve(Request::Stage {
        change: Change::Delete { id: id.into() },
    })
    .await?;
    clear_legacy(id).await
}

async fn clear_legacy(id: &str) -> Result<(), AppError> {
    let legacy = super::CredentialService::legacy_for_migration();
    legacy
        .delete_all(id)
        .await
        .map_err(|_| error("安全变更已提交，但旧凭据清理失败，仍有旧副本；请重试".into()))?;
    if legacy.get(id).await?.is_some() || legacy.get_private_key(id).await?.is_some() {
        return Err(error("仍检测到旧凭据副本".into()));
    }
    Ok(())
}

pub async fn delete_batch(ids: &[String]) -> Result<(), AppError> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut tickets = Vec::new();
    let result = async {
        for id in ids {
            match windows::request(&Request::Stage {
                change: Change::Delete { id: id.clone() },
            })
            .await
            .map_err(error)?
            {
                Response::Staged { ticket } => tickets.push(ticket),
                _ => return Err(error("删除请求暂存失败".into())),
            }
        }
        approve(Request::Batch {
            tickets: tickets.clone(),
        })
        .await
    }
    .await;
    for ticket in tickets {
        let _ = windows::request(&Request::Cancel { ticket }).await;
    }
    result?;
    for id in ids {
        clear_legacy(id).await?;
    }
    Ok(())
}
pub async fn trust(id: &str) -> Result<(), AppError> {
    approve(Request::Stage {
        change: Change::Trust { id: id.into() },
    })
    .await
}
pub fn apply_profile(session: &mut StoredSession, profile: &Profile) {
    session.host = profile.target.host.clone();
    session.port = profile.target.port;
    session.username = profile.target.username.clone();
    session.auth = if profile.target.private_key {
        SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            path: None,
            passphrase_required: false,
        }
    } else {
        SessionAuth::Password
    };
    session.login_save_prompted = true;
}
pub async fn migrate(session: &StoredSession) -> Result<Profile, AppError> {
    let existing = profiles()
        .await?
        .into_iter()
        .find(|p| p.target.id == session.id);
    let legacy = super::CredentialService::legacy_for_migration();
    if existing.is_none() {
        let request = migration_request(session).await?;
        approve(request).await?;
    }
    let profile = profiles()
        .await?
        .into_iter()
        .find(|p| p.target.id == session.id)
        .ok_or_else(|| error("托管会话不存在".into()))?;
    if existing.is_none() || profile.cleanup_pending {
        legacy
            .delete_all(&session.id)
            .await
            .map_err(|_| error("已托管，但旧凭据清理失败，仍有旧副本；请重试迁移".into()))?;
        if legacy.get(&session.id).await?.is_some()
            || legacy.get_private_key(&session.id).await?.is_some()
        {
            return Err(error("已托管，但仍检测到旧凭据副本".into()));
        }
        windows::request(&Request::CleanupComplete {
            id: session.id.clone(),
            revision: profile.revision,
        })
        .await
        .map_err(error)?;
    }
    Ok(Profile {
        cleanup_pending: false,
        ..profile
    })
}

async fn migration_request(session: &StoredSession) -> Result<Request, AppError> {
    let legacy = super::CredentialService::legacy_for_migration();
    let password = legacy.get(&session.id).await?.unwrap_or_default();
    let private_key = match &session.auth {
        SessionAuth::Password => Zeroizing::new(String::new()),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            ..
        } => legacy
            .get_private_key(&session.id)
            .await?
            .ok_or_else(|| error("旧私钥缺失，请通过安全窗口重新配置".into()))?,
        SessionAuth::PrivateKey {
            source: PrivateKeySource::File,
            path,
            ..
        } => {
            let path = path
                .as_deref()
                .ok_or_else(|| error("私钥路径缺失".into()))?;
            let mut file = tokio::fs::File::open(path)
                .await
                .map_err(|_| error("无法读取原私钥文件".into()))?;
            use tokio::io::AsyncReadExt;
            let mut bytes = Zeroizing::new(Vec::new());
            (&mut file)
                .take(fstty_broker::protocol::MAX_KEY as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| error("无法读取原私钥文件".into()))?;
            if bytes.len() > fstty_broker::protocol::MAX_KEY {
                return Err(error("私钥文件超过 1 MiB".into()));
            }
            Zeroizing::new(
                std::str::from_utf8(&bytes)
                    .map_err(|_| error("私钥文件不是 UTF-8 文本".into()))?
                    .to_owned(),
            )
        }
    };
    if password.is_empty() && matches!(session.auth, SessionAuth::Password) {
        Ok(Request::Stage {
            change: Change::Configure {
                target: target(session),
                replace_secret: true,
            },
        })
    } else {
        Ok(Request::StageImport {
            target: target(session),
            secrets: Secrets {
                password,
                private_key,
            },
        })
    }
}

pub async fn migrate_batch(sessions: &[StoredSession]) -> Result<(), AppError> {
    if sessions.len() > 32 {
        return Err(error("一次最多迁移 32 个会话".into()));
    }
    let existing = profiles().await?;
    let mut tickets = Vec::new();
    let result = async {
        for session in sessions {
            if existing.iter().any(|p| p.target.id == session.id) {
                continue;
            }
            let request = migration_request(session).await?;
            if !matches!(request, Request::StageImport { .. }) {
                return Err(error(format!(
                    "会话 {} 缺少旧凭据，请先单独配置",
                    session.name
                )));
            }
            match windows::request(&request).await.map_err(error)? {
                Response::Staged { ticket } => tickets.push(ticket),
                _ => return Err(error("迁移暂存失败".into())),
            }
        }
        if !tickets.is_empty() {
            approve(Request::Batch {
                tickets: tickets.clone(),
            })
            .await?;
        }
        Ok(())
    }
    .await;
    for ticket in tickets {
        let _ = windows::request(&Request::Cancel { ticket }).await;
    }
    result?;
    for session in sessions {
        migrate(session).await?;
    }
    Ok(())
}
pub async fn connect_stream(
    id: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, AppError> {
    let mut pipe = windows::connect().await.map_err(error)?;
    fstty_broker::protocol::write(&mut pipe, &Request::Connect { id: id.into() })
        .await
        .map_err(error)?;
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(55),
        fstty_broker::protocol::read(&mut pipe),
    )
    .await
    .map_err(|_| error("服务连接超时".into()))?
    .map_err(error)?;
    match response {
        Response::Connected => Ok(pipe),
        Response::Error { message } => Err(error(message)),
        _ => Err(error("服务连接响应无效".into())),
    }
}
