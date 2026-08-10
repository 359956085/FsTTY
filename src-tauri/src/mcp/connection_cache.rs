use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use tokio::time::Instant;

#[derive(Clone, Default)]
pub(super) struct ConnectionCache {
    inner: Arc<ConnectionCacheInner>,
}

#[derive(Default)]
struct ConnectionCacheInner {
    entries: Mutex<HashMap<String, CachedConnection>>,
    session_gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

struct CachedConnection {
    connection_id: String,
    last_used: Instant,
}

pub(super) enum CacheLookup {
    Missing,
    Reusable(String),
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

    pub(super) async fn lookup(&self, session_id: &str, idle: Duration) -> CacheLookup {
        let mut entries = self.inner.entries.lock().await;
        let Some(existing) = entries.get_mut(session_id) else {
            return CacheLookup::Missing;
        };
        if existing.last_used.elapsed() < idle {
            existing.last_used = Instant::now();
            return CacheLookup::Reusable(existing.connection_id.clone());
        }
        let expired = entries
            .remove(session_id)
            .expect("缓存条目在持锁期间必须存在");
        CacheLookup::Expired(expired.connection_id)
    }

    pub(super) async fn insert(&self, session_id: String, connection_id: String) {
        self.inner.entries.lock().await.insert(
            session_id,
            CachedConnection {
                connection_id,
                last_used: Instant::now(),
            },
        );
    }

    pub(super) async fn take_if_idle(
        &self,
        session_id: &str,
        connection_id: &str,
        idle: Duration,
    ) -> Option<String> {
        let mut entries = self.inner.entries.lock().await;
        let should_remove = entries.get(session_id).is_some_and(|entry| {
            entry.connection_id == connection_id && entry.last_used.elapsed() >= idle
        });
        should_remove
            .then(|| entries.remove(session_id))
            .flatten()
            .map(|entry| entry.connection_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::timeout;

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

    #[tokio::test]
    async fn 复用刷新空闲时间且到期后先移除() {
        let cache = ConnectionCache::default();
        cache.insert("a".to_owned(), "old".to_owned()).await;
        assert!(matches!(
            cache.lookup("a", Duration::from_secs(300)).await,
            CacheLookup::Reusable(ref id) if id == "old"
        ));
        cache
            .inner
            .entries
            .lock()
            .await
            .get_mut("a")
            .expect("应存在缓存")
            .last_used = Instant::now() - Duration::from_secs(301);
        assert!(matches!(
            cache.lookup("a", Duration::from_secs(300)).await,
            CacheLookup::Expired(ref id) if id == "old"
        ));
        assert!(matches!(
            cache.lookup("a", Duration::from_secs(300)).await,
            CacheLookup::Missing
        ));
    }

    #[tokio::test]
    async fn 旧清理任务不能删除替换后的新连接() {
        let cache = ConnectionCache::default();
        cache.insert("a".to_owned(), "old".to_owned()).await;
        cache.insert("a".to_owned(), "new".to_owned()).await;
        assert_eq!(
            cache
                .take_if_idle("a", "old", Duration::from_secs(300))
                .await,
            None
        );
        assert!(matches!(
            cache.lookup("a", Duration::from_secs(300)).await,
            CacheLookup::Reusable(ref id) if id == "new"
        ));
    }
}
