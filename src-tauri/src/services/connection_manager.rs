#[cfg(test)]
use super::connection_paths::join_remote_path;
use super::connection_paths::{
    checked_join_remote_path, is_same_or_remote_descendant, normalize_mutable_remote_path,
    normalize_remote_path, remote_parent_path, resolve_remote_child, resolve_remote_move_target,
    validate_remote_name,
};
#[cfg(test)]
use crate::models::PrivateKeySource;
use crate::models::{
    AppError, ConnectResult, CredentialKind, FileEntry, HostKeyChallenge, HostKeyChange,
    SessionAuth, ShellName, SshConnection, StoredSession, TerminalEvent, TransferEvent,
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
use russh_sftp::client::{error::Error as SftpError, SftpSession};
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::fs::{File as LocalFile, OpenOptions as TokioOpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
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
pub(crate) use remote_files::RemoteFileWindow;
use remote_files::{file_entry_from_remote, file_kind_rank};
use terminal_io::{run_terminal, validate_terminal_size, wait_for_channel_success};
use transfer::{
    finalize_local_file, finalize_remote_file, send_progress, validate_download_target,
    validate_upload_source, ActiveTransfer,
};

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

#[derive(Clone, Copy)]
enum RemoteReadKind {
    Directory,
    File,
}

fn map_sftp_read_error(
    error: SftpError,
    kind: RemoteReadKind,
    username: &str,
    fallback: &str,
) -> AppError {
    if matches!(
        error,
        SftpError::Status(ref status) if status.status_code == StatusCode::PermissionDenied
    ) {
        let target = match kind {
            RemoteReadKind::Directory => "目录",
            RemoteReadKind::File => "文件",
        };
        return AppError::Sftp(format!("无法读取{target}：当前账号“{username}”权限不足"));
    }
    AppError::Sftp(fallback.to_owned())
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
        let observation = Arc::new(StdMutex::new(None));
        let handler = SshClient {
            host: session.host.clone(),
            port: session.port,
            known_hosts_path: self.inner.known_hosts_path.clone(),
            known_hosts_lock: self.inner.known_hosts_lock.clone(),
            observation: observation.clone(),
        };
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
        .await;

        let mut handle = match connection {
            Err(_) => return Err(AppError::Connection("连接服务器超时".to_owned())),
            Ok(Ok(handle)) => handle,
            Ok(Err(_)) => {
                let observed = observation.lock().ok().and_then(|mut value| value.take());
                return match observed {
                    Some(HostObservation::Unknown(key)) => Ok(ConnectResult::HostKeyRequired {
                        challenge: self.register_challenge(&session, key).await,
                    }),
                    Some(HostObservation::Changed { old_key, new_key }) => {
                        Ok(ConnectResult::HostKeyChanged {
                            change: HostKeyChange {
                                host: session.host,
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
                };
            }
        };

        match authenticate(
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
        let browser_sftp = open_sftp_with_handle(&mut handle).await.ok().map(Arc::new);
        let home_path = match &browser_sftp {
            Some(sftp) => time::timeout(SFTP_TIMEOUT, sftp.canonicalize("."))
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|path| normalize_remote_path(&path).ok())
                .unwrap_or_else(|| "/".to_owned()),
            None => "/".to_owned(),
        };

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
        self.inner
            .connections
            .write()
            .await
            .insert(connection_id.clone(), entry);
        self.inner
            .session_connections
            .write()
            .await
            .entry(session.id.clone())
            .or_default()
            .insert(connection_id.clone());
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
        let observation = Arc::new(StdMutex::new(None));
        let handler = SshClient {
            host: session.host.clone(),
            port: session.port,
            known_hosts_path: self.inner.known_hosts_path.clone(),
            known_hosts_lock: self.inner.known_hosts_lock.clone(),
            observation: observation.clone(),
        };
        let config = client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        };
        let mut handle = time::timeout(
            CONNECT_TIMEOUT,
            client::connect(
                Arc::new(config),
                (session.host.as_str(), session.port),
                handler,
            ),
        )
        .await
        .map_err(|_| AppError::Connection("连接服务器超时".to_owned()))?
        .map_err(|_| {
            let observed = observation.lock().ok().and_then(|mut value| value.take());
            match observed {
                Some(HostObservation::Unknown(_)) => {
                    AppError::Connection("主机密钥尚未信任，请先在 FsTTY 中确认".to_owned())
                }
                Some(HostObservation::Changed { .. }) => {
                    AppError::Connection("主机密钥已变化，请先在 FsTTY 中确认".to_owned())
                }
                _ => AppError::Connection("无法建立 SSH 连接".to_owned()),
            }
        })?;
        match authenticate(&mut handle, &session, credentials, None).await? {
            AuthenticationOutcome::Authenticated => {}
            AuthenticationOutcome::CredentialRequired(_) => {
                return Err(AppError::Authentication(
                    "缺少已保存凭据，MCP 不允许交互输入".to_owned(),
                ));
            }
        }
        let browser_sftp = open_sftp_with_handle(&mut handle).await.ok().map(Arc::new);
        let home_path = match &browser_sftp {
            Some(sftp) => time::timeout(SFTP_TIMEOUT, sftp.canonicalize("."))
                .await
                .ok()
                .and_then(Result::ok)
                .and_then(|path| normalize_remote_path(&path).ok())
                .unwrap_or_else(|| "/".to_owned()),
            None => "/".to_owned(),
        };
        let connection_id = Uuid::new_v4().to_string();
        let entry = Arc::new(ConnectionEntry {
            session_id: session.id.clone(),
            username: session.username.clone(),
            handle: Arc::new(Mutex::new(handle)),
            terminal_tx: None,
            browser_sftp: browser_sftp.clone(),
        });
        self.inner
            .connections
            .write()
            .await
            .insert(connection_id.clone(), entry);
        self.inner
            .session_connections
            .write()
            .await
            .entry(session.id.clone())
            .or_default()
            .insert(connection_id.clone());
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

    pub async fn list_files(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, AppError> {
        let path = normalize_remote_path(path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = entry
            .browser_sftp
            .clone()
            .ok_or_else(|| AppError::Sftp("服务器不支持 SFTP".to_owned()))?;
        let metadata = sftp.symlink_metadata(path.clone()).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::Directory,
                &entry.username,
                "无法读取远程目录信息",
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::Validation("不允许进入符号链接目录".to_owned()));
        }
        if !metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程路径不是目录".to_owned()));
        }
        let directory = sftp.read_dir(path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::Directory,
                &entry.username,
                "无法读取远程目录",
            )
        })?;
        let mut files = directory
            .filter_map(file_entry_from_remote)
            .collect::<Vec<_>>();
        files.sort_by(|left, right| {
            file_kind_rank(left.kind)
                .cmp(&file_kind_rank(right.kind))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(files)
    }

    pub async fn create_remote_directory(
        &self,
        connection_id: &str,
        parent_path: &str,
        name: &str,
    ) -> Result<(), AppError> {
        let target = resolve_remote_child(parent_path, name)?;
        let sftp = self.mutable_browser_sftp(connection_id).await?;
        if sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程目录是否存在".to_owned()))?
        {
            return Err(AppError::Conflict("远程目标已存在".to_owned()));
        }
        sftp.create_dir(target)
            .await
            .map_err(|_| AppError::Sftp("无法创建远程目录".to_owned()))
    }

    pub async fn rename_remote_entry(
        &self,
        connection_id: &str,
        path: &str,
        new_name: &str,
    ) -> Result<(), AppError> {
        let source = normalize_mutable_remote_path(path, "禁止重命名远程根目录")?;
        let parent = remote_parent_path(&source);
        let target = resolve_remote_child(&parent, new_name)?;
        if source == target {
            return Ok(());
        }

        let sftp = self.mutable_browser_sftp(connection_id).await?;
        if sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程重命名目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程目标已存在".to_owned()));
        }
        sftp.rename(source, target)
            .await
            .map_err(|_| AppError::Sftp("无法重命名远程文件".to_owned()))
    }

    pub async fn move_remote_entry(
        &self,
        connection_id: &str,
        source_path: &str,
        target_directory: &str,
    ) -> Result<(), AppError> {
        let (source, target_directory, target) =
            resolve_remote_move_target(source_path, target_directory)?;
        if source == target {
            return Ok(());
        }

        let sftp = self.mutable_browser_sftp(connection_id).await?;
        let source_metadata = sftp
            .symlink_metadata(source.clone())
            .await
            .map_err(|_| AppError::Sftp("无法读取远程移动源".to_owned()))?;
        let target_metadata = sftp
            .symlink_metadata(target_directory.clone())
            .await
            .map_err(|_| AppError::Sftp("无法读取远程目标目录".to_owned()))?;
        if source_metadata.file_type().is_symlink()
            || (!source_metadata.file_type().is_file() && !source_metadata.file_type().is_dir())
        {
            return Err(AppError::Validation("只能移动普通文件或文件夹".to_owned()));
        }
        if target_metadata.file_type().is_symlink() || !target_metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程移动目标不是普通目录".to_owned()));
        }
        if source_metadata.file_type().is_dir()
            && is_same_or_remote_descendant(&target_directory, &source)
        {
            return Err(AppError::Validation(
                "不能将远程文件夹移动到自身或其子目录".to_owned(),
            ));
        }
        if sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程移动目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程目标已存在".to_owned()));
        }

        sftp.rename(source, target)
            .await
            .map_err(|_| AppError::Sftp("无法移动远程条目".to_owned()))
    }

    pub async fn delete_remote_entry(
        &self,
        connection_id: &str,
        path: &str,
    ) -> Result<(), AppError> {
        let root = normalize_mutable_remote_path(path, "禁止删除远程根目录")?;
        let sftp = self.mutable_browser_sftp(connection_id).await?;
        let mut pending = vec![(root, false)];

        // 后序遍历确保先删除子项，再删除目录；符号链接始终按文件处理。
        while let Some((path, directory_visited)) = pending.pop() {
            if directory_visited {
                sftp.remove_dir(path).await.map_err(|_| {
                    AppError::Sftp("递归删除远程目录失败，部分内容可能已删除".to_owned())
                })?;
                continue;
            }

            let metadata = sftp.symlink_metadata(path.clone()).await.map_err(|_| {
                AppError::Sftp("无法读取远程删除目标，部分内容可能已删除".to_owned())
            })?;
            if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                let directory = sftp.read_dir(path.clone()).await.map_err(|_| {
                    AppError::Sftp("无法读取待删除目录，部分内容可能已删除".to_owned())
                })?;
                pending.push((path.clone(), true));
                for entry in directory {
                    let name = entry.file_name();
                    validate_remote_name(&name).map_err(|_| {
                        AppError::Sftp("待删除目录包含无效文件名，部分内容可能已删除".to_owned())
                    })?;
                    let child = checked_join_remote_path(&path, &name).map_err(|_| {
                        AppError::Sftp("待删除目录路径无效，部分内容可能已删除".to_owned())
                    })?;
                    pending.push((child, false));
                }
            } else {
                sftp.remove_file(path).await.map_err(|_| {
                    AppError::Sftp("删除远程文件失败，部分内容可能已删除".to_owned())
                })?;
            }
        }
        Ok(())
    }

    pub async fn read_remote_file(
        &self,
        connection_id: &str,
        path: &str,
        offset: u64,
        limit: usize,
    ) -> Result<Vec<u8>, AppError> {
        let path = normalize_remote_path(path)?;
        if limit == 0 || limit > 1024 * 1024 {
            return Err(AppError::Validation("远程文件读取大小无效".to_owned()));
        }
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let mut file = sftp.open(path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| AppError::Sftp("无法定位远程文件".to_owned()))?;
        let mut content = vec![0_u8; limit];
        let read = file
            .read(&mut content)
            .await
            .map_err(|_| AppError::Sftp("无法读取远程文件".to_owned()))?;
        content.truncate(read);
        Ok(content)
    }

    pub(crate) async fn read_remote_file_window(
        &self,
        connection_id: &str,
        path: &str,
        offset: u64,
        tail: bool,
        limit: usize,
    ) -> Result<RemoteFileWindow, AppError> {
        let path = normalize_remote_path(path)?;
        if limit == 0 || limit > MAX_REMOTE_SEARCH_BYTES {
            return Err(AppError::Validation(
                "远程文件扫描大小必须在 1 字节到 16 MiB 之间".to_owned(),
            ));
        }
        if tail && offset != 0 {
            return Err(AppError::Validation(
                "尾部扫描不能同时指定起始偏移".to_owned(),
            ));
        }
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = sftp.metadata(path.clone()).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法读取远程文件信息",
            )
        })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("远程目标不是普通文件".to_owned()));
        }
        let file_size = metadata.len();
        let start = if tail {
            file_size.saturating_sub(limit as u64)
        } else {
            offset.min(file_size)
        };
        let prefix_length = usize::from(start > 0);
        let available = file_size.saturating_sub(start) as usize;
        let content_length = available.min(limit);
        let seek_offset = start.saturating_sub(prefix_length as u64);
        let read_length = content_length.saturating_add(prefix_length);

        let mut file = sftp.open(path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        file.seek(SeekFrom::Start(seek_offset))
            .await
            .map_err(|_| AppError::Sftp("无法定位远程文件".to_owned()))?;
        let mut content = Vec::with_capacity(read_length);
        file.take(read_length as u64)
            .read_to_end(&mut content)
            .await
            .map_err(|_| AppError::Sftp("无法扫描远程文件".to_owned()))?;

        let starts_at_line_boundary = if prefix_length == 0 {
            true
        } else {
            let boundary = content.first().copied() == Some(b'\n');
            if !content.is_empty() {
                content.remove(0);
            }
            boundary
        };
        let end_of_file = start.saturating_add(content.len() as u64) >= file_size;
        Ok(RemoteFileWindow {
            content,
            offset: start,
            file_size,
            starts_at_line_boundary,
            end_of_file,
        })
    }

    pub async fn write_remote_file_atomic(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> Result<(), AppError> {
        let path = normalize_remote_path(path)?;
        let parent = remote_parent_path(&path);
        let temp =
            checked_join_remote_path(&parent, &format!(".fstty-mcp-{}.part", Uuid::new_v4()))?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        if sftp
            .try_exists(path.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }
        let mut file = sftp
            .create(temp.clone())
            .await
            .map_err(|_| AppError::Sftp("无法创建远程临时文件".to_owned()))?;
        if file.write_all(content).await.is_err() || file.shutdown().await.is_err() {
            let _ = sftp.remove_file(temp).await;
            return Err(AppError::Sftp("写入远程文件失败".to_owned()));
        }
        if sftp.rename(temp.clone(), path).await.is_err() {
            let _ = sftp.remove_file(temp).await;
            return Err(AppError::Sftp("提交远程文件失败".to_owned()));
        }
        Ok(())
    }

    pub async fn upload_file_quiet(
        &self,
        connection_id: &str,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64, AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        if sftp.try_exists(remote_path.clone()).await.unwrap_or(false) {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }
        let mut source = LocalFile::open(local_path)
            .await
            .map_err(|_| AppError::Validation("无法打开本地文件".to_owned()))?;
        let mut target = sftp
            .create(remote_path)
            .await
            .map_err(|_| AppError::Sftp("无法创建远程文件".to_owned()))?;
        tokio::io::copy(&mut source, &mut target)
            .await
            .map_err(|_| AppError::Sftp("上传文件失败".to_owned()))
    }

    pub async fn download_file_quiet(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &Path,
    ) -> Result<u64, AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        if local_path.exists() {
            return Err(AppError::Conflict("本地文件已存在".to_owned()));
        }
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let mut source = sftp.open(remote_path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        let mut target = LocalFile::create(local_path)
            .await
            .map_err(|_| AppError::Validation("无法创建本地文件".to_owned()))?;
        tokio::io::copy(&mut source, &mut target)
            .await
            .map_err(|_| AppError::Sftp("下载文件失败".to_owned()))
    }

    pub(crate) async fn remote_file_info(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> Result<(String, u64), AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = time::timeout(SFTP_TIMEOUT, sftp.symlink_metadata(remote_path.clone()))
            .await
            .map_err(|_| AppError::Sftp("读取远程文件信息超时".to_owned()))?
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::File,
                    &entry.username,
                    "无法读取远程文件信息",
                )
            })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("只能下载普通文件".to_owned()));
        }
        Ok((remote_path, metadata.len()))
    }

    pub(crate) async fn remote_directory_path(
        &self,
        connection_id: &str,
        remote_directory: &str,
    ) -> Result<String, AppError> {
        let remote_directory = normalize_remote_path(remote_directory)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = time::timeout(SFTP_TIMEOUT, sftp.metadata(remote_directory.clone()))
            .await
            .map_err(|_| AppError::Sftp("读取远程目录信息超时".to_owned()))?
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::Directory,
                    &entry.username,
                    "无法读取远程目录信息",
                )
            })?;
        if !metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程目标不是目录".to_owned()));
        }
        Ok(remote_directory)
    }

    pub(crate) async fn stream_remote_file<W>(
        &self,
        connection_id: &str,
        remote_path: &str,
        byte_range: (u64, u64),
        destination: &mut W,
        cancellation: &tokio_util::sync::CancellationToken,
        idle_timeout: Duration,
    ) -> Result<u64, AppError>
    where
        W: AsyncWrite + Unpin,
    {
        let (offset, length) = byte_range;
        let remote_path = normalize_remote_path(remote_path)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let mut source = time::timeout(SFTP_TIMEOUT, sftp.open(remote_path))
            .await
            .map_err(|_| AppError::Sftp("打开远程文件超时".to_owned()))?
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::File,
                    &entry.username,
                    "无法打开远程文件",
                )
            })?;
        if offset > 0 {
            time::timeout(idle_timeout, source.seek(SeekFrom::Start(offset)))
                .await
                .map_err(|_| AppError::Sftp("定位远程文件超时".to_owned()))?
                .map_err(|_| AppError::Sftp("无法定位远程文件".to_owned()))?;
        }

        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = 0_u64;
        while transferred < length {
            let remaining = length - transferred;
            let read_limit = usize::try_from(remaining)
                .unwrap_or(usize::MAX)
                .min(buffer.len());
            let read = tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(AppError::Connection("文件传输已取消".to_owned()));
                }
                result = time::timeout(idle_timeout, source.read(&mut buffer[..read_limit])) => {
                    result
                        .map_err(|_| AppError::Sftp("下载远程文件超时".to_owned()))?
                        .map_err(|_| AppError::Sftp("读取远程文件失败".to_owned()))?
                }
            };
            if read == 0 {
                return Err(AppError::Sftp("远程文件在下载期间发生变化".to_owned()));
            }
            tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(AppError::Connection("文件传输已取消".to_owned()));
                }
                result = time::timeout(idle_timeout, destination.write_all(&buffer[..read])) => {
                    result
                        .map_err(|_| AppError::Connection("发送下载数据超时".to_owned()))?
                        .map_err(|_| AppError::Connection("下载客户端已断开".to_owned()))?;
                }
            }
            transferred += read as u64;
        }
        time::timeout(idle_timeout, destination.flush())
            .await
            .map_err(|_| AppError::Connection("刷新下载数据超时".to_owned()))?
            .map_err(|_| AppError::Connection("无法发送下载数据".to_owned()))?;
        Ok(transferred)
    }

    pub(crate) async fn upload_remote_stream_exclusive<R>(
        &self,
        connection_id: &str,
        remote_directory: &str,
        file_name: &str,
        source: &mut R,
        cancellation: &tokio_util::sync::CancellationToken,
        idle_timeout: Duration,
    ) -> Result<(String, u64), AppError>
    where
        R: AsyncRead + Unpin,
    {
        validate_remote_name(file_name)?;
        let remote_directory = normalize_remote_path(remote_directory)?;
        let target = checked_join_remote_path(&remote_directory, file_name)?;
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let directory_metadata =
            time::timeout(SFTP_TIMEOUT, sftp.metadata(remote_directory.clone()))
                .await
                .map_err(|_| AppError::Sftp("读取远程目录信息超时".to_owned()))?
                .map_err(|error| {
                    map_sftp_read_error(
                        error,
                        RemoteReadKind::Directory,
                        &entry.username,
                        "无法读取远程目录信息",
                    )
                })?;
        if !directory_metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程目标不是目录".to_owned()));
        }
        if time::timeout(SFTP_TIMEOUT, sftp.try_exists(target.clone()))
            .await
            .map_err(|_| AppError::Sftp("检查远程目标超时".to_owned()))?
            .map_err(|_| AppError::Sftp("无法检查远程目标".to_owned()))?
        {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }

        // 排他创建是标准 SFTP 下唯一可移植的“绝不覆盖”保证；代价是上传中目标可见。
        let destination = time::timeout(
            SFTP_TIMEOUT,
            sftp.open_with_flags(
                target.clone(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            ),
        )
        .await
        .map_err(|_| AppError::Sftp("创建远程文件超时".to_owned()))?;
        let mut destination = match destination {
            Ok(destination) => destination,
            Err(_) => {
                if sftp.try_exists(target.clone()).await.unwrap_or(false) {
                    return Err(AppError::Conflict("远程文件已存在".to_owned()));
                }
                return Err(AppError::Sftp("无法创建远程文件".to_owned()));
            }
        };

        let transfer = async {
            let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
            let mut transferred = 0_u64;
            loop {
                let read = tokio::select! {
                    _ = cancellation.cancelled() => {
                        return Err(AppError::Connection("文件传输已取消".to_owned()));
                    }
                    result = time::timeout(idle_timeout, source.read(&mut buffer)) => {
                        result
                            .map_err(|_| AppError::Connection("接收上传数据超时".to_owned()))?
                            .map_err(|_| AppError::Connection("上传客户端已断开".to_owned()))?
                    }
                };
                if read == 0 {
                    break;
                }
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        return Err(AppError::Connection("文件传输已取消".to_owned()));
                    }
                    result = time::timeout(idle_timeout, destination.write_all(&buffer[..read])) => {
                        result
                            .map_err(|_| AppError::Sftp("写入远程文件超时".to_owned()))?
                            .map_err(|_| AppError::Sftp("上传文件失败".to_owned()))?;
                    }
                }
                transferred = transferred
                    .checked_add(read as u64)
                    .ok_or_else(|| AppError::Validation("上传文件过大".to_owned()))?;
            }
            time::timeout(idle_timeout, destination.shutdown())
                .await
                .map_err(|_| AppError::Sftp("提交远程文件超时".to_owned()))?
                .map_err(|_| AppError::Sftp("提交远程文件失败".to_owned()))?;
            Ok(transferred)
        }
        .await;

        match transfer {
            Ok(transferred) => Ok((target, transferred)),
            Err(error) => {
                let _ = time::timeout(SFTP_TIMEOUT, destination.shutdown()).await;
                drop(destination);
                let _ = time::timeout(SFTP_TIMEOUT, sftp.remove_file(target)).await;
                Err(error)
            }
        }
    }

    pub async fn upload_file(
        &self,
        connection_id: &str,
        transfer_id: &str,
        local_path: &str,
        remote_directory: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
    ) -> Result<(), AppError> {
        let cancelled = self.begin_transfer(connection_id, transfer_id).await?;
        let result = self
            .upload_file_inner(
                connection_id,
                transfer_id,
                local_path,
                remote_directory,
                overwrite,
                progress,
                cancelled,
            )
            .await;
        self.end_transfer(transfer_id).await;
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn upload_file_inner(
        &self,
        connection_id: &str,
        transfer_id: &str,
        local_path: &str,
        remote_directory: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), AppError> {
        let local_path = validate_upload_source(local_path).await?;
        let file_name = local_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::Validation("本地文件名必须是有效 Unicode".to_owned()))?;
        validate_remote_name(file_name)?;
        let remote_directory = normalize_remote_path(remote_directory)?;
        let target = checked_join_remote_path(&remote_directory, file_name)?;
        let temp =
            checked_join_remote_path(&remote_directory, &format!(".fstty-{transfer_id}.part"))?;
        let backup =
            checked_join_remote_path(&remote_directory, &format!(".fstty-{transfer_id}.bak"))?;
        let metadata = tokio::fs::metadata(&local_path)
            .await
            .map_err(|_| AppError::Validation("无法读取本地文件".to_owned()))?;
        let total = metadata.len();
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let target_exists = sftp
            .try_exists(target.clone())
            .await
            .map_err(|_| AppError::Sftp("无法检查远程目标".to_owned()))?;
        if target_exists && !overwrite {
            return Err(AppError::Conflict("远程文件已存在".to_owned()));
        }
        if target_exists {
            let target_metadata = sftp
                .symlink_metadata(target.clone())
                .await
                .map_err(|_| AppError::Sftp("无法读取远程目标信息".to_owned()))?;
            if !target_metadata.file_type().is_file() {
                return Err(AppError::Conflict("远程目标不是普通文件".to_owned()));
            }
        }

        let mut source = LocalFile::open(&local_path)
            .await
            .map_err(|_| AppError::Validation("无法打开本地文件".to_owned()))?;
        let mut destination = sftp
            .create(temp.clone())
            .await
            .map_err(|_| AppError::Sftp("无法创建远程临时文件".to_owned()))?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = 0_u64;
        let mut last_progress = Instant::now() - Duration::from_millis(100);
        send_progress(&progress, transfer_id, transferred, total);

        loop {
            if cancelled.load(Ordering::Relaxed) {
                let _ = destination.shutdown().await;
                let _ = sftp.remove_file(temp).await;
                let _ = progress.send(TransferEvent::Cancelled {
                    transfer_id: transfer_id.to_owned(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                });
                return Ok(());
            }
            let read = match source.read(&mut buffer).await {
                Ok(read) => read,
                Err(_) => {
                    let _ = destination.shutdown().await;
                    let _ = sftp.remove_file(temp).await;
                    return Err(AppError::Internal("读取本地文件失败".to_owned()));
                }
            };
            if read == 0 {
                break;
            }
            if destination.write_all(&buffer[..read]).await.is_err() {
                let _ = destination.shutdown().await;
                let _ = sftp.remove_file(temp).await;
                return Err(AppError::Sftp("上传文件失败".to_owned()));
            }
            transferred += read as u64;
            if last_progress.elapsed() >= Duration::from_millis(100) {
                send_progress(&progress, transfer_id, transferred, total);
                last_progress = Instant::now();
            }
        }
        if destination.shutdown().await.is_err() {
            let _ = sftp.remove_file(temp).await;
            return Err(AppError::Sftp("提交远程临时文件失败".to_owned()));
        }
        finalize_remote_file(&sftp, &temp, &target, &backup, target_exists).await?;
        let _ = progress.send(TransferEvent::Completed {
            transfer_id: transfer_id.to_owned(),
            transferred_bytes: transferred,
            total_bytes: total,
        });
        Ok(())
    }

    pub async fn download_file(
        &self,
        connection_id: &str,
        transfer_id: &str,
        remote_path: &str,
        local_path: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
    ) -> Result<(), AppError> {
        let cancelled = self.begin_transfer(connection_id, transfer_id).await?;
        let result = self
            .download_file_inner(
                connection_id,
                transfer_id,
                remote_path,
                local_path,
                overwrite,
                progress,
                cancelled,
            )
            .await;
        self.end_transfer(transfer_id).await;
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_file_inner(
        &self,
        connection_id: &str,
        transfer_id: &str,
        remote_path: &str,
        local_path: &str,
        overwrite: bool,
        progress: Channel<TransferEvent>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), AppError> {
        let remote_path = normalize_remote_path(remote_path)?;
        let local_path = validate_download_target(local_path, overwrite).await?;
        let parent = local_path
            .parent()
            .ok_or_else(|| AppError::Validation("本地保存目录无效".to_owned()))?;
        let temp = parent.join(format!(".fstty-{transfer_id}.part"));
        let backup = parent.join(format!(".fstty-{transfer_id}.bak"));
        let entry = self.entry(connection_id).await?;
        let sftp = open_sftp(&entry).await?;
        let metadata = sftp
            .symlink_metadata(remote_path.clone())
            .await
            .map_err(|error| {
                map_sftp_read_error(
                    error,
                    RemoteReadKind::File,
                    &entry.username,
                    "无法读取远程文件信息",
                )
            })?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("只能下载普通文件".to_owned()));
        }
        let total = metadata.len();
        let mut source = sftp.open(remote_path).await.map_err(|error| {
            map_sftp_read_error(
                error,
                RemoteReadKind::File,
                &entry.username,
                "无法打开远程文件",
            )
        })?;
        let mut destination = TokioOpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .await
            .map_err(|_| AppError::Conflict("本地临时文件已存在".to_owned()))?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = 0_u64;
        let mut last_progress = Instant::now() - Duration::from_millis(100);
        send_progress(&progress, transfer_id, transferred, total);

        loop {
            if cancelled.load(Ordering::Relaxed) {
                drop(destination);
                let _ = tokio::fs::remove_file(&temp).await;
                let _ = progress.send(TransferEvent::Cancelled {
                    transfer_id: transfer_id.to_owned(),
                    transferred_bytes: transferred,
                    total_bytes: total,
                });
                return Ok(());
            }
            let read = match source.read(&mut buffer).await {
                Ok(read) => read,
                Err(_) => {
                    drop(destination);
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(AppError::Sftp("下载文件失败".to_owned()));
                }
            };
            if read == 0 {
                break;
            }
            if destination.write_all(&buffer[..read]).await.is_err() {
                drop(destination);
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(AppError::Internal("写入本地文件失败".to_owned()));
            }
            transferred += read as u64;
            if last_progress.elapsed() >= Duration::from_millis(100) {
                send_progress(&progress, transfer_id, transferred, total);
                last_progress = Instant::now();
            }
        }
        if destination.flush().await.is_err() || destination.sync_all().await.is_err() {
            drop(destination);
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(AppError::Internal("同步本地临时文件失败".to_owned()));
        }
        drop(destination);
        finalize_local_file(&temp, &local_path, &backup, overwrite).await?;
        let _ = progress.send(TransferEvent::Completed {
            transfer_id: transfer_id.to_owned(),
            transferred_bytes: transferred,
            total_bytes: total,
        });
        Ok(())
    }

    pub async fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let transfers = self.inner.transfers.lock().await;
        if let Some(transfer) = transfers.get(transfer_id) {
            transfer.cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    pub async fn session_id(&self, connection_id: &str) -> Result<String, AppError> {
        Ok(self.entry(connection_id).await?.session_id.clone())
    }

    async fn begin_transfer(
        &self,
        connection_id: &str,
        transfer_id: &str,
    ) -> Result<Arc<AtomicBool>, AppError> {
        Uuid::parse_str(transfer_id)
            .map_err(|_| AppError::Validation("传输 ID 无效".to_owned()))?;
        self.entry(connection_id).await?;
        let mut transfers = self.inner.transfers.lock().await;
        if transfers.contains_key(transfer_id) {
            return Err(AppError::Conflict("传输 ID 已存在".to_owned()));
        }
        if transfers
            .values()
            .any(|transfer| transfer.connection_id == connection_id)
        {
            return Err(AppError::Busy("当前会话已有文件传输".to_owned()));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        transfers.insert(
            transfer_id.to_owned(),
            ActiveTransfer {
                connection_id: connection_id.to_owned(),
                cancelled: cancelled.clone(),
            },
        );
        Ok(cancelled)
    }

    async fn mutable_browser_sftp(
        &self,
        connection_id: &str,
    ) -> Result<Arc<SftpSession>, AppError> {
        let entry = self.entry(connection_id).await?;
        if self
            .inner
            .transfers
            .lock()
            .await
            .values()
            .any(|transfer| transfer.connection_id == connection_id)
        {
            return Err(AppError::Busy("当前会话正在传输文件".to_owned()));
        }
        entry
            .browser_sftp
            .clone()
            .ok_or_else(|| AppError::Sftp("服务器不支持 SFTP".to_owned()))
    }

    async fn end_transfer(&self, transfer_id: &str) {
        self.inner.transfers.lock().await.remove(transfer_id);
    }

    async fn cancel_connection_transfers(&self, connection_id: &str) {
        for transfer in self.inner.transfers.lock().await.values() {
            if transfer.connection_id == connection_id {
                transfer.cancelled.store(true, Ordering::Relaxed);
            }
        }
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
