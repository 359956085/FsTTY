use crate::models::{
    AppError, CreateSessionPayload, CredentialAction, CredentialState, LoginSaveDecision,
    PrivateKeyMaterialAction, PrivateKeySource, SessionAuth, SessionAuthInput, SessionGroup,
    SessionProfile, StoredSession, UpdateSessionPayload,
};
use crate::services::CredentialService;
use russh::keys::{decode_secret_key, load_secret_key};
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
const MAX_INLINE_PRIVATE_KEY_BYTES: usize = 16 * 1024;

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

struct AuthChanges {
    credential: SecretChange,
    private_key: SecretChange,
}

struct SecretSnapshot {
    credential: Option<Zeroizing<String>>,
    private_key: Option<Zeroizing<String>>,
}

impl AuthChanges {
    fn changed(&self) -> bool {
        !matches!(self.credential, SecretChange::Preserve)
            || !matches!(self.private_key, SecretChange::Preserve)
    }
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
        validate_auth_username(&payload.username, &payload.auth)?;
        validate_password_username(
            &payload.username,
            &payload.auth,
            &payload.credential,
            None,
            credentials,
        )
        .await?;

        let id = Uuid::new_v4().to_string();
        let (auth, changes) =
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
            login_save_prompted: false,
        };
        let snapshot = SecretSnapshot {
            credential: None,
            private_key: None,
        };
        if let Err(error) = apply_auth_changes(&id, &changes, &snapshot, credentials).await {
            if credentials.delete_all(&id).await.is_err() {
                self.queue_credential_cleanup(&id);
                let _ = self.persist();
            }
            return Err(error);
        }
        let credential_state = match resolve_credential_state(&session, credentials).await {
            Ok(state) => state,
            Err(error) => {
                if credentials.delete_all(&id).await.is_err() {
                    self.queue_credential_cleanup(&id);
                    let _ = self.persist();
                }
                return Err(error);
            }
        };
        let previous = self.store.clone();
        self.store.sessions.push(session.clone());
        if let Err(error) = self.persist() {
            self.store = previous;
            if changes.changed() && credentials.delete_all(&id).await.is_err() {
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
        validate_auth_username(&payload.username, &payload.auth)?;
        let old_session = self.find(&payload.id)?;
        validate_password_username(
            &payload.username,
            &payload.auth,
            &payload.credential,
            Some(&old_session),
            credentials,
        )
        .await?;
        let (auth, changes) = prepare_auth(
            &payload.id,
            payload.auth,
            payload.credential,
            Some(&old_session),
            credentials,
        )
        .await?;
        let snapshot = if changes.changed() {
            snapshot_secrets(&payload.id, &changes, credentials).await?
        } else {
            SecretSnapshot {
                credential: None,
                private_key: None,
            }
        };
        let connection_invalidated = changes.changed()
            || old_session.host != payload.host.trim()
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
            login_save_prompted: old_session.login_save_prompted,
        };
        apply_auth_changes(&payload.id, &changes, &snapshot, credentials).await?;
        let credential_state = match resolve_credential_state(&updated, credentials).await {
            Ok(state) => state,
            Err(error) => {
                if changes.changed() {
                    restore_secrets(&payload.id, &snapshot, credentials)
                        .await
                        .map_err(|_| {
                            AppError::Credential("无法读取新凭据状态，且旧凭据回滚失败".to_owned())
                        })?;
                }
                return Err(error);
            }
        };
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
            if changes.changed() {
                restore_secrets(&payload.id, &snapshot, credentials)
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

        if credentials.delete_all(session_id).await.is_ok() {
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
        if !matches!(
            session.auth,
            SessionAuth::Password
                | SessionAuth::PrivateKey {
                    passphrase_required: true,
                    ..
                }
        ) {
            return Err(AppError::Validation(
                "当前认证方式不需要保存口令".to_owned(),
            ));
        }
        if let SessionAuth::PrivateKey { source, path, .. } = &session.auth {
            match source {
                PrivateKeySource::File => {
                    validate_private_key_file(
                        path.as_deref()
                            .ok_or_else(|| AppError::Persistence("私钥文件路径缺失".to_owned()))?,
                        Some(&value),
                    )
                    .await?;
                }
                PrivateKeySource::Inline => {
                    let private_key =
                        credentials
                            .get_private_key(session_id)
                            .await?
                            .ok_or_else(|| {
                                AppError::Credential("已保存私钥缺失，请重新粘贴".to_owned())
                            })?;
                    validate_inline_private_key(private_key, Some(&value)).await?;
                }
            }
        }
        credentials.set(session_id, value).await?;
        Ok(profile_with_state(session, CredentialState::Stored))
    }

    pub async fn resolve_login_save_prompt(
        &mut self,
        session_id: &str,
        decision: LoginSaveDecision,
        credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        self.ensure_writable()?;
        validate_id(session_id)?;
        let current = self.find(session_id)?;
        if !matches!(current.auth, SessionAuth::Password) {
            return Err(AppError::Validation(
                "只有密码认证会话可以保存登录信息".to_owned(),
            ));
        }
        if current.login_save_prompted {
            let state = resolve_credential_state(&current, credentials).await?;
            return Ok(profile_with_state(current, state));
        }

        let (next_username, next_password) = match decision {
            LoginSaveDecision::Decline => (current.username.clone(), None),
            LoginSaveDecision::Save { username, password } => {
                let normalized_username = username.map(|value| value.trim().to_owned());
                if let Some(value) = normalized_username.as_deref() {
                    validate_text("用户名", value, 128, false)?;
                    if !current.username.is_empty() && current.username != value {
                        return Err(AppError::Validation(
                            "临时账号与会话中已保存账号不一致".to_owned(),
                        ));
                    }
                }
                let next_username = normalized_username.unwrap_or_else(|| current.username.clone());
                if next_username.is_empty() {
                    return Err(AppError::Validation(
                        "保存密码时必须同时保存账号".to_owned(),
                    ));
                }
                if password.as_ref().is_some_and(|value| value.is_empty()) {
                    return Err(AppError::Validation("密码不能为空".to_owned()));
                }
                if next_username == current.username && password.is_none() {
                    return Err(AppError::Validation("没有可保存的登录信息".to_owned()));
                }
                (next_username, password)
            }
        };

        let password_changed = next_password.is_some();
        let credential_snapshot = if password_changed {
            credentials.get(session_id).await?
        } else {
            None
        };
        if let Some(password) = next_password {
            credentials.set(session_id, password).await?;
        }

        let previous = self.store.clone();
        let target = self
            .store
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or_else(|| AppError::NotFound("未找到指定会话".to_owned()))?;
        target.username = next_username;
        target.login_save_prompted = true;
        let updated = target.clone();
        if let Err(error) = self.persist() {
            self.store = previous;
            let rollback = if password_changed {
                match credential_snapshot {
                    Some(value) => credentials.set(session_id, value).await,
                    None => credentials.delete(session_id).await,
                }
            } else {
                Ok(())
            };
            if rollback.is_err() {
                return Err(AppError::Credential(
                    "登录信息保存失败，且旧密码回滚失败，请重新检查凭据".to_owned(),
                ));
            }
            return Err(error);
        }
        let state = resolve_credential_state(&updated, credentials).await?;
        Ok(profile_with_state(updated, state))
    }

    async fn profile(
        &self,
        stored: StoredSession,
        credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        let credential_state = resolve_credential_state(&stored, credentials).await?;
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
            if credentials.delete_all(&id).await.is_err() {
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
) -> Result<(SessionAuth, AuthChanges), AppError> {
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
                    // 不保存密码时保持会话可用，连接前再统一询问。
                    SecretChange::Delete
                }
                CredentialAction::UseOnce { .. } => {
                    return Err(AppError::Validation(
                        "一次性凭据仅用于校验新私钥".to_owned(),
                    ))
                }
            };
            Ok((
                SessionAuth::Password,
                AuthChanges {
                    credential: change,
                    private_key: if matches!(
                        old.map(|session| &session.auth),
                        Some(SessionAuth::PrivateKey { .. })
                    ) {
                        SecretChange::Delete
                    } else {
                        SecretChange::Preserve
                    },
                },
            ))
        }
        SessionAuthInput::PrivateKey {
            source: PrivateKeySource::File,
            path,
            material,
        } => {
            if material.is_some() {
                return Err(AppError::Validation(
                    "文件私钥不能包含粘贴私钥内容".to_owned(),
                ));
            }
            let canonical_path = validate_private_key_path(
                path.as_deref()
                    .ok_or_else(|| AppError::Validation("请选择私钥文件".to_owned()))?,
            )
            .await?;
            let same_key = matches!(
                old.map(|session| &session.auth),
                Some(SessionAuth::PrivateKey {
                    source: PrivateKeySource::File,
                    path: Some(path),
                    ..
                }) if path == &canonical_path
            );
            if matches!(&action, CredentialAction::Preserve) && old.is_some() && !same_key {
                return Err(AppError::Validation(
                    "切换私钥时必须重新确认私钥口令".to_owned(),
                ));
            }

            let private_key_change = if matches!(
                old.map(|session| &session.auth),
                Some(SessionAuth::PrivateKey {
                    source: PrivateKeySource::Inline,
                    ..
                })
            ) {
                SecretChange::Delete
            } else {
                SecretChange::Preserve
            };

            if validate_private_key_file(&canonical_path, None)
                .await
                .is_ok()
            {
                return Ok((
                    SessionAuth::PrivateKey {
                        source: PrivateKeySource::File,
                        path: Some(canonical_path),
                        passphrase_required: false,
                    },
                    AuthChanges {
                        credential: if old.is_some()
                            && (!same_key || old.is_some_and(StoredSession::requires_passphrase))
                        {
                            SecretChange::Delete
                        } else {
                            SecretChange::Preserve
                        },
                        private_key: private_key_change,
                    },
                ));
            }

            let change = match action {
                CredentialAction::Replace { value } => {
                    validate_private_key_file(&canonical_path, Some(&value)).await?;
                    SecretChange::Set(value)
                }
                CredentialAction::UseOnce { value } => {
                    validate_private_key_file(&canonical_path, Some(&value)).await?;
                    SecretChange::Delete
                }
                CredentialAction::Preserve if same_key => {
                    let value = credentials.get(session_id).await?.ok_or_else(|| {
                        AppError::Credential("私钥口令缺失，请重新输入".to_owned())
                    })?;
                    validate_private_key_file(&canonical_path, Some(&value)).await?;
                    SecretChange::Preserve
                }
                CredentialAction::Clear if same_key => SecretChange::Delete,
                CredentialAction::Clear => {
                    return Err(AppError::Credential(
                        "新私钥需要口令，请输入一次完成格式校验".to_owned(),
                    ))
                }
                CredentialAction::Preserve => {
                    return Err(AppError::Credential("请填写私钥口令".to_owned()))
                }
            };
            Ok((
                SessionAuth::PrivateKey {
                    source: PrivateKeySource::File,
                    path: Some(canonical_path),
                    passphrase_required: true,
                },
                AuthChanges {
                    credential: change,
                    private_key: private_key_change,
                },
            ))
        }
        SessionAuthInput::PrivateKey {
            source: PrivateKeySource::Inline,
            path,
            material,
        } => {
            if path.is_some() {
                return Err(AppError::Validation("粘贴私钥不能包含文件路径".to_owned()));
            }
            let old_is_inline = matches!(
                old.map(|session| &session.auth),
                Some(SessionAuth::PrivateKey {
                    source: PrivateKeySource::Inline,
                    ..
                })
            );
            let (private_key, private_key_change, material_preserved) = match material {
                Some(PrivateKeyMaterialAction::Replace { value }) => {
                    validate_inline_private_key_size(&value)?;
                    (value.clone(), SecretChange::Set(value), false)
                }
                Some(PrivateKeyMaterialAction::Preserve) if old_is_inline => {
                    let value =
                        credentials
                            .get_private_key(session_id)
                            .await?
                            .ok_or_else(|| {
                                AppError::Credential("已保存私钥缺失，请重新粘贴".to_owned())
                            })?;
                    (value, SecretChange::Preserve, true)
                }
                Some(PrivateKeyMaterialAction::Preserve) => {
                    return Err(AppError::Validation("请粘贴私钥内容".to_owned()))
                }
                None => return Err(AppError::Validation("粘贴私钥操作缺失".to_owned())),
            };

            if validate_inline_private_key(private_key.clone(), None)
                .await
                .is_ok()
            {
                return Ok((
                    SessionAuth::PrivateKey {
                        source: PrivateKeySource::Inline,
                        path: None,
                        passphrase_required: false,
                    },
                    AuthChanges {
                        credential: if old.is_some()
                            && (!material_preserved
                                || old.is_some_and(StoredSession::requires_passphrase))
                        {
                            SecretChange::Delete
                        } else {
                            SecretChange::Preserve
                        },
                        private_key: private_key_change,
                    },
                ));
            }

            let credential_change = match action {
                CredentialAction::Replace { value } => {
                    validate_inline_private_key(private_key, Some(&value)).await?;
                    SecretChange::Set(value)
                }
                CredentialAction::UseOnce { value } => {
                    validate_inline_private_key(private_key, Some(&value)).await?;
                    SecretChange::Delete
                }
                CredentialAction::Preserve if material_preserved => {
                    let value = credentials.get(session_id).await?.ok_or_else(|| {
                        AppError::Credential("私钥口令缺失，请重新输入".to_owned())
                    })?;
                    validate_inline_private_key(private_key, Some(&value)).await?;
                    SecretChange::Preserve
                }
                CredentialAction::Clear if material_preserved => SecretChange::Delete,
                CredentialAction::Clear => {
                    return Err(AppError::Credential(
                        "新私钥需要口令，请输入一次完成格式校验".to_owned(),
                    ))
                }
                CredentialAction::Preserve => {
                    return Err(AppError::Credential("请填写私钥口令".to_owned()))
                }
            };
            Ok((
                SessionAuth::PrivateKey {
                    source: PrivateKeySource::Inline,
                    path: None,
                    passphrase_required: true,
                },
                AuthChanges {
                    credential: credential_change,
                    private_key: private_key_change,
                },
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

async fn validate_private_key_file(path: &str, passphrase: Option<&str>) -> Result<(), AppError> {
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

fn validate_inline_private_key_size(value: &str) -> Result<(), AppError> {
    if value.is_empty() || value.len() > MAX_INLINE_PRIVATE_KEY_BYTES {
        return Err(AppError::Validation(
            "粘贴私钥不能为空，且不能超过 16384 字节".to_owned(),
        ));
    }
    Ok(())
}

async fn validate_inline_private_key(
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

async fn apply_auth_changes(
    session_id: &str,
    changes: &AuthChanges,
    snapshot: &SecretSnapshot,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    let result = async {
        apply_private_key_change(session_id, &changes.private_key, credentials).await?;
        apply_credential_change(session_id, &changes.credential, credentials).await
    }
    .await;
    if let Err(error) = result {
        restore_secrets(session_id, snapshot, credentials)
            .await
            .map_err(|_| {
                AppError::Credential(
                    "系统凭据更新失败，且旧凭据回滚失败，请重新检查凭据".to_owned(),
                )
            })?;
        return Err(error);
    }
    Ok(())
}

async fn apply_credential_change(
    session_id: &str,
    change: &SecretChange,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    match change {
        SecretChange::Preserve => Ok(()),
        SecretChange::Set(value) => credentials.set(session_id, value.clone()).await,
        SecretChange::Delete => credentials.delete(session_id).await,
    }
}

async fn apply_private_key_change(
    session_id: &str,
    change: &SecretChange,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    match change {
        SecretChange::Preserve => Ok(()),
        SecretChange::Set(value) => credentials.set_private_key(session_id, value.clone()).await,
        SecretChange::Delete => credentials.delete_private_key(session_id).await,
    }
}

async fn snapshot_secrets(
    session_id: &str,
    changes: &AuthChanges,
    credentials: &CredentialService,
) -> Result<SecretSnapshot, AppError> {
    let private_key = if matches!(changes.private_key, SecretChange::Preserve) {
        credentials.get_private_key(session_id).await?
    } else {
        // 替换或删除时允许清除已损坏分块；其他凭据库错误仍必须阻止更新。
        credentials.get_private_key_snapshot(session_id).await?
    };
    Ok(SecretSnapshot {
        credential: credentials.get(session_id).await?,
        private_key,
    })
}

async fn restore_secrets(
    session_id: &str,
    snapshot: &SecretSnapshot,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    let private_key_result = match &snapshot.private_key {
        Some(value) => credentials.set_private_key(session_id, value.clone()).await,
        None => credentials.delete_private_key(session_id).await,
    };
    let credential_result = match &snapshot.credential {
        Some(value) => credentials.set(session_id, value.clone()).await,
        None => credentials.delete(session_id).await,
    };
    private_key_result.and(credential_result)
}

async fn resolve_credential_state(
    session: &StoredSession,
    credentials: &CredentialService,
) -> Result<CredentialState, AppError> {
    match &session.auth {
        SessionAuth::Password => Ok(if credentials.get(&session.id).await?.is_some() {
            CredentialState::Stored
        } else {
            CredentialState::Missing
        }),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::File,
            passphrase_required: false,
            ..
        } => Ok(CredentialState::NotRequired),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::File,
            passphrase_required: true,
            ..
        } => Ok(if credentials.get(&session.id).await?.is_some() {
            CredentialState::Stored
        } else {
            CredentialState::Missing
        }),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            passphrase_required,
            ..
        } => {
            let has_private_key = credentials.private_key_is_complete(&session.id).await?;
            let has_passphrase =
                !passphrase_required || credentials.get(&session.id).await?.is_some();
            Ok(if has_private_key && has_passphrase {
                CredentialState::Stored
            } else {
                CredentialState::Missing
            })
        }
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
        if let SessionAuth::PrivateKey { source, path, .. } = &session.auth {
            match (source, path.as_deref()) {
                (PrivateKeySource::File, Some(path))
                    if path.len() <= 4096
                        && Path::new(path).is_absolute()
                        && !path.chars().any(char::is_control) => {}
                (PrivateKeySource::Inline, None) => {}
                _ => return Err(AppError::Persistence("私钥来源或路径无效".to_owned())),
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
fn validate_auth_username(username: &str, auth: &SessionAuthInput) -> Result<(), AppError> {
    if matches!(auth, SessionAuthInput::PrivateKey { .. }) && username.trim().is_empty() {
        return Err(AppError::Validation("私钥认证必须填写账号".to_owned()));
    }
    Ok(())
}

async fn validate_password_username(
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
    use russh::keys::ssh_key::rand_core::{TryCryptoRng, TryRng};
    use std::convert::Infallible;

    struct TestRng;

    impl TryRng for TestRng {
        type Error = Infallible;

        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            let bytes = Uuid::new_v4().into_bytes();
            Ok(u32::from_le_bytes(
                bytes[..4].try_into().expect("UUID 长度无效"),
            ))
        }

        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            let bytes = Uuid::new_v4().into_bytes();
            Ok(u64::from_le_bytes(
                bytes[..8].try_into().expect("UUID 长度无效"),
            ))
        }

        fn try_fill_bytes(&mut self, destination: &mut [u8]) -> Result<(), Self::Error> {
            for chunk in destination.chunks_mut(16) {
                let bytes = Uuid::new_v4().into_bytes();
                chunk.copy_from_slice(&bytes[..chunk.len()]);
            }
            Ok(())
        }
    }

    impl TryCryptoRng for TestRng {}

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
            login_save_prompted: false,
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
            login_save_prompted: false,
        };
        let store = SessionStore {
            version: STORE_VERSION,
            sessions: vec![session.clone(), session],
            pending_credential_cleanup_ids: vec![],
        };
        assert!(validate_store(&store).is_err());
    }

    #[test]
    fn requires_username_only_for_private_key_input() {
        let private_key = SessionAuthInput::PrivateKey {
            source: PrivateKeySource::Inline,
            path: None,
            material: Some(PrivateKeyMaterialAction::Preserve),
        };
        assert!(validate_auth_username("", &private_key).is_err());
        assert!(validate_auth_username("  ", &private_key).is_err());
        assert!(validate_auth_username("root", &private_key).is_ok());
        assert!(validate_auth_username("", &SessionAuthInput::Password).is_ok());
    }

    #[tokio::test]
    async fn password_requires_username_only_when_password_is_present() {
        let credentials = CredentialService::new();
        let password_auth = SessionAuthInput::Password;
        assert!(validate_password_username(
            "",
            &password_auth,
            &CredentialAction::Replace {
                value: Zeroizing::new("secret".to_owned()),
            },
            None,
            &credentials,
        )
        .await
        .is_err());
        assert!(validate_password_username(
            "",
            &password_auth,
            &CredentialAction::Clear,
            None,
            &credentials,
        )
        .await
        .is_ok());
        assert!(validate_password_username(
            "root",
            &password_auth,
            &CredentialAction::Replace {
                value: Zeroizing::new("secret".to_owned()),
            },
            None,
            &credentials,
        )
        .await
        .is_ok());
    }

    #[test]
    fn normalizes_tags_without_changing_order() {
        assert_eq!(
            normalize_tags(vec![" Web ".to_owned(), "web".to_owned(), "DB".to_owned()]),
            vec!["Web".to_owned(), "DB".to_owned()]
        );
    }

    #[test]
    fn loads_legacy_private_key_session_with_empty_username_without_migration() {
        let directory = test_directory("legacy-private-key");
        fs::create_dir_all(&directory).expect("无法创建测试目录");
        let session_id = Uuid::new_v4().to_string();
        let private_key_path = directory.join("id_ed25519").to_string_lossy().to_string();
        let legacy = serde_json::json!({
            "version": STORE_VERSION,
            "sessions": [{
                "id": session_id,
                "name": "旧私钥会话",
                "host": "127.0.0.1",
                "port": 22,
                "username": "",
                "group": "未分组",
                "tags": [],
                "auth": {
                    "kind": "privateKey",
                    "path": private_key_path,
                    "passphrase_required": false
                }
            }],
            "pendingCredentialCleanupIds": []
        });
        fs::write(
            directory.join(STORE_FILE),
            serde_json::to_vec_pretty(&legacy).expect("无法生成旧会话数据"),
        )
        .expect("无法写入旧会话数据");

        let service = SessionService::load(&directory);
        assert!(service.blocked_error.is_none());
        assert!(service.store.sessions[0].username.is_empty());
        assert!(matches!(
            service.store.sessions[0].auth,
            SessionAuth::PrivateKey {
                source: PrivateKeySource::File,
                path: Some(_),
                passphrase_required: false,
            }
        ));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn validates_inline_private_key_store_shape() {
        let mut session = sample_session("粘贴私钥");
        session.auth = SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            path: None,
            passphrase_required: false,
        };
        let mut store = SessionStore {
            version: STORE_VERSION,
            sessions: vec![session],
            pending_credential_cleanup_ids: vec![],
        };
        assert!(validate_store(&store).is_ok());

        if let SessionAuth::PrivateKey { path, .. } = &mut store.sessions[0].auth {
            *path = Some("不应出现路径".to_owned());
        }
        assert!(validate_store(&store).is_err());
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
    async fn validates_plain_and_encrypted_pasted_private_keys() {
        use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey};

        // 运行时生成测试材料，仓库中不保存任何固定私钥。
        let mut random = TestRng;
        let private_key =
            PrivateKey::random(&mut random, Algorithm::Ed25519).expect("无法生成测试私钥");
        let plain = private_key
            .to_openssh(LineEnding::LF)
            .expect("无法编码测试私钥");
        assert!(validate_inline_private_key(plain, None).await.is_ok());

        let encrypted = private_key
            .encrypt(&mut random, "正确口令")
            .expect("无法加密测试私钥")
            .to_openssh(LineEnding::LF)
            .expect("无法编码加密测试私钥");
        assert!(validate_inline_private_key(encrypted.clone(), None)
            .await
            .is_err());
        assert!(
            validate_inline_private_key(encrypted.clone(), Some("错误口令"))
                .await
                .is_err()
        );
        assert!(validate_inline_private_key(encrypted, Some("正确口令"))
            .await
            .is_ok());
    }

    #[tokio::test]
    #[ignore = "需要使用当前系统凭据库"]
    async fn credential_lifecycle_smoke() {
        let directory = test_directory("credential-store");
        let credentials = CredentialService::new();
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

        let inline_private_key = Zeroizing::new("A".repeat(16 * 1024));
        credentials
            .set_private_key(&created.id, inline_private_key.clone())
            .await
            .expect("无法保存分块私钥");
        assert_eq!(
            credentials
                .get_private_key(&created.id)
                .await
                .expect("无法读取分块私钥")
                .expect("分块私钥意外丢失")
                .as_str(),
            inline_private_key.as_str()
        );
        let replacement_private_key = Zeroizing::new("B".repeat(2_049));
        credentials
            .set_private_key(&created.id, replacement_private_key.clone())
            .await
            .expect("无法替换分块私钥");
        assert_eq!(
            credentials
                .get_private_key(&created.id)
                .await
                .expect("无法读取替换后的分块私钥")
                .expect("替换后的分块私钥意外丢失")
                .as_str(),
            replacement_private_key.as_str()
        );
        let content_after_private_key =
            fs::read_to_string(directory.join(STORE_FILE)).expect("无法重新读取会话文件");
        assert!(!content_after_private_key.contains(inline_private_key.as_str()));
        assert!(!content_after_private_key.contains(replacement_private_key.as_str()));

        let (_, preserve_invalidated) = service
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
        assert!(!preserve_invalidated);
        assert_eq!(
            credentials
                .get(&created.id)
                .await
                .expect("读取凭据失败")
                .expect("凭据意外丢失")
                .as_str(),
            initial_secret.as_str()
        );

        let replacement_secret = Zeroizing::new(Uuid::new_v4().to_string());
        let (_, replacement_invalidated) = service
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
                    credential: CredentialAction::Replace {
                        value: replacement_secret.clone(),
                    },
                },
                &credentials,
            )
            .await
            .expect("替换凭据更新失败");
        assert!(replacement_invalidated);
        assert_eq!(
            credentials
                .get(&created.id)
                .await
                .expect("替换后读取凭据失败")
                .expect("替换后凭据丢失")
                .as_str(),
            replacement_secret.as_str()
        );

        drop(credentials);
        let credentials = CredentialService::new();
        assert_eq!(
            credentials
                .get(&created.id)
                .await
                .expect("重新初始化后读取凭据失败")
                .expect("重新初始化后凭据丢失")
                .as_str(),
            replacement_secret.as_str()
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
            replacement_secret.as_str()
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
        assert!(credentials
            .get_private_key(&created.id)
            .await
            .expect("删除后读取私钥失败")
            .is_none());
        let _ = fs::remove_dir_all(directory);
    }
}
