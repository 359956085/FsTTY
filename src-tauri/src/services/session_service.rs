use super::session_structure::{
    flatten_session_blocks, group_session_blocks, normalize_group, normalize_tags,
    DEFAULT_SESSION_GROUP,
};
mod credentials;
mod persistence;
mod validation;
use crate::models::{
    AppError, CreateSessionPayload, SessionGroup, SessionProfile, StoredSession,
    UpdateSessionPayload,
};
#[cfg(test)]
use crate::models::{
    CredentialAction, CredentialState, PrivateKeyMaterialAction, PrivateKeySource, SessionAuth,
    SessionAuthInput,
};
use crate::services::CredentialService;
use credentials::*;
use persistence::*;
use std::collections::HashSet;
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use validation::*;
#[cfg(test)]
use zeroize::Zeroizing;

const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;
const MAX_INLINE_PRIVATE_KEY_BYTES: usize = 16 * 1024;

pub struct SessionService {
    store: SessionStore,
    store_path: PathBuf,
    backup_path: PathBuf,
    temp_path: PathBuf,
    primary_trusted: bool,
    blocked_error: Option<AppError>,
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

    pub fn reorder_group(&mut self, group_name: &str, target_index: usize) -> Result<(), AppError> {
        self.ensure_writable()?;
        let mut groups = group_session_blocks(&self.store.sessions);
        if target_index >= groups.len() {
            return Err(AppError::Validation("分组目标位置无效".to_owned()));
        }
        let source_index = groups
            .iter()
            .position(|(name, _)| name == group_name)
            .ok_or_else(|| AppError::NotFound("未找到指定分组".to_owned()))?;
        if source_index == target_index {
            return Ok(());
        }

        let group = groups.remove(source_index);
        groups.insert(target_index, group);
        self.replace_sessions(flatten_session_blocks(groups))
    }

    pub fn reorder_session(
        &mut self,
        session_id: &str,
        target_group: &str,
        target_index: usize,
    ) -> Result<(), AppError> {
        self.ensure_writable()?;
        validate_id(session_id)?;
        validate_text("分组", target_group, 128, false)?;

        let mut groups = group_session_blocks(&self.store.sessions);
        let target_exists = groups.iter().any(|(name, _)| name == target_group);
        if !target_exists {
            return Err(AppError::NotFound("未找到目标分组".to_owned()));
        }
        let (source_group_index, source_session_index) = groups
            .iter()
            .enumerate()
            .find_map(|(group_index, (_, sessions))| {
                sessions
                    .iter()
                    .position(|session| session.id == session_id)
                    .map(|session_index| (group_index, session_index))
            })
            .ok_or_else(|| AppError::NotFound("未找到指定会话".to_owned()))?;
        let source_group = groups[source_group_index].0.clone();
        if source_group == target_group && source_session_index == target_index {
            return Ok(());
        }

        let mut session = groups[source_group_index].1.remove(source_session_index);
        if groups[source_group_index].1.is_empty() {
            groups.remove(source_group_index);
        }
        let target_group_index = groups
            .iter()
            .position(|(name, _)| name == target_group)
            .or_else(|| {
                if source_group == target_group {
                    groups.push((target_group.to_owned(), Vec::new()));
                    Some(groups.len() - 1)
                } else {
                    None
                }
            })
            .ok_or_else(|| AppError::NotFound("未找到目标分组".to_owned()))?;
        let target_sessions = &mut groups[target_group_index].1;
        if target_index > target_sessions.len() {
            return Err(AppError::Validation("会话目标位置无效".to_owned()));
        }
        session.group = target_group.to_owned();
        target_sessions.insert(target_index, session);
        self.replace_sessions(flatten_session_blocks(groups))
    }

