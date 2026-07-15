use crate::models::{
    AppError, CreateSessionPayload, CredentialAction, CredentialState, SessionAuth,
    SessionAuthInput, SessionGroup, SessionProfile, StoredSession, UpdateSessionPayload,
};
use crate::services::CredentialService;
use russh::keys::load_secret_key;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::task;
use uuid::Uuid;
use zeroize::Zeroizing;

const STORE_VERSION: u8 = 1;
const STORE_FILE: &str = "sessions.v1.json";
const STORE_BACKUP_FILE: &str = "sessions.v1.json.bak";
const STORE_TEMP_FILE: &str = "sessions.v1.json.tmp";
const MAX_STORE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SESSIONS: usize = 500;
const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStore {
    version: u8,
    sessions: Vec<StoredSession>,
    #[serde(default)]
    pending_credential_cleanup_ids: Vec<String>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            sessions: Vec::new(),
            pending_credential_cleanup_ids: Vec::new(),
        }
    }
}

pub struct SessionService {
    store: SessionStore,
    store_path: PathBuf,
    backup_path: PathBuf,
    temp_path: PathBuf,
    primary_trusted: bool,
    blocked_error: Option<AppError>,
}

enum SecretChange {
    Preserve,
    Set(Zeroizing<String>),
    Delete,
}

impl SessionService {
    pub fn load(app_data_dir: &Path) -> Self {
        let store_path = app_data_dir.join(STORE_FILE);
        let backup_path = app_data_dir.join(STORE_BACKUP_FILE);
        let temp_path = app_data_dir.join(STORE_TEMP_FILE);

        let (store, primary_trusted, blocked_error) = match read_store(&store_path) {
            Ok(Some(store)) => (store, true, None),
            Ok(None) => match read_store(&backup_path) {
                Ok(Some(store)) => (store, false, None),
                Ok(None) => (SessionStore::default(), true, None),
                Err(error) => (SessionStore::default(), false, Some(error)),
            },
            Err(primary_error) => match read_store(&backup_path) {
                Ok(Some(store)) => (store, false, None),
                _ => (SessionStore::default(), false, Some(primary_error)),
            },
        };

        Self {
            store,
            store_path,
            backup_path,
            temp_path,
            primary_trusted,
            blocked_error,
        }
    }

    pub async fn list_groups(
        &mut self,
        credentials: &CredentialService,
    ) -> Result<Vec<SessionGroup>, AppError> {
        self.ensure_readable()?;
        if !self.store.pending_credential_cleanup_ids.is_empty() {
            self.retry_pending_cleanup(credentials).await;
        }

        let mut groups = Vec::<SessionGroup>::new();
        for stored in self.store.sessions.clone() {
            let profile = self.profile(stored, credentials).await?;
            if let Some(group) = groups.iter_mut().find(|group| group.name == profile.group) {
                group.sessions.push(profile);
            } else {
                groups.push(SessionGroup {
                    name: profile.group.clone(),
                    sessions: vec![profile],
                });
            }
        }
        Ok(groups)
    }

