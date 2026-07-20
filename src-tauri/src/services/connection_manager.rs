use crate::models::{
    AppError, ConnectResult, CredentialKind, FileEntry, FileKind, HostKeyChallenge, HostKeyChange,
    PrivateKeySource, SessionAuth, SshConnection, StoredSession, TerminalEvent, TransferEvent,
};
use crate::services::CredentialService;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use russh::client;
use russh::client::KeyboardInteractiveAuthResponse;
use russh::keys::{
    decode_secret_key,
    known_hosts::{check_known_hosts_path, known_host_keys_path, learn_known_hosts_path},
    load_secret_key,
    ssh_key::{HashAlg, PublicKey},
    PrivateKeyWithHashAlg,
};
use russh::{ChannelMsg, Disconnect, MethodKind};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FilePermissions, FileType as SftpFileType};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::fs::{File as LocalFile, OpenOptions as TokioOpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use tokio::time;
use uuid::Uuid;
use zeroize::Zeroizing;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const TERMINAL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(10);
const HOST_CHALLENGE_TTL: Duration = Duration::from_secs(60);
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_PENDING_TERMINAL_BYTES: usize = 1024 * 1024;
const MAX_PENDING_TERMINAL_MESSAGES: usize = 256;
const MAX_EXEC_OUTPUT_BYTES: usize = 1024 * 1024;
const TRANSFER_BUFFER_BYTES: usize = 64 * 1024;
const MAX_REMOTE_PATH_BYTES: usize = 4096;
const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;
#[derive(Clone)]
pub struct ConnectionManager {
    inner: Arc<ConnectionManagerInner>,
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
    handle: Arc<Mutex<client::Handle<SshClient>>>,
    terminal_tx: mpsc::Sender<TerminalControl>,
    browser_sftp: Option<Arc<SftpSession>>,
}

struct PendingHostKey {
    session_id: String,
    host: String,
    port: u16,
    key: PublicKey,
    expires_at: Instant,
}

struct ActiveTransfer {
    connection_id: String,
    cancelled: Arc<AtomicBool>,
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

#[derive(Clone, Debug)]
enum HostObservation {
    Unknown(PublicKey),
    Changed {
        old_key: PublicKey,
        new_key: PublicKey,
    },
    Failure,
}

struct SshClient {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    known_hosts_lock: Arc<StdMutex<()>>,
    observation: Arc<StdMutex<Option<HostObservation>>>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let _known_hosts_guard = match self.known_hosts_lock.lock() {
            Ok(guard) => guard,
            Err(_) => {
                set_observation(&self.observation, HostObservation::Failure);
                return Err(russh::Error::UnknownKey);
            }
        };
        match check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        ) {
            Ok(true) => Ok(true),
            Ok(false) => {
                set_observation(
                    &self.observation,
                    HostObservation::Unknown(server_public_key.clone()),
                );
                Ok(false)
            }
            Err(russh::keys::Error::KeyChanged { .. }) => {
                match known_host_keys_path(&self.host, self.port, &self.known_hosts_path) {
                    Ok(keys) => {
                        let keys = keys.into_iter().map(|(_, key)| key).collect::<Vec<_>>();
                        let old_key = keys
                            .iter()
                            .find(|key| key.algorithm() == server_public_key.algorithm())
                            .or_else(|| keys.first())
                            .cloned();
                        if let Some(old_key) = old_key {
                            set_observation(
                                &self.observation,
                                HostObservation::Changed {
                                    old_key,
                                    new_key: server_public_key.clone(),
                                },
                            );
                        } else {
                            set_observation(&self.observation, HostObservation::Failure);
                        }
                    }
                    Err(_) => set_observation(&self.observation, HostObservation::Failure),
                }
                Ok(false)
            }
            Err(_) => {
                set_observation(&self.observation, HostObservation::Failure);
                Err(russh::Error::UnknownKey)
            }
        }
    }
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
        session: StoredSession,
        columns: u32,
        rows: u32,
        events: Channel<TerminalEvent>,
        credentials: &CredentialService,
        one_time_credential: Option<Zeroizing<String>>,
    ) -> Result<ConnectResult, AppError> {
        validate_terminal_size(columns, rows)?;
        if session.username.trim().is_empty() {
            return Err(AppError::Validation(
                "当前会话缺少用户名，请先编辑会话".to_owned(),
            ));
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
                    one_time: one_time_credential,
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
            handle,
            terminal_tx,
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

        Ok(ConnectResult::Connected {
            connection: SshConnection {
                connection_id,
                session_id: session.id,
                home_path,
                sftp_available: browser_sftp.is_some(),
            },
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

    pub async fn write_terminal(&self, connection_id: &str, data: String) -> Result<(), AppError> {
        if data.is_empty() || data.len() > MAX_TERMINAL_INPUT_BYTES {
            return Err(AppError::Validation("终端输入大小无效".to_owned()));
        }
        let entry = self.entry(connection_id).await?;
        entry
            .terminal_tx
            .send(TerminalControl::Data(data.into_bytes()))
            .await
            .map_err(|_| AppError::Connection("终端连接已关闭".to_owned()))
    }

    pub async fn resize_terminal(
        &self,
        connection_id: &str,
        columns: u32,
        rows: u32,
    ) -> Result<(), AppError> {
        validate_terminal_size(columns, rows)?;
        let entry = self.entry(connection_id).await?;
        entry
            .terminal_tx
            .send(TerminalControl::Resize { columns, rows })
            .await
            .map_err(|_| AppError::Connection("终端连接已关闭".to_owned()))
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), AppError> {
        let entry = self.take_connection(connection_id).await;
        let Some(entry) = entry else {
            return Ok(());
        };
        self.cancel_connection_transfers(connection_id).await;
        let _ = entry.terminal_tx.send(TerminalControl::Close).await;
        let handle = entry.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "", "zh-CN")
            .await;
        Ok(())
    }

    pub async fn disconnect_session(&self, session_id: &str) {
        let cancellations = self
            .inner
            .connecting_sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        for cancellation in cancellations {
            cancellation.cancel();
        }
        let connection_ids = self
            .inner
            .session_connections
            .read()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        for connection_id in connection_ids {
            let _ = self.disconnect(&connection_id).await;
        }
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
        let metadata = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|_| AppError::Sftp("无法读取远程目录信息".to_owned()))?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::Validation("不允许进入符号链接目录".to_owned()));
        }
        if !metadata.file_type().is_dir() {
            return Err(AppError::Validation("远程路径不是目录".to_owned()));
        }
        let directory = sftp
            .read_dir(path)
            .await
            .map_err(|_| AppError::Sftp("无法读取远程目录".to_owned()))?;
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
            .map_err(|_| AppError::Sftp("无法读取远程文件信息".to_owned()))?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation("只能下载普通文件".to_owned()));
        }
        let total = metadata.len();
        let mut source = sftp
            .open(remote_path)
            .await
            .map_err(|_| AppError::Sftp("无法打开远程文件".to_owned()))?;
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

    pub async fn exec(
        &self,
        connection_id: &str,
        command: &'static str,
    ) -> Result<Vec<u8>, AppError> {
        let entry = self.entry(connection_id).await?;
        let mut channel = {
            let handle = entry.handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|_| AppError::Connection("无法创建设备信息通道".to_owned()))?
        };
        channel
            .exec(true, command)
            .await
            .map_err(|_| AppError::Connection("无法执行设备信息命令".to_owned()))?;
        let collect = async {
            let mut output = Vec::new();
            let mut exit_code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if output.len() + data.len() > MAX_EXEC_OUTPUT_BYTES {
                            return Err(AppError::Connection("设备信息输出过大".to_owned()));
                        }
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status);
                        break;
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            if exit_code.is_some_and(|code| code != 0) {
                return Err(AppError::Connection("设备信息命令执行失败".to_owned()));
            }
            Ok(output)
        };
        time::timeout(EXEC_TIMEOUT, collect)
            .await
            .map_err(|_| AppError::Connection("设备信息命令超时".to_owned()))?
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

