use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

const TOOL_INTERVAL: Duration = Duration::from_millis(500);
const BURST: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub(super) struct ToolRateLimit(Arc<Mutex<Bucket>>);

struct Bucket {
    updated_at: Instant,
    credit: Duration,
}

impl Default for ToolRateLimit {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Bucket {
            updated_at: Instant::now(),
            credit: BURST,
        })))
    }
}

impl ToolRateLimit {
    pub(super) fn take(&self) -> Result<(), Duration> {
        let mut bucket = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        bucket.credit = (bucket.credit + now.duration_since(bucket.updated_at)).min(BURST);
        bucket.updated_at = now;
        if let Some(remaining) = bucket.credit.checked_sub(TOOL_INTERVAL) {
            bucket.credit = remaining;
            Ok(())
        } else {
            Err(TOOL_INTERVAL - bucket.credit)
        }
    }
}

#[cfg(test)]
#[tokio::test(start_paused = true)]
async fn cloned_limiters_share_the_burst_and_refill_two_calls_per_second() {
    let first = ToolRateLimit::default();
    let second = first.clone();
    for _ in 0..15 {
        first.take().unwrap();
        second.take().unwrap();
    }
    assert_eq!(second.take(), Err(Duration::from_millis(500)));
    tokio::time::advance(Duration::from_millis(250)).await;
    assert_eq!(first.take(), Err(Duration::from_millis(250)));
    tokio::time::advance(Duration::from_millis(750)).await;
    second.take().unwrap();
    first.take().unwrap();
    assert_eq!(first.take(), Err(Duration::from_millis(500)));
}