    pub fn find(&self, session_id: &str) -> Result<StoredSession, AppError> {
        self.ensure_readable()?;
        self.store
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("未找到指定会话".to_owned()))
    }

    pub async fn create(
        &mut self,
        payload: CreateSessionPayload,
        credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        self.ensure_writable()?;
        if self.store.sessions.len() >= MAX_SESSIONS {
            return Err(AppError::Validation("会话数量不能超过 500 个".to_owned()));
        }
        validate_common(
            &payload.name,
            &payload.host,
            payload.port,
            &payload.username,
            &payload.group,
            &payload.tags,
        )?;

        let id = Uuid::new_v4().to_string();
        let (auth, secret_change) =
            prepare_auth(&id, payload.auth, payload.credential, None, credentials).await?;
        let session = StoredSession {
            id: id.clone(),
            name: payload.name.trim().to_owned(),
            host: payload.host.trim().to_owned(),
            port: payload.port,
            username: payload.username.trim().to_owned(),
            group: normalize_group(&payload.group),
            tags: normalize_tags(payload.tags),
            auth,
        };
        let credential_state =
            resolve_credential_state(&session, &secret_change, credentials).await?;

        let secret_changed = !matches!(&secret_change, SecretChange::Preserve);
        apply_secret_change(&id, secret_change, credentials).await?;
        let previous = self.store.clone();
        self.store.sessions.push(session.clone());
        if let Err(error) = self.persist() {
            self.store = previous;
            if secret_changed && credentials.delete(&id).await.is_err() {
                self.queue_credential_cleanup(&id);
                let _ = self.persist();
            }
            return Err(error);
        }
        Ok(profile_with_state(session, credential_state))
    }

    pub async fn update(
        &mut self,
        payload: UpdateSessionPayload,
        credentials: &CredentialService,
    ) -> Result<(SessionProfile, bool), AppError> {
        self.ensure_writable()?;
        validate_id(&payload.id)?;
        validate_common(
            &payload.name,
            &payload.host,
            payload.port,
            &payload.username,
            &payload.group,
            &payload.tags,
        )?;
        let old_session = self.find(&payload.id)?;
        let (auth, secret_change) = prepare_auth(
            &payload.id,
            payload.auth,
            payload.credential,
            Some(&old_session),
            credentials,
        )
        .await?;
        let secret_changed = !matches!(&secret_change, SecretChange::Preserve);
        let old_secret = if secret_changed && old_session.requires_credential() {
            credentials.get(&payload.id).await?
        } else {
            None
        };
        let connection_invalidated = old_session.host != payload.host.trim()
            || old_session.port != payload.port
            || old_session.username != payload.username.trim()
            || old_session.auth != auth;
        let updated = StoredSession {
            id: payload.id.clone(),
            name: payload.name.trim().to_owned(),
            host: payload.host.trim().to_owned(),
            port: payload.port,
            username: payload.username.trim().to_owned(),
            group: normalize_group(&payload.group),
            tags: normalize_tags(payload.tags),
            auth,
        };
        let credential_state =
            resolve_credential_state(&updated, &secret_change, credentials).await?;

        apply_secret_change(&payload.id, secret_change, credentials).await?;
        let previous = self.store.clone();
        let target = self
            .store
            .sessions
            .iter_mut()
            .find(|session| session.id == payload.id)
            .ok_or_else(|| AppError::NotFound("未找到指定会话".to_owned()))?;
        *target = updated.clone();
        if let Err(error) = self.persist() {
            self.store = previous;
            if secret_changed {
                restore_secret(&payload.id, old_secret, credentials)
                    .await
                    .map_err(|_| {
                        AppError::Credential(
                            "会话保存失败，且系统凭据回滚失败，请重新检查凭据".to_owned(),
                        )
                    })?;
            }
            return Err(error);
        }
        Ok((
            profile_with_state(updated, credential_state),
            connection_invalidated,
        ))
    }

    pub async fn delete(
        &mut self,
        session_id: &str,
        credentials: &CredentialService,
    ) -> Result<(), AppError> {
        self.ensure_writable()?;
        validate_id(session_id)?;
        self.find(session_id)?;

        let previous = self.store.clone();
        self.store
            .sessions
            .retain(|session| session.id != session_id);
        if !self
            .store
            .pending_credential_cleanup_ids
            .iter()
            .any(|id| id == session_id)
        {
            self.store
                .pending_credential_cleanup_ids
                .push(session_id.to_owned());
        }
        if let Err(error) = self.persist() {
            self.store = previous;
            return Err(error);
        }

        if credentials.delete(session_id).await.is_ok() {
            let before_cleanup = self.store.clone();
            self.store
                .pending_credential_cleanup_ids
                .retain(|id| id != session_id);
            if self.persist().is_err() {
                // 磁盘仍保留待清理项时，内存也保留，确保本次运行仍可重试。
                self.store = before_cleanup;
            }
        }
        Ok(())
    }

    pub async fn set_credential(
        &self,
        session_id: &str,
        value: Zeroizing<String>,
        credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        validate_id(session_id)?;
        let session = self.find(session_id)?;
        if !session.requires_credential() {
            return Err(AppError::Validation(
                "当前认证方式不需要保存口令".to_owned(),
            ));
        }
        if let SessionAuth::PrivateKey { path, .. } = &session.auth {
            validate_private_key(path, Some(&value)).await?;
        }
        credentials.set(session_id, value).await?;
        Ok(profile_with_state(session, CredentialState::Stored))
    }

    async fn profile(
        &self,
        stored: StoredSession,
        credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        let credential_state = if !stored.requires_credential() {
            CredentialState::NotRequired
        } else if credentials.get(&stored.id).await?.is_some() {
            CredentialState::Stored
        } else {
            CredentialState::Missing
        };
        let mut profile = SessionProfile::from(stored);
        profile.credential_state = credential_state;
        Ok(profile)
    }

    async fn retry_pending_cleanup(&mut self, credentials: &CredentialService) {
        if self.store.pending_credential_cleanup_ids.is_empty() {
            return;
        }
        let previous = self.store.clone();
        let mut remaining = Vec::new();
        for id in self.store.pending_credential_cleanup_ids.clone() {
            if credentials.delete(&id).await.is_err() {
                remaining.push(id);
            }
        }
        self.store.pending_credential_cleanup_ids = remaining;
        if self.persist().is_err() {
            self.store = previous;
        }
    }

    fn queue_credential_cleanup(&mut self, session_id: &str) {
        if !self
            .store
            .pending_credential_cleanup_ids
            .iter()
            .any(|id| id == session_id)
        {
            self.store
                .pending_credential_cleanup_ids
                .push(session_id.to_owned());
        }
    }

    fn ensure_readable(&self) -> Result<(), AppError> {
        match &self.blocked_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn ensure_writable(&self) -> Result<(), AppError> {
        self.ensure_readable()
    }

    fn persist(&mut self) -> Result<(), AppError> {
        fs::create_dir_all(
            self.store_path
                .parent()
                .ok_or_else(|| AppError::Persistence("会话存储目录无效".to_owned()))?,
        )
        .map_err(|_| AppError::Persistence("无法创建会话存储目录".to_owned()))?;
        let content = serde_json::to_vec_pretty(&self.store)
            .map_err(|_| AppError::Persistence("无法序列化会话数据".to_owned()))?;
        let mut temp = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&self.temp_path)
            .map_err(|_| AppError::Persistence("无法写入会话临时文件".to_owned()))?;
        temp.write_all(&content)
            .and_then(|_| temp.sync_all())
            .map_err(|_| AppError::Persistence("无法同步会话临时文件".to_owned()))?;
        drop(temp);

        if self.store_path.exists() {
            if self.primary_trusted {
                let _ = fs::remove_file(&self.backup_path);
                fs::rename(&self.store_path, &self.backup_path)
                    .map_err(|_| AppError::Persistence("无法备份会话数据".to_owned()))?;
            } else {
                fs::remove_file(&self.store_path)
                    .map_err(|_| AppError::Persistence("无法替换损坏的会话数据".to_owned()))?;
            }
        }
        if fs::rename(&self.temp_path, &self.store_path).is_err() {
            if !self.store_path.exists() && self.backup_path.exists() {
                let _ = fs::copy(&self.backup_path, &self.store_path);
            }
            return Err(AppError::Persistence("无法提交会话数据".to_owned()));
        }
        self.primary_trusted = true;
        Ok(())
    }
}

