use fstty_broker::{
    protocol::{Profile, Secrets, Target},
    proxy,
};
use russh::{client, server, Channel, ChannelId, ChannelMsg};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::time::{timeout, Duration};
use zeroize::Zeroizing;
#[path = "../../network/tests/support/mod.rs"]
mod proxy_fixture;

#[tokio::test]
async fn 经代理探测与认证支持命令和文件并拒绝变化指纹() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    timeout(Duration::from_secs(20), async {
        for socks in [false, true] {
            let (profile, secrets, attempts, server) = remote().await;
            let (route, count, tunnel) = proxy_fixture::tunnel(profile.target.port, socks).await;
            let key = proxy::probe(&profile.target, &route).await.unwrap();
            assert_eq!(key, profile.host_key);
            assert_eq!(attempts.load(Ordering::SeqCst), 0);
            let remote = proxy::authenticate(&profile, secrets.clone(), &route)
                .await
                .unwrap();
            let channel = remote.channel_open_session().await.unwrap();
            channel.request_subsystem(true, "sftp").await.unwrap();
            let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
                .await
                .unwrap();
            let mut file = sftp.create("/fixture").await.unwrap();
            file.write_all(b"proxy file transfer").await.unwrap();
            file.shutdown().await.unwrap();
            // 修改后续连接的路由不影响已经建立的 SSH 与传输。
            let mut changed = profile.clone();
            changed.host_key = "已变化的指纹".into();
            assert!(proxy::authenticate(&changed, secrets, &route)
                .await
                .is_err());
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
            tunnel.abort();
            let mut file = sftp.open("/fixture").await.unwrap();
            let mut content = Vec::new();
            file.read_to_end(&mut content).await.unwrap();
            assert_eq!(content, b"proxy file transfer");
            let mut exec = remote.channel_open_session().await.unwrap();
            exec.exec(true, b"mcp-device-status".to_vec())
                .await
                .unwrap();
            let mut output = Vec::new();
            while let Some(message) = exec.wait().await {
                if let ChannelMsg::Data { data } = message {
                    output.extend_from_slice(&data);
                }
            }
            assert_eq!(output, b"mcp-device-status");
            assert!(count.load(Ordering::SeqCst) >= 3);
            remote
                .disconnect(russh::Disconnect::ByApplication, "", "")
                .await
                .unwrap();
            server.abort();
        }
    })
    .await
    .expect("代理 SSH/SFTP 操作应及时完成");
}

struct TestServer {
    attempts: Arc<AtomicUsize>,
    channels: Vec<Channel<server::Msg>>,
    accepted_key: Option<russh::keys::PublicKey>,
}
impl server::Handler for TestServer {
    type Error = russh::Error;
    async fn auth_publickey(
        &mut self,
        _: &str,
        key: &russh::keys::PublicKey,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if self.accepted_key.as_ref() == Some(key) {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_password(
        &mut self,
        _: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if password == "测试专用密码" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.push(channel);
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        id: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(id)
    }
    async fn shell_request(
        &mut self,
        id: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(id)
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.channels.iter().any(|c| c.id() == id) {
            session.data(id, data.to_vec())
        } else {
            Ok(())
        }
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            return session.channel_failure(id);
        }
        let index = self.channels.iter().position(|c| c.id() == id).unwrap();
        let channel = self.channels.remove(index);
        session.channel_success(id)?;
        tokio::spawn(russh_sftp::server::run(
            channel.into_stream(),
            MemorySftp::default(),
        ));
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(id)?;
        session.data(id, command.to_vec())?;
        session.exit_status_request(id, 0)?;
        session.eof(id)?;
        session.close(id)
    }
}

#[derive(Default)]
struct MemorySftp {
    bytes: Vec<u8>,
}
impl russh_sftp::server::Handler for MemorySftp {
    type Error = russh_sftp::protocol::StatusCode;
    fn unimplemented(&self) -> Self::Error {
        Self::Error::OpUnsupported
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        flags: russh_sftp::protocol::OpenFlags,
        _: russh_sftp::protocol::FileAttributes,
    ) -> Result<russh_sftp::protocol::Handle, Self::Error> {
        if filename != "/fixture" {
            return Err(Self::Error::NoSuchFile);
        }
        if flags.contains(russh_sftp::protocol::OpenFlags::TRUNCATE) {
            self.bytes.clear();
        }
        Ok(russh_sftp::protocol::Handle {
            id,
            handle: filename,
        })
    }
    async fn read(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        let start = offset as usize;
        if start >= self.bytes.len() {
            return Err(Self::Error::Eof);
        }
        let end = (start + len as usize).min(self.bytes.len());
        Ok(russh_sftp::protocol::Data {
            id,
            data: self.bytes[start..end].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        _: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<russh_sftp::protocol::Status, Self::Error> {
        let start = offset as usize;
        let end = start + data.len();
        if end > 8 * 1024 * 1024 {
            return Err(Self::Error::Failure);
        }
        self.bytes.resize(self.bytes.len().max(end), 0);
        self.bytes[start..end].copy_from_slice(&data);
        Ok(sftp_ok(id))
    }
    async fn close(
        &mut self,
        id: u32,
        _: String,
    ) -> Result<russh_sftp::protocol::Status, Self::Error> {
        Ok(sftp_ok(id))
    }
}
fn sftp_ok(id: u32) -> russh_sftp::protocol::Status {
    russh_sftp::protocol::Status {
        id,
        status_code: russh_sftp::protocol::StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}

#[tokio::test]
async fn 服务代理传输大于窗口的文件并在取消后关闭连接() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    timeout(Duration::from_secs(20), async {
        let (profile, secrets, _, server) = remote().await;
        let remote = proxy::authenticate(&profile, secrets, &Default::default())
            .await
            .unwrap();
        let (service_stream, client_stream) = tokio::io::duplex(4096);
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let proxy = tokio::spawn(proxy::serve_until(
            service_stream,
            remote,
            proxy::server_config().unwrap(),
            async {
                let _ = cancel_rx.await;
            },
        ));
        let mut client = client::connect_stream(
            Arc::new(client::Config::default()),
            client_stream,
            LocalClient,
        )
        .await
        .unwrap();
        assert!(client.authenticate_none("fstty").await.unwrap().success());
        let channel = client.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .unwrap();
        let data = (0..3 * 1024 * 1024)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>();
        let mut file = sftp.create("/fixture").await.unwrap();
        file.write_all(&data).await.unwrap();
        file.shutdown().await.unwrap();
        let mut file = sftp.open("/fixture").await.unwrap();
        let mut downloaded = Vec::new();
        file.read_to_end(&mut downloaded).await.unwrap();
        assert_eq!(downloaded, data);
        cancel_tx.send(()).unwrap();
        assert!(timeout(Duration::from_secs(3), proxy)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(sftp.open("/fixture").await.is_err());
        server.abort();
    })
    .await
    .expect("传输或取消不能死锁");
}
struct LocalClient;
impl client::Handler for LocalClient {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _: &russh::keys::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}
async fn remote() -> (
    Profile,
    Secrets,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    remote_with_key(None).await
}

async fn remote_with_key(
    accepted_key: Option<russh::keys::PublicKey>,
) -> (
    Profile,
    Secrets,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let config = proxy::server_config().unwrap();
    let key = config.keys[0].public_key().to_openssh().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                break;
            };
            let handler = TestServer {
                attempts: counter.clone(),
                channels: vec![],
                accepted_key: accepted_key.clone(),
            };
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(running) = server::run_stream(config, socket, handler).await {
                    let _ = running.await;
                }
            });
        }
    });
    (
        Profile {
            target: Target {
                id: uuid::Uuid::new_v4().to_string(),
                host: "127.0.0.1".into(),
                port,
                username: "test".into(),
                private_key: false,
            },
            revision: 1,
            host_key: key,
            cleanup_pending: false,
        },
        Secrets {
            password: Zeroizing::new("测试专用密码".into()),
            ..Default::default()
        },
        attempts,
        task,
    )
}

