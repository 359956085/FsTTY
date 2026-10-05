mod discovery;
#[cfg(windows)]
mod host;
#[cfg(windows)]
mod pipe;
mod protocol;
#[cfg(windows)]
mod windows;

use super::lightweight_mode_service::{LightweightTerminalBridge, TerminalBridgeEnd};
use crate::models::{
    AppError, LocalSession, LocalShellAvailability, LocalTerminalInfo, SshConnection, TerminalEvent,
};
use protocol::{Request, Response, Startup};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub fn run_host(arguments: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        host::run(arguments)
    }
    #[cfg(not(windows))]
    {
        let _ = arguments;
        Err("本地终端仅支持 Windows".into())
    }
}

struct Pending {
    session_id: String,
    runtime_id: String,
    cancel: CancellationToken,
}
#[derive(Clone)]
struct Entry {
    connection: SshConnection,
    request_id: String,
    runtime_id: String,
    cancel: CancellationToken,
    input: mpsc::Sender<Request>,
    bridge: LightweightTerminalBridge,
}
#[derive(Default)]
struct Registry {
    pending: HashMap<String, Pending>,
    entries: HashMap<String, Entry>,
    cancelled: VecDeque<String>,
}
#[derive(Clone, Default)]
pub struct LocalTerminalService {
    registry: Arc<Mutex<Registry>>,
}

struct PendingLease {
    registry: Arc<Mutex<Registry>>,
    request_id: String,
    cancel: CancellationToken,
    committed: bool,
}
impl Drop for PendingLease {
    fn drop(&mut self) {
        self.registry
            .lock()
            .unwrap()
            .pending
            .remove(&self.request_id);
        if !self.committed {
            self.cancel.cancel();
        }
    }
}

impl LocalTerminalService {
    pub fn detect(&self) -> Vec<LocalShellAvailability> {
        discovery::detect()
    }
    pub fn contains(&self, id: &str) -> bool {
        self.registry.lock().unwrap().entries.contains_key(id)
    }
    pub fn has_starting(&self) -> bool {
        !self.registry.lock().unwrap().pending.is_empty()
    }
    pub fn connection_ids(&self) -> HashSet<String> {
        self.registry
            .lock()
            .unwrap()
            .entries
            .keys()
            .cloned()
            .collect()
    }
    pub(super) fn bridge(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<LightweightTerminalBridge, AppError> {
        self.registry
            .lock()
            .unwrap()
            .entries
            .get(id)
            .filter(|entry| entry.connection.session_id == session_id)
            .map(|entry| entry.bridge.clone())
            .ok_or_else(|| AppError::NotFound("本地终端已停止".into()))
    }
    pub fn cancel_start(&self, request_id: &str) {
        let mut registry = self.registry.lock().unwrap();
        // Remember a cancel that raced IPC dispatch, without retaining an
        // unbounded set or cancelling the next attempt in the same tab.
        if !registry.cancelled.iter().any(|id| id == request_id) {
            registry.cancelled.push_back(request_id.into());
            if registry.cancelled.len() > 1024 {
                registry.cancelled.pop_front();
            }
        }
        if let Some(pending) = registry.pending.get(request_id) {
            pending.cancel.cancel();
        }
        for entry in registry
            .entries
            .values()
            .filter(|entry| entry.request_id == request_id)
        {
            entry.cancel.cancel();
        }
    }
    pub fn stop(&self, id: &str) {
        if let Some(entry) = self.registry.lock().unwrap().entries.get(id) {
            entry.cancel.cancel();
        }
    }
    pub fn stop_session(&self, id: &str) {
        let registry = self.registry.lock().unwrap();
        for entry in registry
            .entries
            .values()
            .filter(|entry| entry.connection.session_id == id)
        {
            entry.cancel.cancel();
        }
        for pending in registry
            .pending
            .values()
            .filter(|entry| entry.session_id == id)
        {
            pending.cancel.cancel();
        }
    }
    pub fn shutdown(&self) {
        let registry = self.registry.lock().unwrap();
        for entry in registry.entries.values() {
            entry.cancel.cancel();
        }
        for pending in registry.pending.values() {
            pending.cancel.cancel();
        }
    }
    pub async fn write(&self, id: &str, data: String) -> Result<(), AppError> {
        if data.len() > protocol::MAX_INPUT {
            return Err(AppError::Validation("本地终端输入过大".into()));
        }
        self.send(
            id,
            Request::Input {
                data: data.into_bytes(),
            },
        )
        .await
    }
    pub async fn resize(&self, id: &str, columns: u32, rows: u32) -> Result<(), AppError> {
        if !protocol::dimensions(columns, rows) {
            return Err(AppError::Validation("终端尺寸无效".into()));
        }
        self.send(id, Request::Resize { columns, rows }).await
    }
    async fn send(&self, id: &str, message: Request) -> Result<(), AppError> {
        let entry = self
            .registry
            .lock()
            .unwrap()
            .entries
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("本地终端已停止".into()))?;
        tokio::select! {
            _ = entry.cancel.cancelled() => Err(AppError::Connection("本地终端已停止".into())),
            result = entry.input.send(message) => result.map_err(|_| AppError::Connection("本地终端已停止".into())),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        session: LocalSession,
        runtime_id: String,
        request_id: String,
        columns: u32,
        rows: u32,
        elevated: Option<bool>,
        channel: Channel<TerminalEvent>,
    ) -> Result<SshConnection, AppError> {
        if uuid::Uuid::parse_str(&runtime_id).is_err()
            || uuid::Uuid::parse_str(&request_id).is_err()
            || !protocol::dimensions(columns, rows)
        {
            return Err(AppError::Validation("本地终端启动参数无效".into()));
        }
        discovery::resolve(session.shell).map_err(AppError::Connection)?;
        let directory = if session.starting_directory.is_empty() {
            std::env::var_os("USERPROFILE")
                .map(std::path::PathBuf::from)
                .ok_or_else(|| AppError::Connection("无法确定当前用户主目录".into()))?
        } else {
            std::path::PathBuf::from(&session.starting_directory)
        };
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(AppError::Validation("起始目录不存在或无法访问".into()));
        }
        let startup = Startup {
            shell: session.shell,
            directory: directory.to_string_lossy().into(),
            columns,
            rows,
            elevated: elevated.unwrap_or(session.run_as_admin),
        };
        let cancel = CancellationToken::new();
        {
            let mut registry = self.registry.lock().unwrap();
            if registry.cancelled.contains(&request_id) {
                return Err(AppError::Connection("本地终端启动已取消".into()));
            }
            if registry.pending.contains_key(&request_id)
                || registry
                    .pending
                    .values()
                    .any(|entry| entry.runtime_id == runtime_id)
                || registry
                    .entries
                    .values()
                    .any(|entry| entry.runtime_id == runtime_id)
            {
                return Err(AppError::Busy("该标签已有本地终端".into()));
            }
            registry.pending.insert(
                request_id.clone(),
                Pending {
                    session_id: session.id.clone(),
                    runtime_id: runtime_id.clone(),
                    cancel: cancel.clone(),
                },
            );
        }
        let mut lease = PendingLease {
            registry: self.registry.clone(),
            request_id: request_id.clone(),
            cancel: cancel.clone(),
            committed: false,
        };
        let result = self
            .start_host(
                session.id,
                runtime_id,
                &request_id,
                startup,
                channel,
                cancel,
            )
            .await;
        lease.committed = result.is_ok();
        result
    }