async fn authenticate(
    handle: &mut client::Handle<SshClient>,
    session: &StoredSession,
    credentials: &CredentialService,
    one_time_credential: Option<Zeroizing<String>>,
) -> Result<AuthenticationOutcome, AppError> {
    time::timeout(
        AUTH_TIMEOUT,
        authenticate_inner(handle, session, credentials, one_time_credential),
    )
    .await
    .map_err(|_| AppError::Authentication("SSH 认证超时".to_owned()))?
}

async fn authenticate_inner(
    handle: &mut client::Handle<SshClient>,
    session: &StoredSession,
    credentials: &CredentialService,
    one_time_credential: Option<Zeroizing<String>>,
) -> Result<AuthenticationOutcome, AppError> {
    // OpenSSH 客户端会先用 none 查询可用方法。部分受限服务端依赖该顺序，直接提交密码会被拒绝。
    let remaining_methods = match handle
        .authenticate_none(session.username.clone())
        .await
        .map_err(|_| AppError::Authentication("无法查询 SSH 认证方式".to_owned()))?
    {
        client::AuthResult::Success => return Ok(AuthenticationOutcome::Authenticated),
        client::AuthResult::Failure {
            remaining_methods,
            partial_success,
        } => {
            if partial_success {
                return Err(AppError::Authentication(
                    "SSH 需要继续认证，当前版本不支持多因素认证".to_owned(),
                ));
            }
            remaining_methods
        }
    };

    let expected_method = match &session.auth {
        SessionAuth::Password => {
            if remaining_methods.contains(&MethodKind::Password) {
                MethodKind::Password
            } else if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
                MethodKind::KeyboardInteractive
            } else {
                return Err(authentication_method_unavailable(MethodKind::Password));
            }
        }
        SessionAuth::PrivateKey { .. } => {
            if !remaining_methods.contains(&MethodKind::PublicKey) {
                return Err(authentication_method_unavailable(MethodKind::PublicKey));
            }
            MethodKind::PublicKey
        }
    };

    let result = match &session.auth {
        SessionAuth::Password => {
            let secret = match one_time_credential {
                Some(value) => value,
                None => match credentials.get(&session.id).await? {
                    Some(value) => value,
                    None => {
                        return Ok(AuthenticationOutcome::CredentialRequired(
                            CredentialKind::Password,
                        ))
                    }
                },
            };
            if expected_method == MethodKind::KeyboardInteractive {
                let mut response = handle
                    .authenticate_keyboard_interactive_start(&session.username, None::<String>)
                    .await
                    .map_err(|_| AppError::Authentication("SSH 交互认证失败".to_owned()))?;
                let mut prompt_rounds = 0_u8;
                loop {
                    response = match response {
                        KeyboardInteractiveAuthResponse::Success => {
                            break client::AuthResult::Success;
                        }
                        KeyboardInteractiveAuthResponse::Failure { .. } => {
                            return Err(AppError::Authentication("SSH 交互认证失败".to_owned()))
                        }
                        KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                            if prompt_rounds > 0 {
                                return Err(AppError::Authentication(
                                    "SSH 需要连续交互认证，当前版本不支持多因素认证".to_owned(),
                                ));
                            }
                            prompt_rounds += 1;
                            let responses = prompts
                                .into_iter()
                                .map(|prompt| {
                                    if prompt.echo {
                                        session.username.clone()
                                    } else {
                                        secret.as_str().to_owned()
                                    }
                                })
                                .collect();
                            handle
                                .authenticate_keyboard_interactive_respond(responses)
                                .await
                                .map_err(|_| {
                                    AppError::Authentication("SSH 交互认证失败".to_owned())
                                })?
                        }
                    };
                }
            } else {
                handle
                    .authenticate_password(session.username.clone(), secret.as_str().to_owned())
                    .await
                    .map_err(|_| AppError::Authentication("SSH 密码认证失败".to_owned()))?
            }
        }
        SessionAuth::PrivateKey {
            source,
            path,
            passphrase_required,
        } => {
            if *source == PrivateKeySource::File {
                let key_path = path
                    .as_deref()
                    .ok_or_else(|| AppError::Persistence("私钥文件路径缺失".to_owned()))?;
                let metadata = tokio::fs::metadata(key_path)
                    .await
                    .map_err(|_| AppError::Credential("私钥文件不存在或无法读取".to_owned()))?;
                if !metadata.is_file() || metadata.len() > MAX_PRIVATE_KEY_BYTES {
                    return Err(AppError::Credential(
                        "私钥文件必须是小于 1 MiB 的普通文件".to_owned(),
                    ));
                }
            }
            let inline_key = if *source == PrivateKeySource::Inline {
                Some(
                    credentials
                        .get_private_key(&session.id)
                        .await?
                        .ok_or_else(|| {
                            AppError::Credential("已保存私钥缺失，请重新粘贴".to_owned())
                        })?,
                )
            } else {
                None
            };
            let passphrase = if *passphrase_required {
                match one_time_credential {
                    Some(value) => Some(value),
                    None => match credentials.get(&session.id).await? {
                        Some(value) => Some(value),
                        None => {
                            return Ok(AuthenticationOutcome::CredentialRequired(
                                CredentialKind::PrivateKeyPassphrase,
                            ))
                        }
                    },
                }
            } else {
                None
            };
            let key = match source {
                PrivateKeySource::File => {
                    let key_path = path
                        .clone()
                        .ok_or_else(|| AppError::Persistence("私钥文件路径缺失".to_owned()))?;
                    tokio::task::spawn_blocking(move || {
                        load_secret_key(key_path, passphrase.as_ref().map(|value| value.as_str()))
                    })
                    .await
                    .map_err(|_| AppError::Credential("私钥加载任务失败".to_owned()))?
                    .map_err(|_| AppError::Credential("无法加载私钥或口令错误".to_owned()))?
                }
                PrivateKeySource::Inline => {
                    let inline_key = inline_key.ok_or_else(|| {
                        AppError::Credential("已保存私钥缺失，请重新粘贴".to_owned())
                    })?;
                    tokio::task::spawn_blocking(move || {
                        decode_secret_key(
                            &inline_key,
                            passphrase.as_ref().map(|value| value.as_str()),
                        )
                    })
                    .await
                    .map_err(|_| AppError::Credential("私钥加载任务失败".to_owned()))?
                    .map_err(|_| AppError::Credential("无法加载私钥或口令错误".to_owned()))?
                }
            };
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|_| AppError::Authentication("无法协商私钥算法".to_owned()))?
                .flatten();
            handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|_| AppError::Authentication("SSH 私钥认证失败".to_owned()))?
        }
    };

    match result {
        client::AuthResult::Success => Ok(AuthenticationOutcome::Authenticated),
        client::AuthResult::Failure {
            partial_success: true,
            ..
        } => Err(AppError::Authentication(
            "SSH 需要继续认证，当前版本不支持多因素认证".to_owned(),
        )),
        client::AuthResult::Failure {
            remaining_methods, ..
        } if !remaining_methods.contains(&expected_method) => {
            Err(authentication_method_unavailable(expected_method))
        }
        client::AuthResult::Failure { .. } => {
            let message = match expected_method {
                MethodKind::Password => "SSH 密码认证失败",
                MethodKind::PublicKey => "SSH 私钥认证失败",
                _ => "SSH 认证失败",
            };
            Err(AppError::Authentication(message.to_owned()))
        }
    }
}

