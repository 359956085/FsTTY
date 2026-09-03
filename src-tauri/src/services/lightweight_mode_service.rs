use super::ConnectionManager;
use crate::models::{
    AppError, BeginLightweightModeResult, LightweightModePhase, LightweightModeState,
    LightweightSnapshotKind, LightweightTerminalRequest, PreservedTerminalAttachment,
    PreservedTerminalSummary, TerminalEvent, TerminalResumeEvent,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::{Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio::time::Instant;
use uuid::Uuid;

const STORE_VERSION: u8 = 1;
const STORE_FILE: &str = "lightweight-mode.v1.json";
const STORE_BACKUP_FILE: &str = "lightweight-mode.v1.json.bak";
const STORE_TEMP_FILE: &str = "lightweight-mode.v1.json.tmp";
const MAX_STORE_BYTES: u64 = 16 * 1024;
const MAX_TERMINALS: usize = 256;
const MAX_SNAPSHOT_CHUNK_BYTES: usize = 192 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_VIEWPORT_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TERMINAL_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_GLOBAL_CACHE_BYTES: usize = 128 * 1024 * 1024;
const TRANSACTION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LightweightModeStore {
    version: u8,
    active: bool,
    suppress_confirmation: bool,
}

impl Default for LightweightModeStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            active: false,
            suppress_confirmation: false,
        }
    }
}

struct LightweightModeConfig {
    current: LightweightModeStore,
    store_path: PathBuf,
    backup_path: PathBuf,
    temp_path: PathBuf,
    primary_trusted: bool,
}

impl LightweightModeConfig {
    fn load(app_data_dir: &Path) -> Self {
        let store_path = app_data_dir.join(STORE_FILE);
        let backup_path = app_data_dir.join(STORE_BACKUP_FILE);
        let temp_path = app_data_dir.join(STORE_TEMP_FILE);
        let _ = fs::remove_file(&temp_path);
        let (current, primary_trusted) = match read_store(&store_path) {
            Ok(Some(store)) => (store, true),
            Ok(None) => match read_store(&backup_path) {
                Ok(Some(store)) => (store, false),
                _ => (LightweightModeStore::default(), true),
            },
            Err(_) => match read_store(&backup_path) {
                Ok(Some(store)) => (store, false),
                _ => (LightweightModeStore::default(), false),
            },
        };
        Self {
            current,
            store_path,
            backup_path,
            temp_path,
            primary_trusted,
        }
    }

    fn update(&mut self, active: bool, suppress_confirmation: bool) -> Result<(), AppError> {
        let previous = self.current.clone();
        self.current.active = active;
        self.current.suppress_confirmation = suppress_confirmation;
        if let Err(error) = self.persist() {
            self.current = previous;
            let _ = fs::remove_file(&self.temp_path);
            return Err(error);
        }
        Ok(())
    }

    fn persist(&mut self) -> Result<(), AppError> {
        fs::create_dir_all(
            self.store_path
                .parent()
                .ok_or_else(|| AppError::Persistence("轻量模式存储目录无效".to_owned()))?,
        )
        .map_err(|_| AppError::Persistence("无法创建轻量模式存储目录".to_owned()))?;
        let content = serde_json::to_vec_pretty(&self.current)
            .map_err(|_| AppError::Persistence("无法序列化轻量模式设置".to_owned()))?;
        if content.len() as u64 > MAX_STORE_BYTES {
            return Err(AppError::Validation("轻量模式设置过大".to_owned()));
        }
        let mut temp = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&self.temp_path)
            .map_err(|_| AppError::Persistence("无法写入轻量模式临时文件".to_owned()))?;
        temp.write_all(&content)
            .and_then(|_| temp.sync_all())
            .map_err(|_| AppError::Persistence("无法同步轻量模式临时文件".to_owned()))?;
        drop(temp);

        if self.store_path.exists() {
            if self.primary_trusted {
                let _ = fs::remove_file(&self.backup_path);
                fs::rename(&self.store_path, &self.backup_path)
                    .map_err(|_| AppError::Persistence("无法备份轻量模式设置".to_owned()))?;
            } else {
                fs::remove_file(&self.store_path)
                    .map_err(|_| AppError::Persistence("无法替换损坏的轻量模式设置".to_owned()))?;
            }
        }
        if fs::rename(&self.temp_path, &self.store_path).is_err() {
            if !self.store_path.exists() && self.backup_path.exists() {
                let _ = fs::copy(&self.backup_path, &self.store_path);
            }
            return Err(AppError::Persistence("无法提交轻量模式设置".to_owned()));
        }
        self.primary_trusted = true;
        Ok(())
    }
}

fn read_store(path: &Path) -> Result<Option<LightweightModeStore>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(path).map_err(|_| AppError::Persistence("无法读取轻量模式设置".to_owned()))?;
    if metadata.len() > MAX_STORE_BYTES {
        return Err(AppError::Persistence("轻量模式设置损坏".to_owned()));
    }
    let content =
        fs::read(path).map_err(|_| AppError::Persistence("无法读取轻量模式设置".to_owned()))?;
    let store: LightweightModeStore = serde_json::from_slice(&content)
        .map_err(|_| AppError::Persistence("轻量模式设置损坏".to_owned()))?;
    if store.version != STORE_VERSION {
        return Err(AppError::Persistence("轻量模式设置版本不受支持".to_owned()));
    }
    Ok(Some(store))
}

#[derive(Default)]
struct CacheBudget {
    used: AtomicUsize,
}

impl CacheBudget {
    fn reserve(&self, bytes: usize) -> bool {
        let mut current = self.used.load(Ordering::Acquire);
        loop {
            let Some(next) = current.checked_add(bytes) else {
                return false;
            };
            if next > MAX_GLOBAL_CACHE_BYTES {
                return false;
            }
            match self.used.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn release(&self, bytes: usize) {
        if bytes > 0 {
            self.used.fetch_sub(bytes, Ordering::AcqRel);
        }
    }
}

struct CacheReservation {
    budget: Arc<CacheBudget>,
    bytes: usize,
}

impl CacheReservation {
    fn new(budget: Arc<CacheBudget>, bytes: usize) -> Option<Self> {
        budget.reserve(bytes).then(|| Self { budget, bytes })
    }
}

impl Drop for CacheReservation {
    fn drop(&mut self) {
        self.budget.release(self.bytes);
    }
}

struct CachedBytes {
    bytes: Vec<u8>,
    reservation: CacheReservation,
}

impl CachedBytes {
    fn new(budget: Arc<CacheBudget>) -> Self {
        Self {
            bytes: Vec::new(),
            reservation: CacheReservation { budget, bytes: 0 },
        }
    }

    fn append(&mut self, data: &[u8], limit: usize) -> Result<(), AppError> {
        if self.bytes.len().saturating_add(data.len()) > limit {
            return Err(AppError::Validation("终端快照超过大小上限".to_owned()));
        }
        if !self.reservation.budget.reserve(data.len()) {
            return Err(AppError::Busy("终端缓存超过全局大小上限".to_owned()));
        }
        // 精确扩容避免 Vec 倍增容量绕过缓存预算；预留失败时归还本次额度。
        if self.bytes.try_reserve_exact(data.len()).is_err() {
            self.reservation.budget.release(data.len());
            return Err(AppError::Internal("无法分配终端缓存".to_owned()));
        }
        self.bytes.extend_from_slice(data);
        self.reservation.bytes += data.len();
        Ok(())
    }

    fn take(&mut self) -> Self {
        let budget = self.reservation.budget.clone();
        std::mem::replace(self, Self::new(budget))
    }

    fn clear(&mut self) {
        // 清空时同时释放容量，不能只清长度后把仍占用的内存从预算扣掉。
        self.bytes = Vec::new();
        let bytes = std::mem::take(&mut self.reservation.bytes);
        self.reservation.budget.release(bytes);
    }
}

impl std::ops::Deref for CachedBytes {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
}

#[derive(Default)]
enum ScreenParserState {
    #[default]
    Ground,
    Escape,
    Osc,
}

struct TerminalScreenParser {
    parser: vt100::Parser,
    state: ScreenParserState,
}

impl TerminalScreenParser {
    fn new(rows: u16, columns: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, columns, 0),
            state: ScreenParserState::Ground,
        }
    }

