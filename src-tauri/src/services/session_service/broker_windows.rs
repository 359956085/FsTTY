use super::*;
use crate::{
    models::{
        CredentialAction, CredentialState, LoginSaveDecision, PrivateKeyMaterialAction,
        PrivateKeySource, SessionAuth, SessionAuthInput,
    },
    services::broker_service as broker,
};
use fstty_broker::protocol::Profile;
use zeroize::Zeroizing;

fn state(profile: Option<&Profile>) -> CredentialState {
    match profile {
        Some(p) if p.cleanup_pending => CredentialState::CleanupPending,
        Some(_) => CredentialState::Stored,
        None => CredentialState::MigrationRequired,
    }
}
fn auth(input: &SessionAuthInput) -> Result<SessionAuth, AppError> {
    match input {
        SessionAuthInput::Password => Ok(SessionAuth::Password),
        SessionAuthInput::PrivateKey { material, .. } => {
            if matches!(material, Some(PrivateKeyMaterialAction::Replace { .. })) {
                return Err(AppError::Credential("请在安全窗口输入私钥".into()));
            }
            Ok(SessionAuth::PrivateKey {
                source: PrivateKeySource::Inline,
                path: None,
                passphrase_required: false,
            })
        }
    }
}
fn reject_secret(action: &CredentialAction) -> Result<(), AppError> {
    if matches!(
        action,
        CredentialAction::Replace { .. } | CredentialAction::UseOnce { .. }
    ) {
        return Err(AppError::Credential("请在安全窗口输入凭据".into()));
    }
    Ok(())
}

impl SessionService {
    pub fn with_settings(
        mut self,
        settings: std::sync::Arc<std::sync::Mutex<crate::services::SettingsService>>,
    ) -> Self {
        self.settings_service = Some(settings);
        self
    }

    fn proxy_snapshot(&self) -> Result<fstty_network::ProxySnapshot, AppError> {
        self.settings_service
            .as_ref()
            .ok_or_else(|| AppError::Internal("代理配置不可用".into()))?
            .lock()
            .map(|settings| settings.proxy_snapshot())
            .map_err(|_| AppError::Internal("代理配置不可用".into()))
    }

    pub async fn migrate_batch_to_broker(&mut self, ids: &[String]) -> Result<(), AppError> {
        self.ensure_writable()?;
        let sessions = ids
            .iter()
            .map(|id| self.find(id))
            .collect::<Result<Vec<_>, _>>()?;
        broker::migrate_batch(&sessions, &self.proxy_snapshot()?).await?;
        for id in ids {
            self.migrate_to_broker(id).await?;
        }
        Ok(())
    }
    pub async fn list_groups(
        &mut self,
        _credentials: &CredentialService,
    ) -> Result<Vec<SessionGroup>, AppError> {
        self.ensure_readable()?;
        let fetched = broker::profiles().await;
        let available = fetched.is_ok();
        let profiles = fetched.unwrap_or_default();
        let mut sessions = self.store.sessions.clone();
        // 服务审批已提交而界面元数据写入失败时，仍能重新找到托管会话。
        for profile in &profiles {
            if !sessions.iter().any(|s| s.id == profile.target.id) {
                sessions.push(StoredSession {
                    id: profile.target.id.clone(),
                    name: profile.target.host.clone(),
                    host: profile.target.host.clone(),
                    port: profile.target.port,
                    username: profile.target.username.clone(),
                    group: DEFAULT_SESSION_GROUP.into(),
                    tags: vec![],
                    auth: SessionAuth::Password,
                    login_save_prompted: true,
                });
            }
        }
        let mut groups = Vec::<SessionGroup>::new();
        for mut session in sessions.clone() {
            let profile = profiles.iter().find(|p| p.target.id == session.id);
            if let Some(profile) = profile {
                broker::apply_profile(&mut session, profile);
            }
            let mut visible = SessionProfile::from(session.clone());
            visible.credential_state = if available {
                state(profile)
            } else {
                CredentialState::ServiceUnavailable
            };
            if let Some(current) = sessions.iter_mut().find(|s| s.id == session.id) {
                *current = session;
            }
            if let Some(group) = groups.iter_mut().find(|g| g.name == visible.group) {
                group.sessions.push(visible);
            } else {
                groups.push(SessionGroup {
                    name: visible.group.clone(),
                    sessions: vec![visible],
                });
            }
        }
        // 仅将非秘密元数据同步至现有会话文件；连接始终由服务侧会话 ID 决定。
        if available && sessions != self.store.sessions {
            self.replace_sessions(sessions)?;
        }
        Ok(groups)
    }

    pub async fn create(
        &mut self,
        payload: CreateSessionPayload,
        _credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        self.ensure_writable()?;
        if self.store.sessions.len() >= MAX_SESSIONS {
            return Err(AppError::Validation("会话数量不能超过 500 个".into()));
        }
        validate_common(
            &payload.name,
            &payload.host,
            payload.port,
            &payload.username,
            &payload.group,
            &payload.tags,
        )?;
        reject_secret(&payload.credential)?;
        let mut session = StoredSession {
            id: uuid::Uuid::new_v4().to_string(),
            name: payload.name.trim().into(),
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            group: normalize_group(&payload.group),
            tags: normalize_tags(payload.tags),
            auth: auth(&payload.auth)?,
            login_save_prompted: true,
        };
        let approved =
            broker::configure(broker::target(&session), true, &self.proxy_snapshot()?).await?;
        broker::apply_profile(&mut session, &approved);
        let mut sessions = self.store.sessions.clone();
        sessions.push(session.clone());
        self.replace_sessions(sessions)?;
        let mut profile = SessionProfile::from(session);
        profile.credential_state = state(Some(&approved));
        Ok(profile)
    }