fn authentication_method_unavailable(method: MethodKind) -> AppError {
    let message = match method {
        MethodKind::Password | MethodKind::KeyboardInteractive => "服务器未启用密码认证",
        MethodKind::PublicKey => "服务器未启用私钥认证",
        _ => "服务器未启用所选认证方式",
    };
    AppError::Authentication(message.to_owned())
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

async fn wait_for_channel_success(
    channel: &mut russh::Channel<client::Msg>,
    action: &str,
    pending: &mut PendingTerminalMessages,
) -> Result<(), AppError> {
    // 请求回执可能晚于远端首屏输出；先暂存，避免 Shell 已启动但欢迎信息被静默丢弃。
    time::timeout(TERMINAL_REQUEST_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => {
                    return Err(AppError::Connection(format!("服务器拒绝{action}")));
                }
                Some(ChannelMsg::Close) | None => {
                    return Err(AppError::Connection(format!("{action}时终端通道已关闭")));
                }
                Some(message) => pending.push(message)?,
            }
        }
    })
    .await
    .map_err(|_| AppError::Connection(format!("等待服务器{action}超时")))?
}

async fn open_sftp(entry: &ConnectionEntry) -> Result<SftpSession, AppError> {
    let mut handle = entry.handle.lock().await;
    open_sftp_with_handle(&mut handle).await
}

