#[cfg(test)]
use super::connection_paths::join_remote_path;
use super::connection_paths::normalize_remote_path;
#[cfg(test)]
use super::connection_paths::{
    checked_join_remote_path, is_same_or_remote_descendant, normalize_mutable_remote_path,
    remote_parent_path, resolve_remote_child, resolve_remote_move_target, validate_remote_name,
};
#[cfg(test)]
use crate::models::PrivateKeySource;
#[cfg(test)]
use crate::models::TransferEvent;
use crate::models::{
    AppError, ConnectResult, CredentialKind, HostKeyChallenge, HostKeyChange, SessionAuth,
    ShellName, SshConnection, StoredSession, TerminalEvent,
};
use crate::services::CredentialService;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use russh::client;
#[cfg(test)]
use russh::keys::load_secret_key;
use russh::keys::{known_hosts::learn_known_hosts_path, ssh_key::PublicKey};
#[cfg(test)]
use russh::MethodKind;
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use tokio::time;
use uuid::Uuid;
use zeroize::Zeroizing;

mod authentication;
mod remote_files;
mod terminal_io;
mod transfer;

use authentication::{
    authenticate, key_algorithm, key_fingerprint, remove_known_host, HostObservation, SshClient,
};
#[cfg(test)]
use authentication::{
    authentication_rejected, is_authentication_interruption, map_authentication_exchange_error,
};
#[cfg(test)]
use remote_files::join_directory_reads;
#[cfg(test)]
use remote_files::{map_sftp_read_error, RemoteReadKind};
#[cfg(test)]
use russh_sftp::{client::error::Error as SftpError, protocol::StatusCode};
use terminal_io::{run_terminal, validate_terminal_size, wait_for_channel_success};
#[cfg(test)]
use transfer::finalize_local_file;
use transfer::ActiveTransfer;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const TERMINAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(10);
const HOST_CHALLENGE_TTL: Duration = Duration::from_secs(60);
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_REMOTE_SEARCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_PENDING_TERMINAL_BYTES: usize = 1024 * 1024;
const MAX_PENDING_TERMINAL_MESSAGES: usize = 256;
const MAX_TERMINAL_OUTPUT_BATCH_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_BATCH_DELAY: Duration = Duration::from_millis(4);
const MAX_EXEC_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_MCP_EXEC_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const TRANSFER_BUFFER_BYTES: usize = 64 * 1024;
const MAX_REMOTE_PATH_BYTES: usize = 4096;
const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;

fn append_limited(target: &mut Vec<u8>, data: &[u8], limit: usize, truncated: &mut bool) {
    let remaining = limit.saturating_sub(target.len());
    let accepted = remaining.min(data.len());
    target.extend_from_slice(&data[..accepted]);
    *truncated |= accepted < data.len();
}
#[derive(Clone)]
pub struct ConnectionManager {
    inner: Arc<ConnectionManagerInner>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<u32>,
    pub truncated: bool,
}

#[derive(Default)]
pub struct OneTimeLogin {
    pub credential: Option<Zeroizing<String>>,
    pub username: Option<String>,
}

struct ConnectionManagerInner {
    known_hosts_path: PathBuf,
    known_hosts_lock: Arc<StdMutex<()>>,
    connections: RwLock<HashMap<String, Arc<ConnectionEntry>>>,
    session_connections: RwLock<HashMap<String, HashSet<String>>>,
    connecting_sessions: Mutex<HashMap<String, Vec<Arc<ConnectCancellation>>>>,
    challenges: Mutex<HashMap<String, PendingHostKey>>,
    transfers: Mutex<HashMap<String, ActiveTransfer>>,
}

struct ConnectionEntry {
    session_id: String,
    username: String,
    handle: Arc<Mutex<client::Handle<SshClient>>>,
    terminal_tx: Option<mpsc::Sender<TerminalControl>>,
    browser_sftp: Option<Arc<SftpSession>>,
}

struct PendingHostKey {
    session_id: String,
    host: String,
    port: u16,
    key: PublicKey,
    expires_at: Instant,
}

struct ConnectCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

struct ConnectionCredentialInput<'a> {
    service: &'a CredentialService,
    one_time: Option<Zeroizing<String>>,
}

impl ConnectCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    async fn cancelled(&self) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        self.notify.notified().await;
    }
}

enum TerminalControl {
    Data(Vec<u8>),
    Resize { columns: u32, rows: u32 },
    Close,
}

#[derive(Default)]
struct PendingTerminalMessages {
    messages: VecDeque<ChannelMsg>,
    data_bytes: usize,
}

impl PendingTerminalMessages {
    fn push(&mut self, message: ChannelMsg) -> Result<(), AppError> {
        if self.messages.len() >= MAX_PENDING_TERMINAL_MESSAGES {
            return Err(AppError::Connection("终端启动消息过多".to_owned()));
        }
        let message_bytes = match &message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => data.len(),
            _ => 0,
        };
        self.data_bytes = self
            .data_bytes
            .checked_add(message_bytes)
            .filter(|bytes| *bytes <= MAX_PENDING_TERMINAL_BYTES)
            .ok_or_else(|| AppError::Connection("终端启动输出过大".to_owned()))?;
        self.messages.push_back(message);
        Ok(())
    }
}

struct TerminalOutputBatch {
    bytes: Vec<u8>,
}

impl TerminalOutputBatch {
    fn new() -> Self {
        // 空闲连接不预占 64 KiB；首次输出后按实际流量增长并复用容量。
        Self { bytes: Vec::new() }
    }

