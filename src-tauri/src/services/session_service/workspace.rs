use super::*;
use crate::models::{LocalSession, LocalSessionPayload, WorkspaceSession, WorkspaceSessionGroup};
use std::collections::{HashMap, HashSet};

pub(super) fn validate_local(session: &LocalSession) -> Result<(), AppError> {
    validate_id(&session.id)?;
    validate_text("名称", &session.name, 128, false)?;
    validate_text("分组", &session.group, 128, false)?;
    let path = &session.starting_directory;
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || (!path.is_empty() && !Path::new(path).is_absolute())
    {
        return Err(AppError::Validation("起始目录必须是绝对路径".into()));
    }
    Ok(())
}

impl SessionService {
    pub fn find_local(&self, id: &str) -> Result<LocalSession, AppError> {
        self.ensure_readable()?;
        self.store
            .local_sessions
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("未找到本地会话".into()))
    }

    pub async fn list_workspace(
        &mut self,
        credentials: &CredentialService,
    ) -> Result<Vec<WorkspaceSessionGroup>, AppError> {
        let ssh = self.list_groups(credentials).await?;
        let mut profiles: HashMap<String, WorkspaceSession> = ssh
            .into_iter()
            .flat_map(|g| g.sessions)
            .map(|s| (s.id.clone(), WorkspaceSession::Ssh(s)))
            .collect();
        for local in &self.store.local_sessions {
            profiles.insert(local.id.clone(), WorkspaceSession::Local(local.clone()));
        }
        Ok(self
            .workspace_blocks()
            .into_iter()
            .map(|(name, ids)| WorkspaceSessionGroup {
                name,
                sessions: ids
                    .into_iter()
                    .filter_map(|id| profiles.remove(&id))
                    .collect(),
            })
            .collect())
    }

    fn workspace_blocks(&self) -> Vec<(String, Vec<String>)> {
        let entries: Vec<_> = self
            .store
            .sessions
            .iter()
            .map(|s| (&s.id, &s.group))
            .chain(self.store.local_sessions.iter().map(|s| (&s.id, &s.group)))
            .collect();
        let by_id: HashMap<_, _> = entries.iter().copied().collect();
        let mut seen = HashSet::new();
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for id in self
            .store
            .workspace_order
            .iter()
            .chain(entries.iter().map(|(id, _)| *id))
        {
            let Some(group) = by_id.get(id) else { continue };
            if !seen.insert(id) {
                continue;
            }
            if let Some((_, ids)) = groups.iter_mut().find(|(name, _)| name == *group) {
                ids.push(id.clone());
            } else {
                groups.push(((*group).clone(), vec![id.clone()]));
            }
        }
        groups
    }

    fn commit_workspace(&mut self, previous: SessionStore) -> Result<(), AppError> {
        self.store.workspace_order = self
            .workspace_blocks()
            .into_iter()
            .flat_map(|(_, ids)| ids)
            .collect();
        let positions: HashMap<_, _> = self
            .store
            .workspace_order
            .iter()
            .enumerate()
            .map(|(i, id)| (id.clone(), i))
            .collect();
        self.store
            .sessions
            .sort_by_key(|s| positions.get(&s.id).copied().unwrap_or(usize::MAX));
        if let Err(error) = self.persist() {
            self.store = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn save_local(&mut self, payload: LocalSessionPayload) -> Result<LocalSession, AppError> {
        self.ensure_writable()?;
        let existing = payload
            .id
            .as_deref()
            .map(|id| self.find_local(id))
            .transpose()?;
        if existing.as_ref().is_some_and(|s| s.shell != payload.shell) {
            return Err(AppError::Validation("会话终端类型不能修改".into()));
        }
        if existing.is_none()
            && self.store.sessions.len() + self.store.local_sessions.len() >= MAX_SESSIONS
        {
            return Err(AppError::Validation("会话数量不能超过 500 个".into()));
        }
        let session = LocalSession {
            id: payload
                .id
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: payload.name.trim().into(),
            group: normalize_group(&payload.group),
            tags: existing.map_or_else(Vec::new, |s| s.tags),
            shell: payload.shell,
            starting_directory: payload.starting_directory.trim().into(),
            run_as_admin: payload.run_as_admin,
        };
        validate_local(&session)?;
        if !session.starting_directory.is_empty()
            && !Path::new(&session.starting_directory).is_dir()
        {
            return Err(AppError::Validation("起始目录不存在或无法访问".into()));
        }
        let previous = self.store.clone();
        if let Some(current) = self
            .store
            .local_sessions
            .iter_mut()
            .find(|s| s.id == session.id)
        {
            *current = session.clone();
        } else {
            self.store.local_sessions.push(session.clone());
        }
        self.commit_workspace(previous)?;
        Ok(session)
    }

    pub fn delete_local(&mut self, id: &str) -> Result<(), AppError> {
        self.find_local(id)?;
        let previous = self.store.clone();
        self.store.local_sessions.retain(|s| s.id != id);
        self.commit_workspace(previous)
    }

    pub fn workspace_ids_in_group(&self, group: &str) -> Result<Vec<String>, AppError> {
        self.ensure_readable()?;
        if group == DEFAULT_SESSION_GROUP {
            return Err(AppError::Validation("系统默认分组不能删除".into()));
        }
        self.workspace_blocks()
            .into_iter()
            .find(|(name, _)| name == group)
            .map(|(_, ids)| ids)
            .ok_or_else(|| AppError::NotFound("未找到指定分组".into()))
    }

    pub fn rename_workspace_group(&mut self, group: &str, new_name: &str) -> Result<(), AppError> {
        self.ensure_writable()?;
        validate_text("分组", new_name, 128, false)?;
        let new_name = new_name.trim();
        self.workspace_ids_in_group(group)?;
        if new_name == DEFAULT_SESSION_GROUP {
            return Err(AppError::Validation("系统默认分组不能重命名".into()));
        }
        if new_name == group {
            return Ok(());
        }
        if self
            .workspace_blocks()
            .iter()
            .any(|(name, _)| name == new_name)
        {
            return Err(AppError::Validation("分组名称已存在".into()));
        }
        let previous = self.store.clone();
        for s in &mut self.store.sessions {
            if s.group == group {
                s.group = new_name.into();
            }
        }
        for s in &mut self.store.local_sessions {
            if s.group == group {
                s.group = new_name.into();
            }
        }
        self.commit_workspace(previous)
    }

    pub fn reorder_workspace_group(&mut self, group: &str, target: usize) -> Result<(), AppError> {
        self.ensure_writable()?;
        let mut groups = self.workspace_blocks();
        let from = groups
            .iter()
            .position(|(name, _)| name == group)
            .ok_or_else(|| AppError::NotFound("未找到指定分组".into()))?;
        if target >= groups.len() {
            return Err(AppError::Validation("分组目标位置无效".into()));
        }
        let entry = groups.remove(from);
        groups.insert(target, entry);
        let previous = self.store.clone();
        self.store.workspace_order = groups.into_iter().flat_map(|(_, ids)| ids).collect();
        self.commit_workspace(previous)
    }

    pub fn reorder_workspace_session(
        &mut self,
        id: &str,
        group: &str,
        target: usize,
    ) -> Result<(), AppError> {
        self.ensure_writable()?;
        let mut groups = self.workspace_blocks();
        if !groups
            .iter()
            .any(|(_, ids)| ids.iter().any(|value| value == id))
        {
            return Err(AppError::NotFound("未找到指定会话".into()));
        }
        if !groups.iter().any(|(name, _)| name == group) {
            return Err(AppError::NotFound("未找到目标分组".into()));
        }
        for (_, ids) in &mut groups {
            ids.retain(|value| value != id);
        }
        let ids = &mut groups
            .iter_mut()
            .find(|(name, _)| name == group)
            .expect("已校验分组")
            .1;
        if target > ids.len() {
            return Err(AppError::Validation("会话目标位置无效".into()));
        }
        ids.insert(target, id.into());
        let previous = self.store.clone();
        if let Some(s) = self.store.sessions.iter_mut().find(|s| s.id == id) {
            s.group = group.into();
        }
        if let Some(s) = self.store.local_sessions.iter_mut().find(|s| s.id == id) {
            s.group = group.into();
        }
        self.store.workspace_order = groups.into_iter().flat_map(|(_, ids)| ids).collect();
        self.commit_workspace(previous)
    }

    pub async fn delete_workspace_group(
        &mut self,
        group: &str,
        credentials: &CredentialService,
    ) -> Result<Vec<String>, AppError> {
        let ids = self.workspace_ids_in_group(group)?;
        // 凭据审批完成前不提交本地成员的删除。
        if self.store.sessions.iter().any(|s| s.group == group) {
            self.delete_group(group, credentials).await?;
        }
        let previous = self.store.clone();
        self.store.local_sessions.retain(|s| s.group != group);
        self.commit_workspace(previous)?;
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LocalShell;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("fstty-local-store-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn payload(group: &str) -> LocalSessionPayload {
        LocalSessionPayload {
            id: None,
            name: "CMD".into(),
            group: group.into(),
            shell: LocalShell::Cmd,
            starting_directory: String::new(),
            run_as_admin: false,
        }
    }
    fn ssh(group: &str) -> StoredSession {
        StoredSession {
            id: uuid::Uuid::new_v4().to_string(),
            name: "SSH".into(),
            host: "example.test".into(),
            port: 22,
            username: "user".into(),
            group: group.into(),
            tags: vec![],
            auth: crate::models::SessionAuth::Password,
            login_save_prompted: true,
        }
    }

    #[tokio::test]
    async fn mixed_groups_preserve_order_and_mcp_only_sees_ssh() {
        let directory = Directory::new();
        let mut service = SessionService::load(&directory.0);
        let remote = ssh("Mixed");
        service.replace_sessions(vec![remote.clone()]).unwrap();
        let first = service.save_local(payload("Mixed")).unwrap();
        let second = service.save_local(payload("Other")).unwrap();
        service
            .reorder_workspace_session(&second.id, "Mixed", 1)
            .unwrap();
        let groups = service
            .list_workspace(&CredentialService::new())
            .await
            .unwrap();
        assert_eq!(groups.len(), 1);
        let serialized = serde_json::to_value(&groups).unwrap();
        assert_eq!(serialized[0]["sessions"][0]["kind"], "ssh");
        assert_eq!(serialized[0]["sessions"][1]["kind"], "local");
        assert_eq!(serialized[0]["sessions"][1]["id"], second.id);
        assert!(service.find(&first.id).is_err());
        assert!(service.find_local(&remote.id).is_err());
        assert_eq!(
            service
                .list_groups(&CredentialService::new())
                .await
                .unwrap()[0]
                .sessions
                .len(),
            1
        );
        service.rename_workspace_group("Mixed", "Renamed").unwrap();
        let restored = SessionService::load(&directory.0);
        assert_eq!(
            restored.workspace_blocks()[0],
            ("Renamed".into(), vec![remote.id, second.id, first.id])
        );
    }
    #[test]
    fn v1_migration_preserves_original_and_recovers_from_backup() {
        let directory = Directory::new();
        let session = ssh("Servers");
        let legacy =
            serde_json::to_vec(&serde_json::json!({ "version": 1, "sessions": [session] }))
                .unwrap();
        std::fs::write(directory.0.join("sessions.v1.json"), b"broken").unwrap();
        std::fs::write(directory.0.join("sessions.v1.json.bak"), &legacy).unwrap();
        let service = SessionService::load(&directory.0);
        assert_eq!(service.store.sessions.len(), 1);
        assert_eq!(
            std::fs::read(directory.0.join("sessions.v1.json")).unwrap(),
            b"broken"
        );
        assert_eq!(
            std::fs::read(directory.0.join("sessions.v1.json.bak")).unwrap(),
            legacy
        );
        assert_eq!(
            read_store(&directory.0.join(STORE_FILE))
                .unwrap()
                .unwrap()
                .version,
            2
        );
    }
    #[test]
    fn invalid_v1_never_creates_a_replacement_and_failed_save_rolls_back() {
        let directory = Directory::new();
        std::fs::write(directory.0.join("sessions.v1.json"), b"invalid").unwrap();
        let mut service = SessionService::load(&directory.0);
        assert!(service.save_local(payload("")).is_err());
        assert!(!directory.0.join(STORE_FILE).exists());
        let clean = Directory::new();
        let mut service = SessionService::load(&clean.0);
        let local = service.save_local(payload("")).unwrap();
        std::fs::create_dir(clean.0.join(STORE_TEMP_FILE)).unwrap();
        assert!(service.save_local(payload("Second")).is_err());
        assert_eq!(service.store.local_sessions, vec![local]);
    }
    #[test]
    fn edit_defaults_and_delete_never_modify_the_starting_directory() {
        let directory = Directory::new();
        let scratch = directory.0.join("中文 test");
        std::fs::create_dir(&scratch).unwrap();
        let mut service = SessionService::load(&directory.0);
        let local = service.save_local(payload("")).unwrap();
        let mut edit = payload("Group");
        edit.id = Some(local.id.clone());
        edit.run_as_admin = true;
        edit.starting_directory = scratch.display().to_string();
        let updated = service.save_local(edit).unwrap();
        assert!(updated.run_as_admin);
        let mut wrong = payload("Group");
        wrong.id = Some(local.id.clone());
        wrong.shell = LocalShell::GitBash;
        assert!(service.save_local(wrong).is_err());
        service.delete_local(&local.id).unwrap();
        assert!(scratch.is_dir());
        assert!(SessionService::load(&directory.0)
            .store
            .local_sessions
            .is_empty());
    }
}
