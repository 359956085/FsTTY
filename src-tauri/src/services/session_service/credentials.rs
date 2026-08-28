use super::{
    validation::{
        validate_id, validate_inline_private_key, validate_inline_private_key_size,
        validate_private_key_file, validate_private_key_path, validate_text,
    },
    SessionService,
};
use crate::models::{
    AppError, CredentialAction, CredentialState, LoginSaveDecision, PrivateKeyMaterialAction,
    PrivateKeySource, SessionAuth, SessionAuthInput, SessionProfile, StoredSession,
};
use crate::services::CredentialService;
use zeroize::Zeroizing;

pub(super) enum SecretChange {
    Preserve,
    Set(Zeroizing<String>),
    Delete,
}

pub(super) struct AuthChanges {
    pub(super) credential: SecretChange,
    pub(super) private_key: SecretChange,
}

pub(super) struct SecretSnapshot {
    pub(super) credential: Option<Zeroizing<String>>,
    pub(super) private_key: Option<Zeroizing<String>>,
}

impl AuthChanges {
    pub(super) fn changed(&self) -> bool {
        !matches!(self.credential, SecretChange::Preserve)
            || !matches!(self.private_key, SecretChange::Preserve)
    }
}

impl SessionService {
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

    pub(super) async fn profile(
        &self,
        stored: StoredSession,
        credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        let credential_state = resolve_credential_state(&stored, credentials).await?;
        let mut profile = SessionProfile::from(stored);
        profile.credential_state = credential_state;
        Ok(profile)
    }

    pub(super) async fn retry_pending_cleanup(&mut self, credentials: &CredentialService) {
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

    pub(super) async fn cleanup_credentials_or_queue(
        &mut self,
        session_id: &str,
        credentials: &CredentialService,
    ) {
        if credentials.delete_all(session_id).await.is_err() {
            self.queue_credential_cleanup(session_id);
            let _ = self.persist();
        }
    }

    pub(super) fn queue_credential_cleanup(&mut self, session_id: &str) {
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
}

pub(super) async fn prepare_auth(
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
                    ));
                }
                CredentialAction::Clear => {
                    // 不保存密码时保持会话可用，连接前再统一询问。
                    SecretChange::Delete
                }
                CredentialAction::UseOnce { .. } => {
                    return Err(AppError::Validation(
                        "一次性凭据仅用于校验新私钥".to_owned(),
                    ));
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
                    ));
                }
                CredentialAction::Preserve => {
                    return Err(AppError::Credential("请填写私钥口令".to_owned()));
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
                    return Err(AppError::Validation("请粘贴私钥内容".to_owned()));
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
                    ));
                }
                CredentialAction::Preserve => {
                    return Err(AppError::Credential("请填写私钥口令".to_owned()));
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

pub(super) async fn apply_auth_changes(
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

pub(super) async fn snapshot_secrets(
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

pub(super) async fn restore_secrets(
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

pub(super) async fn resolve_credential_state(
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

pub(super) fn profile_with_state(
    stored: StoredSession,
    credential_state: CredentialState,
) -> SessionProfile {
    let mut profile = SessionProfile::from(stored);
    profile.credential_state = credential_state;
    profile
}