    fn append(&mut self, data: &[u8]) -> usize {
        let writable = (MAX_TERMINAL_OUTPUT_BATCH_BYTES - self.bytes.len()).min(data.len());
        self.bytes.extend_from_slice(&data[..writable]);
        writable
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn is_full(&self) -> bool {
        self.bytes.len() == MAX_TERMINAL_OUTPUT_BATCH_BYTES
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    fn clear(&mut self) {
        self.bytes.clear();
    }
}

enum TerminalEnd {
    Disconnected {
        exit_code: Option<u32>,
        message: String,
    },
    Error(String),
    ClientGone,
}

enum AuthenticationOutcome {
    Authenticated,
    CredentialRequired(CredentialKind),
}

enum TransportError {
    Timeout,
    Handshake(Box<Option<HostObservation>>),
}

impl ConnectionManager {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            inner: Arc::new(ConnectionManagerInner {
                known_hosts_path: app_data_dir.join("known_hosts"),
                known_hosts_lock: Arc::new(StdMutex::new(())),
                connections: RwLock::new(HashMap::new()),
                session_connections: RwLock::new(HashMap::new()),
                connecting_sessions: Mutex::new(HashMap::new()),
                challenges: Mutex::new(HashMap::new()),
                transfers: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn ssh_client(
        &self,
        session: &StoredSession,
    ) -> (SshClient, Arc<StdMutex<Option<HostObservation>>>) {
        let observation = Arc::new(StdMutex::new(None));
        let handler = SshClient {
            host: session.host.clone(),
            port: session.port,
            known_hosts_path: self.inner.known_hosts_path.clone(),
            known_hosts_lock: self.inner.known_hosts_lock.clone(),
            observation: observation.clone(),
        };
        (handler, observation)
    }

    async fn open_transport(
        &self,
        session: &StoredSession,
    ) -> Result<client::Handle<SshClient>, TransportError> {
        let (handler, observation) = self.ssh_client(session);
        let config = client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        };
        let connection = time::timeout(
            CONNECT_TIMEOUT,
            client::connect(
                Arc::new(config),
                (session.host.as_str(), session.port),
                handler,
            ),
        )
        .await
        .map_err(|_| TransportError::Timeout)?;

        connection.map_err(|_| {
            TransportError::Handshake(Box::new(
                observation.lock().ok().and_then(|mut value| value.take()),
            ))
        })
    }

    async fn browser_sftp_and_home_path(
        handle: &mut client::Handle<SshClient>,
    ) -> (Option<Arc<SftpSession>>, String) {
        let browser_sftp = open_sftp_with_handle(handle).await.ok().map(Arc::new);
        let home_path = match &browser_sftp {
            Some(sftp) => time::timeout(SFTP_TIMEOUT, sftp.canonicalize("."))
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|path| normalize_remote_path(&path).ok())
                .unwrap_or_else(|| "/".to_owned()),
            None => "/".to_owned(),
        };
        (browser_sftp, home_path)
    }

    async fn authenticate_handle(
        &self,
        handle: &mut client::Handle<SshClient>,
        session: &StoredSession,
        credentials: &CredentialService,
        one_time: Option<Zeroizing<String>>,
    ) -> Result<AuthenticationOutcome, AppError> {
        authenticate(handle, session, credentials, one_time).await
    }

    async fn register_connection(&self, connection_id: String, entry: Arc<ConnectionEntry>) {
        let session_id = entry.session_id.clone();
        self.inner
            .connections
            .write()
            .await
            .insert(connection_id.clone(), entry);
        self.inner
            .session_connections
            .write()
            .await
            .entry(session_id)
            .or_default()
            .insert(connection_id);
    }

    async fn map_transport_error(
        &self,
        session: &StoredSession,
        error: TransportError,
    ) -> Result<ConnectResult, AppError> {
        match error {
            TransportError::Timeout => Err(AppError::Connection("连接服务器超时".to_owned())),
            TransportError::Handshake(observed) => match *observed {
                Some(HostObservation::Unknown(key)) => Ok(ConnectResult::HostKeyRequired {
                    challenge: self.register_challenge(session, key).await,
                }),
                Some(HostObservation::Changed { old_key, new_key }) => {
                    Ok(ConnectResult::HostKeyChanged {
                        change: HostKeyChange {
                            host: session.host.clone(),
                            port: session.port,
                            algorithm: key_algorithm(&new_key),
                            old_fingerprint: key_fingerprint(&old_key),
                            new_fingerprint: key_fingerprint(&new_key),
                        },
                    })
                }
                Some(HostObservation::Failure) => {
                    Err(AppError::Persistence("无法校验主机密钥存储".to_owned()))
                }
                None => Err(AppError::Connection("无法建立 SSH 连接".to_owned())),
            },
        }
    }

    fn map_headless_transport_error(error: TransportError) -> AppError {
        match error {
            TransportError::Timeout => AppError::Connection("连接服务器超时".to_owned()),
            TransportError::Handshake(observed) => match *observed {
                Some(HostObservation::Unknown(_)) => {
                    AppError::Connection("主机密钥尚未信任，请先在 FsTTY 中确认".to_owned())
                }
                Some(HostObservation::Changed { .. }) => {
                    AppError::Connection("主机密钥已变化，请先在 FsTTY 中确认".to_owned())
                }
                _ => AppError::Connection("无法建立 SSH 连接".to_owned()),
            },
        }
    }

    pub async fn connect(
        &self,
        mut session: StoredSession,
        columns: u32,
        rows: u32,
        events: Channel<TerminalEvent>,
        credentials: &CredentialService,
        one_time_login: Option<OneTimeLogin>,
    ) -> Result<ConnectResult, AppError> {
        validate_terminal_size(columns, rows)?;
        let one_time_login = one_time_login.unwrap_or_default();
        apply_one_time_username(&mut session, one_time_login.username)?;
        if session.username.trim().is_empty() {
            return Err(AppError::Validation("当前会话缺少用户名".to_owned()));
        }
        let cancellation = {
            let mut connecting = self.inner.connecting_sessions.lock().await;
            let cancellation = Arc::new(ConnectCancellation::new());
            connecting
                .entry(session.id.clone())
                .or_default()
                .push(cancellation.clone());
            cancellation
        };

        let result = tokio::select! {
            result = self.connect_inner(
                session.clone(),
                columns,
                rows,
                events,
                ConnectionCredentialInput {
                    service: credentials,
                    one_time: one_time_login.credential,
                },
                &cancellation,
            ) => result,
            () = cancellation.cancelled() => Err(AppError::Connection("连接已取消".to_owned())),
        };
        let mut connecting = self.inner.connecting_sessions.lock().await;
        if let Some(attempts) = connecting.get_mut(&session.id) {
            attempts.retain(|current| !Arc::ptr_eq(current, &cancellation));
            if attempts.is_empty() {
                connecting.remove(&session.id);
            }
        }
        result
    }

    async fn connect_inner(
        &self,
        session: StoredSession,
        columns: u32,
        rows: u32,
        events: Channel<TerminalEvent>,
        credential_input: ConnectionCredentialInput<'_>,
        cancellation: &Arc<ConnectCancellation>,
    ) -> Result<ConnectResult, AppError> {
        let mut handle = match self.open_transport(&session).await {
            Ok(handle) => handle,
            Err(error) => return self.map_transport_error(&session, error).await,
        };

        match self
            .authenticate_handle(
                &mut handle,
                &session,
                credential_input.service,
                credential_input.one_time,
            )
            .await?
        {
            AuthenticationOutcome::Authenticated => {}
            AuthenticationOutcome::CredentialRequired(credential_kind) => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "", "zh-CN")
                    .await;
                return Ok(ConnectResult::CredentialRequired { credential_kind });
            }
        }

        let mut terminal = time::timeout(SFTP_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| AppError::Connection("创建终端通道超时".to_owned()))?
            .map_err(|_| AppError::Connection("无法创建终端通道".to_owned()))?;
        // 终端行规程由服务端按其登录环境初始化，避免客户端模式覆盖造成无回显或不执行回车。
        terminal
            .request_pty(true, "xterm-256color", columns, rows, 0, 0, &[])
            .await
            .map_err(|_| AppError::Connection("服务器拒绝创建终端".to_owned()))?;
        let mut pending_terminal_messages = PendingTerminalMessages::default();
        wait_for_channel_success(&mut terminal, "创建终端", &mut pending_terminal_messages).await?;

        terminal
            .request_shell(true)
            .await
            .map_err(|_| AppError::Connection("服务器拒绝启动 Shell".to_owned()))?;
        wait_for_channel_success(&mut terminal, "启动 Shell", &mut pending_terminal_messages)
            .await?;

        // PTY 与 Shell 请求连续完成，避免 SFTP 初始化插入终端启动握手。
        let (browser_sftp, home_path) = Self::browser_sftp_and_home_path(&mut handle).await;

        let connection_id = Uuid::new_v4().to_string();
        let (terminal_tx, terminal_rx) = mpsc::channel(128);
        let handle = Arc::new(Mutex::new(handle));
        let entry = Arc::new(ConnectionEntry {
            session_id: session.id.clone(),
            username: session.username.clone(),
            handle,
            terminal_tx: Some(terminal_tx),
            browser_sftp: browser_sftp.clone(),
        });
        // 与删除/关键字段更新共用连接门闩，避免取消后旧连接晚到并重新写回。
        let connecting = self.inner.connecting_sessions.lock().await;
        if cancellation.cancelled.load(Ordering::Acquire)
            || !connecting.get(&session.id).is_some_and(|attempts| {
                attempts
                    .iter()
                    .any(|current| Arc::ptr_eq(current, cancellation))
            })
        {
            return Err(AppError::Connection("连接已取消".to_owned()));
        }
        self.register_connection(connection_id.clone(), entry).await;
        drop(connecting);

        let (terminal_reader, terminal_writer) = terminal.split();
        let manager = self.clone();
        let worker_connection_id = connection_id.clone();
        tokio::spawn(async move {
            run_terminal(
                worker_connection_id.clone(),
                terminal_reader,
                terminal_writer,
                terminal_rx,
                events,
                pending_terminal_messages.messages,
            )
            .await;
            manager.finish_connection(&worker_connection_id).await;
        });

        let shell_name = self.detect_login_shell(&connection_id).await;

        Ok(ConnectResult::Connected {
            connection: SshConnection {
                connection_id,
                session_id: session.id,
                home_path,
                sftp_available: browser_sftp.is_some(),
                shell_name,
            },
        })
    }

