//! Only nonce-authenticated, accepted single-line commands enter global history.
//! This parser never changes PTY bytes and never logs command contents.
use crate::services::CommandHistoryService;
use base64::Engine;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};

const MAX_COMMAND: usize = 64 * 1024;
const MAX_NOTIFICATION: usize = MAX_COMMAND.div_ceil(3) * 4 + 24;

pub(super) fn valid_command(command: &str) -> bool {
    !command.trim().is_empty()
        && command.len() <= MAX_COMMAND
        && !command.chars().any(char::is_control)
}

pub(super) struct Observer {
    prefix: Vec<u8>,
    matched: usize,
    body: Vec<u8>,
    collecting: bool,
    last: u64,
    continuation: bool,
}
impl Observer {
    pub fn new(token: Option<&str>) -> Self {
        Self {
            prefix: token
                .filter(|v| uuid::Uuid::parse_str(v).is_ok())
                .map(|v| format!("\x1b]777;fstty-global:{v}:").into_bytes())
                .unwrap_or_default(),
            matched: 0,
            body: Vec::new(),
            collecting: false,
            last: 0,
            continuation: false,
        }
    }
    pub fn observe(&mut self, bytes: &[u8]) -> Vec<(u64, String)> {
        let mut commands = Vec::new();
        if self.prefix.is_empty() {
            return commands;
        }
        for &byte in bytes {
            if self.collecting {
                if byte == 7 {
                    if let Some(value) = self.decode() {
                        commands.push(value);
                    }
                    self.body.clear();
                    self.collecting = false;
                } else if self.body.len() < MAX_NOTIFICATION && byte.is_ascii_graphic() {
                    self.body.push(byte);
                } else {
                    self.body.clear();
                    self.collecting = false;
                    self.matched = usize::from(byte == self.prefix[0]);
                }
            } else if byte == self.prefix[self.matched] {
                self.matched += 1;
                if self.matched == self.prefix.len() {
                    self.matched = 0;
                    self.collecting = true;
                }
            } else {
                self.matched = usize::from(byte == self.prefix[0]);
            }
        }
        commands
    }
    fn decode(&mut self) -> Option<(u64, String)> {
        let value = std::str::from_utf8(&self.body).ok()?;
        if value == "continuation" {
            self.continuation = true;
            return None;
        }
        if value.starts_with("input:") {
            self.continuation = false;
            return None;
        }
        let value = value.strip_prefix("command:")?;
        let (sequence, encoded) = value.split_once(':')?;
        let sequence: u64 = sequence.parse().ok()?;
        if sequence <= self.last {
            return None;
        }
        if self.continuation {
            self.last = sequence;
            self.continuation = false;
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        let command = String::from_utf8(bytes).ok()?;
        if !valid_command(&command) {
            return None;
        }
        self.last = sequence;
        Some((sequence, command))
    }
}

struct Job {
    command: String,
    failed: Box<dyn FnOnce() + Send>,
}
struct Writer {
    history: Arc<Mutex<CommandHistoryService>>,
    sender: OnceLock<mpsc::SyncSender<Job>>,
    pending: Arc<AtomicUsize>,
}
#[derive(Clone)]
pub(super) struct Recorder(Arc<Writer>);
impl Recorder {
    pub fn new(history: Arc<Mutex<CommandHistoryService>>) -> Self {
        Self(Arc::new(Writer {
            history,
            sender: OnceLock::new(),
            pending: Arc::new(AtomicUsize::new(0)),
        }))
    }
    pub fn record(&self, command: String, failed: impl FnOnce() + Send + 'static) {
        let sender = self.0.sender.get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<Job>(128);
            let history = self.0.history.clone();
            let pending = self.0.pending.clone();
            // A dedicated writer keeps SQLite waits off PTY forwarding and UI tasks.
            if let Err(error) = std::thread::Builder::new()
                .name("local-command-history".into())
                .spawn(move || {
                    for job in receiver {
                        let result = history
                            .lock()
                            .map_err(|_| "history lock unavailable".to_owned())
                            .and_then(|mut history| {
                                history.add(&job.command).map_err(|e| e.to_string())
                            });
                        if let Err(error) = result {
                            log::warn!("local-global-history stage=database: {error}");
                            (job.failed)();
                        }
                        pending.fetch_sub(1, Ordering::Release);
                    }
                })
            {
                log::warn!("local-global-history stage=writer: {error}");
            }
            sender
        });
        self.0.pending.fetch_add(1, Ordering::Relaxed);
        if let Err(error) = sender.try_send(Job {
            command,
            failed: Box::new(failed),
        }) {
            log::warn!("local-global-history stage=queue: busy or unavailable");
            let (mpsc::TrySendError::Full(job) | mpsc::TrySendError::Disconnected(job)) = error;
            self.0.pending.fetch_sub(1, Ordering::Release);
            (job.failed)();
        }
    }
    pub async fn drain(&self) {
        // Normal shutdown waits briefly for accepted writes, without holding
        // the database lock or changing terminal stop/cancellation rules.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while self.0.pending.load(Ordering::Acquire) != 0 {
            if tokio::time::Instant::now() >= deadline {
                log::warn!("local-global-history stage=shutdown: pending writes timed out");
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(token: &str, sequence: u64, command: &[u8]) -> Vec<u8> {
        format!(
            "\x1b]777;fstty-global:{token}:command:{sequence}:{}\x07",
            base64::engine::general_purpose::STANDARD.encode(command)
        )
        .into_bytes()
    }
    #[test]
    fn captures_chunks_unicode_once_without_replaying_or_splitting_multiline() {
        let token = uuid::Uuid::new_v4().to_string();
        let mut parser = Observer::new(Some(&token));
        let bytes = message(&token, 1, "echo 中文 & 'test'".as_bytes());
        let found: Vec<_> = bytes.chunks(1).flat_map(|b| parser.observe(b)).collect();
        assert_eq!(found, [(1, "echo 中文 & 'test'".into())]);
        assert!(parser.observe(&bytes).is_empty());
        assert!(parser
            .observe(&message(&uuid::Uuid::new_v4().to_string(), 2, b"wrong"))
            .is_empty());
        for command in [
            b"a\nb".as_slice(),
            b"a\rb",
            b"a\tb",
            b"\x1b[31m",
            b" ",
            &[255],
        ] {
            assert!(parser.observe(&message(&token, 2, command)).is_empty());
        }
        assert!(parser
            .observe(&message(&token, 2, &vec![b'a'; MAX_COMMAND + 1]))
            .is_empty());
        assert_eq!(
            parser.observe(&message(&token, 3, b"echo again")),
            [(3, "echo again".into())]
        );
        assert!(parser.body.is_empty());
    }

    #[test]
    fn native_continuation_excludes_folded_bash_lines_and_resets_at_next_prompt() {
        let token = uuid::Uuid::new_v4().to_string();
        let mut parser = Observer::new(Some(&token));
        assert!(parser
            .observe(format!("\x1b]777;fstty-global:{token}:continuation\x07").as_bytes())
            .is_empty());
        assert!(parser
            .observe(&message(&token, 1, b"printf folded-multiline"))
            .is_empty());
        assert!(parser.observe(&message(&token, 1, b"replayed")).is_empty());
        parser.observe(format!("\x1b]777;fstty-global:{token}:input:clear\x07").as_bytes());
        assert_eq!(
            parser.observe(&message(&token, 2, b"echo next")),
            [(2, "echo next".into())]
        );
    }

    fn wait_until(check: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !check() {
            assert!(
                std::time::Instant::now() < deadline,
                "history writer timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    #[test]
    fn application_queue_is_bounded_and_shared_and_failure_does_not_stop_later_writes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let root =
            std::env::temp_dir().join(format!("fstty-global-writer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let history = Arc::new(Mutex::new(CommandHistoryService::load(&root)));
        let recorder = Recorder::new(history.clone());
        let failed = Arc::new(AtomicUsize::new(0));
        let guard = history.lock().unwrap();
        for _ in 0..150 {
            let failed = failed.clone();
            recorder
                .clone()
                .record("echo same explicit submission".into(), move || {
                    failed.fetch_add(1, Ordering::Relaxed);
                });
        }
        assert!(
            failed.load(Ordering::Relaxed) > 0,
            "queue must not grow beyond its capacity"
        );
        drop(guard);
        wait_until(|| {
            history.lock().unwrap().settings().unwrap().entry_count as usize
                + failed.load(Ordering::Relaxed)
                == 150
        });
        // The configured global deduplication rule remains authoritative.
        history.lock().unwrap().update_deduplication(true).unwrap();
        recorder.record("echo final".into(), || panic!("healthy writer failed"));
        wait_until(|| history.lock().unwrap().settings().unwrap().entry_count == 2);
        drop(recorder);
        wait_until(|| Arc::strong_count(&history) == 1);
        drop(history);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn normal_shutdown_drains_already_accepted_writes() {
        let root =
            std::env::temp_dir().join(format!("fstty-global-drain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let history = Arc::new(Mutex::new(CommandHistoryService::load(&root)));
        let recorder = Recorder::new(history.clone());
        for index in 0..32 {
            recorder.record(format!("echo fixture-{index}"), || panic!("writer failed"));
        }
        recorder.drain().await;
        assert_eq!(history.lock().unwrap().settings().unwrap().entry_count, 32);
        drop(recorder);
        wait_until(|| Arc::strong_count(&history) == 1);
        drop(history);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn database_failure_notifies_without_panicking_or_collecting_log_text() {
        let root =
            std::env::temp_dir().join(format!("fstty-global-unwritable-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, b"not a directory").unwrap();
        let history = Arc::new(Mutex::new(CommandHistoryService::load(&root)));
        let recorder = Recorder::new(history.clone());
        let (sent, received) = mpsc::channel();
        recorder.record("echo fixture".into(), move || {
            sent.send(()).unwrap();
        });
        received
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        drop(recorder);
        wait_until(|| Arc::strong_count(&history) == 1);
        drop(history);
        std::fs::remove_file(root).unwrap();
    }
}