async fn run_terminal(
    connection_id: String,
    terminal_reader: russh::ChannelReadHalf,
    terminal_writer: russh::ChannelWriteHalf<client::Msg>,
    controls: mpsc::Receiver<TerminalControl>,
    events: Channel<TerminalEvent>,
    pending: VecDeque<ChannelMsg>,
) {
    // 拆开读写半通道：写入受远端窗口阻塞时，读取仍会持续推进并释放窗口。
    let reader = run_terminal_reader(
        connection_id.clone(),
        terminal_reader,
        events.clone(),
        pending,
    );
    let writer = run_terminal_writer(terminal_writer, controls);
    tokio::pin!(reader);
    tokio::pin!(writer);
    let end = tokio::select! {
        end = &mut reader => end,
        end = &mut writer => end,
    };
    match end {
        TerminalEnd::Disconnected { exit_code, message } => {
            let _ = events.send(TerminalEvent::Disconnected {
                connection_id,
                exit_code,
                message,
            });
        }
        TerminalEnd::Error(message) => {
            let _ = events.send(TerminalEvent::Error {
                connection_id,
                message,
            });
        }
        TerminalEnd::ClientGone => {}
    }
}

async fn run_terminal_reader(
    connection_id: String,
    mut terminal: russh::ChannelReadHalf,
    events: Channel<TerminalEvent>,
    mut pending: VecDeque<ChannelMsg>,
) -> TerminalEnd {
    loop {
        let message = match pending.pop_front() {
            Some(message) => Some(message),
            None => terminal.wait().await,
        };
        match message {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                if events
                    .send(TerminalEvent::Data {
                        connection_id: connection_id.clone(),
                        data: BASE64_STANDARD.encode(data),
                    })
                    .is_err()
                {
                    return TerminalEnd::ClientGone;
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                return TerminalEnd::Disconnected {
                    exit_code: Some(exit_status),
                    message: format!("远程 Shell 已退出，状态码 {exit_status}"),
                };
            }
            Some(ChannelMsg::ExitSignal { .. }) => {
                return TerminalEnd::Disconnected {
                    exit_code: None,
                    message: "远程 Shell 因信号退出".to_owned(),
                };
            }
            Some(ChannelMsg::Eof) => {
                return TerminalEnd::Disconnected {
                    exit_code: None,
                    message: "远程 Shell 已关闭输出".to_owned(),
                };
            }
            Some(ChannelMsg::Failure) => {
                return TerminalEnd::Error("远程终端请求失败".to_owned());
            }
            Some(ChannelMsg::Close) | None => {
                return TerminalEnd::Disconnected {
                    exit_code: None,
                    message: "连接已断开".to_owned(),
                };
            }
            _ => {}
        }
    }
}

