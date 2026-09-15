use crate::protocol::{Profile, Secrets, Target};
use russh::{client, server, Channel, ChannelMsg, ChannelOpenFailure, Disconnect};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

pub struct Remote {
    expected: String,
    observed: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Remote {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let key = key.to_openssh().map_err(|_| russh::Error::UnknownKey)?;
        *self.observed.lock().map_err(|_| russh::Error::UnknownKey)? = Some(key.clone());
        Ok(!self.expected.is_empty() && self.expected == key)
    }
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        channel_buffer_size: 32,
        ..Default::default()
    })
}

pub fn fingerprint(key: &str) -> String {
    russh::keys::PublicKey::from_openssh(key)
        .map(|k| k.fingerprint(russh::keys::HashAlg::Sha256).to_string())
        .unwrap_or_default()
}

pub async fn probe(target: &Target) -> crate::Result<String> {
    let observed = Arc::new(Mutex::new(None));
    // 探测仅进行主机密钥交换，不发送账号密码或私钥签名。
    let _ = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(
            client_config(),
            (target.host.as_str(), target.port),
            Remote {
                expected: String::new(),
                observed: observed.clone(),
            },
        ),
    )
    .await;
    let result = observed
        .lock()
        .map_err(|_| "主机探测失败")?
        .clone()
        .ok_or_else(|| "无法获取目标主机指纹，请检查地址和网络".into());
    result
}

pub async fn authenticate(
    profile: &Profile,
    secrets: Secrets,
) -> crate::Result<client::Handle<Remote>> {
    let target = &profile.target;
    let observed = Arc::new(Mutex::new(None));
    let mut handle = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(
            client_config(),
            (target.host.as_str(), target.port),
            Remote {
                expected: profile.host_key.clone(),
                observed: observed.clone(),
            },
        ),
    )
    .await
    .map_err(|_| "服务器连接超时")?
    .map_err(|_| {
        if observed
            .lock()
            .ok()
            .and_then(|k| k.clone())
            .is_some_and(|k| k != profile.host_key)
        {
            "主机指纹已变化，请在 FsTTY 安全管理窗口重新确认"
        } else {
            "无法连接服务器"
        }
    })?;
    let auth = async {
        let methods = handle
            .authenticate_none(&target.username)
            .await
            .map_err(|_| "无法查询认证方式")?;
        if methods.success() {
            return Ok(());
        }
        let result = if target.private_key {
            let key = russh::keys::decode_secret_key(
                &secrets.private_key,
                (!secrets.password.is_empty()).then_some(secrets.password.as_str()),
            )
            .map_err(|_| "私钥或口令无效")?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|_| "RSA 算法协商失败")?
                .flatten();
            handle
                .authenticate_publickey(
                    &target.username,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|_| "私钥认证失败")?
        } else {
            let keyboard = matches!(&methods,client::AuthResult::Failure {remaining_methods,..} if !remaining_methods.contains(&russh::MethodKind::Password) && remaining_methods.contains(&russh::MethodKind::KeyboardInteractive));
            if keyboard {
                use client::KeyboardInteractiveAuthResponse as K;
                match handle
                    .authenticate_keyboard_interactive_start(&target.username, None::<String>)
                    .await
                    .map_err(|_| "交互认证失败")?
                {
                    K::Success => return Ok(()),
                    K::InfoRequest { prompts, .. } => {
                        if prompts.len() > 8 {
                            return Err("认证提示过多");
                        }
                        let responses = prompts
                            .into_iter()
                            .map(|p| {
                                if p.echo {
                                    target.username.clone()
                                } else {
                                    secrets.password.to_string()
                                }
                            })
                            .collect();
                        return match handle
                            .authenticate_keyboard_interactive_respond(responses)
                            .await
                            .map_err(|_| "交互认证失败")?
                        {
                            K::Success => Ok(()),
                            _ => Err("认证失败或需要多因素认证"),
                        };
                    }
                    _ => return Err("交互认证失败"),
                }
            }
            handle
                .authenticate_password(&target.username, secrets.password.to_string())
                .await
                .map_err(|_| "密码认证失败")?
        };
        if result.success() {
            Ok(())
        } else {
            Err("认证被服务器拒绝")
        }
    };
    tokio::time::timeout(Duration::from_secs(30), auth)
        .await
        .map_err(|_| "SSH 认证超时")?
        .map_err(str::to_owned)?;
    Ok(handle)
}

pub fn server_config() -> crate::Result<Arc<server::Config>> {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .map_err(|_| "无法生成管道会话密钥")?;
    Ok(Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::from_secs(1),
        channel_buffer_size: 32,
        event_buffer_size: 32,
        ..Default::default()
    }))
}

struct Proxy {
    remote: Arc<tokio::sync::Mutex<client::Handle<Remote>>>,
    channels: tokio::task::JoinSet<()>,
}

impl server::Handler for Proxy {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        // 仅在经 Windows 身份校验的管道完成真实 SSH 认证后创建此处理器。
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        while self.channels.try_join_next().is_some() {}
        if self.channels.len() >= 32 {
            reply.reject(ChannelOpenFailure::ResourceShortage).await;
            return Ok(());
        }
        let remote = tokio::time::timeout(
            Duration::from_secs(15),
            self.remote.lock().await.channel_open_session(),
        )
        .await;
        match remote {
            Ok(Ok(remote)) => {
                reply.accept().await;
                let handle = session.handle();
                self.channels.spawn(async move {
                    let _ = bridge(channel, remote, handle).await;
                });
            }
            _ => {
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
            }
        }
        Ok(())
    }
}