    fn process(&mut self, mut data: &[u8]) {
        // OSC 只携带标题、目录、剪贴板等非画面信息。旁路解析器无需保存这些正文，
        // 且 vte 的 std 模式会无限累积未结束的 OSC，必须在进入解析器前丢弃。
        while !data.is_empty() {
            match self.state {
                ScreenParserState::Ground => match data.iter().position(|byte| *byte == 0x1b) {
                    Some(index) => {
                        self.parser.process(&data[..index]);
                        self.state = ScreenParserState::Escape;
                        data = &data[index + 1..];
                    }
                    None => {
                        self.parser.process(data);
                        return;
                    }
                },
                ScreenParserState::Escape => {
                    let byte = data[0];
                    data = &data[1..];
                    self.state = match byte {
                        b']' => ScreenParserState::Osc,
                        0x1b => ScreenParserState::Escape,
                        _ => {
                            self.parser.process(&[0x1b, byte]);
                            ScreenParserState::Ground
                        }
                    };
                }
                ScreenParserState::Osc => {
                    match data
                        .iter()
                        .position(|byte| matches!(*byte, 0x07 | 0x18 | 0x1a | 0x1b))
                    {
                        Some(index) => {
                            self.state = if data[index] == 0x1b {
                                ScreenParserState::Escape
                            } else {
                                ScreenParserState::Ground
                            };
                            data = &data[index + 1..];
                        }
                        None => return,
                    }
                }
            }
        }
    }

    fn formatted_state(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut snapshot = if screen.alternate_screen() {
            b"\x1b[?1049h".to_vec()
        } else {
            b"\x1b[?1049l".to_vec()
        };
        // 完整状态包含鼠标、方向键和粘贴模式，单纯重画文字不能恢复 Vim 输入。
        snapshot.extend(screen.state_formatted());
        snapshot
    }
}

fn screen_cache_bytes(columns: u32, rows: u32) -> Result<usize, AppError> {
    // 同时计入主屏和备用屏；每行额外预留结构及解析器开销。
    let bytes = (columns as usize)
        .checked_mul(rows as usize)
        .and_then(|cells| cells.checked_mul(std::mem::size_of::<vt100::Cell>() * 2))
        .and_then(|cells| cells.checked_add(rows as usize * 128 + 4096))
        .filter(|bytes| *bytes < MAX_TERMINAL_CACHE_BYTES)
        .ok_or_else(|| AppError::Validation("保活终端尺寸过大".to_owned()))?;
    Ok(bytes)
}

#[derive(Clone)]
enum TerminalSink {
    Standard(Channel<TerminalEvent>),
    Resume(Channel<TerminalResumeEvent>),
}

impl TerminalSink {
    fn send_data(&self, connection_id: &str, data: &[u8]) -> Result<(), ()> {
        let encoded = BASE64_STANDARD.encode(data);
        match self {
            Self::Standard(channel) => channel
                .send(TerminalEvent::Data {
                    connection_id: connection_id.to_owned(),
                    data: encoded,
                })
                .map_err(|_| ()),
            Self::Resume(channel) => channel
                .send(TerminalResumeEvent::Data {
                    connection_id: connection_id.to_owned(),
                    data: encoded,
                })
                .map_err(|_| ()),
        }
    }

    fn send_bytes(&self, connection_id: &str, data: &[u8]) -> Result<(), ()> {
        if data.is_empty() {
            return Ok(());
        }
        for chunk in data.chunks(MAX_SNAPSHOT_CHUNK_BYTES) {
            self.send_data(connection_id, chunk)?;
        }
        Ok(())
    }