async fn prepare_auth(
    session_id: &str,
    input: SessionAuthInput,
    action: CredentialAction,
    old: Option<&StoredSession>,
    credentials: &CredentialService,
) -> Result<(SessionAuth, SecretChange), AppError> {
    match input {
        SessionAuthInput::Password => {
            let same_auth = matches!(
                old.map(|session| &session.auth),
                Some(SessionAuth::Password)
            );
            let change = match action {
                CredentialAction::Replace { value } => SecretChange::Set(value),
                CredentialAction::Preserve if same_auth => SecretChange::Preserve,
                CredentialAction::Preserve => {
                    return Err(AppError::Validation(
                        "切换认证方式时必须填写密码".to_owned(),
                    ))
                }
                CredentialAction::Clear => {
                    return Err(AppError::Validation("密码认证不能清空密码".to_owned()))
                }
            };
            Ok((SessionAuth::Password, change))
        }
        SessionAuthInput::PrivateKey { path } => {
            let canonical_path = validate_private_key_path(&path).await?;
            let same_key = matches!(
                old.map(|session| &session.auth),
                Some(SessionAuth::PrivateKey { path, .. }) if path == &canonical_path
            );
            if matches!(&action, CredentialAction::Preserve) && old.is_some() && !same_key {
                return Err(AppError::Validation(
                    "切换私钥时必须重新确认私钥口令".to_owned(),
                ));
            }

            if validate_private_key(&canonical_path, None).await.is_ok() {
                return Ok((
                    SessionAuth::PrivateKey {
                        path: canonical_path,
                        passphrase_required: false,
                    },
                    if old.is_some_and(StoredSession::requires_credential) {
                        SecretChange::Delete
                    } else {
                        SecretChange::Preserve
                    },
                ));
            }

            let change = match action {
                CredentialAction::Replace { value } => {
                    validate_private_key(&canonical_path, Some(&value)).await?;
                    SecretChange::Set(value)
                }
                CredentialAction::Preserve if same_key => {
                    let value = credentials.get(session_id).await?.ok_or_else(|| {
                        AppError::Credential("私钥口令缺失，请重新输入".to_owned())
                    })?;
                    validate_private_key(&canonical_path, Some(&value)).await?;
                    SecretChange::Preserve
                }
                CredentialAction::Clear => {
                    return Err(AppError::Credential("该私钥需要口令".to_owned()))
                }
                CredentialAction::Preserve => {
                    return Err(AppError::Credential("请填写私钥口令".to_owned()))
                }
            };
            Ok((
                SessionAuth::PrivateKey {
                    path: canonical_path,
                    passphrase_required: true,
                },
                change,
            ))
        }
    }
}