    pub fn rename_group(&mut self, group_name: &str, new_name: &str) -> Result<(), AppError> {
        self.ensure_writable()?;
        validate_text("分组", new_name, 128, false)?;
        let new_name = new_name.trim();
        if group_name == DEFAULT_SESSION_GROUP || new_name == DEFAULT_SESSION_GROUP {
            return Err(AppError::Validation("系统默认分组不能重命名".to_owned()));
        }
        if !self
            .store
            .sessions
            .iter()
            .any(|session| session.group == group_name)
        {
            return Err(AppError::NotFound("未找到指定分组".to_owned()));
        }
        if group_name == new_name {
            return Ok(());
        }
        if self
            .store
            .sessions
            .iter()
            .any(|session| session.group == new_name)
        {
            return Err(AppError::Validation("分组名称已存在".to_owned()));
        }

        let previous = self.store.clone();
        for session in &mut self.store.sessions {
            if session.group == group_name {
                session.group = new_name.to_owned();
            }
        }
        if let Err(error) = self.persist() {
            self.store = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn session_ids_in_group(&self, group_name: &str) -> Result<Vec<String>, AppError> {
        self.ensure_readable()?;
        if group_name == DEFAULT_SESSION_GROUP {
            return Err(AppError::Validation("系统默认分组不能删除".to_owned()));
        }
        let session_ids = self
            .store
            .sessions
            .iter()
            .filter(|session| session.group == group_name)
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        if session_ids.is_empty() {
            return Err(AppError::NotFound("未找到指定分组".to_owned()));
        }
        Ok(session_ids)
    }

    pub async fn delete_group(
        &mut self,
        group_name: &str,
        credentials: &CredentialService,
    ) -> Result<Vec<String>, AppError> {
        self.ensure_writable()?;
        let session_ids = self.session_ids_in_group(group_name)?;
        let deleted_ids = session_ids.iter().cloned().collect::<HashSet<_>>();
        let previous = self.store.clone();
        self.store
            .sessions
            .retain(|session| !deleted_ids.contains(&session.id));
        for session_id in &session_ids {
            if !self
                .store
                .pending_credential_cleanup_ids
                .contains(session_id)
            {
                self.store
                    .pending_credential_cleanup_ids
                    .push(session_id.clone());
            }
        }
        if let Err(error) = self.persist() {
            self.store = previous;
            return Err(error);
        }

        let mut cleaned_ids = HashSet::new();
        for session_id in &session_ids {
            if credentials.delete_all(session_id).await.is_ok() {
                cleaned_ids.insert(session_id.clone());
            }
        }
        if !cleaned_ids.is_empty() {
            let before_cleanup = self.store.clone();
            self.store
                .pending_credential_cleanup_ids
                .retain(|id| !cleaned_ids.contains(id));
            if self.persist().is_err() {
                self.store = before_cleanup;
            }
        }
        Ok(session_ids)
    }

    fn replace_sessions(&mut self, sessions: Vec<StoredSession>) -> Result<(), AppError> {
        let previous = self.store.clone();
        self.store.sessions = sessions;
        if let Err(error) = self.persist() {
            self.store = previous;
            return Err(error);
        }
        Ok(())
    }
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

    fn grouped_session(name: &str, group: &str) -> StoredSession {
        let mut session = sample_session(name);
        session.group = group.to_owned();
        session
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
    fn reorders_group_blocks_and_sessions() {
        let directory = test_directory("session-order");
        let mut service = SessionService::load(&directory);
        let a1 = grouped_session("a1", "A");
        let a1_id = a1.id.clone();
        let a2 = grouped_session("a2", "A");
        let b1 = grouped_session("b1", "B");
        let b1_id = b1.id.clone();
        let c1 = grouped_session("c1", "C");
        service.store.sessions = vec![a1, a2, b1, c1];

        service.reorder_group("A", 2).expect("无法调整分组顺序");
        assert_eq!(
            service
                .store
                .sessions
                .iter()
                .map(|session| session.group.as_str())
                .collect::<Vec<_>>(),
            vec!["B", "C", "A", "A"]
        );

        service
            .reorder_session(&a1_id, "A", 1)
            .expect("无法调整组内会话顺序");
        let group_a_names = service
            .store
            .sessions
            .iter()
            .filter(|session| session.group == "A")
            .map(|session| session.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(group_a_names, vec!["a2", "a1"]);

        service
            .reorder_session(&b1_id, "C", 1)
            .expect("无法跨组移动会话");
        assert!(!service
            .store
            .sessions
            .iter()
            .any(|session| session.group == "B"));
        assert_eq!(
            service
                .store
                .sessions
                .iter()
                .filter(|session| session.group == "C")
                .map(|session| session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["c1", "b1"]
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn renames_groups_and_protects_default_group() {
        let directory = test_directory("group-management");
        let mut service = SessionService::load(&directory);
        service.store.sessions = vec![
            grouped_session("a1", "A"),
            grouped_session("b1", "B"),
            grouped_session("default", DEFAULT_SESSION_GROUP),
        ];

        service.rename_group("A", "生产").expect("无法重命名分组");
        assert_eq!(service.store.sessions[0].group, "生产");
        assert!(service.rename_group("生产", "B").is_err());
        assert!(service.rename_group(DEFAULT_SESSION_GROUP, "其他").is_err());
        assert!(service.session_ids_in_group(DEFAULT_SESSION_GROUP).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn deletes_group_sessions_and_keeps_other_groups() {
        let directory = test_directory("group-delete");
        let credentials = CredentialService::new();
        let mut service = SessionService::load(&directory);
        let first = grouped_session("a1", "A");
        let second = grouped_session("a2", "A");
        let expected_ids = vec![first.id.clone(), second.id.clone()];
        service.store.sessions = vec![first, second, grouped_session("b1", "B")];

        let deleted_ids = service
            .delete_group("A", &credentials)
            .await
            .expect("无法删除分组");
        assert_eq!(deleted_ids, expected_ids);
        assert_eq!(service.store.sessions.len(), 1);
        assert_eq!(service.store.sessions[0].group, "B");
        let _ = fs::remove_dir_all(directory);
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
