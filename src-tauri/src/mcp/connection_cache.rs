use std::{
    collections::HashMap,
    future::Future,
    ops::Deref,
    sync::{Arc, Mutex as StdMutex, MutexGuard},
    time::Duration,
};
use tokio::sync::{Mutex, Notify};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub(super) struct ConnectionCache {
    inner: Arc<ConnectionCacheInner>,
}

#[derive(Default)]
struct ConnectionCacheInner {
    // 计数和到期移除共用短同步锁，Drop 无需异步任务，也不会跨网络 await 持锁。
    entries: StdMutex<HashMap<String, CachedConnection>>,
    session_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    shutdown: CancellationToken,
}

impl ConnectionCacheInner {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, CachedConnection>> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

impl Drop for ConnectionCacheInner {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

struct CachedConnection {
    connection_id: String,
    idle_since: Instant,
    users: usize,
    changed: Arc<Notify>,
}

/// 守卫随整个工具调用存活；错误、提前返回和取消均会同步释放使用计数。
pub(super) struct ConnectionLease {
    inner: Arc<ConnectionCacheInner>,
    session_id: String,
    connection_id: String,
    changed: Arc<Notify>,
}

impl Deref for ConnectionLease {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.connection_id
    }
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        let mut entries = self.inner.entries();
        if let Some(entry) = entries
            .get_mut(&self.session_id)
            .filter(|entry| entry.connection_id == self.connection_id)
        {
            entry.users -= 1;
            if entry.users == 0 {
                entry.idle_since = Instant::now();
                entry.changed.notify_one();
            }
        }
    }
}

pub(super) enum CacheLookup {
    Missing,
    Reusable(ConnectionLease),
    Expired(String),
}