    /// 为自动化创建无 PTY 连接。未知或变化的主机密钥必须回到界面确认。
    pub async fn connect_headless(
        &self,
        session: StoredSession,
        credentials: &CredentialService,
    ) -> Result<SshConnection, AppError> {
        if session.username.trim().is_empty() {
            return Err(AppError::Validation("当前会话缺少用户名".to_owned()));
        }
        let mut handle = self
            .open_transport(&session)
            .await
            .map_err(Self::map_headless_transport_error)?;
        match self
            .authenticate_handle(&mut handle, &session, credentials, None)
            .await?
        {
            AuthenticationOutcome::Authenticated => {}
            AuthenticationOutcome::CredentialRequired(_) => {
                return Err(AppError::Authentication(
                    "缺少已保存凭据，MCP 不允许交互输入".to_owned(),
                ));
            }
        }
        let (browser_sftp, home_path) = Self::browser_sftp_and_home_path(&mut handle).await;
        let connection_id = Uuid::new_v4().to_string();
        let entry = Arc::new(ConnectionEntry {
            session_id: session.id.clone(),
            username: session.username.clone(),
            handle: Arc::new(Mutex::new(handle)),
            terminal_tx: None,
            browser_sftp: browser_sftp.clone(),
        });
        self.register_connection(connection_id.clone(), entry).await;
        Ok(SshConnection {
            connection_id,
            session_id: session.id,
            home_path,
            sftp_available: browser_sftp.is_some(),
            shell_name: None,
        })
    }

    async fn register_challenge(
        &self,
        session: &StoredSession,
        key: PublicKey,
    ) -> HostKeyChallenge {
        let challenge_id = Uuid::new_v4().to_string();
        let challenge = HostKeyChallenge {
            challenge_id: challenge_id.clone(),
            host: session.host.clone(),
            port: session.port,
            algorithm: key_algorithm(&key),
            fingerprint: key_fingerprint(&key),
            expires_in_seconds: HOST_CHALLENGE_TTL.as_secs(),
        };
        let mut challenges = self.inner.challenges.lock().await;
        challenges.retain(|_, value| value.expires_at > Instant::now());
        challenges.insert(
            challenge_id,
            PendingHostKey {
                session_id: session.id.clone(),
                host: session.host.clone(),
                port: session.port,
                key,
                expires_at: Instant::now() + HOST_CHALLENGE_TTL,
            },
        );
        challenge
    }

    pub async fn trust_host_key(
        &self,
        session: &StoredSession,
        challenge_id: &str,
    ) -> Result<(), AppError> {
        let pending = self
            .inner
            .challenges
            .lock()
            .await
            .remove(challenge_id)
            .ok_or_else(|| AppError::Validation("主机密钥确认已失效".to_owned()))?;
        if pending.expires_at <= Instant::now()
            || pending.session_id != session.id
            || pending.host != session.host
            || pending.port != session.port
        {
            return Err(AppError::Validation("主机密钥确认已失效".to_owned()));
        }
        let path = self.inner.known_hosts_path.clone();
        let known_hosts_lock = self.inner.known_hosts_lock.clone();
        let host = pending.host;
        let port = pending.port;
        let key = pending.key;
        tokio::task::spawn_blocking(move || {
            let _guard = known_hosts_lock.lock().map_err(|_| ())?;
            learn_known_hosts_path(&host, port, &key, path).map_err(|_| ())
        })
        .await
        .map_err(|_| AppError::Persistence("保存主机密钥任务失败".to_owned()))?
        .map_err(|_| AppError::Persistence("无法保存主机密钥".to_owned()))
    }

    pub async fn forget_host_key(&self, session: &StoredSession) -> Result<bool, AppError> {
        let path = self.inner.known_hosts_path.clone();
        let known_hosts_lock = self.inner.known_hosts_lock.clone();
        let host = session.host.clone();
        let port = session.port;
        let removed = tokio::task::spawn_blocking(move || {
            let _guard = known_hosts_lock
                .lock()
                .map_err(|_| AppError::Persistence("主机密钥存储锁已失效".to_owned()))?;
            remove_known_host(&path, &host, port)
        })
        .await
        .map_err(|_| AppError::Persistence("删除主机密钥任务失败".to_owned()))??;
        self.inner
            .challenges
            .lock()
            .await
            .retain(|_, value| value.host != session.host || value.port != session.port);
        Ok(removed)
    }