#[tokio::test]
async fn 带口令私钥由服务解锁签名且错误口令不发送认证() {
    timeout(Duration::from_secs(20), async {
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let encrypted = key
            .encrypt(&mut rand::rng(), "测试专用口令")
            .unwrap()
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let (mut profile, _, attempts, server) =
            remote_with_key(Some(key.public_key().clone())).await;
        profile.target.private_key = true;
        let secret = |password: &str| Secrets {
            password: Zeroizing::new(password.into()),
            private_key: Zeroizing::new(encrypted.to_string()),
        };
        assert!(
            proxy::authenticate(&profile, secret("错误口令"), &Default::default())
                .await
                .is_err()
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
        let remote = proxy::authenticate(&profile, secret("测试专用口令"), &Default::default())
            .await
            .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        remote
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await
            .unwrap();
        server.abort();
    })
    .await
    .expect("私钥认证应及时完成");
}

#[tokio::test]
async fn 主机指纹不匹配时绝不发送保存的密码() {
    let (mut profile, secrets, attempts, server) = remote().await;
    profile.host_key = "伪造的主机指纹".into();
    assert!(proxy::authenticate(&profile, secrets, &Default::default())
        .await
        .is_err());
    assert_eq!(attempts.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn 通道代理支持终端与命令并传递退出码() {
    timeout(Duration::from_secs(15),async {
        let (profile,secrets,attempts,server)=remote().await;
        let remote=proxy::authenticate(&profile,secrets,&Default::default()).await.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst),1);
        let (service_stream,client_stream)=tokio::io::duplex(65536);
        let config=proxy::server_config().unwrap();
        let proxy=tokio::spawn(proxy::serve(service_stream,remote,config));
        let mut client=client::connect_stream(Arc::new(client::Config::default()),client_stream,LocalClient).await.unwrap();
        assert!(client.authenticate_none("fstty").await.unwrap().success());
        let mut channel=client.channel_open_session().await.unwrap();
        channel.request_pty(true,"xterm",80,24,0,0,&[]).await.unwrap();
        let response=channel.wait().await;assert!(matches!(response,Some(ChannelMsg::Success)),"PTY 响应：{response:?}");
        channel.request_shell(true).await.unwrap();
        assert!(matches!(channel.wait().await,Some(ChannelMsg::Success)));
        channel.data(&b"test terminal"[..]).await.unwrap();
        assert!(matches!(channel.wait().await,Some(ChannelMsg::Data{data}) if data.as_ref()==b"test terminal"));
        let mut exec=client.channel_open_session().await.unwrap();
        exec.exec(true,b"test command".to_vec()).await.unwrap();
        let mut output=Vec::new();let mut exited=false;
        while let Some(msg)=exec.wait().await{match msg {ChannelMsg::Data{data}=>output.extend_from_slice(&data),ChannelMsg::ExitStatus{exit_status}=>{assert_eq!(exit_status,0);exited=true;},ChannelMsg::Close=>break,_=>{}}}
        assert_eq!(output,b"test command");assert!(exited);
        client.disconnect(russh::Disconnect::ByApplication,"","en").await.unwrap();
        timeout(Duration::from_secs(3),proxy).await.unwrap().unwrap().unwrap();server.abort();
    }).await.expect("通道代理不能互锁");
}
