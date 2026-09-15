use crate::protocol::{Change, Profile, Secrets, Target};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub trait Protector: Send {
    fn seal(&self, bytes: &[u8]) -> crate::Result<Vec<u8>>;
    fn open(&self, bytes: &[u8]) -> crate::Result<Zeroizing<Vec<u8>>>;
}

#[derive(Serialize, Deserialize)]
struct Record {
    owner: String,
    profile: Profile,
    secrets: Secrets,
}

pub struct Pending {
    pub owner: String,
    pub change: Change,
    pub revision: u64,
    pub host_key: Option<String>,
    pub imported: Option<Secrets>,
    created: Instant,
}

pub struct Store {
    db: Connection,
    protector: Box<dyn Protector>,
    pending: HashMap<String, Pending>,
    batches: HashMap<String, Vec<String>>,
}

impl Store {
    pub fn open(path: &Path, protector: Box<dyn Protector>) -> crate::Result<Self> {
        Self::from_connection(Connection::open(path).map_err(db_error)?, protector)
    }

    fn from_connection(db: Connection, protector: Box<dyn Protector>) -> crate::Result<Self> {
        let version: u32 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(db_error)?;
        if version > 1 {
            return Err("服务数据库版本较新，拒绝降级".into());
        }
        db.execute_batch(
            "PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;
            CREATE TABLE IF NOT EXISTS records(owner TEXT NOT NULL, id TEXT NOT NULL,
            revision INTEGER NOT NULL, sealed BLOB, PRIMARY KEY(owner,id));
            PRAGMA user_version=1;",
        )
        .map_err(db_error)?;
        Ok(Self {
            db,
            protector,
            pending: HashMap::new(),
            batches: HashMap::new(),
        })
    }