async fn run_terminal_writer(
    terminal: russh::ChannelWriteHalf<client::Msg>,
    mut controls: mpsc::Receiver<TerminalControl>,
) -> TerminalEnd {
    while let Some(control) = controls.recv().await {
        match control {
            TerminalControl::Data(data) => {
                if terminal.data_bytes(data).await.is_err() {
                    return TerminalEnd::Error("终端输入发送失败".to_owned());
                }
            }
            TerminalControl::Resize { columns, rows } => {
                if terminal.window_change(columns, rows, 0, 0).await.is_err() {
                    return TerminalEnd::Error("终端尺寸同步失败".to_owned());
                }
            }
            TerminalControl::Close => {
                let _ = terminal.close().await;
                return TerminalEnd::Disconnected {
                    exit_code: None,
                    message: "连接已断开".to_owned(),
                };
            }
        }
    }
    let _ = terminal.close().await;
    TerminalEnd::Disconnected {
        exit_code: None,
        message: "连接已断开".to_owned(),
    }
}

fn set_observation(observation: &StdMutex<Option<HostObservation>>, value: HostObservation) {
    if let Ok(mut observation) = observation.lock() {
        *observation = Some(value);
    }
}

fn key_algorithm(key: &PublicKey) -> String {
    key.algorithm().as_str().to_owned()
}