pub async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    remote: client::Handle<Remote>,
    config: Arc<server::Config>,
) -> crate::Result<()> {
    serve_until(stream, remote, config, std::future::pending::<()>()).await
}

pub async fn serve_until<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: S,
    remote: client::Handle<Remote>,
    config: Arc<server::Config>,
    cancel: impl std::future::Future<Output = ()>,
) -> crate::Result<()> {
    let remote = Arc::new(tokio::sync::Mutex::new(remote));
    let handler = Proxy {
        remote: remote.clone(),
        channels: tokio::task::JoinSet::new(),
    };
    let result = match server::run_stream(config, stream, handler).await {
        Ok(running) => {
            let local = running.handle();
            tokio::select! {
                result=running=>result.map_err(|_| "SSH 管道已断开".to_owned()),
                _=cancel=>{
                    let _=local.disconnect(Disconnect::ByApplication,"认证配置已变更".into(),"zh-CN".into()).await;
                    Err("认证配置已变更，连接已关闭".into())
                }
            }
        }
        Err(_) => Err("SSH 管道初始化失败".into()),
    };
    let _ = remote
        .lock()
        .await
        .disconnect(Disconnect::ByApplication, "客户端已断开", "zh-CN")
        .await;
    result
}

async fn bridge(
    local: Channel<server::Msg>,
    remote: Channel<client::Msg>,
    handle: server::Handle,
) -> Result<(), russh::Error> {
    let id = local.id();
    let (mut local_rx, local_tx) = local.split();
    let (mut remote_rx, remote_tx) = remote.split();
    // 两个方向分别等待窗口，防止满窗口时双向互锁；关闭任一方向取消另一方向。
    let outbound = async {
        while let Some(msg) = local_rx.wait().await {
            match msg {
                ChannelMsg::Data { data } => remote_tx.data_bytes(data).await?,
                ChannelMsg::ExtendedData { data, ext } => {
                    remote_tx.extended_data_bytes(ext, data).await?
                }
                ChannelMsg::RequestPty {
                    want_reply,
                    term,
                    col_width,
                    row_height,
                    pix_width,
                    pix_height,
                    terminal_modes,
                } => {
                    // russh 的通道事件包含固定长度模式缓冲区，终止符后的填充不能重新编码。
                    let modes = terminal_modes
                        .into_iter()
                        .take_while(|(mode, _)| *mode != russh::Pty::TTY_OP_END)
                        .collect::<Vec<_>>();
                    remote_tx
                        .request_pty(
                            want_reply, &term, col_width, row_height, pix_width, pix_height, &modes,
                        )
                        .await?;
                }
                ChannelMsg::RequestShell { want_reply } => {
                    remote_tx.request_shell(want_reply).await?
                }
                ChannelMsg::Exec {
                    want_reply,
                    command,
                } => remote_tx.exec(want_reply, command).await?,
                ChannelMsg::RequestSubsystem { want_reply, name } if name == "sftp" => {
                    remote_tx.request_subsystem(want_reply, name).await?
                }
                ChannelMsg::SetEnv {
                    want_reply,
                    variable_name,
                    variable_value,
                } => {
                    remote_tx
                        .set_env(want_reply, variable_name, variable_value)
                        .await?
                }
                ChannelMsg::WindowChange {
                    col_width,
                    row_height,
                    pix_width,
                    pix_height,
                } => {
                    remote_tx
                        .window_change(col_width, row_height, pix_width, pix_height)
                        .await?
                }
                ChannelMsg::Signal { signal } => remote_tx.signal(signal).await?,
                ChannelMsg::Eof => remote_tx.eof().await?,
                ChannelMsg::Close => break,
                ChannelMsg::AgentForward { .. }
                | ChannelMsg::RequestX11 { .. }
                | ChannelMsg::RequestSubsystem { .. } => {
                    let _ = handle.channel_failure(id).await;
                }
                _ => {}
            }
        }
        Ok::<(), russh::Error>(())
    };
    let inbound = async {
        while let Some(msg) = remote_rx.wait().await {
            match msg {
                ChannelMsg::Data { data } => local_tx.data_bytes(data).await?,
                ChannelMsg::ExtendedData { data, ext } => {
                    local_tx.extended_data_bytes(ext, data).await?
                }
                ChannelMsg::Success => {
                    let _ = handle.channel_success(id).await;
                }
                ChannelMsg::Failure => {
                    let _ = handle.channel_failure(id).await;
                }
                ChannelMsg::ExitStatus { exit_status } => local_tx.exit_status(exit_status).await?,
                ChannelMsg::ExitSignal {
                    signal_name,
                    core_dumped,
                    error_message,
                    lang_tag,
                } => {
                    let _ = handle
                        .exit_signal_request(id, signal_name, core_dumped, error_message, lang_tag)
                        .await;
                }
                ChannelMsg::Eof => local_tx.eof().await?,
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<(), russh::Error>(())
    };
    let result = tokio::select! {r=outbound=>r,r=inbound=>r};
    let _ = remote_tx.close().await;
    let _ = local_tx.close().await;
    result
}