    pub async fn update(
        &mut self,
        payload: UpdateSessionPayload,
        _credentials: &CredentialService,
    ) -> Result<(SessionProfile, bool), AppError> {
        self.ensure_writable()?;
        validate_common(
            &payload.name,
            &payload.host,
            payload.port,
            &payload.username,
            &payload.group,
            &payload.tags,
        )?;
        reject_secret(&payload.credential)?;
        let old = self.find(&payload.id)?;
        let existing = broker::profiles()
            .await?
            .into_iter()
            .find(|p| p.target.id == payload.id);
        let mut session = StoredSession {
            id: payload.id,
            name: payload.name.trim().into(),
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            group: normalize_group(&payload.group),
            tags: normalize_tags(payload.tags),
            auth: auth(&payload.auth)?,
            login_save_prompted: true,
        };
        let target = broker::target(&session);
        let changed = existing
            .as_ref()
            .map_or_else(|| broker::target(&old) != target, |p| p.target != target);
        let approved = if changed {
            let replace = existing
                .as_ref()
                .is_none_or(|p| p.target.private_key != target.private_key);
            Some(broker::configure(target, replace, &self.proxy_snapshot()?).await?)
        } else {
            existing
        };
        if approved.is_none() {
            session.auth = old.auth.clone();
        }
        if let Some(profile) = &approved {
            broker::apply_profile(&mut session, profile);
        }
        let mut sessions = self.store.sessions.clone();
        *sessions
            .iter_mut()
            .find(|s| s.id == old.id)
            .ok_or_else(|| AppError::NotFound("会话不存在".into()))? = session.clone();
        self.replace_sessions(sessions)?;
        let mut profile = SessionProfile::from(session);
        profile.credential_state = state(approved.as_ref());
        Ok((profile, changed))
    }

    pub async fn migrate_to_broker(&mut self, id: &str) -> Result<SessionProfile, AppError> {
        self.ensure_writable()?;
        let mut session = self.find(id)?;
        let approved = broker::migrate(&session, &self.proxy_snapshot()?).await?;
        broker::apply_profile(&mut session, &approved);
        let mut sessions = self.store.sessions.clone();
        *sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| AppError::NotFound("会话不存在".into()))? = session.clone();
        self.replace_sessions(sessions)?;
        let mut profile = SessionProfile::from(session);
        profile.credential_state = state(Some(&approved));
        Ok(profile)
    }

    pub async fn manage_broker_credential(&mut self, id: &str) -> Result<SessionProfile, AppError> {
        self.ensure_writable()?;
        let mut session = self.find(id)?;
        let existing = broker::profiles()
            .await?
            .into_iter()
            .find(|p| p.target.id == id);
        if let Some(profile) = existing {
            broker::apply_profile(&mut session, &profile);
        }
        let approved =
            broker::configure(broker::target(&session), true, &self.proxy_snapshot()?).await?;
        broker::apply_profile(&mut session, &approved);
        let mut sessions = self.store.sessions.clone();
        *sessions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| AppError::NotFound("会话不存在".into()))? = session.clone();
        self.replace_sessions(sessions)?;
        let mut profile = SessionProfile::from(session);
        profile.credential_state = state(Some(&approved));
        Ok(profile)
    }

    pub async fn delete(
        &mut self,
        id: &str,
        _credentials: &CredentialService,
    ) -> Result<(), AppError> {
        self.ensure_writable()?;
        self.find(id)?;
        broker::delete(id).await?;
        let sessions = self
            .store
            .sessions
            .iter()
            .filter(|s| s.id != id)
            .cloned()
            .collect();
        self.replace_sessions(sessions)
    }
    pub async fn delete_group(
        &mut self,
        group: &str,
        _credentials: &CredentialService,
    ) -> Result<Vec<String>, AppError> {
        let ids = self.session_ids_in_group(group)?;
        broker::delete_batch(&ids).await?;
        let sessions = self
            .store
            .sessions
            .iter()
            .filter(|s| !ids.contains(&s.id))
            .cloned()
            .collect();
        self.replace_sessions(sessions)?;
        Ok(ids)
    }
    pub async fn set_credential(
        &self,
        _id: &str,
        _secret: Zeroizing<String>,
        _credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        Err(AppError::Credential("请使用安全管理窗口更换凭据".into()))
    }
    pub async fn resolve_login_save_prompt(
        &mut self,
        id: &str,
        decision: LoginSaveDecision,
        _credentials: &CredentialService,
    ) -> Result<SessionProfile, AppError> {
        if !matches!(decision, LoginSaveDecision::Decline) {
            return Err(AppError::Credential("请使用安全管理窗口保存凭据".into()));
        }
        let session = self.find(id)?;
        Ok(SessionProfile::from(session))
    }
}