fn key_fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn remove_known_host(path: &Path, host: &str, port: u16) -> Result<bool, AppError> {
    if !path.exists() {
        return Ok(false);
    }
    let target = if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    };
    let content = fs::read_to_string(path)
        .map_err(|_| AppError::Persistence("无法读取主机密钥文件".to_owned()))?;
    let mut removed = false;
    let retained = content
        .lines()
        .filter(|line| {
            let host_field = line.split_whitespace().next().unwrap_or_default();
            let matched = !line.starts_with('#')
                && host_field.split(',').any(|candidate| candidate == target);
            removed |= matched;
            !matched
        })
        .collect::<Vec<_>>()
        .join("\n");
    if removed {
        let temp = path.with_extension("tmp");
        fs::write(&temp, format!("{retained}\n"))
            .map_err(|_| AppError::Persistence("无法写入主机密钥临时文件".to_owned()))?;
        fs::remove_file(path)
            .map_err(|_| AppError::Persistence("无法替换主机密钥文件".to_owned()))?;
        fs::rename(temp, path)
            .map_err(|_| AppError::Persistence("无法提交主机密钥文件".to_owned()))?;
    }
    Ok(removed)
}

fn file_entry_from_remote(entry: russh_sftp::client::fs::DirEntry) -> Option<FileEntry> {
    let name = entry.file_name();
    validate_remote_name(&name).ok()?;
    let path = normalize_remote_path(&entry.path()).ok()?;
    let metadata = entry.metadata();
    let kind = match metadata.file_type() {
        SftpFileType::Dir => FileKind::Folder,
        SftpFileType::File => FileKind::File,
        SftpFileType::Symlink => FileKind::Symlink,
        SftpFileType::Other => FileKind::Other,
    };
    let mode = metadata.permissions.unwrap_or_default();
    let type_prefix = match kind {
        FileKind::Folder => 'd',
        FileKind::File => '-',
        FileKind::Symlink => 'l',
        FileKind::Other => '?',
    };
    let symbolic = FilePermissions::from(mode).to_string();
    Some(FileEntry {
        name,
        path,
        kind,
        size: matches!(kind, FileKind::File).then_some(metadata.len()),
        modified_at: metadata.mtime.map(|value| value as u64 * 1000),
        owner: metadata
            .user
            .or_else(|| metadata.uid.map(|value| value.to_string()))
            .unwrap_or_else(|| "--".to_owned()),
        group: metadata
            .group
            .or_else(|| metadata.gid.map(|value| value.to_string()))
            .unwrap_or_else(|| "--".to_owned()),
        permissions: format!("{type_prefix}{symbolic} ({:03o})", mode & 0o7777),
    })
}

fn file_kind_rank(kind: FileKind) -> u8 {
    match kind {
        FileKind::Folder => 0,
        FileKind::File => 1,
        FileKind::Symlink => 2,
        FileKind::Other => 3,
    }
}

fn normalize_remote_path(path: &str) -> Result<String, AppError> {
    if path.is_empty()
        || !path.starts_with('/')
        || path.len() > MAX_REMOTE_PATH_BYTES
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(AppError::Validation("远程路径无效".to_owned()));
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn validate_remote_name(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(AppError::Validation("远程文件名无效".to_owned()));
    }
    Ok(())
}

fn join_remote_path(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{directory}/{name}")
    }
}

fn checked_join_remote_path(directory: &str, name: &str) -> Result<String, AppError> {
    normalize_remote_path(&join_remote_path(directory, name))
}

async fn validate_upload_source(path: &str) -> Result<PathBuf, AppError> {
    let path = validate_local_path(path, "本地文件路径无效")?;
    let metadata = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| AppError::Validation("无法读取本地文件".to_owned()))?;
    if !metadata.is_file() {
        return Err(AppError::Validation("只能上传普通文件".to_owned()));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|_| AppError::Validation("无法规范化本地文件路径".to_owned()))
}