impl ConnectionCache {
    pub(super) async fn session_gate(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.inner.session_gates.lock().await;
        gates
            .entry(session_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(super) fn lookup(&self, session_id: &str, idle: Duration) -> CacheLookup {
        let mut entries = self.inner.entries();
        let Some(existing) = entries.get_mut(session_id) else {
            return CacheLookup::Missing;
        };
        if existing.users > 0 || existing.idle_since.elapsed() < idle {
            existing.users += 1;
            existing.changed.notify_one();
            return CacheLookup::Reusable(ConnectionLease {
                inner: self.inner.clone(),
                session_id: session_id.to_owned(),
                connection_id: existing.connection_id.clone(),
                changed: existing.changed.clone(),
            });
        }
        let expired = entries.remove(session_id).expect("持锁期间缓存条目存在");
        expired.changed.notify_one();
        CacheLookup::Expired(expired.connection_id)
    }

    pub(super) fn insert(&self, session_id: String, connection_id: String) -> ConnectionLease {
        let changed = Arc::new(Notify::new());
        let previous = self.inner.entries().insert(
            session_id.clone(),
            CachedConnection {
                connection_id: connection_id.clone(),
                idle_since: Instant::now(),
                users: 1,
                changed: changed.clone(),
            },
        );
        if let Some(previous) = previous {
            previous.changed.notify_one();
        }
        ConnectionLease {
            inner: self.inner.clone(),
            session_id,
            connection_id,
            changed,
        }
    }

    pub(super) fn remove_if_matches(&self, session_id: &str, connection_id: &str) -> bool {
        let mut entries = self.inner.entries();
        if entries
            .get(session_id)
            .is_some_and(|entry| entry.connection_id == connection_id)
        {
            let removed = entries.remove(session_id).expect("持锁期间缓存条目存在");
            removed.changed.notify_one();
            return true;
        }
        false
    }

    /// 每次插入仅创建一个等待任务；返回确切连接 ID，由调用者在锁外断连。
    pub(super) fn idle_expiry(
        &self,
        lease: &ConnectionLease,
        idle: Duration,
    ) -> impl Future<Output = Option<String>> + Send + 'static {
        let cache = Arc::downgrade(&self.inner);
        let shutdown = self.inner.shutdown.clone();
        let session_id = lease.session_id.clone();
        let connection_id = lease.connection_id.clone();
        let changed = lease.changed.clone();
        async move {
            loop {
                let notified = changed.notified();
                let deadline = {
                    // 定时任务不延长缓存生命周期；最后一个使用守卫释放后才会关闭。
                    let Some(inner) = cache.upgrade() else {
                        return Some(connection_id);
                    };
                    let mut entries = inner.entries();
                    let entry = entries
                        .get(&session_id)
                        .filter(|entry| entry.connection_id == connection_id)?;
                    if entry.users > 0 {
                        None
                    } else {
                        let deadline = entry.idle_since + idle;
                        if deadline <= Instant::now() {
                            entries.remove(&session_id);
                            return Some(connection_id);
                        }
                        Some(deadline)
                    }
                };
                let wait_for_deadline = async {
                    match deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending::<()>().await,
                    }
                };
                tokio::select! {
                    _ = notified => {}
                    _ = wait_for_deadline => {}
                    _ = shutdown.cancelled() => return Some(connection_id),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{advance, timeout};

    const IDLE: Duration = Duration::from_secs(300);

    fn acquire(cache: &ConnectionCache, session: &str) -> ConnectionLease {
        match cache.lookup(session, IDLE) {
            CacheLookup::Reusable(lease) => lease,
            _ => panic!("连接应可复用"),
        }
    }

    #[tokio::test]
    async fn 独立进程同步代理不驱逐已有mcp连接() {
        use crate::services::SettingsService;
        let directory =
            std::env::temp_dir().join(format!("fstty-proxy-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let mut writer = SettingsService::load(&directory);
        writer
            .set_proxy_address("http://127.0.0.1:7890".into())
            .unwrap();
        let mut reader = SettingsService::load(&directory);
        let old_snapshot = reader.proxy_snapshot();
        let cache = ConnectionCache::default();
        drop(cache.insert("session".into(), "connected".into()));
        writer
            .set_proxy_address("socks5://127.0.0.1:1080".into())
            .unwrap();
        reader.reload_mcp_runtime_settings().unwrap();
        assert_eq!(old_snapshot.0, "http://127.0.0.1:7890");
        assert_eq!(reader.proxy_snapshot().0, "socks5://127.0.0.1:1080");
        assert_eq!(&*acquire(&cache, "session"), "connected");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 同会话复用门闩且不同会话互不阻塞() {
        let cache = ConnectionCache::default();
        let first = cache.session_gate("a").await;
        let same = cache.session_gate("a").await;
        let different = cache.session_gate("b").await;
        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &different));
        let _first_guard = first.lock().await;
        assert!(timeout(Duration::from_millis(20), same.lock())
            .await
            .is_err());
        assert!(timeout(Duration::from_millis(20), different.lock())
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn 复用后清理任务继续等待最后使用结束的空闲期限() {
        let cache = ConnectionCache::default();
        let lease = cache.insert("a".into(), "headless".into());
        let task = tokio::spawn(cache.idle_expiry(&lease, IDLE));
        drop(lease);
        advance(Duration::from_secs(240)).await;
        drop(acquire(&cache, "a"));
        advance(Duration::from_secs(60)).await;
        assert!(!task.is_finished());
        advance(Duration::from_secs(239)).await;
        assert!(!task.is_finished());
        advance(Duration::from_secs(1)).await;
        assert_eq!(task.await.unwrap(), Some("headless".into()));
        assert!(matches!(cache.lookup("a", IDLE), CacheLookup::Missing));
    }

    #[tokio::test(start_paused = true)]
    async fn 长操作和并发使用仅在最后一个守卫释放后计时() {
        let cache = ConnectionCache::default();
        let command = cache.insert("a".into(), "headless".into());
        let task = tokio::spawn(cache.idle_expiry(&command, IDLE));
        advance(Duration::from_secs(1_800)).await;
        let transfer = acquire(&cache, "a");
        drop(command);
        advance(IDLE * 2).await;
        assert!(!task.is_finished());
        drop(transfer);
        advance(IDLE - Duration::from_secs(1)).await;
        assert!(!task.is_finished());
        advance(Duration::from_secs(1)).await;
        assert_eq!(task.await.unwrap(), Some("headless".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn 请求取消自动释放守卫且恢复空闲回收() {
        let cache = ConnectionCache::default();
        let lease = cache.insert("a".into(), "headless".into());
        let expiry = tokio::spawn(cache.idle_expiry(&lease, IDLE));
        let request = tokio::spawn(async move {
            let _lease = lease;
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        advance(IDLE * 2).await;
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        advance(IDLE).await;
        assert_eq!(expiry.await.unwrap(), Some("headless".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn 旧任务和旧守卫均不能修改替换后的连接() {
        let cache = ConnectionCache::default();
        let old = cache.insert("a".into(), "old".into());
        let old_task = tokio::spawn(cache.idle_expiry(&old, IDLE));
        let new = cache.insert("a".into(), "new".into());
        let new_task = tokio::spawn(cache.idle_expiry(&new, IDLE));
        assert_eq!(old_task.await.unwrap(), None);
        drop(old);
        advance(IDLE * 2).await;
        assert!(!new_task.is_finished());
        assert_eq!(&*acquire(&cache, "a"), "new");
        drop(new);
        advance(IDLE).await;
        assert_eq!(new_task.await.unwrap(), Some("new".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn 查询过期条目与后台回收不能重复取得同一连接() {
        let cache = ConnectionCache::default();
        let lease = cache.insert("a".into(), "old".into());
        let expiry = cache.idle_expiry(&lease, IDLE);
        drop(lease);
        advance(IDLE).await;
        assert!(matches!(cache.lookup("a", IDLE), CacheLookup::Expired(id) if id == "old"));
        assert_eq!(expiry.await, None);
    }

    #[tokio::test]
    async fn 只移除匹配条目且唤醒其清理任务() {
        let cache = ConnectionCache::default();
        let lease = cache.insert("a".into(), "old".into());
        let expiry = tokio::spawn(cache.idle_expiry(&lease, IDLE));
        tokio::task::yield_now().await;
        assert!(!cache.remove_if_matches("a", "new"));
        assert_eq!(&*acquire(&cache, "a"), "old");
        assert!(cache.remove_if_matches("a", "old"));
        assert_eq!(expiry.await.unwrap(), None);
        drop(lease);
        assert!(matches!(cache.lookup("a", IDLE), CacheLookup::Missing));
    }

    #[tokio::test(start_paused = true)]
    async fn 缓存关闭等待正在使用的守卫并释放自己拥有的连接() {
        let cache = ConnectionCache::default();
        let lease = cache.insert("a".into(), "headless".into());
        let expiry = tokio::spawn(cache.idle_expiry(&lease, IDLE));
        drop(cache);
        advance(IDLE * 2).await;
        assert!(!expiry.is_finished());
        drop(lease);
        assert_eq!(expiry.await.unwrap(), Some("headless".into()));
    }
}