    pub async fn session_id(&self, connection_id: &str) -> Result<String, AppError> {
        Ok(self.entry(connection_id).await?.session_id.clone())
    }

    async fn entry(&self, connection_id: &str) -> Result<Arc<ConnectionEntry>, AppError> {
        validate_uuid("连接 ID", connection_id)?;
        self.inner
            .connections
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("SSH 连接不存在或已断开".to_owned()))
    }

    async fn take_connection(&self, connection_id: &str) -> Option<Arc<ConnectionEntry>> {
        let entry = self.inner.connections.write().await.remove(connection_id);
        if let Some(entry) = &entry {
            let mut sessions = self.inner.session_connections.write().await;
            if let Some(connection_ids) = sessions.get_mut(&entry.session_id) {
                connection_ids.remove(connection_id);
                if connection_ids.is_empty() {
                    sessions.remove(&entry.session_id);
                }
            }
        }
        entry
    }

    async fn finish_connection(&self, connection_id: &str) {
        if let Some(entry) = self.take_connection(connection_id).await {
            self.cancel_connection_transfers(connection_id).await;
            let handle = entry.handle.lock().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "zh-CN")
                .await;
        }
    }
}

async fn open_sftp_with_handle(
    handle: &mut client::Handle<SshClient>,
) -> Result<SftpSession, AppError> {
    let channel = time::timeout(SFTP_TIMEOUT, handle.channel_open_session())
        .await
        .map_err(|_| AppError::Sftp("创建 SFTP 通道超时".to_owned()))?
        .map_err(|_| AppError::Sftp("无法创建 SFTP 通道".to_owned()))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|_| AppError::Sftp("服务器拒绝 SFTP 子系统".to_owned()))?;
    time::timeout(SFTP_TIMEOUT, SftpSession::new(channel.into_stream()))
        .await
        .map_err(|_| AppError::Sftp("初始化 SFTP 超时".to_owned()))?
        .map_err(|_| AppError::Sftp("初始化 SFTP 失败".to_owned()))
}

async fn open_sftp(entry: &ConnectionEntry) -> Result<SftpSession, AppError> {
    let mut handle = entry.handle.lock().await;
    open_sftp_with_handle(&mut handle).await
}

fn apply_one_time_username(
    session: &mut StoredSession,
    one_time_username: Option<String>,
) -> Result<(), AppError> {
    let Some(username) = one_time_username else {
        return Ok(());
    };
    if !matches!(session.auth, SessionAuth::Password) {
        return Err(AppError::Validation("临时账号只适用于密码认证".to_owned()));
    }
    if !session.username.trim().is_empty() {
        return Err(AppError::Validation(
            "会话已有账号，不能使用临时账号覆盖".to_owned(),
        ));
    }
    let username = username.trim();
    if username.is_empty() || username.len() > 128 || username.chars().any(char::is_control) {
        return Err(AppError::Validation("用户名无效".to_owned()));
    }
    session.username = username.to_owned();
    Ok(())
}

