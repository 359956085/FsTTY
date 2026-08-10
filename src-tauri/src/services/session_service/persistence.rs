use super::{
    validation::{validate_common, validate_id},
    SessionService,
};
use crate::models::{AppError, PrivateKeySource, SessionAuth, StoredSession};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub(super) const STORE_VERSION: u8 = 1;
pub(super) const STORE_FILE: &str = "sessions.v1.json";
pub(super) const STORE_BACKUP_FILE: &str = "sessions.v1.json.bak";
pub(super) const STORE_TEMP_FILE: &str = "sessions.v1.json.tmp";
const MAX_STORE_BYTES: u64 = 4 * 1024 * 1024;
pub(super) const MAX_SESSIONS: usize = 500;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionStore {
    pub(super) version: u8,
    pub(super) sessions: Vec<StoredSession>,
    #[serde(default)]
    pub(super) pending_credential_cleanup_ids: Vec<String>,
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

pub(super) fn persist_store(
    store: &SessionStore,
    store_path: &Path,
    backup_path: &Path,
    temp_path: &Path,
    primary_trusted: &mut bool,
) -> Result<(), AppError> {
    fs::create_dir_all(
        store_path
            .parent()
            .ok_or_else(|| AppError::Persistence("会话存储目录无效".to_owned()))?,
    )
    .map_err(|_| AppError::Persistence("无法创建会话存储目录".to_owned()))?;
    let content = serde_json::to_vec_pretty(store)
        .map_err(|_| AppError::Persistence("无法序列化会话数据".to_owned()))?;
    let mut temp = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(temp_path)
        .map_err(|_| AppError::Persistence("无法写入会话临时文件".to_owned()))?;
    temp.write_all(&content)
        .and_then(|_| temp.sync_all())
        .map_err(|_| AppError::Persistence("无法同步会话临时文件".to_owned()))?;
    drop(temp);

    if store_path.exists() {
        if *primary_trusted {
            let _ = fs::remove_file(backup_path);
            fs::rename(store_path, backup_path)
                .map_err(|_| AppError::Persistence("无法备份会话数据".to_owned()))?;
        } else {
            fs::remove_file(store_path)
                .map_err(|_| AppError::Persistence("无法替换损坏的会话数据".to_owned()))?;
        }
    }
    if fs::rename(temp_path, store_path).is_err() {
        if !store_path.exists() && backup_path.exists() {
            let _ = fs::copy(backup_path, store_path);
        }
        return Err(AppError::Persistence("无法提交会话数据".to_owned()));
    }
    *primary_trusted = true;
    Ok(())
}

pub(super) fn read_store(path: &Path) -> Result<Option<SessionStore>, AppError> {
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

pub(super) fn validate_store(store: &SessionStore) -> Result<(), AppError> {
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

impl SessionService {
    pub(super) fn ensure_readable(&self) -> Result<(), AppError> {
        match &self.blocked_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    pub(super) fn ensure_writable(&self) -> Result<(), AppError> {
        self.ensure_readable()
    }

    pub(super) fn persist(&mut self) -> Result<(), AppError> {
        persist_store(
            &self.store,
            &self.store_path,
            &self.backup_path,
            &self.temp_path,
            &mut self.primary_trusted,
        )
    }
}