async fn validate_download_target(path: &str, overwrite: bool) -> Result<PathBuf, AppError> {
    let requested = validate_local_path(path, "本地保存路径无效")?;
    let file_name = requested
        .file_name()
        .ok_or_else(|| AppError::Validation("本地保存文件名无效".to_owned()))?;
    let parent = requested
        .parent()
        .ok_or_else(|| AppError::Validation("本地保存目录无效".to_owned()))?;
    let canonical_parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(|_| AppError::Validation("本地保存目录不存在".to_owned()))?;
    let parent_metadata = tokio::fs::metadata(&canonical_parent)
        .await
        .map_err(|_| AppError::Validation("本地保存目录不存在".to_owned()))?;
    if !parent_metadata.is_dir() {
        return Err(AppError::Validation("本地保存目录无效".to_owned()));
    }
    let path = canonical_parent.join(file_name);
    if path.to_string_lossy().len() > MAX_REMOTE_PATH_BYTES {
        return Err(AppError::Validation("本地保存路径过长".to_owned()));
    }
    if let Ok(metadata) = tokio::fs::symlink_metadata(&path).await {
        if !metadata.is_file() {
            return Err(AppError::Conflict("本地目标不是普通文件".to_owned()));
        }
        if !overwrite {
            return Err(AppError::Conflict("本地文件已存在".to_owned()));
        }
    }
    Ok(path)
}

fn validate_local_path(path: &str, message: &str) -> Result<PathBuf, AppError> {
    if path.is_empty()
        || path.len() > MAX_REMOTE_PATH_BYTES
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(AppError::Validation(message.to_owned()));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::Validation(message.to_owned()));
    }
    Ok(path)
}

async fn finalize_remote_file(
    sftp: &SftpSession,
    temp: &str,
    target: &str,
    backup: &str,
    target_exists: bool,
) -> Result<(), AppError> {
    if target_exists
        && sftp
            .rename(target.to_owned(), backup.to_owned())
            .await
            .is_err()
    {
        let _ = sftp.remove_file(temp.to_owned()).await;
        return Err(AppError::Sftp("无法备份远程原文件".to_owned()));
    }
    if sftp
        .rename(temp.to_owned(), target.to_owned())
        .await
        .is_err()
    {
        if target_exists {
            let _ = sftp.rename(backup.to_owned(), target.to_owned()).await;
        }
        let _ = sftp.remove_file(temp.to_owned()).await;
        return Err(AppError::Sftp("无法提交远程文件".to_owned()));
    }
    if target_exists {
        let _ = sftp.remove_file(backup.to_owned()).await;
    }
    Ok(())
}

async fn finalize_local_file(
    temp: &Path,
    target: &Path,
    backup: &Path,
    overwrite: bool,
) -> Result<(), AppError> {
    let target_exists = tokio::fs::metadata(target).await.is_ok();
    if target_exists {
        if !overwrite {
            let _ = tokio::fs::remove_file(temp).await;
            return Err(AppError::Conflict("本地文件已存在".to_owned()));
        }
        tokio::fs::rename(target, backup).await.map_err(|_| {
            let _ = std::fs::remove_file(temp);
            AppError::Internal("无法备份本地原文件".to_owned())
        })?;
    }
    if tokio::fs::rename(temp, target).await.is_err() {
        let restored = !target_exists || tokio::fs::rename(backup, target).await.is_ok();
        let _ = tokio::fs::remove_file(temp).await;
        return Err(AppError::Internal(
            if restored {
                "无法提交本地文件"
            } else {
                "无法提交本地文件，且原文件恢复失败"
            }
            .to_owned(),
        ));
    }
    if target_exists {
        let _ = tokio::fs::remove_file(backup).await;
    }
    Ok(())
}

fn send_progress(
    progress: &Channel<TransferEvent>,
    transfer_id: &str,
    transferred_bytes: u64,
    total_bytes: u64,
) {
    let _ = progress.send(TransferEvent::Progress {
        transfer_id: transfer_id.to_owned(),
        transferred_bytes,
        total_bytes,
    });
}

fn validate_terminal_size(columns: u32, rows: u32) -> Result<(), AppError> {
    if !(1..=1000).contains(&columns) || !(1..=1000).contains(&rows) {
        return Err(AppError::Validation("终端行列数无效".to_owned()));
    }
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
    use zeroize::Zeroizing;

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