    #[cfg(windows)]
    async fn start_host(
        &self,
        session_id: String,
        runtime_id: String,
        request_id: &str,
        startup: Startup,
        channel: Channel<TerminalEvent>,
        cancel: CancellationToken,
    ) -> Result<SshConnection, AppError> {
        let mut pipe = windows::listener(request_id).map_err(AppError::Connection)?;
        let nonce = request_id.to_owned();
        let elevated = startup.elevated;
        // ShellExecuteEx may remain in UAC. Dropping the await never abandons a
        // late process: the task result owns a kill-on-drop process guard.
        let launch = tokio::task::spawn_blocking(move || {
            windows::launch(&nonce, elevated).map(windows::ChildProcess)
        });
        let child = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::Connection("本地终端启动已取消".into())),
            result = launch => result.map_err(|_| AppError::Internal("本地终端启动任务失败".into()))?.map_err(AppError::Connection)?,
        };
        let handshake = async {
            pipe.connect().await.map_err(|e| e.to_string())?;
            windows::verify_client(&pipe, &child.0)?;
            match protocol::receive::<Response>(&mut pipe)
                .await
                .map_err(|e| e.to_string())?
            {
                Response::Hello { nonce } if nonce == request_id => {}
                _ => return Err("本地终端启动请求不匹配".into()),
            }
            let directory = startup.directory.clone();
            let shell = startup.shell;
            protocol::send(&mut pipe, &Request::Start(startup))
                .await
                .map_err(|e| e.to_string())?;
            match protocol::receive::<Response>(&mut pipe)
                .await
                .map_err(|e| e.to_string())?
            {
                Response::Ready {
                    elevated: actual,
                    label,
                } if actual == elevated => Ok((directory, shell, label)),
                Response::Error { message } => Err(message),
                _ => Err("本地终端启动响应无效".into()),
            }
        };
        let (directory, shell, label) = tokio::select! {
            _ = cancel.cancelled() => return Err(AppError::Connection("本地终端启动已取消".into())),
            result = tokio::time::timeout(Duration::from_secs(30), handshake) => result.map_err(|_| AppError::Connection("本地终端启动超时".into()))?.map_err(AppError::Connection)?,
        };
        let connection = SshConnection {
            connection_id: uuid::Uuid::new_v4().to_string(),
            session_id,
            home_path: directory,
            sftp_available: false,
            shell_name: None,
            local: Some(LocalTerminalInfo {
                shell,
                label,
                elevated,
            }),
        };
        let bridge = LightweightTerminalBridge::new(connection.connection_id.clone(), channel);
        let (input, mut messages) = mpsc::channel(16);
        {
            let mut registry = self.registry.lock().unwrap();
            if cancel.is_cancelled() {
                return Err(AppError::Connection("本地终端启动已取消".into()));
            }
            registry.entries.insert(
                connection.connection_id.clone(),
                Entry {
                    connection: connection.clone(),
                    request_id: request_id.into(),
                    runtime_id,
                    cancel: cancel.clone(),
                    input,
                    bridge: bridge.clone(),
                },
            );
        }
        let service = self.clone();
        let id = connection.connection_id.clone();
        tokio::spawn(async move {
            let (mut reader, mut writer) = tokio::io::split(pipe);
            let write = async {
                while let Some(message) = messages.recv().await {
                    protocol::send(&mut writer, &message).await?;
                }
                Ok::<(), std::io::Error>(())
            };
            let read = async {
                loop {
                    match protocol::receive::<Response>(&mut reader)
                        .await
                        .map_err(|e| e.to_string())?
                    {
                        Response::Data { data } => {
                            bridge
                                .emit_data(&data)
                                .await
                                .map_err(|_| "终端界面已关闭".to_owned())?;
                        }
                        Response::Exit { code } => return Ok(code),
                        Response::Error { message } => return Err(message),
                        _ => return Err("本地终端返回了无效消息".into()),
                    }
                }
            };
            let end = tokio::select! {
                _ = cancel.cancelled() => TerminalBridgeEnd::Disconnected { exit_code: None, message: "本地终端已停止".into() },
                result = read => match result { Ok(code) => TerminalBridgeEnd::Disconnected { exit_code: code, message: "本地终端已退出".into() }, Err(message) => TerminalBridgeEnd::Error(message) },
                _ = write => TerminalBridgeEnd::Error("本地终端输入通道已关闭".into()),
            };
            // The host owns a job with KILL_ON_JOB_CLOSE, so its entire process
            // tree is reclaimed even when the host or GUI terminates abruptly.
            drop(child);
            service.registry.lock().unwrap().entries.remove(&id);
            let _ = bridge.emit_end(end).await;
        });
        Ok(connection)
    }
    #[cfg(not(windows))]
    async fn start_host(
        &self,
        _: String,
        _: String,
        _: &str,
        _: Startup,
        _: Channel<TerminalEvent>,
        _: CancellationToken,
    ) -> Result<SshConnection, AppError> {
        Err(AppError::Connection("本地终端仅支持 Windows".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_start_releases_reservation_and_cancels_late_host() {
        let service = LocalTerminalService::default();
        let cancelled = CancellationToken::new();
        service.registry.lock().unwrap().pending.insert(
            "attempt".into(),
            Pending {
                session_id: "session".into(),
                runtime_id: "tab".into(),
                cancel: cancelled.clone(),
            },
        );
        let lease = PendingLease {
            registry: service.registry.clone(),
            request_id: "attempt".into(),
            cancel: cancelled.clone(),
            committed: false,
        };
        assert!(service.has_starting());
        drop(lease);
        assert!(!service.has_starting());
        assert!(cancelled.is_cancelled());
    }

    #[test]
    fn successful_start_keeps_its_running_host() {
        let cancelled = CancellationToken::new();
        drop(PendingLease {
            registry: Default::default(),
            request_id: "attempt".into(),
            cancel: cancelled.clone(),
            committed: true,
        });
        assert!(!cancelled.is_cancelled());
    }

    #[test]
    fn cancellation_is_attempt_scoped_and_bounded() {
        let service = LocalTerminalService::default();
        service.cancel_start("attempt-1");
        let registry = service.registry.lock().unwrap();
        assert!(registry.cancelled.contains(&"attempt-1".into()));
        assert!(!registry.cancelled.contains(&"attempt-2".into()));
        drop(registry);
        for index in 0..2048 {
            service.cancel_start(&index.to_string());
        }
        assert_eq!(service.registry.lock().unwrap().cancelled.len(), 1024);
    }
}