async fn validate_private_key_path(path: &str) -> Result<String, AppError> {
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

async fn validate_private_key(path: &str, passphrase: Option<&str>) -> Result<(), AppError> {
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

async fn apply_secret_change(
    session_id: &str,
    change: SecretChange,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    match change {
        SecretChange::Preserve => Ok(()),
        SecretChange::Set(value) => credentials.set(session_id, value).await,
        SecretChange::Delete => credentials.delete(session_id).await,
    }
}

async fn restore_secret(
    session_id: &str,
    old_secret: Option<Zeroizing<String>>,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    match old_secret {
        Some(secret) => credentials.set(session_id, secret).await,
        None => credentials.delete(session_id).await,
    }
}

async fn resolve_credential_state(
    session: &StoredSession,
    change: &SecretChange,
    credentials: &CredentialService,
) -> Result<CredentialState, AppError> {
    if !session.requires_credential() {
        return Ok(CredentialState::NotRequired);
    }
    match change {
        SecretChange::Set(_) => Ok(CredentialState::Stored),
        SecretChange::Preserve => Ok(if credentials.get(&session.id).await?.is_some() {
            CredentialState::Stored
        } else {
            CredentialState::Missing
        }),
        SecretChange::Delete => Ok(CredentialState::Missing),
    }
}

fn profile_with_state(stored: StoredSession, credential_state: CredentialState) -> SessionProfile {
    let mut profile = SessionProfile::from(stored);
    profile.credential_state = credential_state;
    profile
}

fn read_store(path: &Path) -> Result<Option<SessionStore>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(path).map_err(|_| AppError::Persistence("无法读取会话存储信息".to_owned()))?;
    if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES {
        return Err(AppError::Persistence("会话存储文件无效".to_owned()));
    }
    let content =
        fs::read(path).map_err(|_| AppError::Persistence("无法读取会话存储文件".to_owned()))?;
    let store: SessionStore = serde_json::from_slice(&content)
        .map_err(|_| AppError::Persistence("会话存储文件已损坏".to_owned()))?;
    validate_store(&store)?;
    Ok(Some(store))
}

fn validate_store(store: &SessionStore) -> Result<(), AppError> {
    if store.version != STORE_VERSION
        || store.sessions.len() > MAX_SESSIONS
        || store.pending_credential_cleanup_ids.len() > MAX_SESSIONS
    {
        return Err(AppError::Persistence("会话存储版本或数量无效".to_owned()));
    }
    let mut ids = HashSet::new();
    for session in &store.sessions {
        validate_id(&session.id).map_err(|_| AppError::Persistence("会话 ID 无效".to_owned()))?;
        validate_common(
            &session.name,
            &session.host,
            session.port,
            &session.username,
            &session.group,
            &session.tags,
        )
        .map_err(|_| AppError::Persistence("会话字段无效".to_owned()))?;
        if !ids.insert(&session.id) {
            return Err(AppError::Persistence("会话 ID 重复".to_owned()));
        }
        if let SessionAuth::PrivateKey { path, .. } = &session.auth {
            if path.len() > 4096
                || !Path::new(path).is_absolute()
                || path.chars().any(char::is_control)
            {
                return Err(AppError::Persistence("私钥路径无效".to_owned()));
            }
        }
    }
    let mut cleanup_ids = HashSet::new();
    for id in &store.pending_credential_cleanup_ids {
        validate_id(id).map_err(|_| AppError::Persistence("待清理凭据 ID 无效".to_owned()))?;
        if !cleanup_ids.insert(id) {
            return Err(AppError::Persistence("待清理凭据 ID 重复".to_owned()));
        }
    }
    Ok(())
}

fn validate_common(
    name: &str,
    host: &str,
    port: u16,
    username: &str,
    group: &str,
    tags: &[String],
) -> Result<(), AppError> {
    validate_text("会话名称", name, 128, false)?;
    validate_text("主机地址", host, 253, false)?;
    validate_text("用户名", username, 128, false)?;
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

fn validate_text(
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

fn validate_id(value: &str) -> Result<(), AppError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| AppError::Validation("会话 ID 无效".to_owned()))
}

fn normalize_group(group: &str) -> String {
    let group = group.trim();
    if group.is_empty() {
        "未分组".to_owned()
    } else {
        group.to_owned()
    }
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    tags.into_iter()
        .map(|tag| tag.trim().to_owned())
        .filter(|tag| !tag.is_empty() && seen.insert(tag.to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("fstty-{name}-{}", Uuid::new_v4()))
    }

    fn sample_session(name: &str) -> StoredSession {
        StoredSession {
            id: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            host: "127.0.0.1".to_owned(),
            port: 22,
            username: "root".to_owned(),
            group: "未分组".to_owned(),
            tags: vec![],
            auth: SessionAuth::Password,
        }
    }

    #[test]
    fn rejects_invalid_host_and_duplicate_ids() {
        assert!(validate_common("测试", "bad host", 22, "root", "", &[]).is_err());
        let session = StoredSession {
            id: Uuid::new_v4().to_string(),
            name: "测试".to_owned(),
            host: "127.0.0.1".to_owned(),
            port: 22,
            username: "root".to_owned(),
            group: "未分组".to_owned(),
            tags: vec![],
            auth: SessionAuth::Password,
        };
        let store = SessionStore {
            version: STORE_VERSION,
            sessions: vec![session.clone(), session],
            pending_credential_cleanup_ids: vec![],
        };
        assert!(validate_store(&store).is_err());
    }

    #[test]
    fn normalizes_tags_without_changing_order() {
        assert_eq!(
            normalize_tags(vec![" Web ".to_owned(), "web".to_owned(), "DB".to_owned()]),
            vec!["Web".to_owned(), "DB".to_owned()]
        );
    }

    #[test]
    fn persists_atomically_and_recovers_from_backup() {
        let directory = test_directory("session-store");
        let mut service = SessionService::load(&directory);
        service.store.sessions.push(sample_session("第一版"));
        service.persist().expect("首次保存失败");
        service.store.sessions[0].name = "第二版".to_owned();
        service.persist().expect("第二次保存失败");

        fs::write(directory.join(STORE_FILE), b"{broken").expect("无法破坏主文件");
        let mut recovered = SessionService::load(&directory);
        assert_eq!(recovered.store.sessions[0].name, "第一版");
        assert!(!recovered.primary_trusted);
        recovered.store.sessions[0].name = "恢复版".to_owned();
        recovered.persist().expect("从备份恢复后无法保存");

        let reloaded = SessionService::load(&directory);
        assert_eq!(reloaded.store.sessions[0].name, "恢复版");
        assert!(reloaded.blocked_error.is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn blocks_store_when_primary_and_backup_are_corrupt() {
        let directory = test_directory("corrupt-store");
        fs::create_dir_all(&directory).expect("无法创建测试目录");
        fs::write(directory.join(STORE_FILE), b"broken").expect("无法写入损坏主文件");
        fs::write(directory.join(STORE_BACKUP_FILE), b"broken").expect("无法写入损坏备份");

        let service = SessionService::load(&directory);
        assert!(service.ensure_writable().is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn validates_private_key_path_boundaries() {
        assert!(validate_private_key_path("relative-key").await.is_err());
        let directory = test_directory("private-key");
        fs::create_dir_all(&directory).expect("无法创建测试目录");
        assert!(
            validate_private_key_path(directory.to_str().expect("测试路径无效"))
                .await
                .is_err()
        );

        let oversized = directory.join("oversized-key");
        let file = fs::File::create(&oversized).expect("无法创建超大私钥");
        file.set_len(MAX_PRIVATE_KEY_BYTES + 1)
            .expect("无法设置测试文件大小");
        assert!(
            validate_private_key_path(oversized.to_str().expect("测试路径无效"))
                .await
                .is_err()
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    #[ignore = "需要使用当前系统凭据库"]
    async fn credential_lifecycle_smoke() {
        let directory = test_directory("credential-store");
        let credentials = CredentialService;
        let mut service = SessionService::load(&directory);
        let initial_secret = Zeroizing::new(Uuid::new_v4().to_string());
        let created = service
            .create(
                CreateSessionPayload {
                    name: "凭据测试".to_owned(),
                    host: "127.0.0.1".to_owned(),
                    port: 22,
                    username: "root".to_owned(),
                    group: "测试".to_owned(),
                    tags: vec![],
                    auth: SessionAuthInput::Password,
                    credential: CredentialAction::Replace {
                        value: initial_secret.clone(),
                    },
                },
                &credentials,
            )
            .await
            .expect("创建凭据会话失败");
        assert!(matches!(created.credential_state, CredentialState::Stored));
        let content = fs::read_to_string(directory.join(STORE_FILE)).expect("无法读取会话文件");
        assert!(!content.contains(initial_secret.as_str()));

        service
            .update(
                UpdateSessionPayload {
                    id: created.id.clone(),
                    name: "凭据测试已更新".to_owned(),
                    host: "127.0.0.1".to_owned(),
                    port: 22,
                    username: "root".to_owned(),
                    group: "测试".to_owned(),
                    tags: vec![],
                    auth: SessionAuthInput::Password,
                    credential: CredentialAction::Preserve,
                },
                &credentials,
            )
            .await
            .expect("保留凭据更新失败");
        assert_eq!(
            credentials
                .get(&created.id)
                .await
                .expect("读取凭据失败")
                .expect("凭据意外丢失")
                .as_str(),
            initial_secret.as_str()
        );

        let real_temp_path = service.temp_path.clone();
        let blocked_temp_path = directory.join("blocked-temp");
        fs::create_dir_all(&blocked_temp_path).expect("无法创建阻断目录");
        service.temp_path = blocked_temp_path;
        let failed = service
            .update(
                UpdateSessionPayload {
                    id: created.id.clone(),
                    name: "不应保存".to_owned(),
                    host: "127.0.0.1".to_owned(),
                    port: 22,
                    username: "root".to_owned(),
                    group: "测试".to_owned(),
                    tags: vec![],
                    auth: SessionAuthInput::Password,
                    credential: CredentialAction::Replace {
                        value: Zeroizing::new(Uuid::new_v4().to_string()),
                    },
                },
                &credentials,
            )
            .await;
        assert!(failed.is_err());
        service.temp_path = real_temp_path;
        assert_eq!(
            credentials
                .get(&created.id)
                .await
                .expect("回滚后读取凭据失败")
                .expect("回滚后凭据丢失")
                .as_str(),
            initial_secret.as_str()
        );

        service
            .delete(&created.id, &credentials)
            .await
            .expect("删除凭据会话失败");
        assert!(credentials
            .get(&created.id)
            .await
            .expect("删除后读取凭据失败")
            .is_none());
        let _ = fs::remove_dir_all(directory);
    }
}