    fn send_end(&self, connection_id: &str, end: &TerminalBridgeEnd) -> Result<(), ()> {
        match (self, end) {
            (Self::Standard(channel), TerminalBridgeEnd::Disconnected { exit_code, message }) => {
                channel
                    .send(TerminalEvent::Disconnected {
                        connection_id: connection_id.to_owned(),
                        exit_code: *exit_code,
                        message: message.clone(),
                    })
                    .map_err(|_| ())
            }
            (Self::Standard(channel), TerminalBridgeEnd::Error(message)) => channel
                .send(TerminalEvent::Error {
                    connection_id: connection_id.to_owned(),
                    message: message.clone(),
                })
                .map_err(|_| ()),
            (Self::Resume(channel), TerminalBridgeEnd::Disconnected { exit_code, message }) => {
                channel
                    .send(TerminalResumeEvent::Disconnected {
                        connection_id: connection_id.to_owned(),
                        exit_code: *exit_code,
                        message: message.clone(),
                    })
                    .map_err(|_| ())
            }
            (Self::Resume(channel), TerminalBridgeEnd::Error(message)) => channel
                .send(TerminalResumeEvent::Error {
                    connection_id: connection_id.to_owned(),
                    message: message.clone(),
                })
                .map_err(|_| ()),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum TerminalBridgeEnd {
    Disconnected {
        exit_code: Option<u32>,
        message: String,
    },
    Error(String),
}

struct PausedTerminal {
    token: String,
    sink: TerminalSink,
    buffered: CachedBytes,
    budget: Arc<CacheBudget>,
    invalid: Arc<AtomicBool>,
    end: Option<TerminalBridgeEnd>,
}

struct DetachedTerminal {
    token: String,
    fallback_sink: Option<TerminalSink>,
    full_snapshot: Option<CachedBytes>,
    deltas: CachedBytes,
    parser: TerminalScreenParser,
    truncated: bool,
    screen_reservation: CacheReservation,
    invalid: Arc<AtomicBool>,
    end: Option<TerminalBridgeEnd>,
}

enum TerminalBridgeState {
    Attached(TerminalSink),
    Paused(PausedTerminal),
    Detached(Box<DetachedTerminal>),
    Dead,
}

#[derive(Clone)]
pub(super) struct LightweightTerminalBridge {
    connection_id: String,
    state: Arc<Mutex<TerminalBridgeState>>,
}

impl LightweightTerminalBridge {
    pub(super) fn new(connection_id: String, events: Channel<TerminalEvent>) -> Self {
        Self {
            connection_id,
            state: Arc::new(Mutex::new(TerminalBridgeState::Attached(
                TerminalSink::Standard(events),
            ))),
        }
    }

    pub(super) async fn emit_data(&self, data: &[u8]) -> Result<(), ()> {
        let mut state = self.state.lock().await;
        match &mut *state {
            TerminalBridgeState::Attached(sink) => sink.send_data(&self.connection_id, data),
            TerminalBridgeState::Paused(paused) => {
                if paused
                    .buffered
                    .append(data, MAX_TERMINAL_CACHE_BYTES)
                    .is_ok()
                {
                    return Ok(());
                }
                paused.invalid.store(true, Ordering::Release);
                let sink = paused.sink.clone();
                let buffered = paused.buffered.take();
                let end = paused.end.take();
                if sink.send_bytes(&self.connection_id, &buffered).is_err()
                    || sink.send_bytes(&self.connection_id, data).is_err()
                {
                    *state = TerminalBridgeState::Dead;
                    return Err(());
                }
                if let Some(end) = end {
                    let _ = sink.send_end(&self.connection_id, &end);
                    *state = TerminalBridgeState::Dead;
                } else {
                    *state = TerminalBridgeState::Attached(sink);
                }
                Ok(())
            }
            TerminalBridgeState::Detached(detached) => {
                detached.parser.process(data);
                let delta_limit = MAX_TERMINAL_CACHE_BYTES
                    .saturating_sub(detached.screen_reservation.bytes)
                    .saturating_sub(
                        detached
                            .full_snapshot
                            .as_ref()
                            .map_or(0, |bytes| bytes.len()),
                    );
                if detached.fallback_sink.is_some() {
                    if detached.deltas.append(data, delta_limit).is_ok() {
                        return Ok(());
                    }
                    detached.invalid.store(true, Ordering::Release);
                    let sink = detached.fallback_sink.take().expect("已检查回退通道");
                    let buffered = detached.deltas.take();
                    let end = detached.end.take();
                    if sink.send_bytes(&self.connection_id, &buffered).is_err()
                        || sink.send_bytes(&self.connection_id, data).is_err()
                    {
                        *state = TerminalBridgeState::Dead;
                        return Err(());
                    }
                    if let Some(end) = end {
                        let _ = sink.send_end(&self.connection_id, &end);
                        *state = TerminalBridgeState::Dead;
                    } else {
                        *state = TerminalBridgeState::Attached(sink);
                    }
                    return Ok(());
                }
                if !detached.truncated && detached.deltas.append(data, delta_limit).is_err() {
                    detached.full_snapshot = None;
                    detached.deltas.clear();
                    detached.truncated = true;
                }
                Ok(())
            }
            TerminalBridgeState::Dead => Ok(()),
        }
    }

    pub(super) async fn emit_end(&self, end: TerminalBridgeEnd) -> Result<(), ()> {
        let mut state = self.state.lock().await;
        match &mut *state {
            TerminalBridgeState::Attached(sink) => {
                sink.send_end(&self.connection_id, &end)?;
                *state = TerminalBridgeState::Dead;
            }
            TerminalBridgeState::Paused(paused) => paused.end = Some(end),
            TerminalBridgeState::Detached(detached) => detached.end = Some(end),
            TerminalBridgeState::Dead => {}
        }
        Ok(())
    }

    async fn pause(
        &self,
        token: &str,
        budget: Arc<CacheBudget>,
        invalid: Arc<AtomicBool>,
    ) -> Result<(), AppError> {
        let mut state = self.state.lock().await;
        let TerminalBridgeState::Attached(sink) = &*state else {
            return Err(AppError::Busy("终端正在切换轻量模式".to_owned()));
        };
        let sink = sink.clone();
        // 空数据沿原通道排队，作为 xterm 快照前的 FIFO 屏障。
        sink.send_data(&self.connection_id, &[])
            .map_err(|_| AppError::Connection("终端事件通道已关闭".to_owned()))?;
        *state = TerminalBridgeState::Paused(PausedTerminal {
            token: token.to_owned(),
            sink,
            buffered: CachedBytes::new(budget.clone()),
            budget,
            invalid,
            end: None,
        });
        Ok(())
    }

    async fn commit(
        &self,
        token: &str,
        full_snapshot: CachedBytes,
        viewport_snapshot: CachedBytes,
        columns: u32,
        rows: u32,
    ) -> Result<(), AppError> {
        let mut state = self.state.lock().await;
        let TerminalBridgeState::Paused(paused) = &mut *state else {
            return Err(AppError::Conflict("终端轻量模式事务已失效".to_owned()));
        };
        if paused.token != token || paused.invalid.load(Ordering::Acquire) {
            return Err(AppError::Conflict("终端轻量模式事务已失效".to_owned()));
        }
        let screen_bytes = screen_cache_bytes(columns, rows)?;
        let screen_reservation = CacheReservation::new(paused.budget.clone(), screen_bytes)
            .ok_or_else(|| AppError::Busy("终端缓存超过全局大小上限".to_owned()))?;
        let mut parser = TerminalScreenParser::new(rows as u16, columns as u16);
        parser.process(&viewport_snapshot);
        parser.process(&paused.buffered);

        let can_keep_full = full_snapshot
            .len()
            .saturating_add(paused.buffered.len())
            .saturating_add(screen_bytes)
            <= MAX_TERMINAL_CACHE_BYTES;
        let (full_snapshot, truncated) = if can_keep_full {
            (Some(full_snapshot), false)
        } else {
            (None, true)
        };
        let detached = DetachedTerminal {
            token: paused.token.clone(),
            fallback_sink: Some(paused.sink.clone()),
            full_snapshot,
            deltas: paused.buffered.take(),
            parser,
            truncated,
            screen_reservation,
            invalid: paused.invalid.clone(),
            end: paused.end.take(),
        };
        *state = TerminalBridgeState::Detached(Box::new(detached));
        Ok(())
    }

    async fn finalize_detach_group(
        bridges: &[Self],
        token: &str,
        finalize: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        // 同时锁定全部桥后再移除回退通道，避免多终端提交只成功一半。
        let mut states = Vec::with_capacity(bridges.len());
        for bridge in bridges {
            states.push(bridge.state.clone().lock_owned().await);
        }
        for state in &states {
            let TerminalBridgeState::Detached(detached) = &**state else {
                return Err(AppError::Conflict("终端轻量模式事务已失效".to_owned()));
            };
            if detached.token != token || detached.invalid.load(Ordering::Acquire) {
                return Err(AppError::Conflict("终端轻量模式事务已失效".to_owned()));
            }
        }
        // 窗口操作与最后一次校验共用这组锁，失败前始终保留原通道用于完整回滚。
        finalize()?;
        for state in &mut states {
            let TerminalBridgeState::Detached(detached) = &mut **state else {
                unreachable!("终端桥已在同一组锁内完成校验");
            };
            detached.fallback_sink = None;
            if detached.truncated {
                detached.deltas.clear();
            }
        }
        Ok(())
    }

    async fn abort(&self, token: &str) {
        let mut state = self.state.lock().await;
        let (sink, buffered, end) = match &mut *state {
            TerminalBridgeState::Paused(paused) if paused.token == token => (
                paused.sink.clone(),
                paused.buffered.take(),
                paused.end.take(),
            ),
            TerminalBridgeState::Detached(detached)
                if detached.token == token && detached.fallback_sink.is_some() =>
            {
                (
                    detached.fallback_sink.take().expect("已检查回退通道"),
                    detached.deltas.take(),
                    detached.end.take(),
                )
            }
            _ => return,
        };
        if sink.send_bytes(&self.connection_id, &buffered).is_err() {
            *state = TerminalBridgeState::Dead;
            return;
        }
        if let Some(end) = end {
            let _ = sink.send_end(&self.connection_id, &end);
            *state = TerminalBridgeState::Dead;
        } else {
            *state = TerminalBridgeState::Attached(sink);
        }
    }

    async fn attach(&self, channel: Channel<TerminalResumeEvent>) -> Result<bool, AppError> {
        let mut state = self.state.lock().await;
        let TerminalBridgeState::Detached(detached) = &mut *state else {
            return Err(AppError::NotFound("保活终端不存在或已恢复".to_owned()));
        };
        if detached.fallback_sink.is_some() {
            return Err(AppError::Busy("轻量模式仍在提交".to_owned()));
        }
        let formatted_snapshot = detached
            .truncated
            .then(|| detached.parser.formatted_state());
        let snapshot = formatted_snapshot.as_deref().unwrap_or_else(|| {
            detached
                .full_snapshot
                .as_ref()
                .map_or(&[], |bytes| &**bytes)
        });
        let total_chunks = snapshot.len().div_ceil(MAX_SNAPSHOT_CHUNK_BYTES).max(1);
        for (index, chunk) in snapshot.chunks(MAX_SNAPSHOT_CHUNK_BYTES).enumerate() {
            channel
                .send(TerminalResumeEvent::Snapshot {
                    connection_id: self.connection_id.clone(),
                    data: BASE64_STANDARD.encode(chunk),
                    chunk_index: index as u32,
                    total_chunks: total_chunks as u32,
                    truncated: detached.truncated,
                })
                .map_err(|_| AppError::Connection("终端恢复通道已关闭".to_owned()))?;
        }
        if snapshot.is_empty() {
            channel
                .send(TerminalResumeEvent::Snapshot {
                    connection_id: self.connection_id.clone(),
                    data: String::new(),
                    chunk_index: 0,
                    total_chunks: 1,
                    truncated: detached.truncated,
                })
                .map_err(|_| AppError::Connection("终端恢复通道已关闭".to_owned()))?;
        }
        if !detached.truncated {
            for chunk in detached.deltas.chunks(MAX_SNAPSHOT_CHUNK_BYTES) {
                channel
                    .send(TerminalResumeEvent::Data {
                        connection_id: self.connection_id.clone(),
                        data: BASE64_STANDARD.encode(chunk),
                    })
                    .map_err(|_| AppError::Connection("终端恢复通道已关闭".to_owned()))?;
            }
        }
        if let Some(end) = &detached.end {
            TerminalSink::Resume(channel.clone())
                .send_end(&self.connection_id, end)
                .map_err(|_| AppError::Connection("终端恢复通道已关闭".to_owned()))?;
        }
        channel
            .send(TerminalResumeEvent::Ready {
                connection_id: self.connection_id.clone(),
                truncated: detached.truncated,
            })
            .map_err(|_| AppError::Connection("终端恢复通道已关闭".to_owned()))?;

        let truncated = detached.truncated;
        if detached.end.is_some() {
            *state = TerminalBridgeState::Dead;
        } else {
            *state = TerminalBridgeState::Attached(TerminalSink::Resume(channel));
        }
        Ok(truncated)
    }
}

struct SnapshotBuffer {
    expected_chunks: Option<u32>,
    next_chunk: u32,
    bytes: CachedBytes,
    limit: usize,
}

impl SnapshotBuffer {
    fn new(limit: usize, budget: Arc<CacheBudget>) -> Self {
        Self {
            expected_chunks: None,
            next_chunk: 0,
            bytes: CachedBytes::new(budget),
            limit,
        }
    }

    fn append(&mut self, chunk_index: u32, total_chunks: u32, data: &[u8]) -> Result<(), AppError> {
        if total_chunks == 0
            || total_chunks as usize > self.limit.div_ceil(MAX_SNAPSHOT_CHUNK_BYTES)
            || chunk_index != self.next_chunk
            || chunk_index >= total_chunks
            || data.len() > MAX_SNAPSHOT_CHUNK_BYTES
            || (chunk_index + 1 < total_chunks && data.len() != MAX_SNAPSHOT_CHUNK_BYTES)
            || (total_chunks > 1 && data.is_empty())
        {
            return Err(AppError::Validation("终端快照分块顺序无效".to_owned()));
        }
        match self.expected_chunks {
            Some(expected) if expected != total_chunks => {
                return Err(AppError::Validation("终端快照分块数量不一致".to_owned()));
            }
            _ => {}
        }
        self.bytes.append(data, self.limit)?;
        self.expected_chunks = Some(total_chunks);
        self.next_chunk += 1;
        Ok(())
    }

    fn complete(&self) -> bool {
        self.expected_chunks == Some(self.next_chunk)
    }
}

struct PreparedTerminal {
    request: LightweightTerminalRequest,
    bridge: LightweightTerminalBridge,
    full: SnapshotBuffer,
    viewport: SnapshotBuffer,
}

struct LightweightTransaction {
    token: String,
    deadline: Instant,
    suppress_confirmation: bool,
    invalid: Arc<AtomicBool>,
    terminals: HashMap<String, PreparedTerminal>,
    _gui_activity: OwnedRwLockWriteGuard<()>,
}

struct PreservedTerminal {
    request: LightweightTerminalRequest,
    bridge: LightweightTerminalBridge,
}

#[derive(Default)]
struct LightweightRuntime {
    transaction: Option<LightweightTransaction>,
    terminals: HashMap<String, PreservedTerminal>,
}

#[derive(Clone)]
pub struct LightweightModeService {
    config: Arc<StdMutex<LightweightModeConfig>>,
    runtime: Arc<Mutex<LightweightRuntime>>,
    gui_activity: Arc<RwLock<()>>,
}

impl LightweightModeService {
    pub fn load(app_data_dir: &Path) -> Self {
        Self {
            config: Arc::new(StdMutex::new(LightweightModeConfig::load(app_data_dir))),
            runtime: Arc::new(Mutex::new(LightweightRuntime::default())),
            gui_activity: Arc::new(RwLock::new(())),
        }
    }

    pub fn starts_active(&self) -> bool {
        self.config
            .lock()
            .map(|config| config.current.active)
            .unwrap_or(false)
    }

    pub fn try_gui_activity(&self) -> Result<OwnedRwLockReadGuard<()>, AppError> {
        let guard = self
            .gui_activity
            .clone()
            .try_read_owned()
            .map_err(|_| AppError::Busy("轻量模式切换正在进行".to_owned()))?;
        if self.starts_active() {
            return Err(AppError::Busy("轻量模式切换正在进行".to_owned()));
        }
        Ok(guard)
    }

    pub(crate) async fn window_activation_guard(&self) -> OwnedRwLockReadGuard<()> {
        // 唤回允许发生在已分离状态，但必须等快照提交或回滚完全结束。
        // 许可持有到窗口显示完成，防止新的快照事务穿过建窗过程。
        self.gui_activity.clone().read_owned().await
    }

    pub async fn state(&self) -> LightweightModeState {
        let runtime = self.runtime.lock().await;
        let (active, suppress_confirmation) = self
            .config
            .lock()
            .map(|config| (config.current.active, config.current.suppress_confirmation))
            .unwrap_or((false, false));
        let phase = if runtime.transaction.is_some() {
            LightweightModePhase::Preparing
        } else if active || !runtime.terminals.is_empty() {
            LightweightModePhase::Detached
        } else {
            LightweightModePhase::Normal
        };
        let mut terminals = runtime
            .terminals
            .values()
            .map(|terminal| PreservedTerminalSummary {
                runtime_id: terminal.request.runtime_id.clone(),
                connection_id: terminal.request.connection.connection_id.clone(),
                session_id: terminal.request.connection.session_id.clone(),
                current_path: terminal.request.current_path.clone(),
            })
            .collect::<Vec<_>>();
        terminals.sort_by(|left, right| left.runtime_id.cmp(&right.runtime_id));
        LightweightModeState {
            active,
            suppress_confirmation,
            phase,
            terminals,
            transfer_jobs: Vec::new(),
        }
    }

    pub async fn begin(
        &self,
        connection_manager: &ConnectionManager,
        terminals: Vec<LightweightTerminalRequest>,
        suppress_confirmation: bool,
    ) -> Result<BeginLightweightModeResult, AppError> {
        if terminals.len() > MAX_TERMINALS {
            return Err(AppError::Validation("保活终端数量过多".to_owned()));
        }
        // 连接和更新持读锁，快照事务持写锁；校验后不会再插入新的 GUI 连接。
        let gui_activity = self.gui_activity.clone().try_write_owned().map_err(|_| {
            AppError::Busy("连接、认证或更新正在进行，暂时无法进入轻量模式".to_owned())
        })?;
        if connection_manager.has_connecting_sessions().await {
            return Err(AppError::Busy(
                "连接或认证正在进行，暂时无法进入轻量模式".to_owned(),
            ));
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.transaction.is_some() || !runtime.terminals.is_empty() {
            return Err(AppError::Busy("轻量模式切换正在进行".to_owned()));
        }
        let token = Uuid::new_v4().to_string();
        let budget = Arc::new(CacheBudget::default());
        let invalid = Arc::new(AtomicBool::new(false));
        let mut runtime_ids = HashSet::new();
        let mut connection_ids = HashSet::new();
        let mut prepared = HashMap::new();
        for request in terminals {
            validate_terminal_request(&request)?;
            if !runtime_ids.insert(request.runtime_id.clone())
                || !connection_ids.insert(request.connection.connection_id.clone())
            {
                return Err(AppError::Validation("保活终端映射重复".to_owned()));
            }
            let bridge = connection_manager
                .lightweight_terminal_bridge(
                    &request.connection.connection_id,
                    &request.connection.session_id,
                )
                .await?;
            prepared.insert(
                request.runtime_id.clone(),
                PreparedTerminal {
                    request,
                    bridge,
                    full: SnapshotBuffer::new(MAX_SNAPSHOT_BYTES, budget.clone()),
                    viewport: SnapshotBuffer::new(MAX_VIEWPORT_SNAPSHOT_BYTES, budget.clone()),
                },
            );
        }

        if connection_manager.lightweight_connection_ids().await != connection_ids {
            return Err(AppError::Conflict("终端连接映射已变化，请重试".to_owned()));
        }
        let bridges = prepared
            .values()
            .map(|terminal| terminal.bridge.clone())
            .collect::<Vec<_>>();
        for bridge in &bridges {
            if let Err(error) = bridge.pause(&token, budget.clone(), invalid.clone()).await {
                for current in &bridges {
                    current.abort(&token).await;
                }
                return Err(error);
            }
        }
        runtime.transaction = Some(LightweightTransaction {
            token: token.clone(),
            deadline: Instant::now() + TRANSACTION_TIMEOUT,
            suppress_confirmation,
            invalid,
            terminals: prepared,
            _gui_activity: gui_activity,
        });
        drop(runtime);

        let service = self.clone();
        let timeout_token = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(TRANSACTION_TIMEOUT).await;
            service.abort(&timeout_token).await;
        });
        Ok(BeginLightweightModeResult { token })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn append_snapshot_chunk(
        &self,
        token: &str,
        runtime_id: &str,
        kind: LightweightSnapshotKind,
        chunk_index: u32,
        total_chunks: u32,
        data: &str,
    ) -> Result<(), AppError> {
        if data.len() > MAX_SNAPSHOT_CHUNK_BYTES.div_ceil(3) * 4 {
            return Err(AppError::Validation("终端快照分块超过 192 KiB".to_owned()));
        }
        let decoded = BASE64_STANDARD
            .decode(data)
            .map_err(|_| AppError::Validation("终端快照分块编码无效".to_owned()))?;
        if decoded.len() > MAX_SNAPSHOT_CHUNK_BYTES {
            return Err(AppError::Validation("终端快照分块超过 192 KiB".to_owned()));
        }
        let mut runtime = self.runtime.lock().await;
        let transaction = runtime
            .transaction
            .as_mut()
            .filter(|transaction| transaction.token == token)
            .ok_or_else(|| AppError::Conflict("轻量模式事务已失效".to_owned()))?;
        if transaction.deadline <= Instant::now() || transaction.invalid.load(Ordering::Acquire) {
            return Err(AppError::Conflict("轻量模式事务已失效".to_owned()));
        }
        let terminal = transaction
            .terminals
            .get_mut(runtime_id)
            .ok_or_else(|| AppError::Validation("终端不属于当前轻量模式事务".to_owned()))?;
        match kind {
            LightweightSnapshotKind::Full => {
                terminal.full.append(chunk_index, total_chunks, &decoded)
            }
            LightweightSnapshotKind::Viewport => {
                terminal
                    .viewport
                    .append(chunk_index, total_chunks, &decoded)
            }
        }
    }

    pub async fn commit(
        &self,
        token: &str,
        save_window: impl FnOnce() -> Result<(), AppError>,
        destroy_window: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        // 持有运行时锁直到窗口提交完成，阻止 begin、abort 和 restore 穿过提交空隙。
        let mut runtime = self.runtime.lock().await;
        let transaction = runtime
            .transaction
            .as_ref()
            .filter(|transaction| transaction.token == token)
            .ok_or_else(|| AppError::Conflict("轻量模式事务已失效".to_owned()))?;
        if transaction.deadline <= Instant::now() || transaction.invalid.load(Ordering::Acquire) {
            return Err(AppError::Conflict("轻量模式事务已失效".to_owned()));
        }
        if transaction
            .terminals
            .values()
            .any(|terminal| !terminal.full.complete() || !terminal.viewport.complete())
        {
            return Err(AppError::Conflict("终端快照尚未完整提交".to_owned()));
        }
        // 先验证令牌再取出；错误令牌绝不能消耗其他调用仍有效的事务。
        let mut transaction = runtime.transaction.take().expect("已校验当前事务");
        let bridges = transaction
            .terminals
            .values()
            .map(|terminal| terminal.bridge.clone())
            .collect::<Vec<_>>();
        let mut preserved = HashMap::new();
        for terminal in transaction.terminals.values_mut() {
            if let Err(error) = terminal
                .bridge
                .commit(
                    token,
                    terminal.full.bytes.take(),
                    terminal.viewport.bytes.take(),
                    terminal.request.columns,
                    terminal.request.rows,
                )
                .await
            {
                for current in &bridges {
                    current.abort(token).await;
                }
                return Err(error);
            }
            preserved.insert(
                terminal.request.runtime_id.clone(),
                PreservedTerminal {
                    request: terminal.request.clone(),
                    bridge: terminal.bridge.clone(),
                },
            );
        }
        let finalize = || {
            if transaction.deadline <= Instant::now() {
                return Err(AppError::Conflict("轻量模式事务已失效".to_owned()));
            }
            save_window()?;
            let previous = self
                .config
                .lock()
                .map_err(|_| AppError::Internal("轻量模式设置锁已失效".to_owned()))?
                .current
                .clone();
            self.set_config(true, transaction.suppress_confirmation)?;
            if let Err(error) = destroy_window() {
                // 即使磁盘再次失败，仍保持已打开窗口的运行时为普通模式，允许用户重试。
                let mut config = self
                    .config
                    .lock()
                    .map_err(|_| AppError::Internal("轻量模式设置锁已失效".to_owned()))?;
                config.current = previous;
                config.persist()?;
                return Err(error);
            }
            Ok(())
        };
        if let Err(error) =
            LightweightTerminalBridge::finalize_detach_group(&bridges, token, finalize).await
        {
            for current in &bridges {
                current.abort(token).await;
            }
            return Err(error);
        }
        runtime.terminals = preserved;
        Ok(())
    }

    pub async fn abort(&self, token: &str) {
        let mut runtime = self.runtime.lock().await;
        let transaction = match runtime
            .transaction
            .as_ref()
            .filter(|transaction| transaction.token == token)
        {
            Some(_) => runtime.transaction.take(),
            None => None,
        };
        if let Some(transaction) = transaction {
            for terminal in transaction.terminals.values() {
                terminal.bridge.abort(token).await;
            }
        }
    }

    pub async fn attach_terminal(
        &self,
        runtime_id: &str,
        channel: Channel<TerminalResumeEvent>,
    ) -> Result<PreservedTerminalAttachment, AppError> {
        let mut runtime = self.runtime.lock().await;
        let (request, bridge) = {
            let terminal = runtime
                .terminals
                .get(runtime_id)
                .ok_or_else(|| AppError::NotFound("保活终端不存在或已恢复".to_owned()))?;
            (terminal.request.clone(), terminal.bridge.clone())
        };
        let truncated = bridge.attach(channel).await?;
        runtime.terminals.remove(runtime_id);
        Ok(PreservedTerminalAttachment {
            runtime_id: request.runtime_id,
            connection: request.connection,
            current_path: request.current_path,
            columns: request.columns,
            rows: request.rows,
            truncated,
            shell_integration_token: request.shell_integration_token,
        })
    }

    pub async fn finish_restore(
        &self,
        connection_manager: &ConnectionManager,
        valid_runtime_ids: Vec<String>,
    ) -> Result<(), AppError> {
        if valid_runtime_ids.len() > MAX_TERMINALS
            || valid_runtime_ids
                .iter()
                .any(|runtime_id| Uuid::parse_str(runtime_id).is_err())
        {
            return Err(AppError::Validation("恢复终端标签列表无效".to_owned()));
        }
        let mut runtime = self.runtime.lock().await;
        if runtime.transaction.is_some() {
            return Err(AppError::Busy("轻量模式切换正在进行".to_owned()));
        }
        let suppress_confirmation = self
            .config
            .lock()
            .map_err(|_| AppError::Internal("轻量模式设置锁已失效".to_owned()))?
            .current
            .suppress_confirmation;
        self.set_config(false, suppress_confirmation)?;

        let valid = valid_runtime_ids.into_iter().collect::<HashSet<_>>();
        let orphan_connections = {
            let orphan_ids = runtime
                .terminals
                .keys()
                .filter(|runtime_id| !valid.contains(*runtime_id))
                .cloned()
                .collect::<Vec<_>>();
            orphan_ids
                .into_iter()
                .filter_map(|runtime_id| runtime.terminals.remove(&runtime_id))
                .map(|terminal| terminal.request.connection.connection_id)
                .collect::<Vec<_>>()
        };
        drop(runtime);
        for connection_id in orphan_connections {
            let _ = connection_manager.disconnect(&connection_id).await;
        }
        Ok(())
    }

    pub fn force_normal(&self) -> Result<(), AppError> {
        let mut config = self
            .config
            .lock()
            .map_err(|_| AppError::Internal("轻量模式设置锁已失效".to_owned()))?;
        config.current.active = false;
        config.persist()
    }

    fn set_config(&self, active: bool, suppress_confirmation: bool) -> Result<(), AppError> {
        self.config
            .lock()
            .map_err(|_| AppError::Internal("轻量模式设置锁已失效".to_owned()))?
            .update(active, suppress_confirmation)
    }
}

fn validate_terminal_request(request: &LightweightTerminalRequest) -> Result<(), AppError> {
    if Uuid::parse_str(&request.runtime_id).is_err()
        || Uuid::parse_str(&request.connection.connection_id).is_err()
        || Uuid::parse_str(&request.connection.session_id).is_err()
        || !(1..=1000).contains(&request.columns)
        || !(1..=1000).contains(&request.rows)
        || !request.current_path.starts_with('/')
        || request.current_path.len() > 4096
        || request.current_path.chars().any(char::is_control)
        || !request.connection.home_path.starts_with('/')
        || request.connection.home_path.len() > 4096
        || request.connection.home_path.chars().any(char::is_control)
        || request
            .shell_integration_token
            .as_ref()
            .is_some_and(|token| {
                token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    {
        return Err(AppError::Validation("保活终端参数无效".to_owned()));
    }
    screen_cache_bytes(request.columns, request.rows)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tauri::ipc::InvokeResponseBody;

    fn temp_directory() -> PathBuf {
        std::env::temp_dir().join(format!("fstty-lightweight-{}", Uuid::new_v4()))
    }

    fn cached(budget: &Arc<CacheBudget>, bytes: &[u8]) -> CachedBytes {
        let mut cached = CachedBytes::new(budget.clone());
        cached
            .append(bytes, MAX_SNAPSHOT_BYTES)
            .expect("测试缓存应可分配");
        cached
    }

    type CapturedEvents = Arc<StdMutex<Vec<Value>>>;

    struct PreparedTest {
        service: LightweightModeService,
        directory: PathBuf,
        token: String,
        bridges: Vec<LightweightTerminalBridge>,
        events: Vec<CapturedEvents>,
        budget: Arc<CacheBudget>,
    }

    impl Drop for PreparedTest {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    async fn prepared_test(count: usize) -> PreparedTest {
        let directory = temp_directory();
        let service = LightweightModeService::load(&directory);
        let token = Uuid::new_v4().to_string();
        let budget = Arc::new(CacheBudget::default());
        let invalid = Arc::new(AtomicBool::new(false));
        let mut terminals = HashMap::new();
        let mut bridges = Vec::new();
        let mut captured_events = Vec::new();
        for _ in 0..count {
            let (channel, events) = capture_channel::<TerminalEvent>();
            let connection_id = Uuid::new_v4().to_string();
            let runtime_id = Uuid::new_v4().to_string();
            let bridge = LightweightTerminalBridge::new(connection_id.clone(), channel);
            bridge
                .pause(&token, budget.clone(), invalid.clone())
                .await
                .expect("应暂停测试终端");
            let mut full = SnapshotBuffer::new(MAX_SNAPSHOT_BYTES, budget.clone());
            let mut viewport = SnapshotBuffer::new(MAX_VIEWPORT_SNAPSHOT_BYTES, budget.clone());
            full.append(0, 1, b"snapshot").expect("应填充完整快照");
            viewport.append(0, 1, b"screen").expect("应填充画面快照");
            terminals.insert(
                runtime_id.clone(),
                PreparedTerminal {
                    request: LightweightTerminalRequest {
                        runtime_id,
                        connection: crate::models::SshConnection {
                            connection_id,
                            session_id: Uuid::new_v4().to_string(),
                            home_path: "/".to_owned(),
                            sftp_available: false,
                            shell_name: None,
                        },
                        current_path: "/".to_owned(),
                        columns: 80,
                        rows: 24,
                        shell_integration_token: None,
                    },
                    bridge: bridge.clone(),
                    full,
                    viewport,
                },
            );
            bridges.push(bridge);
            captured_events.push(events);
        }
        service.runtime.lock().await.transaction = Some(LightweightTransaction {
            token: token.clone(),
            deadline: Instant::now() + TRANSACTION_TIMEOUT,
            suppress_confirmation: true,
            invalid,
            terminals,
            _gui_activity: service
                .gui_activity
                .clone()
                .try_write_owned()
                .expect("应取得测试切换锁"),
        });
        PreparedTest {
            service,
            directory,
            token,
            bridges,
            events: captured_events,
            budget,
        }
    }

    fn capture_channel<T: Serialize>() -> (Channel<T>, Arc<StdMutex<Vec<Value>>>) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let captured = events.clone();
        let channel = Channel::<T>::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                captured
                    .lock()
                    .expect("事件存储锁应有效")
                    .push(serde_json::from_str(&json).expect("事件应为 JSON"));
            }
            Ok(())
        });
        (channel, events)
    }

    fn decoded_data(events: &Arc<StdMutex<Vec<Value>>>) -> Vec<Vec<u8>> {
        events
            .lock()
            .expect("事件存储锁应有效")
            .iter()
            .filter(|event| event["kind"] == "data")
            .map(|event| {
                BASE64_STANDARD
                    .decode(event["data"].as_str().expect("数据事件应有内容"))
                    .expect("数据事件应为 Base64")
            })
            .collect()
    }

    #[test]
    fn 损坏主文件时使用备份且清理临时文件() {
        let directory = temp_directory();
        fs::create_dir_all(&directory).expect("应创建测试目录");
        fs::write(directory.join(STORE_FILE), b"{").expect("应写入损坏主文件");
        fs::write(
            directory.join(STORE_BACKUP_FILE),
            br#"{"version":1,"active":true,"suppressConfirmation":true}"#,
        )
        .expect("应写入备份");
        fs::write(directory.join(STORE_TEMP_FILE), b"temp").expect("应写入临时文件");

        let config = LightweightModeConfig::load(&directory);
        assert!(config.current.active);
        assert!(config.current.suppress_confirmation);
        assert!(!directory.join(STORE_TEMP_FILE).exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 主备均损坏时回退普通模式() {
        let directory = temp_directory();
        fs::create_dir_all(&directory).expect("应创建测试目录");
        fs::write(directory.join(STORE_FILE), b"bad").expect("应写入损坏主文件");
        fs::write(directory.join(STORE_BACKUP_FILE), b"bad").expect("应写入损坏备份");

        let config = LightweightModeConfig::load(&directory);
        assert!(!config.current.active);
        assert!(!config.current.suppress_confirmation);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 保存失败时回滚内存配置() {
        let directory = temp_directory();
        fs::write(&directory, "不是目录".as_bytes()).expect("应创建冲突文件");
        let mut config = LightweightModeConfig::load(&directory);

        assert!(config.update(true, true).is_err());
        assert!(!config.current.active);
        assert!(!config.current.suppress_confirmation);
        let _ = fs::remove_file(directory);
    }

    #[test]
    fn 连续保存保留上一版备份() {
        let directory = temp_directory();
        let mut config = LightweightModeConfig::load(&directory);
        config.update(true, true).expect("首次保存应成功");
        config.update(false, true).expect("第二次保存应成功");

        let current = read_store(&directory.join(STORE_FILE))
            .expect("应读取主文件")
            .expect("主文件应存在");
        let backup = read_store(&directory.join(STORE_BACKUP_FILE))
            .expect("应读取备份")
            .expect("备份应存在");
        assert!(!current.active);
        assert!(backup.active);
        assert!(current.suppress_confirmation && backup.suppress_confirmation);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn 快照分块拒绝乱序和超限() {
        let budget = Arc::new(CacheBudget::default());
        let mut buffer = SnapshotBuffer::new(MAX_SNAPSHOT_CHUNK_BYTES + 1, budget);
        assert!(buffer.append(1, 2, b"a").is_err());
        assert!(buffer
            .append(0, 2, &vec![b'a'; MAX_SNAPSHOT_CHUNK_BYTES])
            .is_ok());
        assert!(buffer.append(1, 2, b"de").is_err());
        assert!(!buffer.complete());
    }

    #[tokio::test]
    async fn 暂停后中止按顺序补发且不重复() {
        let (channel, events) = capture_channel::<TerminalEvent>();
        let bridge = LightweightTerminalBridge::new("connection".to_owned(), channel);
        let budget = Arc::new(CacheBudget::default());
        let invalid = Arc::new(AtomicBool::new(false));

        bridge
            .pause("token", budget, invalid)
            .await
            .expect("应进入暂停状态");
        bridge.emit_data(b"buffered").await.expect("应缓存输出");
        bridge.abort("token").await;
        bridge.emit_data(b"tail").await.expect("应恢复原通道");

        let chunks = decoded_data(&events);
        assert_eq!(
            chunks,
            vec![Vec::<u8>::new(), b"buffered".to_vec(), b"tail".to_vec()]
        );
    }

    #[tokio::test]
    async fn 提交前缓存溢出立即回退且不丢当前输出() {
        let (channel, events) = capture_channel::<TerminalEvent>();
        let bridge = LightweightTerminalBridge::new("connection".to_owned(), channel);
        let budget = Arc::new(CacheBudget::default());
        let invalid = Arc::new(AtomicBool::new(false));

        bridge
            .pause("token", budget.clone(), invalid.clone())
            .await
            .expect("应进入暂停状态");
        bridge.emit_data(b"buffered").await.expect("应缓存输出");
        bridge
            .commit(
                "token",
                cached(&budget, b"snapshot"),
                cached(&budget, b"screen"),
                80,
                24,
            )
            .await
            .expect("应准备分离状态");
        budget.used.store(MAX_GLOBAL_CACHE_BYTES, Ordering::Release);
        bridge.emit_data(b"overflow").await.expect("应回退原通道");
        bridge.emit_data(b"tail").await.expect("回退后应继续输出");

        assert!(invalid.load(Ordering::Acquire));
        let chunks = decoded_data(&events);
        assert_eq!(
            chunks,
            vec![
                Vec::<u8>::new(),
                b"buffered".to_vec(),
                b"overflow".to_vec(),
                b"tail".to_vec()
            ]
        );
    }

    #[tokio::test]
    async fn 恢复依次发送快照增量和就绪标记() {
        let (channel, _) = capture_channel::<TerminalEvent>();
        let bridge = LightweightTerminalBridge::new("connection".to_owned(), channel);
        let budget = Arc::new(CacheBudget::default());
        let invalid = Arc::new(AtomicBool::new(false));
        bridge
            .pause("token", budget.clone(), invalid)
            .await
            .expect("应进入暂停状态");
        bridge
            .emit_data(b"delta-one")
            .await
            .expect("应缓存首段增量");
        bridge
            .commit(
                "token",
                cached(&budget, b"snapshot"),
                cached(&budget, b"screen"),
                80,
                24,
            )
            .await
            .expect("应准备分离状态");
        LightweightTerminalBridge::finalize_detach_group(
            std::slice::from_ref(&bridge),
            "token",
            || Ok(()),
        )
        .await
        .expect("应完成分离");
        bridge
            .emit_data(b"delta-two")
            .await
            .expect("应缓存后台增量");

        let (resume, events) = capture_channel::<TerminalResumeEvent>();
        assert!(!bridge.attach(resume).await.expect("应恢复终端"));
        let events = events.lock().expect("事件存储锁应有效");
        assert_eq!(events[0]["kind"], "snapshot");
        assert_eq!(events.last().expect("应有就绪事件")["kind"], "ready");
        let replayed = events
            .iter()
            .filter(|event| event["kind"] == "data")
            .flat_map(|event| {
                BASE64_STANDARD
                    .decode(event["data"].as_str().expect("增量应有内容"))
                    .expect("增量应为 Base64")
            })
            .collect::<Vec<_>>();
        assert_eq!(replayed, b"delta-onedelta-two");
    }

    #[tokio::test]
    async fn 错误令牌不能消耗有效事务() {
        let test = prepared_test(1).await;
        assert!(test
            .service
            .commit("wrong-token", || Ok(()), || Ok(()))
            .await
            .is_err());
        assert_eq!(
            test.service.state().await.phase,
            LightweightModePhase::Preparing
        );
        test.bridges[0]
            .emit_data(b"buffered")
            .await
            .expect("应继续缓存");
        test.service.abort(&test.token).await;
        assert_eq!(
            decoded_data(&test.events[0]),
            vec![vec![], b"buffered".to_vec()]
        );
        assert_eq!(test.budget.used.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn 窗口销毁与配置回滚同时失败仍恢复内存状态和原通道() {
        let prepared = prepared_test(1).await;
        let result = prepared
            .service
            .commit(
                &prepared.token,
                || Ok(()),
                || {
                    fs::create_dir(prepared.directory.join(STORE_TEMP_FILE))
                        .expect("应模拟回滚写入失败");
                    Err(AppError::Internal("窗口销毁失败".to_owned()))
                },
            )
            .await;
        assert!(result.is_err());
        assert!(!prepared.service.starts_active());
        prepared.bridges[0]
            .emit_data(b"after")
            .await
            .expect("回滚后原通道应可继续接收输出");
        assert_eq!(
            decoded_data(&prepared.events[0]).last(),
            Some(&b"after".to_vec())
        );
        assert_eq!(prepared.budget.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn 托盘失败回退普通模式不被磁盘故障阻止() {
        let directory = temp_directory();
        let service = LightweightModeService::load(&directory);
        service.set_config(true, true).expect("应保存初始轻量配置");
        fs::create_dir(directory.join(STORE_TEMP_FILE)).expect("应模拟无法写入临时文件");
        assert!(service.force_normal().is_err());
        assert!(!service.starts_active());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn 远端钩子令牌随终端恢复且不写入轻量配置() {
        let prepared = prepared_test(1).await;
        let token = "0123456789abcdef0123456789abcdef";
        let runtime_id = {
            let mut runtime = prepared.service.runtime.lock().await;
            let terminal = runtime
                .transaction
                .as_mut()
                .expect("应有准备事务")
                .terminals
                .values_mut()
                .next()
                .expect("应有终端");
            terminal.request.shell_integration_token = Some(token.to_owned());
            terminal.request.runtime_id.clone()
        };
        prepared
            .service
            .commit(&prepared.token, || Ok(()), || Ok(()))
            .await
            .expect("应提交保活终端");
        let (channel, _) = capture_channel::<TerminalResumeEvent>();
        let attachment = prepared
            .service
            .attach_terminal(&runtime_id, channel)
            .await
            .expect("应恢复终端");
        assert_eq!(attachment.shell_integration_token.as_deref(), Some(token));
        let stored = fs::read_to_string(prepared.directory.join(STORE_FILE)).expect("应读取配置");
        assert!(!stored.contains(token));
        assert!(!stored.contains(&runtime_id));
    }

    #[tokio::test]
    async fn 多终端中途失败回滚全部桥和缓存额度() {
        let test = prepared_test(3).await;
        for bridge in &test.bridges {
            bridge.emit_data(b"buffered").await.expect("应缓存输出");
        }
        let failed_bridge = test
            .service
            .runtime
            .lock()
            .await
            .transaction
            .as_ref()
            .expect("应存在事务")
            .terminals
            .values()
            .nth(1)
            .expect("应有第二个终端")
            .bridge
            .clone();
        failed_bridge.abort(&test.token).await;
        assert!(test
            .service
            .commit(&test.token, || Ok(()), || Ok(()))
            .await
            .is_err());
        for (bridge, events) in test.bridges.iter().zip(&test.events) {
            bridge
                .emit_data(b"tail")
                .await
                .expect("全部终端应恢复原通道");
            let bytes = decoded_data(events).concat();
            assert_eq!(bytes, b"bufferedtail");
        }
        assert_eq!(test.budget.used.load(Ordering::Acquire), 0);
        assert!(!test.service.starts_active());
    }

    #[tokio::test]
    async fn 保存窗口失败不销毁窗口且回滚终端() {
        let test = prepared_test(1).await;
        test.bridges[0]
            .emit_data(b"buffered")
            .await
            .expect("应缓存输出");
        let result = test
            .service
            .commit(
                &test.token,
                || Err(AppError::Persistence("保存失败".to_owned())),
                || panic!("保存失败后不能销毁窗口"),
            )
            .await;
        assert!(result.is_err());
        test.bridges[0]
            .emit_data(b"tail")
            .await
            .expect("应恢复原通道");
        assert_eq!(decoded_data(&test.events[0]).concat(), b"bufferedtail");
        assert_eq!(test.budget.used.load(Ordering::Acquire), 0);
        assert!(!test.service.starts_active());
    }

    #[tokio::test]
    async fn 销毁窗口失败恢复配置和全部终端() {
        let test = prepared_test(2).await;
        let saved = AtomicBool::new(false);
        let result = test
            .service
            .commit(
                &test.token,
                || {
                    saved.store(true, Ordering::Release);
                    Ok(())
                },
                || {
                    assert!(saved.load(Ordering::Acquire));
                    assert!(test.service.starts_active());
                    Err(AppError::Internal("销毁失败".to_owned()))
                },
            )
            .await;
        assert!(result.is_err());
        assert!(!test.service.starts_active());
        assert!(!LightweightModeConfig::load(&test.directory).current.active);
        assert!(!test.service.state().await.suppress_confirmation);
        for (bridge, events) in test.bridges.iter().zip(&test.events) {
            bridge.emit_data(b"tail").await.expect("应恢复原通道");
            assert_eq!(decoded_data(events).concat(), b"tail");
        }
        assert_eq!(test.budget.used.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn 过期事务拒绝提交且中止可重复() {
        let test = prepared_test(1).await;
        test.service
            .runtime
            .lock()
            .await
            .transaction
            .as_mut()
            .expect("应存在事务")
            .deadline = Instant::now();
        assert!(test
            .service
            .commit(&test.token, || Ok(()), || Ok(()))
            .await
            .is_err());
        test.service.abort(&test.token).await;
        test.service.abort(&test.token).await;
        assert_eq!(
            test.service.state().await.phase,
            LightweightModePhase::Normal
        );
        assert_eq!(test.budget.used.load(Ordering::Acquire), 0);
        assert!(test.service.try_gui_activity().is_ok());
    }

    #[tokio::test]
    async fn 新旧事务和连接活动互斥() {
        let directory = temp_directory();
        let service = LightweightModeService::load(&directory);
        let manager = ConnectionManager::new(&directory);
        let activity = service.try_gui_activity().expect("普通模式应允许连接");
        assert!(service.begin(&manager, Vec::new(), false).await.is_err());
        drop(activity);
        let first = service
            .begin(&manager, Vec::new(), false)
            .await
            .expect("应开启事务");
        assert!(service.try_gui_activity().is_err());
        service.abort(&first.token).await;
        let second = service
            .begin(&manager, Vec::new(), false)
            .await
            .expect("应开启新事务");
        service.abort(&first.token).await;
        assert_eq!(service.state().await.phase, LightweightModePhase::Preparing);
        service.abort(&second.token).await;
        assert!(service.try_gui_activity().is_ok());
    }

    #[tokio::test]
    async fn 窗口唤回等待轻量提交且不提前清除保活状态() {
        let test = prepared_test(1).await;
        let mut waiting = Box::pin(test.service.window_activation_guard());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        test.service
            .commit(&test.token, || Ok(()), || Ok(()))
            .await
            .unwrap();
        let _window_access = waiting.await;
        assert!(test.service.starts_active());
        let state = test.service.state().await;
        assert_eq!(state.phase, LightweightModePhase::Detached);
        assert_eq!(state.terminals.len(), 1);
    }

    #[tokio::test]
    async fn 窗口唤回等待回滚后保留原通道输出顺序() {
        let test = prepared_test(1).await;
        test.bridges[0].emit_data(b"buffered").await.unwrap();
        let mut waiting = Box::pin(test.service.window_activation_guard());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        test.service.abort(&test.token).await;
        let _window_access = waiting.await;
        test.bridges[0].emit_data(b"-live").await.unwrap();
        assert_eq!(decoded_data(&test.events[0]).concat(), b"buffered-live");
        assert_eq!(
            test.service.state().await.phase,
            LightweightModePhase::Normal
        );
    }

    #[tokio::test]
    async fn 提交失败释放唤回许可且恢复普通模式() {
        let test = prepared_test(1).await;
        let mut waiting = Box::pin(test.service.window_activation_guard());
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        assert!(test
            .service
            .commit(
                &test.token,
                || Err(AppError::Persistence("模拟保存失败".to_owned())),
                || panic!("保存失败后不能销毁窗口"),
            )
            .await
            .is_err());
        let _window_access = waiting.await;
        assert!(!test.service.starts_active());
        assert_eq!(
            test.service.state().await.phase,
            LightweightModePhase::Normal
        );
    }

    #[tokio::test]
    async fn 窗口激活许可持有期间不能开始新的快照事务() {
        let test = prepared_test(0).await;
        test.service.abort(&test.token).await;
        let manager = ConnectionManager::new(&test.directory);
        let window_access = test.service.window_activation_guard().await;
        assert!(test
            .service
            .begin(&manager, Vec::new(), false)
            .await
            .is_err());
        drop(window_access);
        let transaction = test
            .service
            .begin(&manager, Vec::new(), false)
            .await
            .unwrap();
        test.service.abort(&transaction.token).await;
    }

    #[test]
    fn 快照预算覆盖所有终端且拒绝超大分块数量() {
        let budget = Arc::new(CacheBudget::default());
        let mut first = SnapshotBuffer::new(MAX_SNAPSHOT_BYTES, budget.clone());
        assert!(first.append(0, u32::MAX, b"x").is_err());
        first.append(0, 1, b"a").expect("首个快照应成功");
        let remaining = CacheReservation::new(budget.clone(), MAX_GLOBAL_CACHE_BYTES - 1)
            .expect("应占满剩余额度");
        let mut second = SnapshotBuffer::new(MAX_SNAPSHOT_BYTES, budget.clone());
        assert!(second.append(0, 1, b"b").is_err());
        assert!(!second.complete());
        drop(remaining);
        drop(first);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
        second.append(0, 1, b"b").expect("释放额度后可重试同一分块");
    }

    #[tokio::test]
    async fn 编码长度在解码前受限且错误连接归属被拒绝() {
        let test = prepared_test(1).await;
        assert!(test
            .service
            .append_snapshot_chunk(
                &test.token,
                "missing",
                LightweightSnapshotKind::Full,
                0,
                1,
                &"a".repeat(MAX_SNAPSHOT_CHUNK_BYTES.div_ceil(3) * 4 + 1),
            )
            .await
            .is_err());
        assert!(test
            .service
            .append_snapshot_chunk(
                &test.token,
                "missing",
                LightweightSnapshotKind::Full,
                0,
                1,
                "eA==",
            )
            .await
            .is_err());
        test.service.abort(&test.token).await;
        assert_eq!(test.budget.used.load(Ordering::Acquire), 0);
    }

    #[test]
    fn 旁路解析器不累积未结束的目录或剪贴板正文() {
        let mut parser = TerminalScreenParser::new(24, 80);
        parser.process(b"a\x1b]52;c;");
        parser.process(&vec![b'x'; MAX_SNAPSHOT_CHUNK_BYTES]);
        parser.process(&vec![b'x'; MAX_SNAPSHOT_CHUNK_BYTES]);
        parser.process(b"\x07b");
        assert_eq!(parser.parser.screen().contents(), "ab");
        assert!(parser.formatted_state().len() < 1024);
    }

    #[tokio::test]
    async fn 缓存折叠恢复备用屏和输入模式并保留断线墓碑() {
        let (channel, _) = capture_channel::<TerminalEvent>();
        let bridge = LightweightTerminalBridge::new("connection".to_owned(), channel);
        let budget = Arc::new(CacheBudget::default());
        let viewport = b"\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1003hseed";
        bridge
            .pause("token", budget.clone(), Arc::new(AtomicBool::new(false)))
            .await
            .expect("应暂停");
        bridge
            .commit(
                "token",
                cached(&budget, viewport),
                cached(&budget, viewport),
                80,
                24,
            )
            .await
            .expect("应准备提交");
        LightweightTerminalBridge::finalize_detach_group(
            std::slice::from_ref(&bridge),
            "token",
            || Ok(()),
        )
        .await
        .expect("应完成提交");
        let remaining = CacheReservation::new(
            budget.clone(),
            MAX_GLOBAL_CACHE_BYTES - budget.used.load(Ordering::Acquire),
        )
        .expect("应占满预算");
        bridge.emit_data(b"-latest").await.expect("超限应折叠画面");
        drop(remaining);
        bridge
            .emit_end(TerminalBridgeEnd::Disconnected {
                exit_code: Some(0),
                message: "结束".to_owned(),
            })
            .await
            .expect("应记录断线");
        let (resume, events) = capture_channel::<TerminalResumeEvent>();
        assert!(bridge.attach(resume).await.expect("应恢复截断终端"));
        let events = events.lock().expect("事件锁应有效");
        let mut restored = vt100::Parser::new(24, 80, 0);
        for event in events.iter().filter(|event| event["kind"] == "snapshot") {
            restored.process(
                &BASE64_STANDARD
                    .decode(event["data"].as_str().expect("快照应有数据"))
                    .expect("快照应为 Base64"),
            );
        }
        assert!(restored.screen().alternate_screen());
        assert!(restored.screen().application_cursor());
        assert!(restored.screen().bracketed_paste());
        assert!(restored.screen().contents().contains("seed-latest"));
        assert_eq!(events[events.len() - 2]["kind"], "disconnected");
        assert_eq!(events[events.len() - 1]["kind"], "ready");
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
    }
}