fn validate_uuid(label: &str, value: &str) -> Result<(), AppError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| AppError::Validation(format!("{label}无效")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::DeviceService;
    use russh_sftp::protocol::Status;
    use std::sync::atomic::AtomicBool;
    use zeroize::Zeroizing;

    fn sftp_status_error(status_code: StatusCode) -> SftpError {
        SftpError::Status(Status {
            id: 1,
            status_code,
            error_message: status_code.to_string(),
            language_tag: "zh-CN".to_owned(),
        })
    }

    #[test]
    fn permission_denied_reports_remote_account_for_directory_and_file() {
        let directory = map_sftp_read_error(
            sftp_status_error(StatusCode::PermissionDenied),
            RemoteReadKind::Directory,
            "ubuntu",
            "无法读取远程目录",
        );
        assert_eq!(
            directory.to_string(),
            "无法读取目录：当前账号“ubuntu”权限不足"
        );

        let file = map_sftp_read_error(
            sftp_status_error(StatusCode::PermissionDenied),
            RemoteReadKind::File,
            "root",
            "无法打开远程文件",
        );
        assert_eq!(file.to_string(), "无法读取文件：当前账号“root”权限不足");
    }

    #[test]
    fn non_permission_sftp_errors_keep_original_message() {
        let missing = map_sftp_read_error(
            sftp_status_error(StatusCode::NoSuchFile),
            RemoteReadKind::File,
            "ubuntu",
            "无法打开远程文件",
        );
        assert_eq!(missing.to_string(), "无法打开远程文件");

        let disconnected = map_sftp_read_error(
            SftpError::IO("connection lost".to_owned()),
            RemoteReadKind::Directory,
            "ubuntu",
            "无法读取远程目录",
        );
        assert_eq!(disconnected.to_string(), "无法读取远程目录");
    }

    #[tokio::test]
    async fn directory_metadata_and_listing_start_concurrently() {
        let metadata_started = Arc::new(AtomicBool::new(false));
        let directory_started = Arc::new(AtomicBool::new(false));
        let metadata_peer = directory_started.clone();
        let directory_peer = metadata_started.clone();

        let reads = join_directory_reads(
            async {
                metadata_started.store(true, Ordering::Release);
                while !metadata_peer.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
                "metadata"
            },
            async {
                directory_started.store(true, Ordering::Release);
                while !directory_peer.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
                "directory"
            },
        );

        assert_eq!(
            time::timeout(Duration::from_secs(1), reads)
                .await
                .expect("目录读取任务应并发完成"),
            ("metadata", "directory")
        );
    }

    #[test]
    fn parses_supported_login_shells() {
        assert_eq!(
            terminal_io::parse_shell_name(b"/bin/bash\n"),
            Some(ShellName::Bash)
        );
        assert_eq!(
            terminal_io::parse_shell_name(br"C:\tools\ZSH"),
            Some(ShellName::Zsh)
        );
    }

    #[test]
    fn rejects_unsupported_or_invalid_login_shells() {
        assert_eq!(terminal_io::parse_shell_name(b"/usr/bin/fish"), None);
        assert_eq!(terminal_io::parse_shell_name(b""), None);
        assert_eq!(terminal_io::parse_shell_name(&[0xff]), None);
    }

    fn temporary_username_session(auth: SessionAuth) -> StoredSession {
        StoredSession {
            id: Uuid::new_v4().to_string(),
            name: "临时账号测试".to_owned(),
            host: "127.0.0.1".to_owned(),
            port: 22,
            username: String::new(),
            group: "测试".to_owned(),
            tags: vec![],
            auth,
            login_save_prompted: false,
        }
    }

    #[test]
    fn accepts_temporary_username_only_for_blank_password_session() {
        let mut password_session = temporary_username_session(SessionAuth::Password);
        apply_one_time_username(&mut password_session, Some(" root ".to_owned()))
            .expect("密码会话应接受临时账号");
        assert_eq!(password_session.username, "root");

        let mut existing = temporary_username_session(SessionAuth::Password);
        existing.username = "ubuntu".to_owned();
        assert!(apply_one_time_username(&mut existing, Some("root".to_owned())).is_err());

        let mut private_key = temporary_username_session(SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            path: None,
            passphrase_required: false,
        });
        assert!(apply_one_time_username(&mut private_key, Some("root".to_owned())).is_err());
        assert!(apply_one_time_username(
            &mut temporary_username_session(SessionAuth::Password),
            Some(" \n".to_owned()),
        )
        .is_err());
    }

    #[test]
    fn classifies_only_closed_authentication_connections_as_interruptions() {
        for error in [
            russh::Error::HUP,
            russh::Error::Disconnect,
            russh::Error::SendError,
            russh::Error::RecvError,
        ] {
            assert!(is_authentication_interruption(&error));
        }
        for kind in [
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::ConnectionAborted,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::UnexpectedEof,
            std::io::ErrorKind::NotConnected,
        ] {
            assert!(is_authentication_interruption(&russh::Error::IO(
                std::io::Error::from(kind)
            )));
        }
        assert!(!is_authentication_interruption(
            &russh::Error::ConnectionTimeout
        ));
        assert!(!is_authentication_interruption(&russh::Error::IO(
            std::io::Error::from(std::io::ErrorKind::PermissionDenied)
        )));
    }

    #[test]
    fn distinguishes_authentication_rejection_from_exchange_failure() {
        assert!(matches!(
            authentication_rejected(MethodKind::Password),
            AppError::AuthenticationRejected(_)
        ));
        assert!(matches!(
            map_authentication_exchange_error(russh::Error::HUP, "认证失败"),
            AppError::AuthenticationInterrupted(_)
        ));
        assert!(matches!(
            map_authentication_exchange_error(russh::Error::PacketAuth, "认证失败"),
            AppError::Authentication(_)
        ));
    }

    #[test]
    fn normalizes_remote_paths_without_escaping_root() {
        assert_eq!(
            normalize_remote_path("/var/www/../log").unwrap(),
            "/var/log"
        );
        assert_eq!(normalize_remote_path("/../../").unwrap(), "/");
        assert!(normalize_remote_path("relative/path").is_err());
    }

    #[test]
    fn validates_remote_file_names() {
        assert!(validate_remote_name("report.txt").is_ok());
        assert!(validate_remote_name("../report.txt").is_err());
        assert!(validate_remote_name("bad/name").is_err());
        assert_eq!(
            normalize_remote_path("/folder/with space ").unwrap(),
            "/folder/with space "
        );
        assert!(checked_join_remote_path(&format!("/{}", "a".repeat(4091)), "file").is_err());
    }

    #[test]
    fn resolves_remote_mutation_targets_safely() {
        assert_eq!(
            resolve_remote_child("/var/www", "assets").unwrap(),
            "/var/www/assets"
        );
        assert!(resolve_remote_child("/var/www", "../assets").is_err());
        assert!(resolve_remote_child("/var/www", "bad/name").is_err());
        assert!(normalize_mutable_remote_path("/", "禁止删除").is_err());
        assert!(normalize_mutable_remote_path("/folder/..", "禁止删除").is_err());
        assert_eq!(remote_parent_path("/file.txt"), "/");
        assert_eq!(remote_parent_path("/var/file.txt"), "/var");
    }

    #[test]
    fn resolves_remote_move_targets_safely() {
        assert_eq!(
            resolve_remote_move_target("/var/www/report.txt", "/archive").unwrap(),
            (
                "/var/www/report.txt".to_owned(),
                "/archive".to_owned(),
                "/archive/report.txt".to_owned(),
            )
        );
        assert_eq!(
            resolve_remote_move_target("/var/www/report.txt", "/var/www").unwrap(),
            (
                "/var/www/report.txt".to_owned(),
                "/var/www".to_owned(),
                "/var/www/report.txt".to_owned(),
            )
        );
        assert!(resolve_remote_move_target("/", "/archive").is_err());
        assert!(resolve_remote_move_target("/folder/..", "/archive").is_err());
        assert!(resolve_remote_move_target("/report.txt", "archive").is_err());
        assert!(resolve_remote_move_target(
            "/report.txt",
            &format!("/{}", "a".repeat(MAX_REMOTE_PATH_BYTES))
        )
        .is_err());
        assert!(is_same_or_remote_descendant("/folder", "/folder"));
        assert!(is_same_or_remote_descendant(
            "/folder/nested/archive",
            "/folder"
        ));
        assert!(!is_same_or_remote_descendant("/folder-two", "/folder"));
        assert!(!is_same_or_remote_descendant("/", "/folder"));
    }

    #[test]
    fn preserves_terminal_messages_received_before_request_reply() {
        let mut pending = PendingTerminalMessages::default();
        pending
            .push(ChannelMsg::Data {
                data: vec![1_u8, 2, 3].into(),
            })
            .expect("无法暂存终端数据");
        pending
            .push(ChannelMsg::ExitStatus { exit_status: 7 })
            .expect("无法暂存退出状态");

        assert_eq!(pending.data_bytes, 3);
        assert!(matches!(
            pending.messages.pop_front(),
            Some(ChannelMsg::Data { data }) if data.as_ref() == [1, 2, 3]
        ));
        assert!(matches!(
            pending.messages.pop_front(),
            Some(ChannelMsg::ExitStatus { exit_status: 7 })
        ));
    }

    #[test]
    fn rejects_excessive_terminal_output_before_request_reply() {
        let mut pending = PendingTerminalMessages::default();
        let result = pending.push(ChannelMsg::Data {
            data: vec![0_u8; MAX_PENDING_TERMINAL_BYTES + 1].into(),
        });

        assert!(result.is_err());
        assert!(pending.messages.is_empty());
    }

    #[test]
    fn rejects_excessive_terminal_messages_before_request_reply() {
        let mut pending = PendingTerminalMessages::default();
        for _ in 0..MAX_PENDING_TERMINAL_MESSAGES {
            pending
                .push(ChannelMsg::WindowAdjusted { new_size: 1024 })
                .expect("无法暂存终端窗口消息");
        }

        assert!(pending
            .push(ChannelMsg::WindowAdjusted { new_size: 1024 })
            .is_err());
    }

    #[test]
    fn batches_consecutive_terminal_output_in_order() {
        let mut batch = TerminalOutputBatch::new();

        assert_eq!(batch.append(b"first"), 5);
        assert_eq!(batch.append(b"-second"), 7);
        assert_eq!(batch.as_slice(), b"first-second");
        assert!(!batch.is_full());
    }

    #[test]
    fn splits_dense_terminal_output_at_batch_limit() {
        let input = vec![7_u8; 1024 * 1024];
        let mut remaining = input.as_slice();
        let mut batch = TerminalOutputBatch::new();
        let mut output = Vec::with_capacity(input.len());
        let mut emitted_batches = 0;

        while !remaining.is_empty() {
            let appended = batch.append(remaining);
            remaining = &remaining[appended..];
            if batch.is_full() {
                output.extend_from_slice(batch.as_slice());
                batch.clear();
                emitted_batches += 1;
            }
        }

        assert!(batch.is_empty());
        assert_eq!(emitted_batches, 16);
        assert_eq!(output, input);
    }

    #[tokio::test]
    async fn restores_local_target_when_commit_fails() {
        let directory = std::env::temp_dir().join(format!("fstty-restore-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("无法创建测试目录");
        let target = directory.join("target.bin");
        let temp = directory.join("missing.part");
        let backup = directory.join("backup.bin");
        tokio::fs::write(&target, b"original")
            .await
            .expect("无法创建原文件");

        assert!(finalize_local_file(&temp, &target, &backup, true)
            .await
            .is_err());
        assert_eq!(
            tokio::fs::read(&target).await.expect("原文件未恢复"),
            b"original"
        );
        assert!(!backup.exists());
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn disconnect_session_cancels_all_inflight_connects() {
        let manager = ConnectionManager::new(&std::env::temp_dir());
        let session_id = Uuid::new_v4().to_string();
        let first = Arc::new(ConnectCancellation::new());
        let second = Arc::new(ConnectCancellation::new());
        manager
            .inner
            .connecting_sessions
            .lock()
            .await
            .insert(session_id.clone(), vec![first.clone(), second.clone()]);

        manager.disconnect_session(&session_id).await;
        for cancellation in [first, second] {
            assert!(cancellation.cancelled.load(Ordering::Acquire));
            time::timeout(Duration::from_millis(50), cancellation.cancelled())
                .await
                .expect("连接取消通知未生效");
        }
    }

    #[tokio::test]
    #[ignore = "需要显式配置本地 OpenSSH 测试服务器"]
    async fn real_ssh_sftp_smoke() {
        let host = std::env::var("FSTTY_TEST_SSH_HOST").expect("缺少测试 SSH 主机");
        let port = std::env::var("FSTTY_TEST_SSH_PORT")
            .expect("缺少测试 SSH 端口")
            .parse::<u16>()
            .expect("测试 SSH 端口无效");
        let username = std::env::var("FSTTY_TEST_SSH_USER").expect("缺少测试 SSH 用户");
        let password =
            Zeroizing::new(std::env::var("FSTTY_TEST_SSH_PASSWORD").expect("缺少测试密码"));
        let test_id = Uuid::new_v4().to_string();
        let test_dir = std::env::temp_dir().join(format!("fstty-ssh-{test_id}"));
        std::fs::create_dir_all(&test_dir).expect("无法创建测试目录");
        let manager = ConnectionManager::new(&test_dir);
        let credentials = CredentialService::new();
        let session = StoredSession {
            id: Uuid::new_v4().to_string(),
            name: "真实 SSH 测试".to_owned(),
            host,
            port,
            username,
            group: "测试".to_owned(),
            tags: vec![],
            auth: SessionAuth::Password,
            login_save_prompted: false,
        };
        credentials
            .set(&session.id, password.clone())
            .await
            .expect("无法保存测试凭据");

        let first = manager
            .connect(
                session.clone(),
                100,
                30,
                Channel::<TerminalEvent>::new(|_| Ok(())),
                &credentials,
                None,
            )
            .await
            .expect("首次 SSH 握手失败");
        let challenge_id = match first {
            ConnectResult::HostKeyRequired { challenge } => challenge.challenge_id,
            _ => panic!("首次连接未要求确认主机密钥"),
        };
        manager
            .trust_host_key(&session, &challenge_id)
            .await
            .expect("保存测试主机密钥失败");
        let terminal_output = Arc::new(StdMutex::new(Vec::new()));
        let terminal_output_sink = terminal_output.clone();
        let terminal_events = Channel::<TerminalEvent>::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let value = serde_json::from_str::<serde_json::Value>(&json).ok();
                let data = value
                    .as_ref()
                    .filter(|value| value["kind"] == "data")
                    .and_then(|value| value["data"].as_str())
                    .and_then(|value| BASE64_STANDARD.decode(value).ok());
                if let (Some(data), Ok(mut output)) = (data, terminal_output_sink.lock()) {
                    output.extend_from_slice(&data);
                }
            }
            Ok(())
        });
        let connected = manager
            .connect(
                session.clone(),
                100,
                30,
                terminal_events,
                &credentials,
                None,
            )
            .await
            .expect("SSH 密码连接失败");
        let connection = match connected {
            ConnectResult::Connected { connection } => connection,
            _ => panic!("确认主机密钥后仍未连接"),
        };
        assert!(connection.sftp_available, "测试服务器未启用 SFTP");
        manager
            .resize_terminal(&connection.connection_id, 120, 40)
            .await
            .expect("终端缩放失败");
        manager
            .write_terminal(
                &connection.connection_id,
                "printf 'FSTTY_TERMINAL_OK\\n'\r".to_owned(),
            )
            .await
            .expect("终端输入失败");
        time::timeout(Duration::from_secs(3), async {
            loop {
                let received = terminal_output
                    .lock()
                    .map(|output| String::from_utf8_lossy(&output).contains("FSTTY_TERMINAL_OK"))
                    .unwrap_or(false);
                if received {
                    break;
                }
                time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("未收到真实终端输出");
        manager
            .list_files(&connection.connection_id, &connection.home_path)
            .await
            .expect("SFTP 目录浏览失败");

        let file_name = format!("fstty-smoke-{test_id}.bin");
        let upload_source = test_dir.join(&file_name);
        let download_target = test_dir.join(format!("download-{file_name}"));
        let content = b"FsTTY SSH/SFTP smoke test\0\xff";
        tokio::fs::write(&upload_source, content)
            .await
            .expect("无法写入测试源文件");
        manager
            .upload_file(
                &connection.connection_id,
                &Uuid::new_v4().to_string(),
                upload_source.to_str().expect("测试路径无效"),
                &connection.home_path,
                false,
                Channel::<TransferEvent>::new(|_| Ok(())),
            )
            .await
            .expect("SFTP 上传失败");
        let remote_path = join_remote_path(&connection.home_path, &file_name);
        manager
            .download_file(
                &connection.connection_id,
                &Uuid::new_v4().to_string(),
                &remote_path,
                download_target.to_str().expect("测试路径无效"),
                false,
                Channel::<TransferEvent>::new(|_| Ok(())),
            )
            .await
            .expect("SFTP 下载失败");
        assert_eq!(
            tokio::fs::read(&download_target)
                .await
                .expect("无法读取下载文件"),
            content
        );

        let replacement = b"FsTTY overwrite smoke test";
        tokio::fs::write(&upload_source, replacement)
            .await
            .expect("无法更新测试源文件");
        manager
            .upload_file(
                &connection.connection_id,
                &Uuid::new_v4().to_string(),
                upload_source.to_str().expect("测试路径无效"),
                &connection.home_path,
                true,
                Channel::<TransferEvent>::new(|_| Ok(())),
            )
            .await
            .expect("SFTP 覆盖上传失败");
        tokio::fs::write(&download_target, b"stale")
            .await
            .expect("无法创建旧下载文件");
        manager
            .download_file(
                &connection.connection_id,
                &Uuid::new_v4().to_string(),
                &remote_path,
                download_target.to_str().expect("测试路径无效"),
                true,
                Channel::<TransferEvent>::new(|_| Ok(())),
            )
            .await
            .expect("SFTP 覆盖下载失败");
        assert_eq!(
            tokio::fs::read(&download_target)
                .await
                .expect("无法读取覆盖下载文件"),
            replacement
        );

        let cancelled_transfer_id = Uuid::new_v4().to_string();
        let cancelled_source = test_dir.join(format!("cancel-{cancelled_transfer_id}.bin"));
        tokio::fs::write(&cancelled_source, vec![1_u8; TRANSFER_BUFFER_BYTES * 2])
            .await
            .expect("无法创建取消测试文件");
        manager
            .upload_file_inner(
                &connection.connection_id,
                &cancelled_transfer_id,
                cancelled_source.to_str().expect("测试路径无效"),
                &connection.home_path,
                false,
                Channel::<TransferEvent>::new(|_| Ok(())),
                Arc::new(AtomicBool::new(true)),
            )
            .await
            .expect("取消上传失败");
        let files = manager
            .list_files(&connection.connection_id, &connection.home_path)
            .await
            .expect("取消后目录浏览失败");
        assert!(files.iter().all(|file| {
            file.name != format!(".fstty-{cancelled_transfer_id}.part")
                && file.name != format!("cancel-{cancelled_transfer_id}.bin")
        }));

        let operations_directory_name = format!("fstty-ops-{test_id}");
        manager
            .create_remote_directory(
                &connection.connection_id,
                &connection.home_path,
                &operations_directory_name,
            )
            .await
            .expect("创建远程测试目录失败");
        let operations_directory =
            join_remote_path(&connection.home_path, &operations_directory_name);
        manager
            .create_remote_directory(&connection.connection_id, &operations_directory, "nested")
            .await
            .expect("创建远程嵌套目录失败");
        let nested_directory = join_remote_path(&operations_directory, "nested");
        manager
            .upload_file(
                &connection.connection_id,
                &Uuid::new_v4().to_string(),
                upload_source.to_str().expect("测试路径无效"),
                &nested_directory,
                false,
                Channel::<TransferEvent>::new(|_| Ok(())),
            )
            .await
            .expect("上传递归删除测试文件失败");
        assert!(manager
            .move_remote_entry(&connection.connection_id, &remote_path, &nested_directory)
            .await
            .is_err());
        assert!(manager
            .move_remote_entry(
                &connection.connection_id,
                &operations_directory,
                &nested_directory,
            )
            .await
            .is_err());
        let nested_file = join_remote_path(&nested_directory, &file_name);
        manager
            .move_remote_entry(
                &connection.connection_id,
                &nested_file,
                &operations_directory,
            )
            .await
            .expect("移动远程测试文件失败");
        manager
            .create_remote_directory(
                &connection.connection_id,
                &operations_directory,
                "move-target",
            )
            .await
            .expect("创建远程移动目标目录失败");
        let move_target = join_remote_path(&operations_directory, "move-target");
        manager
            .move_remote_entry(&connection.connection_id, &nested_directory, &move_target)
            .await
            .expect("移动远程测试目录失败");
        assert!(manager
            .list_files(&connection.connection_id, &move_target)
            .await
            .expect("读取远程移动目标失败")
            .iter()
            .any(|file| file.name == "nested"));
        let renamed_directory_name = format!("fstty-ops-renamed-{test_id}");
        manager
            .rename_remote_entry(
                &connection.connection_id,
                &operations_directory,
                &renamed_directory_name,
            )
            .await
            .expect("重命名远程测试目录失败");
        let renamed_directory = join_remote_path(&connection.home_path, &renamed_directory_name);
        manager
            .delete_remote_entry(&connection.connection_id, &renamed_directory)
            .await
            .expect("递归删除远程测试目录失败");
        assert!(manager
            .delete_remote_entry(&connection.connection_id, "/")
            .await
            .is_err());
        assert!(manager
            .list_files(&connection.connection_id, &connection.home_path)
            .await
            .expect("文件操作后目录浏览失败")
            .iter()
            .all(|file| file.name != renamed_directory_name));
        manager
            .delete_remote_entry(&connection.connection_id, &remote_path)
            .await
            .expect("清理远程上传测试文件失败");

        assert!(
            DeviceService
                .status(&manager, &connection.connection_id)
                .await
                .expect("设备状态命令失败")
                .available,
            "未解析到设备状态"
        );
        assert!(manager
            .upload_file(
                &connection.connection_id,
                &Uuid::new_v4().to_string(),
                upload_source.to_str().expect("测试路径无效"),
                "/root",
                false,
                Channel::<TransferEvent>::new(|_| Ok(())),
            )
            .await
            .is_err());

        let concurrent_session = StoredSession {
            id: Uuid::new_v4().to_string(),
            name: "并发 SSH 测试".to_owned(),
            host: session.host.clone(),
            port: session.port,
            username: session.username.clone(),
            group: "测试".to_owned(),
            tags: vec![],
            auth: SessionAuth::Password,
            login_save_prompted: false,
        };
        credentials
            .set(&concurrent_session.id, Zeroizing::new(password.to_string()))
            .await
            .expect("无法保存并发测试凭据");
        let concurrent = manager
            .connect(
                concurrent_session.clone(),
                80,
                24,
                Channel::<TerminalEvent>::new(|_| Ok(())),
                &credentials,
                None,
            )
            .await
            .expect("并发 SSH 连接失败");
        let concurrent_connection = match concurrent {
            ConnectResult::Connected { connection } => connection,
            _ => panic!("第二个会话未并发连接"),
        };
        manager
            .disconnect(&concurrent_connection.connection_id)
            .await
            .expect("断开并发 SSH 失败");
        credentials
            .delete(&concurrent_session.id)
            .await
            .expect("清理并发测试凭据失败");

        let bad_password_session = StoredSession {
            id: Uuid::new_v4().to_string(),
            name: "错误密码测试".to_owned(),
            host: session.host.clone(),
            port: session.port,
            username: session.username.clone(),
            group: "测试".to_owned(),
            tags: vec![],
            auth: SessionAuth::Password,
            login_save_prompted: false,
        };
        credentials
            .set(
                &bad_password_session.id,
                Zeroizing::new(Uuid::new_v4().to_string()),
            )
            .await
            .expect("无法保存错误密码测试凭据");
        assert!(matches!(
            manager
                .connect(
                    bad_password_session.clone(),
                    80,
                    24,
                    Channel::<TerminalEvent>::new(|_| Ok(())),
                    &credentials,
                    None,
                )
                .await,
            Err(AppError::Authentication(_))
        ));
        credentials
            .delete(&bad_password_session.id)
            .await
            .expect("清理错误密码测试凭据失败");
        manager
            .disconnect(&connection.connection_id)
            .await
            .expect("断开 SSH 失败");
        credentials
            .delete(&session.id)
            .await
            .expect("清理测试凭据失败");

        if let Ok(private_key_path) = std::env::var("FSTTY_TEST_SSH_PRIVATE_KEY") {
            let key_session = StoredSession {
                id: Uuid::new_v4().to_string(),
                name: "无口令私钥测试".to_owned(),
                host: session.host.clone(),
                port: session.port,
                username: session.username.clone(),
                group: "测试".to_owned(),
                tags: vec![],
                auth: SessionAuth::PrivateKey {
                    source: PrivateKeySource::File,
                    path: Some(private_key_path),
                    passphrase_required: false,
                },
                login_save_prompted: false,
            };
            let connected = manager
                .connect(
                    key_session,
                    100,
                    30,
                    Channel::<TerminalEvent>::new(|_| Ok(())),
                    &credentials,
                    None,
                )
                .await
                .expect("SSH 无口令私钥连接失败");
            let connection = match connected {
                ConnectResult::Connected { connection } => connection,
                _ => panic!("已信任主机使用无口令私钥时未连接"),
            };
            manager
                .disconnect(&connection.connection_id)
                .await
                .expect("断开无口令私钥连接失败");
        }

        if let (Ok(private_key_path), Ok(passphrase)) = (
            std::env::var("FSTTY_TEST_SSH_ENCRYPTED_PRIVATE_KEY"),
            std::env::var("FSTTY_TEST_SSH_PRIVATE_KEY_PASSPHRASE"),
        ) {
            let bad_key_path = private_key_path.clone();
            let key_session = StoredSession {
                id: Uuid::new_v4().to_string(),
                name: "加密私钥测试".to_owned(),
                host: session.host.clone(),
                port: session.port,
                username: session.username.clone(),
                group: "测试".to_owned(),
                tags: vec![],
                auth: SessionAuth::PrivateKey {
                    source: PrivateKeySource::File,
                    path: Some(private_key_path),
                    passphrase_required: true,
                },
                login_save_prompted: false,
            };
            credentials
                .set(&key_session.id, Zeroizing::new(passphrase))
                .await
                .expect("无法保存测试私钥口令");
            let connected = manager
                .connect(
                    key_session.clone(),
                    100,
                    30,
                    Channel::<TerminalEvent>::new(|_| Ok(())),
                    &credentials,
                    None,
                )
                .await
                .expect("SSH 加密私钥连接失败");
            let connection = match connected {
                ConnectResult::Connected { connection } => connection,
                _ => panic!("已信任主机使用加密私钥时未连接"),
            };
            manager
                .disconnect(&connection.connection_id)
                .await
                .expect("断开加密私钥连接失败");
            credentials
                .delete(&key_session.id)
                .await
                .expect("清理测试私钥口令失败");

            let bad_key_session = StoredSession {
                id: Uuid::new_v4().to_string(),
                name: "错误私钥口令测试".to_owned(),
                host: session.host.clone(),
                port: session.port,
                username: session.username.clone(),
                group: "测试".to_owned(),
                tags: vec![],
                auth: SessionAuth::PrivateKey {
                    source: PrivateKeySource::File,
                    path: Some(bad_key_path),
                    passphrase_required: true,
                },
                login_save_prompted: false,
            };
            credentials
                .set(
                    &bad_key_session.id,
                    Zeroizing::new(Uuid::new_v4().to_string()),
                )
                .await
                .expect("无法保存错误私钥口令");
            assert!(matches!(
                manager
                    .connect(
                        bad_key_session.clone(),
                        100,
                        30,
                        Channel::<TerminalEvent>::new(|_| Ok(())),
                        &credentials,
                        None,
                    )
                    .await,
                Err(AppError::Credential(_))
            ));
            credentials
                .delete(&bad_key_session.id)
                .await
                .expect("清理错误私钥口令失败");
        }

        assert!(manager
            .forget_host_key(&session)
            .await
            .expect("忘记主机密钥失败"));
        let required_again = manager
            .connect(
                session.clone(),
                100,
                30,
                Channel::<TerminalEvent>::new(|_| Ok(())),
                &credentials,
                None,
            )
            .await
            .expect("忘记密钥后的握手失败");
        let challenge_id = match required_again {
            ConnectResult::HostKeyRequired { challenge } => challenge.challenge_id,
            _ => panic!("忘记主机密钥后未重新要求确认"),
        };
        manager
            .trust_host_key(&session, &challenge_id)
            .await
            .expect("重新保存主机密钥失败");

        if let Ok(private_key_path) = std::env::var("FSTTY_TEST_SSH_PRIVATE_KEY") {
            manager
                .forget_host_key(&session)
                .await
                .expect("准备密钥变化测试失败");
            let fake_host_key =
                load_secret_key(private_key_path, None).expect("无法加载测试替代密钥");
            learn_known_hosts_path(
                &session.host,
                session.port,
                fake_host_key.public_key(),
                manager.inner.known_hosts_path.clone(),
            )
            .expect("无法写入测试替代主机密钥");
            let changed = manager
                .connect(
                    session.clone(),
                    100,
                    30,
                    Channel::<TerminalEvent>::new(|_| Ok(())),
                    &credentials,
                    None,
                )
                .await
                .expect("主机密钥变化握手失败");
            match changed {
                ConnectResult::HostKeyChanged { change } => {
                    assert_ne!(change.old_fingerprint, change.new_fingerprint);
                }
                _ => panic!("主机密钥变化未被阻止"),
            }
            manager
                .forget_host_key(&session)
                .await
                .expect("清理测试替代主机密钥失败");
        }

        let _ = std::fs::remove_dir_all(test_dir);
    }
}