    pub fn revision(&self, owner: &str, id: &str) -> crate::Result<u64> {
        Ok(self
            .db
            .query_row(
                "SELECT revision FROM records WHERE owner=?1 AND id=?2",
                params![owner, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or(0))
    }

    pub fn load(&self, owner: &str, id: &str) -> crate::Result<Option<(Profile, Secrets)>> {
        let sealed: Option<Option<Vec<u8>>> = self
            .db
            .query_row(
                "SELECT sealed FROM records WHERE owner=?1 AND id=?2",
                params![owner, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(sealed) = sealed.flatten() else {
            return Ok(None);
        };
        let clear = self.protector.open(&sealed)?;
        let record: Record = serde_json::from_slice(&clear).map_err(|_| "服务凭据记录损坏")?;
        if record.owner != owner
            || record.profile.target.id != id
            || record.profile.revision != self.revision(owner, id)?
        {
            return Err("服务凭据绑定校验失败".into());
        }
        Ok(Some((record.profile, record.secrets)))
    }

    pub fn list(&self, owner: &str) -> crate::Result<Vec<Profile>> {
        let mut stmt = self
            .db
            .prepare("SELECT id FROM records WHERE owner=?1 AND sealed IS NOT NULL ORDER BY id")
            .map_err(db_error)?;
        let ids = stmt
            .query_map([owner], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        ids.into_iter()
            .map(|id| {
                self.load(owner, &id)?
                    .map(|r| r.0)
                    .ok_or_else(|| "服务凭据缺失".into())
            })
            .collect()
    }

    fn save(&mut self, owner: &str, profile: Profile, secrets: Secrets) -> crate::Result<()> {
        let record = Record {
            owner: owner.to_owned(),
            profile,
            secrets,
        };
        let clear = Zeroizing::new(serde_json::to_vec(&record).map_err(|_| "无法编码凭据")?);
        let sealed = self.protector.seal(&clear)?;
        // 提交前先验证解密结果；SQLite 事务中仅出现密文。
        if self.protector.open(&sealed)?.as_slice() != clear.as_slice() {
            return Err("凭据加密校验失败".into());
        }
        self.db
            .execute(
                "INSERT INTO records(owner,id,revision,sealed) VALUES(?1,?2,?3,?4)
            ON CONFLICT(owner,id) DO UPDATE SET revision=excluded.revision,sealed=excluded.sealed",
                params![
                    owner,
                    record.profile.target.id,
                    record.profile.revision,
                    sealed
                ],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub fn stage(
        &mut self,
        owner: &str,
        change: Change,
        imported: Option<Secrets>,
    ) -> crate::Result<String> {
        self.pending
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
        self.batches
            .retain(|_, tickets| tickets.iter().all(|t| self.pending.contains_key(t)));
        if self.pending.len() >= 500
            || (imported.is_some()
                && self
                    .pending
                    .values()
                    .filter(|p| p.imported.is_some())
                    .count()
                    >= 32)
        {
            return Err("待确认操作过多，请稍后重试".into());
        }
        let id = change_id(&change);
        uuid::Uuid::parse_str(id).map_err(|_| "会话 ID 无效")?;
        if let Change::Configure { target, .. } = &change {
            target.validate()?;
        }
        let revision = self.revision(owner, id)?;
        if imported.is_some() && revision != 0 {
            return Err("已迁移会话禁止重新导入旧副本".into());
        }
        if let Some(secrets) = &imported {
            secrets.validate()?;
        }
        if matches!(change, Change::Trust { .. }) && self.load(owner, id)?.is_none() {
            return Err("会话尚未托管，请先迁移".into());
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        self.pending.insert(
            ticket.clone(),
            Pending {
                owner: owner.into(),
                change,
                revision,
                host_key: None,
                imported,
                created: Instant::now(),
            },
        );
        Ok(ticket)
    }

    pub fn pending(&self, ticket: &str) -> crate::Result<&Pending> {
        self.pending
            .get(ticket)
            .filter(|p| p.created.elapsed() < Duration::from_secs(300))
            .ok_or_else(|| "确认请求已失效，请重新操作".into())
    }

    pub fn batch(&mut self, owner: &str, tickets: Vec<String>) -> crate::Result<String> {
        if tickets.is_empty() || tickets.len() > 500 {
            return Err("一次最多确认 500 个删除请求或 32 个迁移请求".into());
        }
        let mut ids = std::collections::HashSet::new();
        for ticket in &tickets {
            let p = self.pending(ticket)?;
            if p.owner != owner
                || !ids.insert(change_id(&p.change).to_owned())
                || (p.imported.is_none() && !matches!(p.change, Change::Delete { .. }))
            {
                return Err("批量请求必须属于同一用户，且只能包含不同会话的导入或删除".into());
            }
            if self.batches.values().any(|batch| batch.contains(ticket)) {
                return Err("请求已加入批量审批".into());
            }
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        self.batches.insert(ticket.clone(), tickets);
        Ok(ticket)
    }

    pub fn tickets(&self, ticket: &str) -> Vec<String> {
        self.batches
            .get(ticket)
            .cloned()
            .unwrap_or_else(|| vec![ticket.into()])
    }

    pub fn target(&self, ticket: &str) -> crate::Result<Target> {
        let p = self.pending(ticket)?;
        match &p.change {
            Change::Configure { target, .. } => Ok(target.clone()),
            _ => self
                .load(&p.owner, change_id(&p.change))?
                .map(|r| r.0.target)
                .ok_or_else(|| "会话不存在".into()),
        }
    }

    pub fn set_observed_key(&mut self, ticket: &str, key: String) -> crate::Result<()> {
        self.pending(ticket)?;
        self.pending.get_mut(ticket).expect("已检查请求").host_key = Some(key);
        Ok(())
    }

    pub fn cancel(&mut self, owner: &str, ticket: &str) {
        if let Some(tickets) = self.batches.get(ticket).cloned() {
            if tickets
                .iter()
                .all(|t| self.pending.get(t).is_none_or(|p| p.owner == owner))
            {
                self.batches.remove(ticket);
                for ticket in tickets {
                    self.cancel(owner, &ticket);
                }
            }
        }
        if self.pending.get(ticket).is_some_and(|p| p.owner == owner) {
            self.pending.remove(ticket);
        }
    }

    pub fn approve(
        &mut self,
        ticket: &str,
        elevated: bool,
        supplied: Option<Secrets>,
    ) -> crate::Result<()> {
        if !elevated {
            return Err("修改凭据需要管理员确认".into());
        }
        if let Some(tickets) = self.batches.remove(ticket) {
            if supplied.is_some() {
                return Err("批量审批不接受替换秘密".into());
            }
            self.db.execute_batch("BEGIN IMMEDIATE").map_err(db_error)?;
            let result = tickets
                .iter()
                .try_for_each(|ticket| self.approve(ticket, true, None));
            if result.is_ok() {
                if self.db.execute_batch("COMMIT").is_err() {
                    let _ = self.db.execute_batch("ROLLBACK");
                    return Err("批量提交失败，已撤销变更".into());
                }
            } else {
                self.db.execute_batch("ROLLBACK").map_err(db_error)?;
            }
            for ticket in tickets {
                self.pending.remove(&ticket);
            }
            return result;
        }
        let p = self.pending(ticket)?;
        if self.revision(&p.owner, change_id(&p.change))? != p.revision {
            return Err("会话已变化，请重新确认".into());
        }
        if !matches!(p.change, Change::Delete { .. }) && p.host_key.is_none() {
            return Err("必须先核对目标主机指纹".into());
        }
        let p = self.pending.remove(ticket).expect("已检查请求");
        let id = change_id(&p.change).to_owned();
        let old = self.load(&p.owner, &id)?;
        if matches!(p.change, Change::Delete { .. }) {
            self.db
                .execute(
                    "INSERT INTO records(owner,id,revision,sealed) VALUES(?1,?2,?3,NULL) ON CONFLICT(owner,id) DO UPDATE SET sealed=NULL,revision=excluded.revision",
                    params![p.owner, id,p.revision+1],
                )
                .map_err(db_error)?;
            return Ok(());
        }
        let imported = p.imported.is_some();
        let target = match &p.change {
            Change::Configure { target, .. } => target.clone(),
            _ => old.as_ref().ok_or("会话不存在")?.0.target.clone(),
        };
        let replace = matches!(
            p.change,
            Change::Configure {
                replace_secret: true,
                ..
            }
        );
        let secrets = p
            .imported
            .or(supplied)
            .or_else(|| {
                if !replace {
                    old.as_ref()
                        .filter(|r| r.0.target.private_key == target.private_key)
                        .map(|r| r.1.clone())
                } else {
                    None
                }
            })
            .ok_or("请在安全窗口输入凭据")?;
        secrets.validate()?;
        if target.private_key {
            russh::keys::decode_secret_key(
                &secrets.private_key,
                (!secrets.password.is_empty()).then_some(secrets.password.as_str()),
            )
            .map_err(|_| "私钥无效或口令错误")?;
        } else if secrets.password.is_empty() || !secrets.private_key.is_empty() {
            return Err("密码凭据无效".into());
        }
        self.save(
            &p.owner,
            Profile {
                target,
                revision: p.revision + 1,
                host_key: p.host_key.expect("已核对指纹"),
                cleanup_pending: imported || old.is_none_or(|r| r.0.cleanup_pending),
            },
            secrets,
        )
    }

    pub fn cleanup_complete(&mut self, owner: &str, id: &str, revision: u64) -> crate::Result<()> {
        let (mut profile, secrets) = self.load(owner, id)?.ok_or("会话不存在")?;
        if profile.revision != revision {
            return Err("会话版本已变化".into());
        }
        profile.cleanup_pending = false;
        self.save(owner, profile, secrets)
    }
}

pub fn change_id(change: &Change) -> &str {
    match change {
        Change::Configure { target, .. } => &target.id,
        Change::Delete { id } | Change::Trust { id } => id,
    }
}
fn db_error(_: rusqlite::Error) -> String {
    "服务凭据数据库操作失败".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestProtector;
    impl Protector for TestProtector {
        fn seal(&self, b: &[u8]) -> crate::Result<Vec<u8>> {
            Ok(b.iter().map(|b| b ^ 0xa5).collect())
        }
        fn open(&self, b: &[u8]) -> crate::Result<Zeroizing<Vec<u8>>> {
            Ok(Zeroizing::new(b.iter().map(|b| b ^ 0xa5).collect()))
        }
    }
    fn store() -> Store {
        Store::from_connection(
            Connection::open_in_memory().unwrap(),
            Box::new(TestProtector),
        )
        .unwrap()
    }
    fn target() -> Target {
        Target {
            id: uuid::Uuid::new_v4().to_string(),
            host: "example.test".into(),
            port: 22,
            username: "test".into(),
            private_key: false,
        }
    }
    fn secret() -> Secrets {
        Secrets {
            password: Zeroizing::new("唯一测试秘密".into()),
            ..Default::default()
        }
    }

    #[test]
    fn 批量迁移失败必须回滚全部记录且请求不能重放() {
        let mut s = store();
        let a = target();
        let b = target();
        let first = s
            .stage(
                "owner",
                Change::Configure {
                    target: a.clone(),
                    replace_secret: true,
                },
                Some(secret()),
            )
            .unwrap();
        let second = s
            .stage(
                "owner",
                Change::Configure {
                    target: b.clone(),
                    replace_secret: true,
                },
                Some(secret()),
            )
            .unwrap();
        s.set_observed_key(&first, "测试指纹".into()).unwrap();
        let batch = s.batch("owner", vec![first, second]).unwrap();
        assert!(s.approve(&batch, true, None).is_err());
        assert!(s.load("owner", &a.id).unwrap().is_none());
        assert_eq!(s.revision("owner", &a.id).unwrap(), 0);
        assert!(s.approve(&batch, true, None).is_err());
    }

    #[test]
    fn 批量审批隔离账号且清理状态需匹配版本() {
        let mut s = store();
        let a = target();
        let b = target();
        let first = s
            .stage(
                "owner",
                Change::Configure {
                    target: a.clone(),
                    replace_secret: true,
                },
                Some(secret()),
            )
            .unwrap();
        let second = s
            .stage(
                "owner",
                Change::Configure {
                    target: b.clone(),
                    replace_secret: true,
                },
                Some(secret()),
            )
            .unwrap();
        assert!(s.batch("other", vec![first.clone()]).is_err());
        assert!(s
            .batch("owner", vec![first.clone(), first.clone()])
            .is_err());
        for ticket in [&first, &second] {
            s.set_observed_key(ticket, "测试指纹".into()).unwrap();
        }
        let batch = s.batch("owner", vec![first, second]).unwrap();
        s.approve(&batch, true, None).unwrap();
        assert!(s.load("owner", &a.id).unwrap().unwrap().0.cleanup_pending);
        assert!(s.cleanup_complete("other", &a.id, 1).is_err());
        assert!(s.cleanup_complete("owner", &a.id, 2).is_err());
        s.cleanup_complete("owner", &a.id, 1).unwrap();
        assert!(!s.load("owner", &a.id).unwrap().unwrap().0.cleanup_pending);
    }

    #[test]
    fn 取消过期和删除记录禁止旧秘密重新导入() {
        let mut s = store();
        let target = target();
        let ticket = s
            .stage(
                "owner",
                Change::Configure {
                    target: target.clone(),
                    replace_secret: true,
                },
                Some(secret()),
            )
            .unwrap();
        s.cancel("other", &ticket);
        assert!(s.pending(&ticket).is_ok());
        s.pending.get_mut(&ticket).unwrap().created = Instant::now() - Duration::from_secs(301);
        assert!(s.approve(&ticket, true, None).is_err());
        let deletion = s
            .stage(
                "owner",
                Change::Delete {
                    id: target.id.clone(),
                },
                None,
            )
            .unwrap();
        s.approve(&deletion, true, None).unwrap();
        assert!(s
            .stage(
                "owner",
                Change::Configure {
                    target,
                    replace_secret: true
                },
                Some(secret())
            )
            .is_err());
    }

    #[test]
    fn 密文损坏和较新数据库必须报错不能生成替代凭据() {
        let mut s = store();
        let target = target();
        let ticket = s
            .stage(
                "owner",
                Change::Configure {
                    target: target.clone(),
                    replace_secret: true,
                },
                Some(secret()),
            )
            .unwrap();
        s.set_observed_key(&ticket, "测试指纹".into()).unwrap();
        s.approve(&ticket, true, None).unwrap();
        s.db.execute("UPDATE records SET sealed=?1", ["损坏".as_bytes()])
            .unwrap();
        assert!(s.load("owner", &target.id).is_err());
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA user_version=2").unwrap();
        assert!(Store::from_connection(db, Box::new(TestProtector)).is_err());
    }
    #[test]
    fn 未提权及未核对指纹不能批准() {
        let mut s = store();
        let t = s
            .stage(
                "owner",
                Change::Configure {
                    target: target(),
                    replace_secret: true,
                },
                None,
            )
            .unwrap();
        assert!(s.approve(&t, false, Some(secret())).is_err());
        assert!(s.approve(&t, true, Some(secret())).is_err());
    }
    #[test]
    fn 绑定账号禁止重放且数据库只有密文() {
        let mut s = store();
        let target = target();
        let id = target.id.clone();
        let t = s
            .stage(
                "owner",
                Change::Configure {
                    target,
                    replace_secret: true,
                },
                None,
            )
            .unwrap();
        s.set_observed_key(&t, "测试指纹".into()).unwrap();
        s.approve(&t, true, Some(secret())).unwrap();
        assert!(s.approve(&t, true, Some(secret())).is_err());
        assert!(s.load("other", &id).unwrap().is_none());
        let bytes: Vec<u8> =
            s.db.query_row("SELECT sealed FROM records", [], |r| r.get(0))
                .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("唯一测试秘密"));
    }
    #[test]
    fn 并发审批版本变化必须拒绝且禁止旧副本重新迁入() {
        let mut s = store();
        let target = target();
        let change = Change::Configure {
            target: target.clone(),
            replace_secret: true,
        };
        let a = s.stage("owner", change.clone(), Some(secret())).unwrap();
        let b = s.stage("owner", change.clone(), None).unwrap();
        for t in [&a, &b] {
            s.set_observed_key(t, "测试指纹".into()).unwrap();
        }
        s.approve(&a, true, None).unwrap();
        assert!(s.approve(&b, true, Some(secret())).is_err());
        assert!(s.stage("owner", change, Some(secret())).is_err());
    }
}
